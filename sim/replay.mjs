// Replay of one recorded week of the three COMMUNITAS pilots as a pair of runs on a local anvil (see sim/ODD.md).
// Baseline: EnergyBiddingMarket behind an ERC1967 proxy, one wallet per household, placeBid.
// Treatment: PrivateEnergyBiddingMarket, one Semaphore group per pilot, households enrolled through the mock DSO
// and admission, bids relayed with placeBidWithProof, refund = relayer. Same input, same clock, so rounds pair.
// Writes public_record.csv, ground_truth.csv, cost.csv and summary.md to OUT.
//
// Env: ORDERS (orders.csv), PILOTS_TS (the bot's config/pilots.ts), WEEK_START (unix s), ROUNDS (168),
// QUANTITY (deployed | bucketed), STEP (W, for bucketed), ORDER (treatment order: shuffled | deployed),
// SEED, PORT (8547), OUT (sim/out). Runs forge build, then starts and stops its own anvil on PORT.
import { spawn, execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createPublicClient, http, encodeFunctionData, encodeDeployData, toHex } from "viem"
import { createDso, createHolder, createAdmission, bindingNonce } from "../dso/lib.mjs"
import { rebuildGroup, proveBid, bidScope, placePrivateBid } from "../client/index.mjs"

const t0 = Date.now()
const path = (p) => new URL(p, import.meta.url).pathname
const env = process.env
const ORDERS = env.ORDERS ?? path("../../28thjunepaper/analysis/investigation/orders.csv")
const PILOTS_TS = env.PILOTS_TS ?? path("../../simulation-bot/src/config/pilots.ts")
const WEEK = Number(env.WEEK_START ?? 1793664000)
const ROUNDS = Number(env.ROUNDS ?? 168)
const END = WEEK + ROUNDS * 3600
const QUANTITY = env.QUANTITY ?? "deployed"
const STEP = Number(env.STEP ?? 100)
const ORDER = env.ORDER ?? "shuffled"
const SEED = Number(env.SEED ?? 1)
const PORT = Number(env.PORT ?? 8547)
const OUT = env.OUT ?? path("out/")
const PRICE = 5_700_000_000n // wei per W, the bot's PRICE_WEI_PER_WATT default
const PILOTS = ["danish", "spanish", "italian"]
const RUNS = ["baseline", "treatment"]

// Policies (M1_REVIEW 4.4). Quantity: the record already holds the bot's 50% of the positive delta.
const quantity = { deployed: (w) => w, bucketed: (w) => Math.max(STEP, Math.ceil(w / STEP) * STEP) }[QUANTITY]
const price = () => PRICE // fixed reference price; zero-intelligence pricing is not implemented
if (!quantity || !["shuffled", "deployed"].includes(ORDER)) throw new Error("QUANTITY must be deployed|bucketed, ORDER shuffled|deployed")

// Seeded RNG (mulberry32) for the shuffled order, so a run can be repeated.
let s = SEED >>> 0
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 }
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

// Households and locations in the bot's configured order, read from its source (never copied here).
const cfg = readFileSync(PILOTS_TS, "utf8")
const list = (name, key) => [...cfg.match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\];`))[1].matchAll(new RegExp(`${key}: "([^"]+)"`, "g"))].map((m) => m[1])
const households = Object.fromEntries(PILOTS.map((p) => [p, list(`${p.toUpperCase()}_HOUSEHOLDS`, "componentId")]))
const locations = Object.fromEntries(PILOTS.map((p) => [p, list(`${p.toUpperCase()}_LOCATIONS`, "locationId")]))

// The week's record, kept in row order: within a pilot and hour that is the chain's log order, i.e. bid index.
const book = Object.fromEntries(PILOTS.map((p) => [p, {}]))
const agents = Object.fromEntries(PILOTS.map((p) => [p, Object.fromEntries(households[p].map((label) => [label, { pilot: p, label, trace: new Map() }]))]))
for (const line of readFileSync(ORDERS, "utf8").trim().split("\n").slice(1)) {
  const [p, kind, label, h, w] = line.split(","), hour = Number(h)
  if (hour < WEEK || hour >= END || !book[p]) continue
  const slot = (book[p][hour] ??= { bids: [], asks: [] })
  if (kind === "bid") {
    const a = agents[p][label]
    if (!a || a.trace.has(hour)) throw new Error(`bid row not a configured household, or a second bid in one hour: ${p} ${hour}`)
    a.trace.set(hour, Number(w))
    slot.bids.push(a)
  } else {
    if (!locations[p].includes(label)) throw new Error(`ask row not a configured location: ${p} ${hour}`)
    slot.asks.push({ label, w: Number(w) })
  }
}

// anvil on PORT, genesis three hours before the week so setup lands before the first bids.
const url = `http://127.0.0.1:${PORT}`
const pub = createPublicClient({ transport: http(url) })
const up = () => pub.request({ method: "eth_chainId" }).then(() => true, () => false)
if (await up()) throw new Error(`something already listens on ${url}`)
execFileSync("forge", ["build"], { cwd: path(".."), stdio: "ignore" })
const anvil = spawn("anvil", ["--port", String(PORT), "--timestamp", String(WEEK - 3 * 3600), "--accounts", "80", "--silent"], { stdio: "ignore" })
process.on("exit", () => anvil.kill())
while (!(await up())) await new Promise((r) => setTimeout(r, 100))
const anvilVersion = execFileSync("anvil", ["--version"]).toString().split("\n")[0]

// Accounts: deployer (owner, group admin, admission), operator (whitelisted seller, clears), relayer,
// then one wallet per household and one per location. anvil signs for them.
const accts = await pub.request({ method: "eth_accounts" })
const [D, OPERATOR, RELAYER] = accts
let next = 3
for (const p of PILOTS) for (const label of households[p]) agents[p][label].wallet = accts[next++]
const locWallet = Object.fromEntries(PILOTS.map((p) => [p, Object.fromEntries(locations[p].map((l) => [l, accts[next++]]))]))

const art = (n) => JSON.parse(readFileSync(path(`../out/${n}.sol/${n}.json`)))
const [EBM, PEBM, PROXY, VERIFIER, POSEIDON, SEM] = ["EnergyBiddingMarket", "PrivateEnergyBiddingMarket", "ERC1967Proxy", "SemaphoreVerifier", "PoseidonT3", "Semaphore"].map(art)
const abiOf = { baseline: EBM.abi, treatment: PEBM.abi }

// Every transaction becomes one cost row. Execution gas = gasUsed - gasUsedForL1 (the latter is 0 on anvil).
const cost = []
async function tx(meta, from, to, data, value = 0n) {
  const hash = await pub.request({ method: "eth_sendTransaction", params: [{ from, to, data, value: toHex(value) }] })
  let r
  while (!(r = await pub.request({ method: "eth_getTransactionReceipt", params: [hash] }))) await new Promise((ok) => setTimeout(ok, 5))
  if (r.status !== "0x1") throw new Error(`${meta.function} reverted: ${hash}`)
  const l1 = BigInt(r.gasUsedForL1 ?? 0)
  cost.push({ ...meta, tx_hash: hash, exec_gas: BigInt(r.gasUsed) - l1, l1_gas: l1, calldata_bytes: (data.length - 2) / 2, effective_gas_price: BigInt(r.effectiveGasPrice) })
  return { ...r, hash }
}
const call = (meta, from, address, abi, functionName, args, value) => tx({ ...meta, function: functionName }, from, address, encodeFunctionData({ abi, functionName, args }), value)
const deploy = async (meta, a, name, args = [], bytecode = a.bytecode.object) =>
  (await tx({ ...meta, function: `new ${name}` }, D, undefined, encodeDeployData({ abi: a.abi, bytecode, args }))).contractAddress
const read = (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args })

// Setup, baseline: one implementation, a proxy per pilot, the operator whitelisted as the bot's seller.
const market = { baseline: {}, treatment: {} }
const setup = (run, pilot, role = "deployer") => ({ run, pilot, hour: "", role })
const baseImpl = await deploy(setup("baseline", ""), EBM, "EnergyBiddingMarket")
for (const p of PILOTS) {
  market.baseline[p] = await deploy(setup("baseline", p), PROXY, "ERC1967Proxy", [baseImpl, encodeFunctionData({ abi: EBM.abi, functionName: "initialize", args: [D] })])
  await call(setup("baseline", p), D, market.baseline[p], EBM.abi, "whitelistSeller", [OPERATOR, true])
}

// Setup, treatment: Semaphore v4 (PoseidonT3 linked), a group and a proxy per pilot, then enrolment of every
// configured household: DSO credential, presentation bound to the commitment, admission, addMember.
const verifier = await deploy(setup("treatment", ""), VERIFIER, "SemaphoreVerifier")
const poseidon = await deploy(setup("treatment", ""), POSEIDON, "PoseidonT3")
const semaphore = await deploy(setup("treatment", ""), SEM, "Semaphore", [verifier], SEM.bytecode.object.replace(/__\$[0-9a-f]{34}\$__/g, poseidon.slice(2).toLowerCase()))
const privImpl = await deploy(setup("treatment", ""), PEBM, "PrivateEnergyBiddingMarket")
const dso = await createDso()
const groupId = {}, group = {}
for (const p of PILOTS) {
  groupId[p] = (await pub.simulateContract({ account: D, address: semaphore, abi: SEM.abi, functionName: "createGroup", args: [D] })).result
  await call(setup("treatment", p, "admission"), D, semaphore, SEM.abi, "createGroup", [D])
  market.treatment[p] = await deploy(setup("treatment", p), PROXY, "ERC1967Proxy", [privImpl, encodeFunctionData({ abi: PEBM.abi, functionName: "initializePrivate", args: [D, semaphore, groupId[p]] })])
  await call(setup("treatment", p), D, market.treatment[p], PEBM.abi, "whitelistSeller", [OPERATOR, true])
  const aud = `admission:${market.treatment[p].toLowerCase()}`
  const admission = await createAdmission({ dsoPublicJwk: dso.publicJwk, aud, statusListFetcher: () => dso.statusList() })
  for (const label of households[p]) {
    const holder = await createHolder(`communitas-sim-${SEED}-${p}-${label}`)
    const credential = await dso.issue({ community: "COMMUNITAS", pilot: p, meter_id: label }, holder.publicJwk)
    const r = admission.challenge()
    const presentation = await holder.present(credential, { nonce: bindingNonce(r, holder.identity.commitment), aud })
    const admitted = await admission.admit(presentation, holder.identity.commitment, r)
    if (admitted.pilot !== p) throw new Error("admission returned another pilot")
    await call(setup("treatment", p, "admission"), D, semaphore, SEM.abi, "addMember", [groupId[p], admitted.commitment])
    agents[p][label].identity = holder.identity
  }
  group[p] = await rebuildGroup(pub, semaphore, groupId[p]) // as a household would, from chain events
  if ((await read(market.treatment[p], PEBM.abi, "bidScope", [BigInt(WEEK)])) !== bidScope(market.treatment[p], groupId[p], BigInt(WEEK))) throw new Error("bidScope encoding differs")
}

const publicRecord = [], truth = [], submitted = {}, plainGas = {}, privGas = {}, verifGas = []
const note = (run, p, h, i, sender, amount, hash, label) => {
  publicRecord.push([run, p, h, i, sender, amount, hash]); truth.push([run, p, h, i, label])
  ;((submitted[run] ??= {})[`${p},${h}`] ??= []).push({ amount, bidder: run === "baseline" ? sender : RELAYER })
}

async function bidBaseline(p, h) {
  for (const [i, a] of (book[p][h]?.bids ?? []).entries()) { // deployed order: the record's
    const amount = BigInt(quantity(a.trace.get(h)))
    const r = await call({ run: "baseline", pilot: p, hour: h, role: "household" }, a.wallet, market.baseline[p], EBM.abi, "placeBid", [BigInt(h), amount], amount * price())
    plainGas[`${p},${h},${a.label}`] = { gas: BigInt(r.gasUsed), index: i }
    note("baseline", p, h, i, a.wallet, amount, r.hash, a.label)
  }
}

const findCall = (c, to) => (c.to?.toLowerCase() === to.toLowerCase() ? c : (c.calls ?? []).map((x) => findCall(x, to)).find(Boolean))

async function bidTreatment(p, h) {
  const bids = []
  for (const a of book[p][h]?.bids ?? []) { // each household proves its own bid, then hands it to the relayer
    const amount = BigInt(quantity(a.trace.get(h)))
    const proof = await proveBid({ identity: a.identity, group: group[p], market: market.treatment[p], groupId: groupId[p], hour: BigInt(h), amount, price: price(), refund: RELAYER })
    bids.push({ a, amount, proof })
  }
  if (ORDER === "shuffled") shuffle(bids)
  const meta = { run: "treatment", pilot: p, hour: h, role: "relayer" }
  const send = (address, abi, fn, args, value) => call(meta, RELAYER, address, abi, fn, args, value)
  for (const [i, { a, amount, proof }] of bids.entries()) {
    const r = await placePrivateBid({ send, market: market.treatment[p], hour: BigInt(h), amount, price: price(), refund: RELAYER, proof })
    // verification proper: the Semaphore.validateProof subcall (checks the proof, records the nullifier)
    const trace = await pub.request({ method: "debug_traceTransaction", params: [r.hash, { tracer: "callTracer" }] })
    const v = findCall(trace, semaphore) // proxy -> delegatecall to the implementation -> call to Semaphore
    verifGas.push({ hour: h, gas: Number(BigInt(v.gasUsed)) })
    privGas[`${p},${h},${a.label}`] = { gas: BigInt(r.gasUsed), index: i }
    note("treatment", p, h, i, proof.nullifier.toString(), amount, r.hash, a.label)
  }
}

// Clearing as the bot does it: asks of the hour from the operator with price-sorted indices, or clearMarket
// when the hour has bids but no asks, nothing when it has no bids. Checks the chain holds what was submitted.
const chainCount = {}
async function clear(run, p, h) {
  const m = market[run][p], abi = abiOf[run]
  const bids = await read(m, abi, "getBidsByHour", [BigInt(h)])
  const mine = submitted[run]?.[`${p},${h}`] ?? []
  if (run === "baseline") chainCount[`${p},${h}`] = bids.length
  if (bids.length !== mine.length || bids.some((b, i) => b.amount !== mine[i].amount || b.bidder.toLowerCase() !== mine[i].bidder.toLowerCase())) throw new Error(`${run} ${p} ${h}: chain bids differ from submitted`)
  if (bids.length === 0) return
  const meta = { run, pilot: p, hour: h, role: "operator" }
  const asks = book[p][h]?.asks ?? []
  if (asks.length === 0) return call(meta, OPERATOR, m, abi, "clearMarket", [BigInt(h)])
  const sorted = bids.map((b, i) => ({ price: b.price, i })).sort((x, y) => (x.price < y.price) - (x.price > y.price)).map((x) => BigInt(x.i))
  await call(meta, OPERATOR, m, abi, "placeAsksAndClearMarket", [BigInt(h), asks.map((a) => ({ receiver: locWallet[p][a.label], amount: BigInt(a.w) })), sorted])
}

// The bot's cycle, run at minute 5 of each hour c: bids for c + 1 h, then asks and clearing for c - 1 h.
for (let c = WEEK - 3600; c <= END; c += 3600) {
  await pub.request({ method: "evm_setNextBlockTimestamp", params: [c + 300] })
  await pub.request({ method: "evm_mine", params: [] })
  const bidHour = c + 3600, clearHour = c - 3600
  if (bidHour < END) for (const p of PILOTS) { await bidBaseline(p, bidHour); await bidTreatment(p, bidHour) }
  if (clearHour >= WEEK) for (const p of PILOTS) for (const run of RUNS) await clear(run, p, clearHour)
  if ((c - WEEK) % (24 * 3600) === 0) console.error(`${new Date(c * 1000).toISOString()} ${cost.length} transactions, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

// Probes, measured and then reverted, so they are not part of either run: enrolment as one addMembers per pilot
// (the path scripts/market-demo.mjs takes), and one direct validateProof transaction (what the Semaphore gas
// report measures, as opposed to the subcall inside placeBidWithProof).
const snap = await pub.request({ method: "evm_snapshot", params: [] })
const keep = cost.length
const batch = []
for (const p of PILOTS) {
  const g = (await pub.simulateContract({ account: D, address: semaphore, abi: SEM.abi, functionName: "createGroup", args: [D] })).result
  await call({}, D, semaphore, SEM.abi, "createGroup", [D])
  const r = await call({}, D, semaphore, SEM.abi, "addMembers", [g, households[p].map((l) => agents[p][l].identity.commitment)])
  batch.push({ p, gas: Math.round(Number(BigInt(r.gasUsed)) / households[p].length) })
}
const a0 = agents.danish[households.danish[0]]
const probe = await proveBid({ identity: a0.identity, group: group.danish, market: semaphore, groupId: groupId.danish, hour: 0n, amount: 1n, price: 1n, refund: D })
const direct = Number(BigInt((await call({}, D, semaphore, SEM.abi, "validateProof", [groupId.danish, probe])).gasUsed))
cost.length = keep
await pub.request({ method: "evm_revert", params: [snap] })

// Outputs.
mkdirSync(OUT, { recursive: true })
const csv = (file, header, rows) => writeFileSync(join(OUT, file), [header, ...rows.map((r) => r.join(","))].join("\n") + "\n")
csv("public_record.csv", "run,pilot,hour,index,sender,amount_W,tx_hash", publicRecord)
csv("ground_truth.csv", "run,pilot,hour,index,household", truth)
const cols = ["run", "pilot", "hour", "role", "function", "tx_hash", "exec_gas", "l1_gas", "calldata_bytes", "effective_gas_price"]
csv("cost.csv", cols.join(","), cost.map((r) => cols.map((k) => r[k])))

// Summary of the cost instrument.
const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.max(0, Math.ceil(p * a.length) - 1)] } // nearest rank
const fmt = (x) => (typeof x === "number" && !Number.isInteger(x) ? x.toFixed(2) : Number(x).toLocaleString("en-US"))
const rows = (run, fn) => cost.filter((r) => r.run === run && r.function === fn)
const sum = (rs, k) => rs.reduce((t, r) => t + Number(r[k]), 0)
const hours = Array.from({ length: ROUNDS }, (_, i) => WEEK + i * 3600)
const per = (run, h) => cost.filter((r) => r.run === run && r.hour === h)
const played = hours.filter((h) => per("baseline", h).length > 0)
const gasRatio = played.map((h) => sum(per("treatment", h), "exec_gas") / sum(per("baseline", h), "exec_gas"))
const byteRatio = played.map((h) => sum(per("treatment", h), "calldata_bytes") / sum(per("baseline", h), "calldata_bytes"))
const verifPerRound = played.map((h) => verifGas.filter((v) => v.hour === h).reduce((t, v) => t + v.gas, 0))
const bidsPerRound = played.map((h) => rows("treatment", "placeBidWithProof").filter((r) => r.hour === h).length)
const privExec = rows("treatment", "placeBidWithProof").map((r) => Number(r.exec_gas))
const plainExec = rows("baseline", "placeBid").map((r) => Number(r.exec_gas))
const pairs = Object.keys(privGas).map((k) => ({ d: Number(privGas[k].gas - plainGas[k].gas), first: privGas[k].index === 0 || plainGas[k].index === 0 }))
const later = pairs.filter((x) => !x.first).map((x) => x.d)
const enrol = rows("treatment", "addMember").map((r) => Number(r.exec_gas))
const verif = verifGas.map((v) => v.gas)
const clearB = cost.filter((r) => r.run === "baseline" && r.role === "operator").map((r) => Number(r.exec_gas))
const clearT = cost.filter((r) => r.run === "treatment" && r.role === "operator").map((r) => Number(r.exec_gas))
const bytesOf = (run, fn) => [...new Set(rows(run, fn).map((r) => r.calldata_bytes))].join(", ")
const empty = PILOTS.map((p) => `${p} ${hours.filter((h) => !book[p][h]?.bids.length).length}`).join(", ")
const recordMatch = PILOTS.flatMap((p) => hours.map((h) => (book[p][h]?.bids.length ?? 0) === (chainCount[`${p},${h}`] ?? 0))).filter(Boolean).length
const dev = (m, p) => `${(((m - p) / p) * 100).toFixed(1)}%`
const pass = (ok) => (ok ? "met" : "MISSED")
const maxVerif = Math.max(...verif), maxEnrol = Math.max(...enrol), maxRound = Math.max(...verifPerRound)
const runtime = (Date.now() - t0) / 1000

const md = `# Cost instrument, replay of ${new Date(WEEK * 1000).toISOString().slice(0, 16)}Z + ${ROUNDS} h

Generated ${new Date().toISOString()} by \`node sim/replay.mjs\` in ${runtime.toFixed(0)} s on ${anvilVersion} (local node, chain 31337).
Parameters: QUANTITY=${QUANTITY}${QUANTITY === "bucketed" ? ` STEP=${STEP}` : ""}, price ${PRICE} wei/W, baseline order deployed (the record's), treatment ORDER=${ORDER}, SEED=${SEED}.
Baseline: EnergyBiddingMarket (lib/energy-bidding-market) behind an ERC1967 proxy, one wallet per household, placeBid.
Treatment: PrivateEnergyBiddingMarket, Semaphore v4 group per pilot, ${enrol.length} households enrolled, placeBidWithProof through one relayer, refund = relayer.
Execution gas is gasUsed minus the receipt's parent-chain part; anvil reports no parent-chain part, so l1_gas is 0 throughout and bytes are reported as calldata length.

## Predicted and measured

| Component | Predicted | Measured | Deviation | Threshold | Result |
|---|---|---|---|---|---|
| Calldata, plain bid (bytes) | 68 | ${bytesOf("baseline", "placeBid")} | | | |
| Calldata, private bid (bytes) | 484 | ${bytesOf("treatment", "placeBidWithProof")} | ${dev(Number(bytesOf("treatment", "placeBidWithProof")), 484)} | | |
| Plain bid, placeBid (gas), median / max | 133,528 (first bid of an hour) | ${fmt(q(plainExec, 0.5))} / ${fmt(Math.max(...plainExec))} | ${dev(Math.max(...plainExec), 133528)} (max) | | |
| Clearing, baseline (gas), median | 343,738 (field median) | ${fmt(q(clearB, 0.5))} | ${dev(q(clearB, 0.5), 343738)} | | |
| Verification, Semaphore.validateProof subcall (gas), median / max | 288,798 | ${fmt(q(verif, 0.5))} / ${fmt(maxVerif)} | ${dev(maxVerif, 288798)} (max) | <= 300,000 (O2, max) | ${pass(maxVerif <= 300000)} |
| Verification, one direct validateProof transaction (gas, probe) | 288,798 | ${fmt(direct)} | ${dev(direct, 288798)} | <= 300,000 (O2) | ${pass(direct <= 300000)} |
| Verification per round, sum over the round's private bids (gas), max | | ${fmt(maxRound)} | | <= 15,000,000 (O2) | ${pass(maxRound <= 15e6)} |
| Enrolment, addMember per household (gas), median / max | 133,880 | ${fmt(q(enrol, 0.5))} / ${fmt(maxEnrol)} | ${dev(maxEnrol, 133880)} (max) | <= 150,000 (O2) | ${pass(maxEnrol <= 150000)} |
| Enrolment, one addMembers per pilot, per household (gas, probe) | 133,880 | ${batch.map((b) => `${b.p} ${fmt(b.gas)}`).join(", ")} | | <= 150,000 (O2) | ${pass(batch.every((b) => b.gas <= 150000))} |
| Round execution gas, treatment / baseline, median / p95 | | ${fmt(q(gasRatio, 0.5))} / ${fmt(q(gasRatio, 0.95))} | | <= 5 (O1a, median) | ${pass(q(gasRatio, 0.5) <= 5)} |
| Round calldata bytes, treatment / baseline, median / p95 | | ${fmt(q(byteRatio, 0.5))} / ${fmt(q(byteRatio, 0.95))} | | <= 10 (O1b, median) | ${pass(q(byteRatio, 0.5) <= 10)} |

The private bid carries one word more than predicted: the refund address, bound into the proof's message. The
verification subcall excludes the transaction's intrinsic 21,000 gas and its calldata, which the Semaphore report's
figure includes; the direct transaction is the like-for-like comparison. A single addMember costs more as the
group's tree gets deeper (the Poseidon hashes and stored side nodes per insertion grow with the depth), so in a group
of 32 most insertions exceed the report's average; one batch insertion per pilot shares that work and costs much
less per household. The methodology's baseline round took 133,528 gas per plain bid, a test-harness figure; the
deployed bytecode measures less, so the measured baseline round is smaller and the round ratios larger than that
derivation implied. Rounds carry different numbers of bids, and the ratio rises with them.

## Per call

- placeBidWithProof execution gas: median ${fmt(q(privExec, 0.5))}, max ${fmt(Math.max(...privExec))} (${privExec.length} bids).
- placeBid execution gas: median ${fmt(q(plainExec, 0.5))}, max ${fmt(Math.max(...plainExec))} (${plainExec.length} bids).
- placeBidWithProof minus placeBid, same household, hour and amount (${pairs.length} pairs): median ${fmt(q(pairs.map((x) => x.d), 0.5))}, max ${fmt(Math.max(...pairs.map((x) => x.d)))}; median ${fmt(q(later, 0.5))} over the ${later.length} pairs where neither bid is the first of its hour (the first pays to initialise the hour's bid counter, in either run). The difference holds the verification subcall plus the proof's calldata, the scope and message checks and the extra event.
- Clearing execution gas (placeAsksAndClearMarket or clearMarket): baseline median ${fmt(q(clearB, 0.5))}, max ${fmt(Math.max(...clearB))}; treatment median ${fmt(q(clearT, 0.5))}, max ${fmt(Math.max(...clearT))} (${clearB.length} clearings per run). Treatment refunds all go to one address, which makes its storage writes cheaper.
- Private bids per round: median ${q(bidsPerRound, 0.5)}, max ${Math.max(...bidsPerRound)}.

## Rounds

${played.length} of ${ROUNDS} rounds replayed, ${ROUNDS - played.length} skipped (a round is skipped only when no instance has a bid in the record).
Instance-hours with no bids in the record: ${empty}. The record does not say whether these are upstream outages or hours without a positive delta; the ingestion service's audit log would, and it was not read. Those instance-hours have no bids and no clearing in either run, as with the bot.
The baseline's on-chain bid count matches the record in ${recordMatch} of ${ROUNDS * PILOTS.length} instance-hours${QUANTITY === "deployed" ? "; amounts and index order were checked equal to the record's before every clearing" : ""}.

Not replayed: the bot's claims (claimBalance), wallet top-ups and the empty transaction it sends to move the L3's clock. They are outside the methodology's round (bids plus clearings).
`
writeFileSync(join(OUT, "summary.md"), md)
console.log(md)
process.exit(0)
