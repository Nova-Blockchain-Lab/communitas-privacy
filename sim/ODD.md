# Replay of the COMMUNITAS week: ODD description

Model description following the ODD protocol, second update (Grimm et al. 2020, JASSS 23(2) 7). The code is
`sim/replay.mjs`.

## 1. Purpose and patterns

The model measures what the privacy layer costs on chain, and produces the public record that the attack harness
analyses. It replays one recorded week of the three COMMUNITAS pilots through the market contracts twice: once
as deployed (baseline) and once through the identity layer (treatment). The two runs take the same input on the
same clock, so each round's cost difference is a paired difference.

It is not a model of household behaviour. The agents replay recorded bid quantities under fixed rules. The model
supports no claim about bidding behaviour, price discovery or welfare.

Pattern used to check the model: the baseline run must reproduce the field record's bids for every instance and
hour of the week, in count, amount and index order. The replay checks this against the chain before every clearing
and stops if it fails.

## 2. Entities, state variables and scales

- Household agent, one per household in the bot's configuration (48: 32 Danish, 6 Spanish, 10 Italian). State:
  pilot; meter id (input label, never sent to the chain); trace, the recorded bid in W for each hour of the week in
  which the household bid; a wallet (baseline); a Semaphore identity derived from the seed and the meter id
  (treatment); the three policies of section 7.
- Location, one per configured location (21: 9, 2, 10). A wallet that receives asks. It takes no decisions.
- Operator: the whitelisted seller account. Places the asks and clears each hour, as the bot's operator key does.
- Relayer (treatment): one account. Submits and funds every private bid, and is the refund address of every bid.
- Mock DSO and admission service (treatment), from `dso/lib.mjs`: issue a credential per household and admit its
  Semaphore commitment.
- Market instance, one per pilot and run. Baseline: `EnergyBiddingMarket` from `lib/energy-bidding-market` behind
  an ERC1967 proxy. Treatment: `PrivateEnergyBiddingMarket` behind an ERC1967 proxy, with one Semaphore v4 group
  per pilot in one Semaphore contract.

Time step: one market hour. Extent: 168 rounds, 3 Nov 2026 00:00 UTC to 10 Nov 2026 00:00 UTC. Chain time is set
on a local anvil node. There is no spatial dimension.

## 3. Process overview and scheduling

Each cycle runs at minute 5 of hour c, as the bot's cron does (block time set to c + 300 s), and has two steps:

1. Bids for hour c + 1 h, pilot by pilot. Baseline: each household with a recorded bid for that hour sends
   `placeBid` from its own wallet, in the record's order. Treatment: each such household generates a proof for its
   bid and passes it to the relayer, which orders the proofs by the order policy and sends `placeBidWithProof`.
2. Clearing of hour c - 1 h, for each pilot and run. The operator reads `getBidsByHour`. With bids and recorded
   asks it calls `placeAsksAndClearMarket` with the asks and the bid indices sorted by price; with bids and no asks
   it calls `clearMarket`; with no bids it does nothing.

Cycles run from one hour before the week to its last hour plus one, 170 cycles. Transactions are sent one at a
time and each is mined in its own block.

## 4. Design concepts

- Basic principles: the paired replay protocol of the methodology (section "Replay protocol and tiers").
- Emergence: none is claimed. A round's cost follows from the number of bids it carries.
- Adaptation, objectives, learning, prediction: none. Policies are fixed rules chosen per run.
- Sensing: an agent knows its own trace. In the treatment run it rebuilds its group from public chain events, as a
  household client would.
- Interaction: indirect, through the market. The clearing matches all bids of an hour with that hour's asks.
- Stochasticity: the shuffled order uses a seeded RNG (mulberry32); the seed also fixes the Semaphore identities
  and so the nullifiers. Credential keys and proof randomness differ between executions. The proof bytes then
  differ too, and a private bid's calldata gas can move by a few multiples of 12 (a zero byte costs 4 gas, a
  non-zero byte 16). Transaction hashes and block times also differ; the bids, their order and the nullifiers do not.
- Collectives: the three pilots, each with its own market instance and, in the treatment run, its own group.
- Observation: every transaction is a row of `cost.csv`; every bid is a row of `public_record.csv` (what the chain
  shows) and of `ground_truth.csv` (which household placed it); `summary.md` holds the cost instrument's results.

## 5. Initialization

anvil starts with its genesis three hours before the week and 80 funded development accounts: deployer (market
owner, group admin, admission), operator, relayer, 48 household wallets, 21 location wallets. Both runs' contracts
are deployed and the operator is whitelisted as seller in each market. In the treatment run every configured
household is enrolled before the week, including households with no bid in it: the DSO issues an SD-JWT VC, the
holder presents it with a key-binding nonce tied to its commitment, admission checks it (and its status list
entry) and the commitment is added with `addMember`. Each household client then rebuilds its group from events and
checks the root against the contract.

## 6. Input data

- The field record, `orders.csv` (columns pilot, kind, label, hour, amount_W), extracted from the event logs of the
  three production markets. Rows are in log order, so within a pilot and hour they are in bid index order. The
  week holds 1,150 Danish, 955 Spanish and 1,221 Italian bids, and 115, 255 and 357 asks. The file is read only;
  its labels (household meter ids) appear only in `sim/out/`, which is not tracked.
- The bot's pilot configuration (`simulation-bot/src/config/pilots.ts`), for the household and location lists and
  their order. Read at run time, not copied.
- The bot's fixed price, 5,700,000,000 wei per W (`PRICE_WEI_PER_WATT` default).

## 7. Submodels

- Quantity policy. `deployed`: the recorded amount. The bot bid 50% of the household's positive hourly
  consumption delta, rounded to whole W, so the record is that policy's output. `bucketed`: the recorded amount
  rounded up to the next multiple of STEP (default 100 W), at least STEP, so no bid becomes zero and participation
  does not change. Asks are never bucketed.
- Price policy: the fixed price. The value sent is amount times price, so the market returns no excess.
- Order and timing policy. All bids of a cycle are sent at minute 5 of the hour before the market hour.
  `deployed`: the record's order, which is the order the bot's transactions landed in. `shuffled`: a Fisher-Yates
  shuffle per pilot and hour. The baseline always uses `deployed`; the treatment uses `shuffled` unless ORDER says
  otherwise.
- Private bid: a Semaphore v4 proof with scope keccak256(market, groupId, hour) and message
  keccak256(amount, price, refund), refund = relayer (`client/index.mjs`). The relayer fronts the value.
- Clearing: the bot's rule (`services/asking.ts`, `services/market-cycle.ts`), as in section 3.
- Measurement: execution gas is gasUsed minus the receipt's parent-chain part (zero on anvil); calldata bytes are
  the transaction's input length; the verification subcall is read from a call trace of each private bid.

Departures from the bot: the bot sent bids in concurrent batches of five, so its order was not fixed in advance;
the replay takes the order that landed. Claims, wallet top-ups and the empty transaction the bot sends to move the
L3's clock are not replayed; they are outside the methodology's round of bids and clearings.
