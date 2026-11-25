// Self-test of the issuance pipeline: 48 synthetic households (no real data) are issued a
// credential, present it and are admitted; then each attack below must be refused.
import { Identity } from "@semaphore-protocol/core"
import { createDso, createHolder, createAdmission, bindingNonce, YEAR } from "./lib.mjs"

const aud = "https://admission.mock.communitas.invalid"
const pilots = { DK: 32, ES: 6, IT: 10 }
const households = Object.entries(pilots).flatMap(([pilot, n]) =>
  Array.from({ length: n }, (_, i) => ({ community: "communitas", pilot, meter_id: `${pilot.toLowerCase()}-meter-${String(i + 1).padStart(2, "0")}` })),
)

const dso = await createDso()
const admission = await createAdmission({ dsoPublicJwk: dso.publicJwk, aud })
let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`) }
const ms = (t) => `${(performance.now() - t).toFixed(0)} ms`

// Happy path, timed per stage.
const holders = await Promise.all(households.map((h) => createHolder(`selftest-${h.meter_id}`)))
let t = performance.now()
const creds = await Promise.all(households.map((h, i) => dso.issue(h, holders[i].publicJwk)))
console.log(`issued    ${creds.length} credentials in ${ms(t)}`)
const rs = households.map(() => admission.challenge())
t = performance.now()
const presentations = await Promise.all(holders.map((h, i) => h.present(creds[i], { nonce: bindingNonce(rs[i], h.identity.commitment), aud })))
console.log(`presented ${presentations.length} in ${ms(t)}`)
t = performance.now()
const admitted = []
for (const [i, h] of holders.entries()) {
  try {
    const res = await admission.admit(presentations[i], h.identity.commitment, rs[i])
    if (res.commitment !== h.identity.commitment || res.pilot !== households[i].pilot) fail(`wrong result for ${households[i].meter_id}`)
    admitted.push(res)
  } catch (e) {
    fail(`${households[i].meter_id} refused: ${e.message}`)
  }
}
const byPilot = Object.keys(pilots).map((p) => `${p} ${admitted.filter((a) => a.pilot === p).length}`).join(", ")
console.log(`admitted  ${admitted.length}/48 in ${ms(t)} (${byPilot})`)
if (admitted.length !== 48) fail("not all 48 admitted")

// Attacks. Each uses an unenrolled meter (except the double enrolment) so the refusal has one cause,
// and the error message must name that cause.
const other = new Identity("selftest-other")
const fresh = async (meter_id, issuer = dso, iat) => {
  const holder = await createHolder()
  return { holder, cred: await issuer.issue({ community: "communitas", pilot: "DK", meter_id }, holder.publicJwk, iat) }
}
async function refused(label, re, fn) {
  try {
    await fn()
    fail(`${label}: accepted`)
  } catch (e) {
    if (re.test(e.message)) console.log(`refused   ${label}: ${e.message}`)
    else fail(`${label}: refused for the wrong reason: ${e.message}`)
  }
}
const run = async (presenter, cred, { commitment = presenter.identity.commitment, nonceFor = commitment, audience = aud, r = admission.challenge() } = {}) =>
  admission.admit(await presenter.present(cred, { nonce: bindingNonce(r, nonceFor), aud: audience }), commitment, r)

await refused("second enrolment of dk-meter-01 with another commitment", /already enrolled/, () =>
  run(holders[0], creds[0], { commitment: other.commitment }))
const a = await fresh("dk-meter-91")
await refused("nonce computed for a different commitment", /nonce/i, () =>
  run(a.holder, a.cred, { commitment: other.commitment, nonceFor: a.holder.identity.commitment }))
const b = await fresh("dk-meter-92", await createDso())
await refused("credential signed by a different DSO key", /signature/i, () => run(b.holder, b.cred))
const c = await fresh("dk-meter-93")
await refused("KB-JWT signed by a different holder key", /signature/i, async () => run(await createHolder(), c.cred))
const d = await fresh("dk-meter-94", dso, Math.floor(Date.now() / 1000) - YEAR - 60)
await refused("expired credential", /expired/i, () => run(d.holder, d.cred))
const e = await fresh("dk-meter-95")
await refused("KB-JWT for another audience", /audience/i, () => run(e.holder, e.cred, { audience: "https://other.invalid" }))
await refused("reused challenge", /challenge/, () => run(e.holder, e.cred, { r: rs[1] }))

console.log(failures ? `${failures} FAILED` : "all checks passed")
process.exit(failures ? 1 : 0)
