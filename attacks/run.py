#!/usr/bin/env python3
"""Instrument 2: adversarial privacy analysis of the anonymous bidding layer.

For every bid in a public record each attack outputs a probability
distribution over the households of that pilot. See README.md.
Standard library only.
"""
import argparse
import collections
import csv
import math
import random
import re
import statistics
from pathlib import Path

HOUR, ROUNDS, BINS = 3600, 168, 5
PRE_START = 1779753600              # 26 May 2026 00:00 UTC (labels changed that day)
WEEK_START = 1793664000             # 3 Nov 2026 00:00 UTC
PROFILE_DAYS = 28                   # profiles from the last 28 days of the pre-privacy record
EPS = 0.05                          # weight of the pilot-wide density in each quantity model
PILOTS = ('danish', 'spanish', 'italian')
O3 = {'danish': 2.5, 'spanish': 1.3, 'italian': 1.7}            # bits at round 168, level 2
PREDICTED = {'danish': 2.3, 'spanish': 1.6, 'italian': 2.6}     # as written in the methodology
ATTACKS = ('pattern', 'intersection', 'order', 'composed')
COMPOSED = ('pattern', 'intersection')                          # the methodology's composition
COMMUNITAS = Path(__file__).resolve().parents[2]
Bid = collections.namedtuple('Bid', 'r d sender x rank hh')      # round 1..168, UTC hour of day, log quantity, rank


# ---------- inputs ----------

def load_members(path):
    text = Path(path).read_text()
    out = {}
    for p in PILOTS:
        block = re.search(p.upper() + r'_HOUSEHOLDS[^=]*=\s*\[(.*?)\];', text, re.S).group(1)
        out[p] = re.findall(r'componentId:\s*"([^"]+)"', block)
    return out


def load_field(path):
    with open(path) as f:   # file order is kept: it is the submission order within an hour
        return [(r['pilot'], r['kind'], r['label'], int(r['hour']), float(r['amount_W']))
                for r in csv.DictReader(f)]


def simulate(field, members, ws, seed):
    """Public record and ground truth for the week, as the replay would write them.
    Baseline: one fixed address per household, bot order. Treatment: fresh sender per bid, order shuffled."""
    rng = random.Random(seed)
    hexid = lambda bits: '0x%0*x' % (bits // 4, rng.getrandbits(bits))
    wallet = {h: hexid(160) for p in PILOTS for h in members[p]}
    hours = collections.defaultdict(list)
    for p, kind, label, hour, q in field:
        if kind == 'bid' and ws <= hour < ws + ROUNDS * HOUR and label in members[p]:
            hours[p, hour].append((label, q))
    pub, tru = [], []
    for (p, hour), bids in sorted(hours.items()):
        for run in ('baseline', 'treatment'):
            order = list(bids)
            if run == 'treatment':
                rng.shuffle(order)
            for i, (label, q) in enumerate(order):
                sender = wallet[label] if run == 'baseline' else hexid(256)
                pub.append({'run': run, 'pilot': p, 'hour': hour, 'index': i, 'sender': sender,
                            'amount_W': int(q) if q.is_integer() else q, 'tx_hash': hexid(256)})
                tru.append({'run': run, 'pilot': p, 'hour': hour, 'index': i, 'household': label})
    return pub, tru


def write_csv(path, rows):
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def to_bids(pub, tru, ws):
    """Group the record by (run, pilot); rank = position within the hour by index."""
    hh = {(r['run'], r['pilot'], int(r['hour']), int(r['index'])): r['household'] for r in tru}
    hours = collections.defaultdict(list)
    for r in pub:
        key = (r['run'], r['pilot'], int(r['hour']), int(r['index']))
        hours[key[:3]].append((key[3], r['sender'], math.log(float(r['amount_W'])), hh[key]))
    out = collections.defaultdict(list)
    for (run, p, hour), hb in sorted(hours.items()):
        rnd = (hour - ws) // HOUR + 1
        if 1 <= rnd <= ROUNDS:
            hb.sort()
            for pos, (_, sender, x, h) in enumerate(hb):
                out[run, p].append(Bid(rnd, hour // HOUR % 24, sender, x, pos / (len(hb) - 1) if len(hb) > 1 else None, h))
    return out


# ---------- household models (knowledge level 2) ----------

def build_model(field, pilot, mems, ws, days):
    """Per household and hour of day: mean and sd of log quantity, eligibility p.
    Per household: histogram of its position within the hour. Pilot-wide log-quantity density."""
    start = ws - days * 86400
    hod = lambda hour: hour // HOUR % 24
    uptime = collections.Counter(hod(h) for h in {f[3] for f in field if start <= f[3] < ws})  # bot running
    hours = collections.defaultdict(list)
    for p, kind, label, hour, q in field:
        if p == pilot and kind == 'bid' and start <= hour < ws and label in mems:
            hours[hour].append((label, math.log(q)))
    xs, allx, ranks = collections.defaultdict(list), collections.defaultdict(list), {h: [1] * BINS for h in mems}
    for hour, hb in hours.items():
        for i, (h, x) in enumerate(hb):
            xs[h, hod(hour)].append(x)
            allx[h].append(x)
            if len(hb) > 1:
                ranks[h][min(int(i / (len(hb) - 1) * BINS), BINS - 1)] += 1
    every = [x for v in allx.values() for x in v]
    m = {'mu': {}, 'sd': {}, 'p': {}, 'rank': {}, 'g': (statistics.fmean(every), statistics.pstdev(every))}
    for h in mems:
        fall = allx[h] if len(allx[h]) > 1 else every          # fewer than 2 samples: household, then pilot
        m['mu'][h], m['sd'][h], m['p'][h] = [], [], []
        for d in range(24):
            v = xs[h, d] if len(xs[h, d]) > 1 else fall
            m['mu'][h].append(statistics.fmean(v))
            m['sd'][h].append(max(statistics.pstdev(v), 0.1))   # floor: 10 percent in quantity
            m['p'][h].append((len(xs[h, d]) + 1) / (uptime[d] + 2))  # Laplace-smoothed Bernoulli
        tot = sum(ranks[h])
        m['rank'][h] = [math.log(c / tot) for c in ranks[h]]
    return m


# ---------- attacks ----------

def incl(p, k):
    """P(household i is among the k present | exactly k present), independent Bernoulli(p_i)."""
    n, k = len(p), min(k, len(p))
    if k == 0:
        return [0.0] * n
    def grow(poly, x):     # multiply by (1 - x + x z), keep degree <= k
        return [(poly[j] if j < len(poly) else 0) * (1 - x) + (poly[j - 1] * x if j else 0)
                for j in range(min(len(poly) + 1, k + 1))]
    pre, suf = [[1.0]], [[1.0]]
    for x in p:
        pre.append(grow(pre[-1], x))
    for x in reversed(p):
        suf.append(grow(suf[-1], x))
    suf.reverse()
    out = []
    for i in range(n):
        a, b = pre[i], suf[i + 1]
        c = sum(a[j] * b[k - 1 - j] for j in range(k) if j < len(a) and k - 1 - j < len(b))
        out.append(p[i] * c / pre[n][k])
    return out


def link(bids, by_round, model, cands):
    """Attack 1 linking: two bids in adjacent hours are linked when both quantities lie within one sd
    of a common household model. Applied only where unambiguous: each has exactly one such partner."""
    mu, sd = model['mu'], model['sd']
    mask = [sum(1 << j for j, c in enumerate(cands) if abs(b.x - mu[c][b.d]) <= sd[c][b.d])
            for b in bids]
    nxt = {}
    for r in range(1, ROUNDS):
        pairs = [(a, b) for a in by_round[r] for b in by_round[r + 1] if mask[a] & mask[b]]
        na, nb = collections.Counter(a for a, _ in pairs), collections.Counter(b for _, b in pairs)
        nxt.update((a, b) for a, b in pairs if na[a] == 1 and nb[b] == 1)
    starts = set(range(len(bids))) - set(nxt.values())
    frags = []
    for i in sorted(starts):
        f = [i]
        while f[-1] in nxt:
            f.append(nxt[f[-1]])
        frags.append(f)
    return frags


def run_attack(bids, model, cands, attack):
    """Evidence accumulates round by round. Returns per-round and cumulative sums
    [sum H, min H, sum H_inf, sum recovered, n, sum top p] for rounds 1..168, and (links, correct links)."""
    n = len(cands)
    col = {c: j for j, c in enumerate(cands)}
    by_round = collections.defaultdict(list)
    for i, b in enumerate(bids):
        by_round[b.r].append(i)
    persistent = len({b.sender for b in bids}) < len(bids)    # baseline: one address per household
    uses = set() if model is None else set(COMPOSED) if attack == 'composed' else {attack}
    if persistent:                                              # link by address
        groups = collections.defaultdict(list)
        for i, b in enumerate(bids):
            groups[b.sender].append(i)
        frags = list(groups.values())
    elif 'pattern' in uses:
        frags = link(bids, by_round, model, cands)
    else:
        frags = [[i] for i in range(len(bids))]
    frag_of = {i: f for f, fr in enumerate(frags) for i in fr}
    links = sum(len(f) - 1 for f in frags)
    good = sum(bids[a].hh == bids[b].hh for f in frags for a, b in zip(f, f[1:]))

    logpi, logabs = {}, {}
    if 'intersection' in uses:
        for r in range(1, ROUNDS + 1):
            k = len({bids[i].sender for i in by_round[r]})
            d = bids[by_round[r][0]].d if k else 0
            pi = incl([model['p'][c][d] for c in cands], k)
            logpi[r] = [math.log(max(x, 1e-300)) for x in pi]
            logabs[r] = [math.log(max(1 - x, 1e-300)) for x in pi]

    def term(i):
        b, t = bids[i], [0.0] * n
        if 'pattern' in uses:       # robust density: (1-EPS) household model + EPS pilot-wide model
            gm, gs = model['g']
            g = EPS * math.exp(-0.5 * ((b.x - gm) / gs) ** 2) / gs
            for j, c in enumerate(cands):
                mu, s = model['mu'][c][b.d], model['sd'][c][b.d]
                t[j] += math.log((1 - EPS) * math.exp(-0.5 * ((b.x - mu) / s) ** 2) / s + g)
        if 'intersection' in uses:
            t = [x + y for x, y in zip(t, logpi[b.r])]
        if 'order' in uses and b.rank is not None:
            t = [x + model['rank'][c][min(int(b.rank * BINS), BINS - 1)] for x, c in zip(t, cands)]
        return t

    ll = [[0.0] * n for _ in frags]
    seen = [0] * len(frags)
    stat = {}                  # fragment -> (H, H_inf, recovered among seen bids, top p, tied argmax set)
    cum, per = [], []
    for r in range(1, ROUNDS + 1):
        present = collections.defaultdict(list)
        for i in by_round[r]:
            present[frag_of[i]].append(i)
        touched = range(len(frags)) if persistent and 'intersection' in uses else present
        for f in touched:
            for i in present.get(f, ()):
                ll[f] = [x + y for x, y in zip(ll[f], term(i))]
            if f not in present:                                # a persistent address absent this round
                ll[f] = [x + y for x, y in zip(ll[f], logabs[r])]
            seen[f] += len(present.get(f, ()))
            top = max(ll[f])
            e = [math.exp(x - top) for x in ll[f]]
            s = sum(e)
            post = [x / s for x in e]
            pmax = max(post)
            tied = {j for j, x in enumerate(post) if x >= pmax * (1 - 1e-9)}   # ties share the credit
            got = sum(1 / len(tied) for i in frags[f][:seen[f]] if col[bids[i].hh] in tied)
            stat[f] = (-sum(x * math.log2(x) for x in post if x > 0), -math.log2(pmax), got, pmax, tied)
        live = [f for f in stat if seen[f]]
        cum.append([sum(seen[f] * stat[f][0] for f in live), min((stat[f][0] for f in live), default=math.inf),
                    sum(seen[f] * stat[f][1] for f in live), sum(stat[f][2] for f in live),
                    sum(seen[f] for f in live), sum(seen[f] * stat[f][3] for f in live)])
        here = [(i, stat[frag_of[i]]) for i in by_round[r]]
        per.append([sum(s[0] for _, s in here), min((s[0] for _, s in here), default=math.inf),
                    sum(s[1] for _, s in here), sum(1 / len(s[4]) for i, s in here if col[bids[i].hh] in s[4]),
                    len(here), sum(s[3] for _, s in here)])
    return per, cum, links, good


def pool(a, b):
    if a is None:
        return [[row[:] for row in b[0]], [row[:] for row in b[1]], b[2], b[3]]
    for pa, pb in zip(a[:2], b[:2]):
        for x, y in zip(pa, pb):
            x[0] += y[0]; x[1] = min(x[1], y[1]); x[2] += y[2]; x[3] += y[3]; x[4] += y[4]; x[5] += y[5]
    a[2] += b[2]
    a[3] += b[3]
    return a


def evaluate(bids, model, mems, attack, level):
    """Level 1: no household knowledge. Level 2: profiles. Level 3: level 2 seen by each member in turn,
    which removes its own bids and itself from the candidates; the members' views are pooled."""
    views = [(bids, mems)] if level < 3 else \
        [([b for b in bids if b.hh != m], [c for c in mems if c != m]) for m in mems]
    total = None
    for vb, vc in views:
        total = pool(total, run_attack(vb, model if level > 1 else None, vc, attack))
    return total


def final_mean(res):
    c = res[1][-1]
    return c[0] / c[4]


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--record', help='public_record.csv')
    ap.add_argument('--truth', help='ground_truth.csv')
    ap.add_argument('--field', default=COMMUNITAS / '28thjunepaper/analysis/investigation/orders.csv')
    ap.add_argument('--pilots', default=COMMUNITAS / 'simulation-bot/src/config/pilots.ts')
    ap.add_argument('--week-start', type=int, default=WEEK_START)
    ap.add_argument('--profile-days', type=int, default=PROFILE_DAYS)
    ap.add_argument('--simulate', action='store_true', help='build the record from the field record')
    ap.add_argument('--seeds', type=int, default=10, help='simulated records per batch (--simulate only)')
    ap.add_argument('--out', default=Path(__file__).resolve().parent / 'out')
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    members = load_members(a.pilots)
    field = load_field(a.field)
    models = {p: build_model(field, p, members[p], a.week_start, a.profile_days) for p in PILOTS}

    if a.simulate:      # the only random part is the simulated record (fresh senders, shuffled order)
        def record(seed):
            pub, tru = simulate(field, members, a.week_start, seed)
            if seed == 0:
                (out / 'sim').mkdir(exist_ok=True)
                write_csv(out / 'sim' / 'public_record.csv', pub)
                write_csv(out / 'sim' / 'ground_truth.csv', tru)
            return to_bids(pub, tru, a.week_start)
        batch = a.seeds
    elif a.record and a.truth:
        with open(a.record) as f1, open(a.truth) as f2:
            fixed = to_bids(list(csv.DictReader(f1)), list(csv.DictReader(f2)), a.week_start)
        record, batch = (lambda seed: fixed), 1
    else:
        ap.error('give --record and --truth, or --simulate')

    keys = [(run, p, at, lv) for p in PILOTS for run in ('baseline', 'treatment') for lv in (1, 2, 3) for at in ATTACKS]
    pooled, figs, means, seed = {}, collections.defaultdict(list), collections.defaultdict(list), 0
    while True:         # one batch; more batches until the batch means agree within 0.1 bit (max 10)
        start = len(figs[keys[0]])
        for _ in range(batch):
            rec = record(seed)
            seed += 1
            for run, p, at, lv in keys:
                bids = rec[run, p]
                assert {b.hh for b in bids} <= set(members[p]), f'{p}: household outside the membership list'
                res = evaluate(bids, models[p], members[p], at, lv)
                pooled[run, p, at, lv] = pool(pooled.get((run, p, at, lv)), res)
                figs[run, p, at, lv].append(final_mean(res))
        for k in keys:
            means[k].append(statistics.fmean(figs[k][start:]))
        spread = max(max(v) - min(v) for v in (means if len(means[keys[0]]) > 1 else figs).values())
        if spread <= 0.1 or len(means[keys[0]]) == 10:
            break
    nseeds = len(figs[keys[0]])
    print(f'seeds {nseeds}, largest round-168 spread {spread:.3f} bit')

    results = {}
    with open(out / 'curves.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['run', 'pilot', 'attack', 'level', 'scope', 'round', 'shannon_mean', 'shannon_min',
                    'min_entropy_mean', 'recovery_rate', 'top_p_mean'])
        for k in keys:
            res = pooled[k]
            for scope, part in zip(('per_round', 'cumulative'), res[:2]):
                for r, (h, hmin, hinf, got, n, ptop) in enumerate(part, 1):
                    if n:
                        w.writerow([*k, scope, r, *(round(v, 4) for v in (h / n, hmin, hinf / n, got / n, ptop / n))])
            h, hmin, hinf, got, n, ptop = res[1][-1]
            results[k] = (h / n, hmin, hinf / n, got / n, ptop / n, res[2], res[3])
            print(*k, 'H=%.3f min=%.3f Hinf=%.3f rec=%.3f top=%.3f links=%d good=%d' % results[k], flush=True)
    (out / 'summary.md').write_text(summary(results, record(0), members, a, nseeds, spread))
    print('wrote', out / 'curves.csv', 'and', out / 'summary.md')


def summary(res, record, members, a, nseeds, spread):
    src = 'simulated from the field record (`--simulate`)' if a.simulate else f'`{a.record}`'
    L = ['# Adversarial privacy analysis: summary', '',
         f'Record: {src}. Week start {a.week_start}, rounds 1 to {ROUNDS}. Profiles: last {a.profile_days} days '
         'of the pre-privacy record. Figures are cumulative at round 168 (every bid of the week, all evidence of '
         'the week) unless stated. Shannon and min-entropy are means over bids, in bits.',
         f'Seeds: {nseeds}; largest spread of a round-168 figure {spread:.3f} bit. The attacks are exact; '
         'the only random part is the simulated record.' if a.simulate else
         'Seeds: 1. The attacks are exact (no sampling, no random tie-breaks), so one run is the result.',
         'Funding path: closed in the treatment (the relayer fronts value), so the pair "with and without '
         'funding path" reduces to the treatment as run.',
         'Channels: pattern = bid quantity; intersection = participation (which households have net '
         'consumption in an hour); order = submission order within the hour. Composed = pattern x intersection.',
         '']
    fmt = lambda v: ' | '.join(f'{x:.2f}' for x in v[:5])
    for p in PILOTS:
        n = len(members[p])
        bids = record['treatment', p]
        k = collections.Counter(b.r for b in bids)
        obs_bid = statistics.fmean(math.log2(k[b.r]) for b in bids)
        obs_hour = statistics.fmean(math.log2(v) for v in k.values())
        L += [f'## {p.capitalize()}', '',
              f'{n} members, {len({b.hh for b in bids})} bid this week, {len(bids)} bids in {len(k)} hours. '
              f'Ceiling log2({n}) = {math.log2(n):.2f} bits. Observed set: median {statistics.median(k.values()):g} '
              f'bidders per hour; mean log2 {obs_hour:.2f} over hours, {obs_bid:.2f} over bids.', '',
              '### Positive control (baseline record, one address = one household)', '',
              'Recovery at round 168, with mean top probability in brackets (a top probability well above the '
              'recovery means the attack is confidently wrong). Level 1 has no household knowledge, so it is '
              'not a control.', '', '| attack | level 2 | level 3 |', '|---|---|---|']
        ok = []
        for at in ATTACKS:
            r2, r3 = (res['baseline', p, at, lv] for lv in (2, 3))
            if r2[3] >= 0.9995 and r3[3] >= 0.9995:
                ok.append(at)
            L.append(f'| {at} | {r2[3]:.3f} ({r2[4]:.2f}) | {r3[3]:.3f} ({r3[4]:.2f}) |')
        L += ['', 'Identifies every bid: ' + (', '.join(ok) if ok else 'none') + '. Fails: '
              + (', '.join(at for at in ATTACKS if at not in ok) or 'none') + '.', '',
              '### Treatment, round 168', '',
              '| attack | level | Shannon mean | Shannon min | min-entropy mean | recovery | mean top p |',
              '|---|---|---|---|---|---|---|']
        for lv in (1, 2, 3):
            for at in ATTACKS:
                L.append(f'| {at} | {lv} | {fmt(res["treatment", p, at, lv])} |')
        lk, good = res['treatment', p, 'pattern', 2][5:]
        L += ['', f'Linking (pattern, level 2, per seed): {lk / nseeds:.0f} links made, '
              f'{good / max(lk, 1):.0%} of them join bids of the same household.']
        h2 = res['treatment', p, 'composed', 2][0]
        d = h2 - O3[p]
        L += [f'O3 (composed, level 2, threshold {O3[p]} bits): {h2:.2f} bits, '
              f'**{"met" if d >= 0 else "missed"}** by {abs(d):.2f} bit.'
              + ('' if 'composed' in ok else ' The composed attack failed the positive control here, so this '
                 'figure shows what these attacks leave, not that the objective holds against a competent observer.')]
        gap = h2 - obs_bid
        verdict = 'confirmed' if abs(gap) <= 0.5 else 'refuted' if gap < -1 else 'neither confirmed nor refuted'
        L += [f'Prediction (written as {PREDICTED[p]} bits; tested against this week\'s mean log2 observed set over '
              f'bids, {obs_bid:.2f}): composed level-2 figure {h2:.2f}, difference {gap:+.2f} bit, **{verdict}**.']
        lost = {at: math.log2(n) - res['treatment', p, at, 2][0] for at in ATTACKS}
        top = max((at for at in ATTACKS if at != 'composed'), key=lost.get)
        L += ['Bits lost at level 2 against the ceiling (recovery in brackets; chance is '
              f'{1 / n:.2f}): ' + ', '.join(f'{at} {v:.2f} ({res["treatment", p, at, 2][3]:.2f})'
                                          for at, v in lost.items())
              + f'. Largest single channel: **{top}**. Bits lost by an attack whose recovery stays at chance '
              'are overconfidence, not leakage.', '']
    return '\n'.join(L) + '\n'


if __name__ == '__main__':
    main()
