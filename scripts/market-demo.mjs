// End-to-end Milestone 1 path: a mock DSO issues SD-JWT VCs to 48 synthetic households, the admission
// service checks each presentation and adds the household's Semaphore commitment to the market's group,
// then households bid anonymously through a relayer with one proof per market hour, and the hour clears
// with the unchanged COMMUNITAS clearing code.
//
// Env: RPC_URL, MARKET (PrivateEnergyBiddingMarket proxy), PRIVATE_KEY (group admin, relayer and demo seller).
// MODE=enrol | bid | clear | all | revoke. "all" runs enrol, bid and clear and fast-forwards time, so it is for anvil only.
// clear takes HOUR (unix seconds) from the bid output; default is the previous hour.
// revoke takes REVOKE=<meter_id>: the DSO revokes it, admission finds the commitment, the group admin removes it.
// The DSO and admission state of each market is kept in state/ between runs.
import { Group, Identity } from "@semaphore-protocol/core"
import { createPublicClient, createWalletClient, http, defineChain } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { randomInt } from "node:crypto"
import { mkdirSync } from "node:fs"
import { createDso, createHolder, createAdmission, bindingNonce } from "../dso/lib.mjs"
import { marketAbi, semaphoreAbi, rebuildGroup, proveBid, createSender, placePrivateBid, bidScope, removalArgs } from "../client/index.mjs"

const { RPC_URL, MARKET, PRIVATE_KEY, MODE = "all", HOUR, REVOKE } = process.env
const PRICE = 5_700_000_000n // wei per Watt, the COMMUNITAS bot's fixed price (simulation-bot PRICE_WEI_PER_WATT)
const BIDDERS = 12
// Synthetic households: 32 DK, 6 ES, 10 IT, as in the pilots. Identities are derived from fixed strings so a
// later run can rebuild them; real households would keep their own identity secret.
const households = [["DK", 32], ["ES", 6], ["IT", 10]].flatMap(([pilot, n]) =>
  Array.from({ length: n }, (_, i) => ({ community: "COMMUNITAS", pilot, meter_id: `${pilot.toLowerCase()}-meter-${String(i + 1).padStart(2, "0")}` })))
const seed = (h) => `communitas-m1-demo-${h.meter_id}`
const identityOf = (h) => new Identity(seed(h))

const pub = createPublicClient({ transport: http(RPC_URL) })
const chainId = await pub.getChainId()
const chain = defineChain({ id: chainId, name: "target", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } })
const account = privateKeyToAccount(PRIVATE_KEY)
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })
const send = createSender(pub, wallet)
const read = (functionName, args = []) => pub.readContract({ address: MARKET, abi: marketAbi, functionName, args })

const semaphore = await read("semaphore")
const groupId = await read("groupId")

// The mock DSO and the admission service of this market, with their state in state/. Delete the files after
// restarting anvil, or enrol refuses the meters as already enrolled.
const aud = `admission:${MARKET.toLowerCase()}`
const stateDir = new URL("../state/", import.meta.url)
mkdirSync(stateDir, { recursive: true })
async function parties() {
  const file = (party) => new URL(`${chainId}-${MARKET.toLowerCase()}-${party}.json`, stateDir)
  const dso = await createDso(file("dso"))
  const admission = await createAdmission({ dsoPublicJwk: dso.publicJwk, aud, statusListFetcher: () => dso.statusList(), path: file("admission") })
  return { dso, admission }
}

async function enrol() {
  const { dso, admission } = await parties()
  const commitments = []
  for (const h of households) {
    const holder = await createHolder(seed(h))
    const credential = await dso.issue(h, holder.publicJwk)
    const r = admission.challenge()
    const presentation = await holder.present(credential, { nonce: bindingNonce(r, holder.identity.commitment), aud })
    commitments.push((await admission.admit(presentation, holder.identity.commitment, r)).commitment)
  }
  console.log(`DSO issued and admission accepted ${commitments.length} credentials`)
  // insert in random order: a later MemberRemoved event shows a leaf index, which must not follow household order
  for (let i = commitments.length - 1; i > 0; i--) { const j = randomInt(i + 1); [commitments[i], commitments[j]] = [commitments[j], commitments[i]] }
  const tx = await send(semaphore, semaphoreAbi, "addMembers", [groupId, commitments])
  console.log(`addMembers(${commitments.length}) ${tx.hash} execution gas ${tx.exec}, parent-chain data ${tx.l1}`)
}

async function bid() {
  const group = await rebuildGroup(pub, semaphore, groupId)
  const hour = (await read("getCurrentHourTimestamp")) + 3600n
  // the local encoding must match the contract's, or every proof would fail the scope check
  if ((await read("bidScope", [hour])) !== bidScope(MARKET, groupId, hour)) throw new Error("bidScope encoding differs from the contract")
  const refund = account.address // M1: the relayer; M2: a stealth address per bid
  const members = households.filter((h) => group.indexOf(identityOf(h).commitment) >= 0) // revoked ones were removed
  const chosen = members.map((h) => [Math.random(), h]).sort((a, b) => a[0] - b[0]).slice(0, BIDDERS).map(([, h]) => h)
  const bids = []
  for (const h of chosen) {
    const amount = BigInt(randomInt(100, 1500)) // Watts in the hour
    const t = Date.now()
    const proof = await proveBid({ identity: identityOf(h), group, market: MARKET, groupId, hour, amount, price: PRICE, refund })
    bids.push({ amount, proof, ms: Date.now() - t })
  }
  // bids are generated in household order; submit them shuffled so the index does not identify the household
  for (let i = bids.length - 1; i > 0; i--) { const j = randomInt(i + 1); [bids[i], bids[j]] = [bids[j], bids[i]] }
  for (const b of bids) {
    const tx = await placePrivateBid({ send, market: MARKET, hour, amount: b.amount, price: PRICE, refund, proof: b.proof })
    console.log(`bid ${b.amount} W, proof ${b.ms} ms, ${tx.hash}, execution gas ${tx.exec}, parent-chain data ${tx.l1}`)
  }
  const plain = await pub.estimateContractGas({ account, address: MARKET, abi: marketAbi, functionName: "placeBid", args: [hour, 1000n], value: 1000n * PRICE })
  console.log(`for comparison, a plain placeBid estimates at ${plain} gas in total`)

  const again = await proveBid({ identity: identityOf(chosen[0]), group, market: MARKET, groupId, hour, amount: 999n, price: PRICE, refund })
  try {
    await pub.simulateContract({ account, address: MARKET, abi: marketAbi, functionName: "placeBidWithProof", args: [hour, 999n, refund, again], value: 999n * PRICE })
    throw new Error("a second bid by the same household in the same hour was accepted")
  } catch (e) {
    if (!String(e.message).includes("Semaphore__YouAreUsingTheSameNullifierTwice")) throw e
    console.log("second bid by the same household for the same hour: refused (same nullifier)")
  }
  console.log(`HOUR=${hour} (${new Date(Number(hour) * 1000).toISOString()}), clearable after ${new Date(Number(hour + 3600n) * 1000).toISOString()}`)
  return hour
}

async function clear(hour) {
  // Orbit makes a block only when there is a transaction, so on a quiet chain the latest block can predate the end
  // of the hour and the gas estimate reverts with HourNotInPast. An empty transaction moves the chain's clock.
  if ((await pub.getBlock()).timestamp < hour + 3600n) await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: account.address, value: 0n }) })
  const bids = await read("getBidsByHour", [hour])
  const sorted = bids.map((b, i) => [b.price, i]).sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : a[1] - b[1])).map(([, i]) => BigInt(i))
  const total = bids.reduce((s, b) => s + b.amount, 0n)
  const supply = (total * 6n) / 10n // the demo seller offers 60% of demand, so the clearing is partial
  const tx = await send(MARKET, marketAbi, "placeAsksAndClearMarket", [hour, [{ receiver: account.address, amount: supply }], sorted])
  console.log(`cleared hour ${hour}: ${bids.length} private bids, ${total} W demanded, ${supply} W offered, price ${await read("clearingPricePerHour", [hour])} wei/W`)
  console.log(`clear ${tx.hash} execution gas ${tx.exec}, parent-chain data ${tx.l1}`)
  const traded = await pub.getContractEvents({ address: MARKET, abi: marketAbi, eventName: "EnergyTraded", args: { hour }, fromBlock: 0n })
  console.log(`${traded.length} EnergyTraded events; every buyer is the refund address ${account.address}`)
}

// Semaphore 4.14.3 accepts a proof against a past root until that root's creation time plus the group's
// merkleTreeDuration. So the removed household keeps a revocation window: from its removal until the pre-removal
// root expires, at most merkleTreeDuration, and none if the group had not changed for that long before.
async function revoke(meter) {
  const { dso, admission } = await parties()
  dso.revoke(meter)
  const identity = identityOf({ meter_id: meter })
  const group = await rebuildGroup(pub, semaphore, groupId)
  const removals = (await admission.removals(await dso.statusList())).filter((c) => group.indexOf(c) >= 0)
  console.log(`DSO revoked ${meter}; admission found ${removals.length} member(s) with a revoked credential`)
  let old, removedAt
  for (const c of removals) {
    const own = c === identity.commitment
    if (own) old = Group.import(group.export()) // the household's own copy, from before its removal
    const tx = await send(semaphore, semaphoreAbi, "removeMember", removalArgs(group, groupId, c))
    group.removeMember(group.indexOf(c))
    if (own) removedAt = (await pub.getBlock({ blockNumber: (await pub.getTransactionReceipt({ hash: tx.hash })).blockNumber })).timestamp
    console.log(`removeMember ${tx.hash} execution gas ${tx.exec}, parent-chain data ${tx.l1}`)
  }
  if (!old) return console.log(`${meter} was not in the group`)
  const current = await rebuildGroup(pub, semaphore, groupId) // replays MemberRemoved and checks the new root

  const hour = (await read("getCurrentHourTimestamp")) + 3n * 3600n // still in the future after the clock moves below
  const refund = account.address
  const prove = (g) => proveBid({ identity, group: g, market: MARKET, groupId, hour, amount: 500n, price: PRICE, refund })
  const outcome = (proof) =>
    pub.simulateContract({ account, address: MARKET, abi: marketAbi, functionName: "placeBidWithProof", args: [hour, 500n, refund, proof], value: 500n * PRICE })
      .then(() => "accepted", (e) => e.message.match(/Semaphore__\w+/)?.[0] ?? e.shortMessage)
  const expect = async (label, proof, want) => {
    const got = await outcome(proof)
    if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`)
    console.log(`${label}: ${got}`)
  }

  // New root: the household is no longer a leaf, so it has no Merkle path. A tree that still holds it has a root the
  // contract does not know.
  if (current.indexOf(identity.commitment) >= 0) throw new Error("the revoked commitment is still in the group")
  console.log("new root: the household is not a leaf, so it cannot build a proof against it")
  const forged = Group.import(current.export())
  forged.addMember(identity.commitment)
  await expect("proof against the new tree with the household added back", await prove(forged), "Semaphore__MerkleTreeRootIsNotPartOfTheGroup")

  // Old root: accepted until it expires.
  const duration = await pub.readContract({ address: semaphore, abi: semaphoreAbi, functionName: "groups", args: [groupId] })
  const made = (await pub.getContractEvents({ address: semaphore, abi: semaphoreAbi, fromBlock: 0n })).find((l) => l.args.groupId === groupId && l.args.merkleTreeRoot === old.root)
  const createdAt = (await pub.getBlock({ blockHash: made.blockHash })).timestamp
  const expiry = createdAt + duration
  const window = expiry > removedAt ? expiry - removedAt : 0n
  console.log(`pre-removal root created ${createdAt}, valid until ${expiry} (merkleTreeDuration ${duration} s), removal at ${removedAt}: revocation window ${window} s`)
  const stale = await prove(old)
  await expect("proof against the pre-removal root, now", stale, window > 0n ? "accepted" : "Semaphore__MerkleTreeRootIsExpired")
  if (window === 0n) return
  if (chainId !== 31337) return console.log(`accepted until ${new Date(Number(expiry) * 1000).toISOString()}`)
  for (const [t, label, want] of [[expiry, "= expiry", "accepted"], [expiry + 1n, "= expiry + 1 s", "Semaphore__MerkleTreeRootIsExpired"]]) {
    await pub.request({ method: "evm_setNextBlockTimestamp", params: [Number(t)] })
    await pub.request({ method: "evm_mine", params: [] })
    await expect(`proof against the pre-removal root, block time ${label}`, stale, want)
  }
}

if (MODE === "enrol" || MODE === "all") await enrol()
let hour = HOUR ? BigInt(HOUR) : (await read("getCurrentHourTimestamp")) - 3600n
if (MODE === "bid" || MODE === "all") hour = await bid()
if (MODE === "all") { await pub.request({ method: "evm_increaseTime", params: [7200] }); await pub.request({ method: "evm_mine", params: [] }) }
if (MODE === "clear" || MODE === "all") await clear(hour)
if (MODE === "revoke") await revoke(REVOKE)

// snarkjs leaves worker threads open, so exit explicitly
process.exit(0)
