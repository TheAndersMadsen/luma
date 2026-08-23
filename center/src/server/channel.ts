/*
 * The wearer's ephemeral channel key — the thing that makes sealed content
 * readable.
 *
 * Humane's lifecycle, which the clone implements and this reproduces:
 *
 *   1. EstablishWrappingKeys  server publishes its RSA-OAEP public key (SPKI DER)
 *   2. (client) generate an ephemeral AES-128 key and pick a kid
 *   3. ImportKeys             upload it RSA-OAEP-wrapped to the server, which
 *                             unwraps it into the shared KeyDirectory
 *
 * After step 3 BOTH sides hold the key: we can seal and open envelopes, and the
 * server can index notes and decrypt for share links. That symmetry is what the
 * real system had — `GetShareLinkContents` returns `decrypted_thumbnail_bytes`,
 * so Humane's backend held key material for at least some content too.
 *
 * The key is the WEARER'S. It is never logged, it never leaves this module, and
 * — the part that used to be wrong — it is never shared between wearers: the
 * in-process cache is keyed by principal and the persisted store is keyed by
 * kid, so nothing here can hand one wearer's key to another.
 *
 * A wearer can hold MORE THAN ONE kid over time, because the kid is derived from
 * whatever identity a request carries and that derivation has changed shape
 * once already. So this module answers two different questions, and the
 * difference matters:
 *
 *   channelKey()             what to SEAL under — today's derived kid
 *   channelKeyForSealed()    what to OPEN a given envelope with — the key that
 *                            envelope NAMES, provided it names this wearer
 *
 * Opening with today's key is how content sealed last month became "this frame
 * could not be opened": a statement about the capture, made about the key.
 *
 * Where those keys are KEPT is ./channelStore.ts. The split is not cosmetic:
 * this module cannot be loaded without a gRPC stack and a request scope, and
 * the durable home of irreplaceable wearer key material has to be testable on
 * its own — see verify/channel-key-store.test.mjs.
 */

import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "./auth";
import {
  ChannelKeyUnavailableError,
  CHANNEL_KEY_IDENTITY_INVALID,
  centerKidForPrincipal,
  namesSameWearer,
  parseCenterPrincipal,
  saveKey,
  storedKeysFor,
  type ChannelKey,
} from "./channelStore";
import { Services, SessionExpiredError, call } from "./cosmos";
import { decodeEnvelope, generateChannelKey, wrapChannelKey } from "./envelope";
import { logWarn } from "./log";

type ChannelRpcCall = <TReq extends object, TRes>(
  service: string,
  method: string,
  request: TReq,
) => Promise<TRes>;

let channelRpcCall: ChannelRpcCall = call;

/** Replace only the channel lifecycle's RPC seam in the Node verification process. */
export function setChannelRpcCallForTests(replacement: ChannelRpcCall | null): void {
  channelRpcCall = replacement ?? call;
}

/*
 * Re-exported because this is the module every route and the data seam already
 * import the key from; where the bytes are kept is not their concern, and a
 * second import path for the same typed error would make `instanceof` a
 * question rather than an answer.
 */
export { ChannelKeyUnavailableError } from "./channelStore";

/**
 * Kid naming: `refuse_foreign_kids` parses a wearer id out of the kid and
 * refuses one naming somebody else, so this is derived from our own principal.
 */
function kidFor(principal: string): string {
  const kid = centerKidForPrincipal(principal);
  if (kid === null) throw new ChannelKeyUnavailableError(CHANNEL_KEY_IDENTITY_INVALID);
  return kid;
}

/**
 * Which wearer this key belongs to.
 *
 * The key seals THIS wearer's content, so it may never be shared. One
 * process-global key would seal every wearer's notes under one kid, and the
 * first wearer to establish it would own everybody else's — which is why the
 * fix for the old `COSMOS_PRINCIPAL` gate is emphatically NOT to set
 * `COSMOS_PRINCIPAL` in a deployment that serves more than one person.
 *
 * The identity is the same one `requestMetadata()` forwards to the workloads:
 *
 *   1. the signed session's `sub`, namespaced `U:<sub>` — the exact partition
 *      `AuthenticatedPrincipal::for_user` resolves a Keycloak bearer to, and the
 *      same one this wearer's Pin writes under;
 *   2. `COSMOS_PRINCIPAL`, the static identity local development and the staging
 *      smoke run under. A FALLBACK, never a gate: gating on it is what made note
 *      creation answer "no channel key" on every production deployment, because
 *      nothing sets it there and nothing should.
 *
 * Neither available means no key — reported, not silently swallowed.
 */
async function channelPrincipal(): Promise<string | null> {
  let session: Awaited<ReturnType<typeof verifySession>> = null;
  try {
    const jar = await cookies();
    session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  } catch {
    // Not a request scope — `cookies()` throws there. The static identity below
    // is the only one that exists outside one anyway.
  }
  // Parse outside the request-scope catch. A validly signed session containing an
  // invalid subject is an invalid identity, not permission to fall through to a
  // static COSMOS_PRINCIPAL and act as somebody else.
  if (session?.sub) {
    const candidate = `U:${session.sub}`;
    const parsed = parseCenterPrincipal(candidate);
    if (parsed === null) throw new ChannelKeyUnavailableError(CHANNEL_KEY_IDENTITY_INVALID);
    return parsed.principal;
  }
  const configured = process.env.COSMOS_PRINCIPAL ?? "";
  if (configured.length === 0) return null;
  const parsed = parseCenterPrincipal(configured);
  if (parsed === null) throw new ChannelKeyUnavailableError(CHANNEL_KEY_IDENTITY_INVALID);
  return parsed.principal;
}

/**
 * One in-flight establishment per principal, so concurrent requests for the
 * same wearer share a key rather than racing ImportKeys — and so one wearer's
 * key is never handed to another. Keyed by principal for that reason alone.
 */
const established = new Map<string, Promise<ChannelKey>>();

/**
 * This request's channel key.
 *
 * Throws `ChannelKeyUnavailableError` when there is none and
 * `SessionExpiredError` when the wearer's grant died underneath their cookie;
 * both are conditions a caller has to say something about.
 */
export async function channelKey(): Promise<ChannelKey> {
  const principal = await channelPrincipal();
  if (!principal) {
    throw new ChannelKeyUnavailableError(
      "this request carries no wearer identity, so there is no key to seal under - sign in again, or set COSMOS_PRINCIPAL for a single-identity local deployment",
    );
  }

  let pending = established.get(principal);
  if (!pending) {
    pending = establish(principal);
    established.set(principal, pending);
  }

  try {
    return await pending;
  } catch (error) {
    // Never latch the failure. A single ImportKeys/EstablishWrappingKeys blip
    // used to cache `null` for the life of the process, so a transient outage
    // disabled note writes until the container was restarted. Evict instead, and
    // let the next request try again.
    if (established.get(principal) === pending) established.delete(principal);
    if (error instanceof SessionExpiredError) throw error;
    // The only trace this failure has ever left. The kid is not secret; the key
    // is, and is not in scope here.
    logWarn("channel: key establishment failed", error);
    throw error;
  }
}

async function establish(principal: string): Promise<ChannelKey> {
  const kid = kidFor(principal);
  // Reuse this wearer's established key if one exists, so we open what the
  // seeder sealed. Looked up BY KID, so it is only ever this wearer's.
  const stored = storedKeysFor(kid);
  const existing = stored.find((candidate) => candidate.kid === kid) ?? null;
  // A key does not stop being the wearer's because the kid we DERIVE for them
  // changed shape. When the store holds one of theirs under an older kid, adopt
  // its BYTES under the new name rather than generating a second key: one key,
  // two names, and everything sealed under either name still opens. Generating
  // instead is what left the August key stranded in the file it was written to.
  const inherited = existing ?? stored[0] ?? null;

  // 1. the server's wrapping public key
  const wrapping = await channelRpcCall<
    Record<string, never>,
    { clearKey?: { jcaEncoded?: Buffer | Uint8Array | string } }
  >(Services.privacy, "EstablishWrappingKeys", {});

  const der = toBuffer(wrapping.clearKey?.jcaEncoded);
  if (!der || der.length === 0) {
    throw new ChannelKeyUnavailableError(
      "cosmos published no wrapping key, so a channel key cannot be established",
    );
  }

  // 2. our ephemeral channel key — reused if we already have one. The kid is
  //    always the one derived above: a stored key under a kid that does not name
  //    this wearer belongs to a different wearer, and `storedKeysFor` never
  //    hands it to us.
  const key = inherited?.key ?? generateChannelKey();

  // 3. hand it to the server, wrapped
  const result = await channelRpcCall<
    { keys: Array<Record<string, unknown>> },
    { results?: Array<{ kid?: Buffer | string; status?: string | number }> }
  >(Services.privacy, "ImportKeys", {
    keys: [
      {
        kid: Buffer.from(kid, "utf8"),
        wrappedKey: {
          // The backend key directory persists this identifier and rollback
          // releases recognize the legacy spelling. It is a wire key, not a
          // logical implementation name.
          wrappingKid: Buffer.from("cosmos-clone/wrapping/rsa-oaep", "utf8"),
          keydata: wrapChannelKey(der, key),
        },
      },
    ],
  });

  const status = result.results?.[0]?.status;
  // KEY_IMPORTED is the only outcome that means the server can open what we seal.
  if (status !== "KEY_IMPORTED" && status !== 1) {
    throw new ChannelKeyUnavailableError(
      `cosmos answered ${String(status)} to ImportKeys, so nothing it stores could be read back`,
    );
  }

  const channel = { kid, key };
  // Persist whenever the store does not already hold this exact kid. That is
  // the first establishment AND the rename: the inherited bytes gain a second
  // name, and the write migrates the legacy top-level pair into the map so both
  // names stay reachable to `channelKeyForSealed` below.
  if (!existing) saveKey(channel);
  return channel;
}

/**
 * The key to OPEN a sealed payload with: the one the envelope NAMES, not the one
 * this request happens to hold.
 *
 * `envelope.open()` decodes `kid` and then ignores it, so every reader used
 * whatever key it was handed. That is invisible while there is only ever one
 * key, and wrong the moment there are two: the GCM tag fails to verify, the
 * caller reports "this frame could not be opened", and the wearer is told
 * something about their capture when the truth is about their key.
 *
 * Resolution is confined to kids that name THIS wearer. A kid arrives inside the
 * payload, so it is caller-influenced; a lookup that trusted it verbatim would
 * be a way to ask for another wearer's key by name.
 */
export async function channelKeyForSealed(sealed: Buffer): Promise<ChannelKey> {
  let named: string | null = null;
  try {
    named = decodeEnvelope(sealed).kid;
  } catch {
    // Not a readable envelope. `open()` is about to say so precisely, and
    // guessing a key here would only change which error it reports.
  }

  if (named) {
    const principal = await channelPrincipal();
    if (principal) {
      const derived = kidFor(principal);
      if (namesSameWearer(named, derived)) {
        const stored = storedKeysFor(derived).find((candidate) => candidate.kid === named);
        // Established, persisted, and named by the payload in front of us —
        // there is nothing to ask the backend for.
        if (stored) return stored;
      }
    }
  }

  // No stored key answers to that name: fall through to the current one, which
  // is right for anything this process sealed and establishes one if needed.
  return channelKey();
}

function toBuffer(value: Buffer | Uint8Array | string | undefined): Buffer | null {
  if (value === undefined) return null;
  if (typeof value === "string") return Buffer.from(value, "base64");
  return Buffer.from(value);
}

/** Forget every established key — used by tests and after a SyncKeys delete. */
export function resetChannelKey(): void {
  established.clear();
}
