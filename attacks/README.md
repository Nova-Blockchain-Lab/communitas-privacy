# attacks: adversarial privacy analysis

Instrument 2 of the RS2 methodology (section "Instrument 2: adversarial privacy analysis"). For every bid
in a public record, each attack outputs a probability distribution over the households of that pilot.
Python 3 standard library only.

## Run

```
python3 run.py --simulate                      # record built from the field record, 10 seeds
python3 run.py --record ../sim/out/public_record.csv --truth ../sim/out/ground_truth.csv --out out/replay
python3 test_attacks.py                        # self-check: the positive control passes
```

Inputs default to `../../28thjunepaper/analysis/investigation/orders.csv` (field record) and
`../../simulation-bot/src/config/pilots.ts` (membership: 32, 6, 10). Output goes to `out/` (gitignored):
`curves.csv`, `summary.md`, and with `--simulate` the generated record in `out/sim/`. The field record and
the ground truth name households by meter id; keep them out of tracked files.

## Attacks

- **pattern** (behaviour pattern matching, after Jawurek et al. 2011). Each household's model is the mean and
  sd of its log bid quantity per hour of day. Bids in adjacent hours are linked when both quantities lie within
  one sd of a common household model and the link is unambiguous. A fragment's likelihood is the product of
  its per-bid densities.
- **intersection** (statistical disclosure, after Danezis and Serjantov 2004). Each household is present in an
  hour with probability p, from its record of hours with a bid. With k bids seen in the hour, the likelihood of
  a household is P(it is among the k present), computed exactly. A persistent address also scores the hours it
  was absent, so evidence accumulates across rounds.
- **order** (submission order within the hour). The household's histogram of position in the hour, from the
  field record. Not part of the composition. It checks whether the replay's shuffle removed the channel.
- **composed**: pattern times intersection, normalised, with a uniform prior over the pilot's members.

Knowledge levels: 1, the public record only (no household knowledge, so every bid sits at log2 N); 2, plus
profiles from the pre-privacy record (the headline); 3, a member who also knows its own bids, removes them and
itself, with all members' views pooled.

## Numbers

Per bid: Shannon entropy of the distribution, min-entropy (minus log2 of the top probability), recovery
(the top household is the true one; ties share the credit), and the top probability itself. `curves.csv`
gives means over bids (and the minimum Shannon entropy) per round (`per_round`: bids of round r, evidence of
rounds 1 to r) and cumulatively (`cumulative`: bids of rounds 1 to r, evidence of rounds 1 to r). O3 and the
prediction read the cumulative composed figure at round 168, level 2.

Entropy is the attack's belief, not a fact about the record. Read it beside recovery: when mean top
probability is well above recovery, the attack is confidently wrong and the bits it reports as lost are not
leakage.

## Choices made to pass the positive control

The control runs every attack on the baseline record, where one address is one household. The attacks link
bids by address there and must then name the household from the profiles.

- Quantities are modelled on a log scale with a 5 percent pilot-wide component (`EPS`). With a plain Gaussian
  on watts, one drifted bid cost the true household thousands of nats and the broadest profile won every bid.
- Profiles come from the last 28 days of the pre-privacy record (`--profile-days`), by hour of day. The record
  drifts by season (one Italian household fell from about 14,000 W in summer to 1,175 W in the week), and 28
  days hold at most four samples per hour of week.
- Links are made only where the rule is unambiguous. Resolving it greedily or by nearest neighbour joined bids
  of different households 42 to 88 percent of the time, and the products of those fragments gave near-certain
  wrong answers.

## Limits

- Denmark fails the control for every attack. Co-located households bid alike, eight households bid once in
  the week, and Danish bidding follows whole locations switching on and off by day, which the history does not
  predict. Even profiles built from the week itself name 76 percent of Danish baseline bids by quantity. The
  Danish treatment figures say what these attacks leave, not what a competent observer would.
- The intersection attack cannot pass the control in Spain and Italy: most households bid in every hour, so
  presence does not separate them. It is not broken; the channel is empty there.
- The attacks are exact, so seeds only matter for the simulated record (fresh senders and shuffled order).
- A lower bound on leakage for these two attack families, not a guarantee. Volume matching against load
  signatures is not run.
