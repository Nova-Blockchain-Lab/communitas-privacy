"""Self-check: the positive control passes. Run: python3 test_attacks.py"""
import math
from pathlib import Path

import run as R


def recovery(res):
    c = res[1][-1]
    return c[3] / c[4]


def synthetic():
    """Three households with distinct hours, quantities and submission order: every attack must name every bid."""
    ws, field = R.WEEK_START, []
    for day in range(-R.PROFILE_DAYS, 7):
        for d in range(24):
            hour = ws + (day * 24 + d) * R.HOUR
            wiggle = 1 + 0.1 * ((day + d) % 3)
            for h, lo, hi, q in (('A', 0, 12, 100), ('B', 6, 18, 1000), ('C', 12, 24, 10000)):
                if lo <= d < hi:
                    field.append(('danish', 'bid', h, hour, q * wiggle))
    members = {'danish': ['A', 'B', 'C'], 'spanish': [], 'italian': []}
    rec = R.to_bids(*R.simulate(field, members, ws, 0), ws)
    model = R.build_model(field, 'danish', members['danish'], ws, R.PROFILE_DAYS)
    for at in R.ATTACKS:
        for lv in (2, 3):
            assert recovery(R.evaluate(rec['baseline', 'danish'], model, members['danish'], at, lv)) == 1, (at, lv)
    res = R.evaluate(rec['treatment', 'danish'], model, members['danish'], 'composed', 1)
    assert abs(R.final_mean(res) - math.log2(3)) < 1e-9          # level 1 is the ceiling
    assert abs(sum(R.incl([0.2, 0.5, 0.9, 0.3], 2)) - 2) < 1e-12  # inclusion probabilities sum to k


def field_record():
    """Regression on the real record: the controls that passed when the instrument was fixed still pass."""
    path = R.COMMUNITAS / '28thjunepaper/analysis/investigation/orders.csv'
    if not Path(path).exists():
        print('field record not found, skipped')
        return
    members = R.load_members(R.COMMUNITAS / 'simulation-bot/src/config/pilots.ts')
    field = R.load_field(path)
    rec = R.to_bids(*R.simulate(field, members, R.WEEK_START, 0), R.WEEK_START)
    for p in ('spanish', 'italian'):
        model = R.build_model(field, p, members[p], R.WEEK_START, R.PROFILE_DAYS)
        for at in ('pattern', 'order', 'composed'):
            assert recovery(R.evaluate(rec['baseline', p], model, members[p], at, 2)) == 1, (p, at)


if __name__ == '__main__':
    synthetic()
    field_record()
    print('positive control: ok')
