// End-to-end check of HourlyGate: 48 test households join the group, one proves membership
// for the current hour, and a second proof by the same household in that hour is refused.
// Env: RPC_URL, GATE, PRIVATE_KEY (group admin, also used as relayer for this demo).
import { Identity, Group, generateProof } from "@semaphore-protocol/core"
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, defineChain } from "viem"
import { privateKeyToAccount } from "viem/accounts"

const { RPC_URL, GATE, PRIVATE_KEY } = process.env
const N = 48 // pilot households: 32 DK + 6 ES + 10 IT

const gateAbi = parseAbi([
  "function semaphore() view returns (address)",
  "function groupId() view returns (uint256)",
  "function epoch() view returns (uint256)",
  "function scope(uint256) view returns (uint256)",
  "function addMembers(uint256[])",
  "function act((uint256 merkleTreeDepth,uint256 merkleTreeRoot,uint256 nullifier,uint256 message,uint256 scope,uint256[8] points))",
  "error WrongScope()",
  "error Semaphore__YouAreUsingTheSameNullifierTwice()",
  "error Semaphore__InvalidProof()",
  "error Semaphore__MerkleTreeRootIsExpired()",
])
const semAbi = parseAbi([
  "function getMerkleTreeSize(uint256) view returns (uint256)",
  "function getMerkleTreeRoot(uint256) view returns (uint256)",
])

const pub = createPublicClient({ transport: http(RPC_URL) })
const chain = defineChain({ id: await pub.getChainId(), name: "target", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } })
const account = privateKeyToAccount(PRIVATE_KEY)
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })
const read = (functionName, args = []) => pub.readContract({ address: GATE, abi: gateAbi, functionName, args })
// Orbit charges the parent-chain data fee as L3 gas, so fixed limits fail; use the node's estimate plus 30%.
const send = async (functionName, args) => {
  const gas = await pub.estimateContractGas({ account, address: GATE, abi: gateAbi, functionName, args })
  return wallet.writeContract({ address: GATE, abi: gateAbi, functionName, args, gas: (gas * 13n) / 10n })
}

// Deterministic test identities, so reruns rebuild the same group. Not real households.
const ids = Array.from({ length: N }, (_, i) => new Identity(`communitas-demo-household-${i}`))
const group = new Group(ids.map((id) => id.commitment))

const semaphore = await read("semaphore")
const groupId = await read("groupId")
const size = await pub.readContract({ address: semaphore, abi: semAbi, functionName: "getMerkleTreeSize", args: [groupId] })
if (size === 0n) {
  const hash = await send("addMembers", [ids.map((id) => id.commitment)])
  const r = await pub.waitForTransactionReceipt({ hash })
  console.log(`addMembers(${N}) tx ${hash} status ${r.status} gasUsed ${r.gasUsed}`)
}
const root = await pub.readContract({ address: semaphore, abi: semAbi, functionName: "getMerkleTreeRoot", args: [groupId] })
if (root !== group.root) throw new Error(`on-chain root ${root} != local root ${group.root}`)

const epoch = await read("epoch")
const scope = await read("scope", [epoch])
const me = ids[7] // any member; the chain cannot tell which
const bid = (n) => BigInt(keccak256(toHex(`bid:epoch=${epoch}:price=120:qty=1500:n=${n}`)))

const toArg = (p) => ({ ...p, merkleTreeDepth: BigInt(p.merkleTreeDepth), merkleTreeRoot: BigInt(p.merkleTreeRoot), nullifier: BigInt(p.nullifier), message: BigInt(p.message), scope: BigInt(p.scope), points: p.points.map(BigInt) })

let t = Date.now()
const proof = toArg(await generateProof(me, group, bid(1), scope))
console.log(`epoch ${epoch}, depth ${proof.merkleTreeDepth}, proof generated in ${Date.now() - t} ms`)
const hash = await send("act", [proof])
const r = await pub.waitForTransactionReceipt({ hash })
console.log(`act tx ${hash} status ${r.status} gasUsed ${r.gasUsed} nullifier ${proof.nullifier}`)
if (r.status !== "success") process.exit(1)

// Same household, same hour, different bid: must be refused (same nullifier).
const again = toArg(await generateProof(me, group, bid(2), scope))
if (again.nullifier !== proof.nullifier) throw new Error("nullifier should be fixed within an epoch")
try {
  await pub.simulateContract({ account, address: GATE, abi: gateAbi, functionName: "act", args: [again] })
  throw new Error("second proof in the same epoch was accepted")
} catch (e) {
  if (!String(e.message).includes("Semaphore__YouAreUsingTheSameNullifierTwice")) throw e
  console.log("second proof in the same epoch: refused (Semaphore__YouAreUsingTheSameNullifierTwice)")
}
// A different household in the same hour gets its own nullifier.
const other = toArg(await generateProof(ids[8], group, bid(3), scope))
console.log(`different household, same epoch: distinct nullifier ${other.nullifier !== proof.nullifier}`)
process.exit(0)
