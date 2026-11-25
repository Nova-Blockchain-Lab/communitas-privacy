// End-to-end Milestone 1 path: a mock DSO issues SD-JWT VCs to 48 synthetic households, the admission
// service checks each presentation and adds the household's Semaphore commitment to the market's group,
// then households bid anonymously through a relayer with one proof per market hour, and the hour clears
// with the unchanged COMMUNITAS clearing code.
//
// Env: RPC_URL, MARKET (PrivateEnergyBiddingMarket proxy), PRIVATE_KEY (group admin, relayer and demo seller).
// MODE=enrol | bid | clear | all. "all" runs everything and fast-forwards time, so it is for anvil only.
// clear takes HOUR (unix seconds) from the bid output; default is the previous hour.
import { Group, Identity, generateProof } from "@semaphore-protocol/core"
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, defineChain } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { randomInt } from "node:crypto"
import { createDso, createHolder, createAdmission, bindingNonce } from "../dso/lib.mjs"

const { RPC_URL, MARKET, PRIVATE_KEY, MODE = "all", HOUR } = process.env
const PRICE = 5_700_000_000n // wei per Watt, the COMMUNITAS bot's fixed price (simulation-bot PRICE_WEI_PER_WATT)
const BIDDERS = 12
// Synthetic households: 32 DK, 6 ES, 10 IT, as in the pilots. Identities are derived from fixed strings so a
// later run can rebuild them; real households would keep their own identity secret.
const households = [["DK", 32], ["ES", 6], ["IT", 10]].flatMap(([pilot, n]) =>
  Array.from({ length: n }, (_, i) => ({ community: "COMMUNITAS", pilot, meter_id: `${pilot.toLowerCase()}-meter-${String(i + 1).padStart(2, "0")}` })))
const seed = (h) => `communitas-m1-demo-${h.meter_id}`
const identityOf = (h) => new Identity(seed(h))

const proofT = "(uint256 merkleTreeDepth,uint256 merkleTreeRoot,uint256 nullifier,uint256 message,uint256 scope,uint256[8] points)"
const marketAbi = parseAbi([
  "function semaphore() view returns (address)",
  "function groupId() view returns (uint256)",
  "function getCurrentHourTimestamp() view returns (uint256)",
  "function bidScope(uint256) view returns (uint256)",
  "function bidMessage(uint256,uint256,address) pure returns (uint256)",
  `function placeBidWithProof(uint256,uint256,address,${proofT}) payable`,
  "function placeBid(uint256,uint256) payable",
  "function getBidsByHour(uint256) view returns ((address bidder,uint88 amount,bool settled,uint88 price,bool canceled)[])",
  "function placeAsksAndClearMarket(uint256,(address receiver,uint88 amount)[],uint256[])",
  "function clearingPricePerHour(uint256) view returns (uint256)",
  "function claimableBalance(address) view returns (uint256)",
  "event EnergyTraded(uint256 indexed hour, address indexed buyer, address indexed seller, uint256 amount, uint256 price)",
  "error PrivateMarket__WrongScope()",
  "error PrivateMarket__WrongMessage()",
  "error Semaphore__YouAreUsingTheSameNullifierTwice()",
  "error Semaphore__InvalidProof()",
])
const semAbi = parseAbi(["function addMembers(uint256,uint256[])", "function getMerkleTreeRoot(uint256) view returns (uint256)"])
const membersAdded = parseAbiItem("event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)")

const pub = createPublicClient({ transport: http(RPC_URL) })
const chain = defineChain({ id: await pub.getChainId(), name: "target", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } })
const account = privateKeyToAccount(PRIVATE_KEY)
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })
const read = (functionName, args = [], address = MARKET, abi = marketAbi) => pub.readContract({ address, abi, functionName, args })
// Orbit charges the parent-chain data fee as L3 gas, so fixed limits fail; use the node's estimate plus 30%.
async function send(functionName, args, { address = MARKET, abi = marketAbi, value } = {}) {
  const gas = await pub.estimateContractGas({ account, address, abi, functionName, args, value })
  const hash = await wallet.writeContract({ address, abi, functionName, args, value, gas: (gas * 13n) / 10n })
  await pub.waitForTransactionReceipt({ hash })
  // Arbitrum receipts split gasUsed into execution and the parent-chain data part (gasUsedForL1).
  const raw = await pub.request({ method: "eth_getTransactionReceipt", params: [hash] })
  if (raw.status !== "0x1") throw new Error(`${functionName} reverted: ${hash}`)
  const l1 = BigInt(raw.gasUsedForL1 ?? 0)
  return { hash, exec: BigInt(raw.gasUsed) - l1, l1 }
}
const toArg = (p) => ({ ...p, merkleTreeDepth: BigInt(p.merkleTreeDepth), merkleTreeRoot: BigInt(p.merkleTreeRoot), nullifier: BigInt(p.nullifier), message: BigInt(p.message), scope: BigInt(p.scope), points: p.points.map(BigInt) })

const semaphore = await read("semaphore")
const groupId = await read("groupId")

async function enrol() {
  const dso = await createDso()
  const aud = `admission:${MARKET.toLowerCase()}`
  const admission = await createAdmission({ dsoPublicJwk: dso.publicJwk, aud })
  const commitments = []
  for (const h of households) {
    const holder = await createHolder(seed(h))
    const credential = await dso.issue(h, holder.publicJwk)
    const r = admission.challenge()
    const presentation = await holder.present(credential, { nonce: bindingNonce(r, holder.identity.commitment), aud })
    commitments.push((await admission.admit(presentation, holder.identity.commitment, r)).commitment)
  }
  console.log(`DSO issued and admission accepted ${commitments.length} credentials`)
  const tx = await send("addMembers", [groupId, commitments], { address: semaphore, abi: semAbi })
  console.log(`addMembers(${commitments.length}) ${tx.hash} execution gas ${tx.exec}, parent-chain data ${tx.l1}`)
}

// The client rebuilds the group from public events, as any household could, and checks the root.
async function rebuildGroup() {
  const logs = await pub.getLogs({ address: semaphore, event: membersAdded, args: { groupId }, fromBlock: 0n })
  const group = new Group(logs.flatMap((l) => l.args.identityCommitments))
  const root = await read("getMerkleTreeRoot", [groupId], semaphore, semAbi)
  if (group.root !== root) throw new Error(`rebuilt root ${group.root} != on-chain root ${root}`)
  return group
}

async function bid() {
  const group = await rebuildGroup()
  const hour = (await read("getCurrentHourTimestamp")) + 3600n
  const scope = await read("bidScope", [hour])
  const refund = account.address // M1: the relayer; M2: a stealth address per bid
  const chosen = households.map((h) => [Math.random(), h]).sort((a, b) => a[0] - b[0]).slice(0, BIDDERS).map(([, h]) => h)
  const bids = []
  for (const h of chosen) {
    const amount = BigInt(randomInt(100, 1500)) // Watts in the hour
    const message = await read("bidMessage", [amount, PRICE, refund])
    const t = Date.now()
    const proof = toArg(await generateProof(identityOf(h), group, message, scope))
    bids.push({ amount, proof, ms: Date.now() - t })
  }
  // bids are generated in household order; submit them shuffled so the index does not identify the household
  for (let i = bids.length - 1; i > 0; i--) { const j = randomInt(i + 1); [bids[i], bids[j]] = [bids[j], bids[i]] }
  for (const b of bids) {
    const tx = await send("placeBidWithProof", [hour, b.amount, refund, b.proof], { value: b.amount * PRICE })
    console.log(`bid ${b.amount} W, proof ${b.ms} ms, ${tx.hash}, execution gas ${tx.exec}, parent-chain data ${tx.l1}`)
  }
  const plain = await pub.estimateContractGas({ account, address: MARKET, abi: marketAbi, functionName: "placeBid", args: [hour, 1000n], value: 1000n * PRICE })
  console.log(`for comparison, a plain placeBid estimates at ${plain} gas in total`)

  const again = toArg(await generateProof(identityOf(chosen[0]), group, await read("bidMessage", [999n, PRICE, refund]), scope))
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
  const tx = await send("placeAsksAndClearMarket", [hour, [{ receiver: account.address, amount: supply }], sorted])
  console.log(`cleared hour ${hour}: ${bids.length} private bids, ${total} W demanded, ${supply} W offered, price ${await read("clearingPricePerHour", [hour])} wei/W`)
  console.log(`clear ${tx.hash} execution gas ${tx.exec}, parent-chain data ${tx.l1}`)
  const traded = await pub.getContractEvents({ address: MARKET, abi: marketAbi, eventName: "EnergyTraded", args: { hour }, fromBlock: 0n })
  console.log(`${traded.length} EnergyTraded events; every buyer is the refund address ${account.address}`)
}

if (MODE === "enrol" || MODE === "all") await enrol()
let hour = HOUR ? BigInt(HOUR) : (await read("getCurrentHourTimestamp")) - 3600n
if (MODE === "bid" || MODE === "all") hour = await bid()
if (MODE === "all") { await pub.request({ method: "evm_increaseTime", params: [7200] }); await pub.request({ method: "evm_mine", params: [] }) }
if (MODE === "clear" || MODE === "all") await clear(hour)

// snarkjs leaves worker threads open, so exit explicitly
process.exit(0)
