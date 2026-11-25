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
- `script/DeployPrivateMarket.s.sol`: new market proxy and a new Semaphore group whose admin is the deployer
  (the admission service). Reuses `SEMAPHORE` if set.
- `test/PrivateEnergyBiddingMarket.t.sol`: scope, message, nullifier, root and refund checks, and a full
  clearing, with a verifier that accepts every zk proof. Real proofs are covered by `market-demo.mjs`.
- `scripts/market-demo.mjs`: the whole M1 path. DSO issuance and admission for 48 synthetic households,
  `addMembers`, the client rebuilding the group from `MembersAdded` events, 12 anonymous bids in shuffled
  order through one relayer, a refused second bid in the same hour, then the clearing.
- `dso/lib.mjs`: off-chain enrolment. A mock DSO issues an SD-JWT VC (ES256, `vct`
  `urn:communitas:dso:household:1`, `pilot` and `meter_id` selectively disclosable, holder P-256 key in
  `cnf.jwk`). The admission service checks the presentation and its KB-JWT, whose nonce is
  `hex(SHA-256(r || C))` for its challenge `r` and the Semaphore commitment `C`, refuses a second
  enrolment of the same `meter_id`, and returns `{ commitment, pilot }` for `addMembers`.
  Revocation through a Token Status List is the next step; it is not implemented.
- `dso/selftest.mjs`: issues to and admits 48 synthetic households (32 DK, 6 ES, 10 IT), then checks that
  double enrolment, a nonce for another commitment, a foreign DSO key, a foreign holder key, an expired
  credential, a wrong audience and a reused challenge are refused.

## Commands

```
git clone --recursive <this repo> && cd communitas-privacy
npm install && forge test
node dso/selftest.mjs   # credential issuance and admission, off-chain

# private market on anvil (anvil --port 8546)
DEPLOYER_PRIVATE_KEY=<anvil key> forge script script/DeployPrivateMarket.s.sol:DeployPrivateMarket --rpc-url http://127.0.0.1:8546 --broadcast
RPC_URL=http://127.0.0.1:8546 MARKET=<proxy> PRIVATE_KEY=<anvil key> MODE=all node scripts/market-demo.mjs

# private market on the Nova Cidade L3 (.env holds DEPLOYER_PRIVATE_KEY and RPC_URL)
set -a && . ./.env && set +a
SEMAPHORE=0xC327b3A6d85618D30dC3263E95beFB40485a27C7 forge script script/DeployPrivateMarket.s.sol:DeployPrivateMarket --rpc-url $RPC_URL --broadcast --gas-estimate-multiplier 100000 --slow
export MARKET=<proxy> PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY
MODE=enrol node scripts/market-demo.mjs
MODE=bid node scripts/market-demo.mjs                  # bids for the next hour, prints HOUR
MODE=clear HOUR=<HOUR> node scripts/market-demo.mjs    # once HOUR + 1 h has passed

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

A private bid costs about 274,000 execution gas more than a plain bid: the Groth16 verification, the
nullifier and the extra event. Proof generation takes about 0.1 s (about 2 s on the first run,
including the download of the depth-6 artifacts).

Transactions, 25 Nov: addMembers `0x79d878a8d5a7e7143d3eeefe77742e1d4402cba07f2325b8c3a08d3ed793eb0e`;
12 bids for the hour 2026-11-25 21:00 UTC, for example `0x93ff4403494a9f2311cc57f190593c5dcb2a4b9173cb417f6f23854b30bd2e88`;
clearing of that hour (11,648 W demanded, 6,988 W offered, 8 `EnergyTraded` events)
`0xfa20993eedf0e9896d6f05623645dfe954dd894e8e5efc47624900948300d078`.
9 Oct: addMembers `0xbc23ae713ab00d7e71e8fc75d4256d62b0ef560a7324739dbf83070c1855baa4`, proof
`0x97bf5c257094460ec9c7fc84f7b8021a25c76228839f65713b33497cadd127a4` (epoch 497651).

## Limits

- The 48 households are synthetic (32 DK, 6 ES, 10 IT, as in the pilots). Their Semaphore identities
  are derived from fixed strings so the demo can be rerun; real households would hold their own secret.
- One relayer submits and funds every bid, and is the refund address. This removes the link between
  a bid and a household wallet on chain; the operator, who funds the relayer and runs admission, still
  knows which household enrolled which commitment (custodial assumption). Stealth refund addresses are M2.
- Asks stay whitelisted per location. Seller anonymity is out of scope at 2 to 10 locations per pilot.
- No revocation yet: the Token Status List check at admission and member removal are the next step.
- Bid quantities are public, and the meter platform that produced them can match them to households
  unless they are bucketed.
- The admission service keeps its state in memory.
