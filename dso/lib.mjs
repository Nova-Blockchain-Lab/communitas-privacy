// Mock DSO, holder and admission service for enrolment into the Semaphore group
// (EF FY26-2499, M1 item 2). SD-JWT VC per draft-ietf-oauth-sd-jwt-vc (work in progress),
// signed with ES256; the holder key in cnf.jwk is P-256. Off-chain only: admit() returns the
// commitment, and the caller adds it to the group.
import { createHash, randomBytes } from "node:crypto"
import { SdJwtVcInstance } from "@sd-jwt/sd-jwt-vc"
import { ES256, hasher, generateSalt } from "@owf/crypto"
import { Identity } from "@semaphore-protocol/core"

export const VCT = "urn:communitas:dso:household:1"
export const ISS = "https://dso.mock.communitas.invalid"
export const YEAR = 365 * 24 * 3600
const MAX_AGE = 300 // seconds a challenge and a KB-JWT stay valid
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const now = () => Math.floor(Date.now() / 1000)
const base = { hasher, hashAlg: "sha-256", saltGenerator: generateSalt }

// Binds the presentation to the Semaphore identity commitment C through the KB-JWT nonce:
//   nonce = hex(SHA-256(r || C))
// r is the 32-byte random challenge from the admission service, C the commitment as 32 bytes big-endian.
export function bindingNonce(r, commitment) {
  const c = BigInt(commitment)
  if (r.length !== 32 || c < 0n || c >= 1n << 256n) throw new Error("bindingNonce: r must be 32 bytes, C must fit in 32 bytes")
  return createHash("sha256").update(Buffer.concat([r, Buffer.from(c.toString(16).padStart(64, "0"), "hex")])).digest("hex")
}

export async function createDso() {
  const { publicKey, privateKey } = await ES256.generateKeyPair()
  const sdjwt = new SdJwtVcInstance({ ...base, signer: await ES256.getSigner(privateKey), signAlg: "ES256" })
  return {
    publicJwk: publicKey,
    // household: { community, pilot, meter_id }. iat is a parameter only so the self-test can issue an expired credential.
    issue: (household, holderPublicJwk, iat = now()) =>
      sdjwt.issue(
        { ...household, iss: ISS, vct: VCT, iat, exp: iat + YEAR, cnf: { jwk: holderPublicJwk } },
        { _sd: ["pilot", "meter_id"] },
      ),
  }
}

// seed fixes the Semaphore identity; the P-256 key is always fresh.
export async function createHolder(seed) {
  const { publicKey, privateKey } = await ES256.generateKeyPair()
  const sdjwt = new SdJwtVcInstance({ ...base, kbSigner: await ES256.getSigner(privateKey), kbSignAlg: "ES256" })
  return {
    publicJwk: publicKey,
    identity: new Identity(seed),
    present: (credential, { nonce, aud }) =>
      sdjwt.present(credential, { pilot: true, meter_id: true }, { kb: { payload: { iat: now(), aud, nonce } } }),
  }
}

// Operator-run and trusted (custodial assumption). The DSO public key is pinned.
export async function createAdmission({ dsoPublicJwk, aud }) {
  const sdjwt = new SdJwtVcInstance({
    ...base,
    verifier: await ES256.getVerifier(dsoPublicJwk),
    // The KB-JWT must be signed by the key the DSO put in cnf.jwk.
    kbVerifier: async (data, sig, payload) => (await ES256.getVerifier(payload.cnf.jwk))(data, sig),
  })
  // ponytail: in-memory state, lost on restart and unbounded; move to a store when this runs as a service.
  const pending = new Map() // challenge hex -> issue time; single use
  const enrolled = new Set() // meter_id values already admitted

  return {
    challenge() {
      const r = randomBytes(32)
      pending.set(r.toString("hex"), now())
      return r
    },
    async admit(presentation, commitment, r) {
      const key = Buffer.from(r).toString("hex")
      const issued = pending.get(key)
      pending.delete(key)
      if (issued === undefined || now() - issued > MAX_AGE) throw new Error("unknown, used or stale challenge")
      const C = BigInt(commitment)
      if (C <= 0n || C >= SNARK_FIELD) throw new Error("commitment out of range")

      const { payload } = await sdjwt.verify(presentation, {
        expectedIssuer: ISS,
        expectedVct: VCT,
        allowedIssuerAlgorithms: ["ES256"],
        allowedKeyBindingAlgorithms: ["ES256"],
        // Also refuses a presentation that withholds pilot or meter_id (the double enrolment tag).
        requiredClaimKeys: ["iat", "exp", "cnf", "community", "pilot", "meter_id"],
        keyBindingNonce: bindingNonce(Buffer.from(r), C),
        expectedKeyBindingAudience: aud,
        keyBindingMaxAgeSeconds: MAX_AGE,
      })
      if (enrolled.has(payload.meter_id)) throw new Error(`meter ${payload.meter_id} already enrolled`)
      enrolled.add(payload.meter_id)
      return { commitment: C, pilot: payload.pilot }
    },
  }
}
