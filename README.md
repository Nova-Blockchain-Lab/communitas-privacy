# communitas-privacy

Privacy layer for the COMMUNITAS energy market on the Nova Cidade L3 (EF PhD Fellowship FY26-2499,
Milestone 1). A household proves it belongs to the community's Semaphore v4 group without revealing
which member it is, and can act at most once per hourly market epoch.

## Files

- `src/HourlyGate.sol`: owns one Semaphore group; `act(proof)` accepts a proof only if its scope is
  `keccak256(groupId, block.timestamp / 1 hours)`, so the nullifier is fixed within an hour.
- `script/Deploy.s.sol`: deploys `SemaphoreVerifier`, `Semaphore` (official v4.14.3 contracts) and `HourlyGate`.
- `scripts/prove.mjs`: adds 48 deterministic test identities (not real households), generates one proof
  for the current hour, submits it, and checks that a second proof by the same identity in that hour is refused.
- `test/HourlyGate.t.sol`: admin and scope checks. Real proofs are covered by `prove.mjs`.
- `src/PrivateEnergyBiddingMarket.sol`: the COMMUNITAS `EnergyBiddingMarket` (unchanged, from the
  `lib/energy-bidding-market` submodule at commit 166f062) plus `placeBidWithProof(hour, amount, refund, proof)`.
  The proof's scope is `keccak256(market, groupId, hour)`, so one bid per member per market hour; its message
  is `keccak256(amount, price, refund)`, so the relayer cannot change the bid. The bid is stored with `refund`
  as bidder, so refunds and claims go there (the relayer in M1, a stealth address in M2). Asks stay whitelisted.
- `client/index.mjs`: the household client in relayer mode, used by the demo, the replay and the bot's private
  mode (`communitas-privacy/client` in package exports). `rebuildGroup` replays the group's add, update and
  remove events and checks the root; `proveBid` builds the proof with the contract's scope and message
  encodings, computed locally; `removalArgs` gives the siblings for `removeMember`; `createSender` sends with the
  node's estimate plus 30% and splits execution gas from the parent-chain data part.
- `script/DeployPrivateMarket.s.sol`: new market proxy and a new Semaphore group whose admin is the deployer
  (the admission service). Reuses `SEMAPHORE` if set.
- `test/PrivateEnergyBiddingMarket.t.sol`: scope, message, nullifier, root and refund checks, and a full
  clearing, with a verifier that accepts every zk proof. Real proofs are covered by `market-demo.mjs`.
- `scripts/market-demo.mjs`: the whole M1 path. DSO issuance and admission for 48 synthetic households,
  `addMembers`, the client rebuilding the group from `MembersAdded` events, 12 anonymous bids in shuffled
  order through one relayer, a refused second bid in the same hour, then the clearing. `MODE=revoke
  REVOKE=<meter_id>`: the DSO revokes the meter, admission maps the status list to commitments, the group
  admin calls `removeMember` with siblings from the group rebuilt from events, and the script checks that the
  household cannot prove against the new root and for how long a proof against the pre-removal root is still
  accepted. The DSO and admission state of each market is kept in `state/` (gitignored) between runs.
- `dso/lib.mjs`: off-chain enrolment. A mock DSO issues an SD-JWT VC (ES256, `vct`
  `urn:communitas:dso:household:1`, `pilot` and `meter_id` selectively disclosable, holder P-256 key in
  `cnf.jwk`). The admission service checks the presentation and its KB-JWT, whose nonce is
  `hex(SHA-256(r || C))` for its challenge `r` and the Semaphore commitment `C`, refuses a second
  enrolment of the same `meter_id`, and returns `{ commitment, pilot }` for `addMembers`.
  Revocation follows the Token Status List draft (draft-ietf-oauth-status-list-21). Each credential carries
  `status.status_list` `{ idx, uri }` with a random index into a list of 4,096. `revoke(meter_id)` sets the bit
  of the meter's credentials; `statusList()` returns the signed Status List Token (`typ` `statuslist+jwt`,
  1 bit per credential, ZLIB, base64url, `exp` 5 minutes after `iat`), encoded with `@owf/token-status-list`
  0.8.0, the package `@sd-jwt/sd-jwt-vc` 0.25.0 uses for its own status check (`@sd-jwt/jwt-status-list` is
  deprecated in its favour). At admission the library fetches the token, checks its signature against the
  pinned DSO key and refuses a revoked credential, or one without `status`. Admission keeps
  `meter_id -> { commitment, idx, uri }`; `removals(token)` checks a token the same way and returns the
  commitments of enrolled households whose bit is set. `createDso(path)` and `createAdmission({ path })` keep
  their state in a JSON file when given a path.
- `dso/selftest.mjs`: issues to and admits 48 synthetic households (32 DK, 6 ES, 10 IT), then checks that
  double enrolment, a nonce for another commitment, a foreign DSO key, a foreign holder key, an expired
  credential, a wrong audience and a reused challenge are refused. Revocation: a revoked credential, a status
  list signed by another key and a tampered status list are refused at admission; `removals()` returns only
  the revoked household's commitment and refuses a foreign or tampered list; DSO and admission state survive a
  reload.
- `sim/replay.mjs`: replays the recorded week (3 to 10 Nov 2026, 168 rounds, three pilots) as a pair of runs on
  its own anvil: baseline `EnergyBiddingMarket` with one wallet per household, treatment
  `PrivateEnergyBiddingMarket` with every configured household enrolled through `dso/lib.mjs` and bids relayed
  with proofs in shuffled order. One agent per household, replaying its recorded quantities. Writes
  `sim/out/public_record.csv`, `ground_truth.csv` (which household placed each bid), `cost.csv` (every
  transaction) and `summary.md` (the cost instrument). `sim/out/` is not tracked: the input's labels are meter ids.
- `sim/ODD.md`: the replay described in the ODD protocol.
- `attacks/run.py`: the methodology's adversarial instrument (standard library Python). Behaviour pattern
  matching after Jawurek et al. 2011 and intersection after Danezis and Serjantov 2004, composed, at three
  knowledge levels, with a positive control on the baseline record; reports Shannon entropy, min-entropy and
  recovery rate per bid over rounds 1 to 168. `--simulate` builds a treatment record from the field record
  without a chain. `attacks/test_attacks.py` is the self-check. Details in `attacks/README.md`.

## Commands

```
git clone --recursive <this repo> && cd communitas-privacy
npm install && forge test
node dso/selftest.mjs   # credential issuance and admission, off-chain

# private market on anvil (anvil --port 8546)
DEPLOYER_PRIVATE_KEY=<anvil key> forge script script/DeployPrivateMarket.s.sol:DeployPrivateMarket --rpc-url http://127.0.0.1:8546 --broadcast
RPC_URL=http://127.0.0.1:8546 MARKET=<proxy> PRIVATE_KEY=<anvil key> MODE=all node scripts/market-demo.mjs
RPC_URL=http://127.0.0.1:8546 MARKET=<proxy> PRIVATE_KEY=<anvil key> MODE=revoke REVOKE=dk-meter-01 node scripts/market-demo.mjs
# after restarting anvil, delete state/: the proxy address repeats and enrol would refuse every meter as already enrolled

# private market on the Nova Cidade L3 (.env holds DEPLOYER_PRIVATE_KEY and RPC_URL)
set -a && . ./.env && set +a
SEMAPHORE=0xC327b3A6d85618D30dC3263E95beFB40485a27C7 forge script script/DeployPrivateMarket.s.sol:DeployPrivateMarket --rpc-url $RPC_URL --broadcast --gas-estimate-multiplier 100000 --slow
export MARKET=<proxy> PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY
MODE=enrol node scripts/market-demo.mjs
MODE=bid node scripts/market-demo.mjs                  # bids for the next hour, prints HOUR
MODE=clear HOUR=<HOUR> node scripts/market-demo.mjs    # once HOUR + 1 h has passed
MODE=revoke REVOKE=<meter_id> node scripts/market-demo.mjs   # needs state/ from MODE=enrol on this machine

# replay of the recorded week and cost instrument (runs forge build, starts and stops its own anvil on port 8547)
node sim/replay.mjs
# env: ORDERS, PILOTS_TS (default: ../28thjunepaper/... and ../simulation-bot/... beside this repo),
# WEEK_START=1793664000 ROUNDS=168 QUANTITY=deployed|bucketed STEP=100 ORDER=shuffled|deployed SEED=1 PORT=8547 OUT=sim/out/
QUANTITY=bucketed OUT=sim/out/bucketed/ node sim/replay.mjs   # mitigation scenario
cd attacks && python3 test_attacks.py && python3 run.py --record ../sim/out/public_record.csv --truth ../sim/out/ground_truth.csv --out out/replay

# HourlyGate (9 Oct)
forge script script/Deploy.s.sol:DeployScript --rpc-url $RPC_URL --broadcast --gas-estimate-multiplier 100000 --slow
GATE=<gate> PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY node scripts/prove.mjs
```

Orbit charges the parent-chain data fee as L3 gas units, so fixed gas limits fail with "intrinsic gas
too low". The scripts use the node's estimate plus 30%; `forge script` needs the large multiplier.

## Deployments, Nova Cidade L3 (chain 93735000855)

All verified on https://testnet.explorer.novaims.unl.pt/. Deployer, group admin and relayer:
`0xc2C772910da01cC5f04BE9bADa70805d804d9Bf4` (dedicated key, funded with 0.05 ETH from the market deployer).

| Contract | Address | Date |
|---|---|---|
| PoseidonT3 (library) | `0x4Ff06215ae5dD999DdC5A527297cd5fFF2a56d8d` | 9 Oct 2026 |
| SemaphoreVerifier | `0x91930Aa2A71478B2Ba3fc8Bfc11eE19AF8EcBe44` | 9 Oct 2026 |
| Semaphore (v4.14.3) | `0xC327b3A6d85618D30dC3263E95beFB40485a27C7` | 9 Oct 2026 |
| HourlyGate (group 0) | `0x3e8064298414925850a8dE50690D21874f3A43C4` | 9 Oct 2026 |
| PrivateEnergyBiddingMarket, implementation | `0x6fcb00b982148b0ebfc72ee5025c46392d2b00e0` | 25 Nov 2026 |
| PrivateEnergyBiddingMarket, proxy (group 1) | `0x8b644c96333131b75e5dd5a647dbc4920244e9f6` | 25 Nov 2026 |
| PrivateEnergyBiddingMarket, implementation | `0xDCEC0BD19Ea44361Ee46d2342370512CAd98b9Cd` | 26 Nov 2026 |
| PrivateEnergyBiddingMarket, proxy (group 2, revocation run) | `0x197216874ADc0b818e9a0Bc8044eE9f9661c929f` | 26 Nov 2026 |

The 25 Nov implementation was compiled against a local checkout of the market repository and of
OpenZeppelin 5.5.0 before they became submodules here. The sources are byte-identical. A build from
this repository differs in 158 hex characters of bytecode because the import paths changed; the
verified sources are on the explorer.

## Measurements

L3 gas price 0.0001 gwei. Execution gas is the same on anvil and on the L3; the parent-chain data
part depends on the L1 pricer at the time.

| Step | Execution gas | Parent-chain data (L3 gas units) | Cost on the L3 |
|---|---|---|---|
| 9 Oct, `addMembers`, 48 identities | 2,918,480 | 20,223,836 | 0.0000023 ETH |
| 9 Oct, `HourlyGate.act`, one proof, depth 6 | 291,185 | 6,306,736 | 0.00000066 ETH |
| 25 Nov, `addMembers`, 48 enrolled households | 2,914,740 | 1,686,237 | 0.00000046 ETH |
| 25 Nov, `placeBidWithProof` (11 of 12 bids; the first bid of an hour costs 374,621) | 357,473 to 357,533 | 614,664 | 0.000000097 ETH |
| 25 Nov, plain `placeBid`, for comparison (node estimate, total) | about 83,000 on anvil | | 316,852 L3 gas units in total |
| 25 Nov, `placeAsksAndClearMarket`, 12 private bids, one ask, 8 trades | 372,780 | 288,511 | 0.000000066 ETH |
| 25 Nov, `removeMember`, one of 48 members (anvil; depends on the leaf's position) | 393,072 to 459,889 | | |
| 26 Nov, `addMembers`, 48 enrolled households, group 2 | 2,914,740 | 1,680,686 | 0.00000046 ETH |
| 26 Nov, `removeMember`, one revoked household, group 2 | 457,657 | 422,808 | 0.000000088 ETH |
| 26 Nov, `placeAsksAndClearMarket`, 12 private bids, one ask, 9 trades | 376,003 | 279,411 | 0.000000066 ETH |

A private bid costs about 274,000 execution gas more than a plain bid: the Groth16 verification, the
nullifier and the extra event. Proof generation takes about 0.1 s (about 2 s on the first run,
including the download of the depth-6 artifacts).

Transactions, 25 Nov: addMembers `0x79d878a8d5a7e7143d3eeefe77742e1d4402cba07f2325b8c3a08d3ed793eb0e`;
12 bids for the hour 2026-11-25 21:00 UTC, for example `0x93ff4403494a9f2311cc57f190593c5dcb2a4b9173cb417f6f23854b30bd2e88`;
clearing of that hour (11,648 W demanded, 6,988 W offered, 8 `EnergyTraded` events)
`0xfa20993eedf0e9896d6f05623645dfe954dd894e8e5efc47624900948300d078`.
9 Oct: addMembers `0xbc23ae713ab00d7e71e8fc75d4256d62b0ef560a7324739dbf83070c1855baa4`, proof
`0x97bf5c257094460ec9c7fc84f7b8021a25c76228839f65713b33497cadd127a4` (epoch 497651).
26 Nov, market 2: addMembers `0x859a9c4dfe91c5e6f01254c5c280d1bd6e5a028dc27d9d14b6a16b73b89b055e`; 12 bids for the hour
2026-11-26 00:00 UTC; removal of `es-meter-03` after the DSO revoked it
`0x9dec094174d8163e5251d9557395034b17ab04e1e42babe22a6f7cc4c03d94f4`; clearing of that hour (9,949 W demanded,
5,969 W offered, 9 trades) `0xed8f9d568b56b4bb1577464b45c042f8f582a619c2b1762d5539a13c0973aec6`.

Revocation window. Semaphore 4.14.3 accepts a proof against a past root until that root's creation time plus
the group's `merkleTreeDuration`, which `createGroup(admin)` sets to 1 hour. A removed household can therefore
still bid with a proof against the pre-removal root until that root expires: the window is
`max(0, created + duration - removal)`, one hour at most, and zero if the group had not changed for an hour
before the removal. On anvil (25 Nov), removing `dk-meter-01` two hours after `addMembers` left 0 s: the
old-root proof was refused at once with `MerkleTreeRootIsExpired`. A second removal right after left 3,594 s
(6 s later) and 3,600 s (same second) in two runs: the old-root proof was accepted at block time equal to the
expiry and refused one second later. In every run a tree with the household added back was refused with
`MerkleTreeRootIsNotPartOfTheGroup`. On the L3 (26 Nov) the removal came 7 s after enrolment, so the window was
3,593 s; at 01:01 UTC, after the root expired, the household's proof against it was refused with
`MerkleTreeRootIsExpired`.

## Replay week (3 to 10 Nov 2026), on anvil

3,326 bids and 495 clearings per run; the baseline matches the field record in 504 of 504 pilot-hours. Against
the methodology's thresholds: execution gas per round, treatment over baseline, median 3.07 (O1a, 5); bytes per
round, median 4.43 (O1b, 10); one `validateProof` transaction 285,907 gas (O2, 300,000); verification per round at
most 8.5M (O2, 15M); enrolment 62,000 to 82,000 gas per household in one `addMembers` per pilot, but 163,463
(median) one `addMember` at a time (O2, 150,000). A private bid is 516 bytes of calldata against 68.

Bits left per bid at round 168 against the public record plus the field record from before the layer
(composed attacks, O3): Spain 1.87 of 2.58 (threshold 1.3), Italy 1.96 of 3.32 (1.7). Denmark is not assessable:
on the record without the layer the attacks name only 48% of Danish bids, so they fail their positive control.
Bid quantity is the channel that costs the most bits; submission order is at chance once the relayer shuffles.

## Limits

- The 48 households are synthetic (32 DK, 6 ES, 10 IT, as in the pilots). Their Semaphore identities
  are derived from fixed strings so the demo can be rerun; real households would hold their own secret.
- One relayer submits and funds every bid, and is the refund address. This removes the link between
  a bid and a household wallet on chain; the operator, who funds the relayer and runs admission, still
  knows which household enrolled which commitment (custodial assumption). Stealth refund addresses are M2.
- Asks stay whitelisted per location. Seller anonymity is out of scope at 2 to 10 locations per pilot.
- Revocation reaches the market only when the group admin runs the removal (`MODE=revoke`); there is no
  periodic re-check of the status list. After `removeMember` the household keeps a revocation window of up
  to one hour (`merkleTreeDuration`) in which a proof against the pre-removal root is still accepted.
- Bid quantities are public, and the meter platform that produced them can match them to households
  unless they are bucketed. They are also the main leak against the public (see the replay results).
- A bid's hour has no upper limit, so whoever holds a household's identity secret can bid once for every future
  hour until the household is removed; bids placed before a removal stay valid.
- The replay week ran on a local node. The L3 runs are single rounds.
- The DSO and admission state are JSON files, rewritten on every change; open admission challenges are lost on
  restart. The mock DSO's private key is in its state file.
