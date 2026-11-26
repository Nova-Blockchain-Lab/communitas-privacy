// Mock DSO, holder and admission service for enrolment into the Semaphore group
// (EF FY26-2499, M1 item 2). SD-JWT VC per draft-ietf-oauth-sd-jwt-vc (work in progress),
// signed with ES256; the holder key in cnf.jwk is P-256. Revocation through a Token Status List
// (draft-ietf-oauth-status-list-21). Off-chain only: admit() returns the commitment, and the caller
// adds it to the group; removals() returns the commitments the caller removes from it.
import { createHash, randomBytes, randomInt } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { SdJwtVcInstance } from "@sd-jwt/sd-jwt-vc"
import { ES256, hasher, generateSalt } from "@owf/crypto"
import { StatusList, StatusType, decodeStatusListJwt } from "@owf/token-status-list"
import { Identity } from "@semaphore-protocol/core"

export const VCT = "urn:communitas:dso:household:1"
export const ISS = "https://dso.mock.communitas.invalid"
export const STATUS_URI = `${ISS}/status/1`
export const YEAR = 365 * 24 * 3600
const MAX_AGE = 300 // seconds a challenge and a KB-JWT stay valid
const LIST_SIZE = 4096 // status list entries, 1 bit each; indices are random (draft section 12.5)
const LIST_TTL = 300 // seconds a status list token stays valid, so an old (pre-revocation) list cannot be replayed for long
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const now = () => Math.floor(Date.now() / 1000)
const base = { hasher, hashAlg: "sha-256", saltGenerator: generateSalt }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
// Optional JSON file state, so the DSO and the admission service survive a restart.
const load = (path) => (path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined)
const store = (path, state) => path && writeFileSync(path, JSON.stringify(state))

// Binds the presentation to the Semaphore identity commitment C through the KB-JWT nonce:
//   nonce = hex(SHA-256(r || C))
// r is the 32-byte random challenge from the admission service, C the commitment as 32 bytes big-endian.
export function bindingNonce(r, commitment) {
  const c = BigInt(commitment)
  if (r.length !== 32 || c < 0n || c >= 1n << 256n) throw new Error("bindingNonce: r must be 32 bytes, C must fit in 32 bytes")
  return createHash("sha256").update(Buffer.concat([r, Buffer.from(c.toString(16).padStart(64, "0"), "hex")])).digest("hex")
}

// path (optional): JSON file with the DSO key pair, the status index of each credential and the revoked indices.
export async function createDso(path) {
  const s = load(path) ?? { ...(await ES256.generateKeyPair()), indices: {}, revoked: [] }
  store(path, s)
  const signer = await ES256.getSigner(s.privateKey)
  const sdjwt = new SdJwtVcInstance({ ...base, signer, signAlg: "ES256" })
  return {
    publicJwk: s.publicKey,
    // household: { community, pilot, meter_id }. iat is a parameter only so the self-test can issue an expired credential.
    async issue(household, holderPublicJwk, iat = now()) {
      const used = new Set(Object.values(s.indices).flat())
      let idx = randomInt(LIST_SIZE)
      while (used.has(idx)) idx = randomInt(LIST_SIZE)
      s.indices[household.meter_id] = [...(s.indices[household.meter_id] ?? []), idx]
      store(path, s)
      return sdjwt.issue(
        { ...household, iss: ISS, vct: VCT, iat, exp: iat + YEAR, cnf: { jwk: holderPublicJwk }, status: { status_list: { idx, uri: STATUS_URI } } },
        { _sd: ["pilot", "meter_id"] },
      )
    },
    // Revokes every credential issued for the meter.
    revoke(meter_id) {
      if (!s.indices[meter_id]) throw new Error(`no credential issued for ${meter_id}`)
      s.revoked.push(...s.indices[meter_id])
      store(path, s)
    },
    // Status List Token (draft section 5.1): 1 bit per credential, 1 = revoked, ZLIB-compressed and base64url-encoded.
    async statusList() {
      const list = new StatusList(new Array(LIST_SIZE).fill(StatusType.Valid), 1)
      for (const i of s.revoked) list.setStatus(i, StatusType.Invalid)
      const iat = now()
      const lst = Buffer.from(list.compressStatusListToBytes()).toString("base64url")
      const input = `${b64({ alg: "ES256", typ: "statuslist+jwt" })}.${b64({ sub: STATUS_URI, iat, exp: iat + LIST_TTL, ttl: LIST_TTL, status_list: { bits: 1, lst } })}`
      return `${input}.${await signer(input)}`
    },
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
// statusListFetcher(uri) returns the DSO's current Status List Token; the library checks its signature against the
// DSO key, its sub against the credential's uri, and refuses a credential whose bit is set.
// path (optional): JSON file with the enrolments, meter_id -> { commitment, idx, uri }.
export async function createAdmission({ dsoPublicJwk, aud, statusListFetcher, path }) {
  const verifier = await ES256.getVerifier(dsoPublicJwk)
  const sdjwt = new SdJwtVcInstance({
    ...base,
    verifier,
    // The KB-JWT must be signed by the key the DSO put in cnf.jwk.
    kbVerifier: async (data, sig, payload) => (await ES256.getVerifier(payload.cnf.jwk))(data, sig),
    statusListFetcher,
  })
  // Challenges stay in memory: a restart only voids the open ones. ponytail: JSON file rewritten on every
  // admission; move to a database when this runs as a service.
  const pending = new Map() // challenge hex -> issue time; single use
  const enrolled = load(path) ?? {}

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
        // Also refuses a presentation that withholds pilot or meter_id (the double enrolment tag), and a
        // credential without status, which could never be revoked.
        requiredClaimKeys: ["iat", "exp", "cnf", "status", "community", "pilot", "meter_id"],
        keyBindingNonce: bindingNonce(Buffer.from(r), C),
        expectedKeyBindingAudience: aud,
        keyBindingMaxAgeSeconds: MAX_AGE,
      })
      if (enrolled[payload.meter_id]) throw new Error(`meter ${payload.meter_id} already enrolled`)
      enrolled[payload.meter_id] = { commitment: C.toString(), ...payload.status.status_list }
      store(path, enrolled)
      return { commitment: C, pilot: payload.pilot }
    },
    // Commitments of enrolled households whose credential the given Status List Token marks as revoked. The
    // caller removes those still in the group. The meter stays enrolled, so it cannot enrol again.
    async removals(token) {
      const [h, p, sig] = token.split(".")
      if (!sig || !(await verifier(`${h}.${p}`, sig))) throw new Error("status list token: invalid signature")
      const { payload, statusList } = decodeStatusListJwt(token)
      if (payload.exp !== undefined && payload.exp < now()) throw new Error("status list token: expired")
      return Object.values(enrolled)
        .filter((e) => e.uri === payload.sub && statusList.getStatus(e.idx) !== StatusType.Valid)
        .map((e) => BigInt(e.commitment))
    },
  }
}
