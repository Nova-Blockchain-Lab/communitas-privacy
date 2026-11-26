// Household client for PrivateEnergyBiddingMarket in relayer mode. It rebuilds the market's Semaphore group from
// public chain events, proves one bid per member per market hour, and hands the transaction to a relayer account.
// Used by scripts/market-demo.mjs, the replay in sim/ and the bot's private mode.
import { Group, generateProof } from "@semaphore-protocol/core"
import { parseAbi, keccak256, encodeAbiParameters } from "viem"

const proofT = "(uint256 merkleTreeDepth,uint256 merkleTreeRoot,uint256 nullifier,uint256 message,uint256 scope,uint256[8] points)"
export const marketAbi = parseAbi([
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
  "function whitelistSeller(address,bool)",
  "event BidPlaced(address indexed bidder, uint256 indexed hour, uint256 price, uint256 amount)",
  "event PrivateBidPlaced(uint256 indexed hour, uint256 indexed index, uint256 nullifier)",
  "event EnergyTraded(uint256 indexed hour, address indexed buyer, address indexed seller, uint256 amount, uint256 price)",
  "error PrivateMarket__WrongScope()",
  "error PrivateMarket__WrongMessage()",
  "error Semaphore__YouAreUsingTheSameNullifierTwice()",
  "error Semaphore__InvalidProof()",
  "error Semaphore__MerkleTreeRootIsExpired()",
  "error Semaphore__MerkleTreeRootIsNotPartOfTheGroup()",
  "error EnergyBiddingMarket__HourNotInPast(uint256)",
])
export const semaphoreAbi = parseAbi([
  "function addMembers(uint256,uint256[])",
  "function removeMember(uint256,uint256,uint256[])",
  "function getMerkleTreeRoot(uint256) view returns (uint256)",
  "function groups(uint256) view returns (uint256 merkleTreeDuration)",
  "function updateGroupMerkleTreeDuration(uint256,uint256)",
  "event MemberAdded(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)",
  "event MembersAdded(uint256 indexed groupId, uint256 startIndex, uint256[] identityCommitments, uint256 merkleTreeRoot)",
  "event MemberUpdated(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 newIdentityCommitment, uint256 merkleTreeRoot)",
  "event MemberRemoved(uint256 indexed groupId, uint256 index, uint256 identityCommitment, uint256 merkleTreeRoot)",
])
const groupEvents = semaphoreAbi.filter((x) => x.type === "event")

// Same encodings as the contract's bidScope and bidMessage, computed locally to save two calls per bid.
export const bidScope = (market, groupId, hour) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [market, groupId, hour])))
export const bidMessage = (amount, price, refund) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "address" }], [amount, price, refund])))

// Rebuilds the group from its add, update and remove events, as any household could, and checks the root.
export async function rebuildGroup(pub, semaphore, groupId) {
  const logs = (await pub.getLogs({ address: semaphore, events: groupEvents, fromBlock: 0n })).filter((l) => l.args.groupId === groupId)
  const group = new Group()
  for (const { eventName: e, args: a } of logs) {
    if (e === "MemberAdded") group.addMember(a.identityCommitment)
    else if (e === "MembersAdded") group.addMembers(a.identityCommitments)
    else if (e === "MemberUpdated") group.updateMember(Number(a.index), a.newIdentityCommitment)
    else if (e === "MemberRemoved") group.removeMember(Number(a.index))
  }
  const root = await pub.readContract({ address: semaphore, abi: semaphoreAbi, functionName: "getMerkleTreeRoot", args: [groupId] })
  if (group.size > 0 && group.root !== root) throw new Error(`rebuilt root ${group.root} != on-chain root ${root}`)
  return group
}

// One proof for one bid. The scope fixes the nullifier per member and market hour; the message fixes the bid.
export async function proveBid({ identity, group, market, groupId, hour, amount, price, refund }) {
  const p = await generateProof(identity, group, bidMessage(amount, price, refund), bidScope(market, groupId, hour))
  return { ...p, merkleTreeDepth: BigInt(p.merkleTreeDepth), merkleTreeRoot: BigInt(p.merkleTreeRoot), nullifier: BigInt(p.nullifier), message: BigInt(p.message), scope: BigInt(p.scope), points: p.points.map(BigInt) }
}

// Siblings for Semaphore.removeMember, from a group rebuilt with rebuildGroup.
export const removalArgs = (group, groupId, commitment) => {
  const i = group.indexOf(commitment)
  if (i < 0) throw new Error("commitment is not a member")
  return [groupId, commitment, group.generateMerkleProof(i).siblings]
}

// Sends a transaction and returns execution gas and the parent-chain data part separately. Orbit charges the
// parent-chain data fee as L3 gas, so fixed limits fail; use the node's estimate plus 30%.
export function createSender(pub, wallet) {
  return async function send(address, abi, functionName, args, value) {
    const gas = await pub.estimateContractGas({ account: wallet.account, address, abi, functionName, args, value })
    const hash = await wallet.writeContract({ address, abi, functionName, args, value, gas: (gas * 13n) / 10n })
    await pub.waitForTransactionReceipt({ hash })
    const raw = await pub.request({ method: "eth_getTransactionReceipt", params: [hash] })
    if (raw.status !== "0x1") throw new Error(`${functionName} reverted: ${hash}`)
    const l1 = BigInt(raw.gasUsedForL1 ?? 0)
    return { hash, exec: BigInt(raw.gasUsed) - l1, l1 }
  }
}

// Places a relayed private bid: the relayer pays amount * price and is the refund address in M1.
export async function placePrivateBid({ send, market, hour, amount, price, refund, proof }) {
  return send(market, marketAbi, "placeBidWithProof", [hour, amount, refund, proof], amount * price)
}
