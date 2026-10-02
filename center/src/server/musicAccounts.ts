/**
 * The wearer's music provider accounts. They live in Cosmos, sealed
 * (`cosmos/crates/cosmos/src/music_api.rs`). Center keeps none of them.
 *
 * Two callers, two planes:
 *
 * - The provider gateway (catalog, playback, save, sign-in and token refresh)
 *   reads and writes the linked accounts as the wearer it acts for, on the edge
 *   plane: `x-forwarded-client-cert: U:<subject>` beside the edge proof. It has
 *   to, because it also acts for the Pin's owner when no browser is involved: a
 *   Pin playback, a TIDAL token refresh, a YouTube sign-in that completes after
 *   the request that started it. Every write names the revision it read, and a
 *   concurrent write makes it read again and reapply its change.
 * - The settings page reads the account summary, records the chosen provider
 *   and resolves track artwork as the signed-in wearer, on the web plane. It
 *   never sees a token.
 */
import {
  musicAccountSummarySchema,
  type MusicAccountSummary,
  type MusicProvider,
} from "@/lib/contracts/music";
import {
  COSMOS_WEBAPI,
  cosmosDeadlineSignal,
  edgeProofHeaders,
  SessionExpiredError,
  webapiGet,
  webapiPut,
} from "./cosmos";
import { revisionedMusicAccountsSchema, type MusicAccountRecord } from "./musicCredentials";

export class MusicAccountError extends Error {
  readonly status: number;

  constructor(message = "Music accounts are unavailable.", status = 503) {
    super(message);
    this.name = "MusicAccountError";
    this.status = status;
  }
}

const PROVIDERS_PATH = "/account-service/music-providers";
const ACTIVE_PATH = "/account-service/music-providers/active";
const CREDENTIALS_PATH = "/account-service/music-providers/credentials";
const MAX_CREDENTIALS_BYTES = 256 * 1024;
/** A write that keeps losing to other writers stops here. */
const MAX_WRITE_ATTEMPTS = 8;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Cosmos's account principal for a sign-in subject. */
function principalFor(subject: string): string {
  if (!/^[A-Za-z0-9._-]{1,126}$/u.test(subject)) throw new MusicAccountError();
  return `U:${subject}`;
}

async function credentialsRequest(
  method: "GET" | "PUT",
  subject: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  if (!COSMOS_WEBAPI) throw new MusicAccountError();
  signal?.throwIfAborted();
  const deadline = cosmosDeadlineSignal();
  const response = await fetch(`${COSMOS_WEBAPI}${CREDENTIALS_PATH}`, {
    method,
    headers: {
      "x-forwarded-client-cert": principalFor(subject),
      ...edgeProofHeaders(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  }).catch(() => null);
  if (!response) {
    if (signal?.aborted) throw signal.reason;
    throw new MusicAccountError();
  }
  return response;
}

async function readRevisioned(
  subject: string,
  signal?: AbortSignal,
): Promise<{ revision: number; record: MusicAccountRecord }> {
  const response = await credentialsRequest("GET", subject, undefined, signal);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (
    !response.ok ||
    (Number.isFinite(declared) && declared > MAX_CREDENTIALS_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new MusicAccountError();
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CREDENTIALS_BYTES)
      throw new MusicAccountError();
    body = JSON.parse(text);
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new MusicAccountError();
  }
  const parsed = revisionedMusicAccountsSchema.safeParse(body);
  if (!parsed.success) throw new MusicAccountError();
  return { revision: parsed.data.revision, record: parsed.data.accounts };
}

/** The wearer's linked accounts, credentials included, for the gateway. */
export async function readMusicAccountRecord(
  subject: string,
  signal?: AbortSignal,
): Promise<MusicAccountRecord> {
  return (await readRevisioned(subject, signal)).record;
}

/**
 * Change the wearer's linked accounts without losing a concurrent change.
 *
 * `update` gets the stored accounts and returns their replacement. Cosmos keeps
 * the replacement only if nothing was written since the read. Otherwise this
 * reads again and `update` runs again on what is there now.
 */
export async function updateMusicAccountRecord(
  subject: string,
  update: (current: MusicAccountRecord) => MusicAccountRecord | Promise<MusicAccountRecord>,
  signal?: AbortSignal,
): Promise<MusicAccountRecord> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const { revision, record } = await readRevisioned(subject, signal);
    const next = await update(record);
    const response = await credentialsRequest("PUT", subject, { revision, accounts: next }, signal);
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 409) continue;
    if (!response.ok) throw new MusicAccountError();
    return next;
  }
  throw new MusicAccountError("Music accounts kept changing. Try again.");
}

function summaryShape(value: unknown): MusicAccountSummary {
  const parsed = musicAccountSummarySchema.safeParse(value);
  if (!parsed.success) throw new MusicAccountError();
  return parsed.data;
}

/** The signed-in wearer's provider choice and which accounts are linked. */
export async function musicAccountSummary(): Promise<MusicAccountSummary> {
  let value: unknown;
  try {
    value = await webapiGet(PROVIDERS_PATH);
  } catch (error) {
    // A dead Keycloak grant is the one failure the wearer can act on.
    if (error instanceof SessionExpiredError) throw error;
    throw new MusicAccountError();
  }
  return summaryShape(value);
}

/** Record the provider the signed-in wearer's Pin now plays from. */
export async function saveActiveMusicProvider(
  provider: MusicProvider,
): Promise<MusicAccountSummary> {
  let value: unknown;
  try {
    value = await webapiPut(ACTIVE_PATH, { provider });
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    throw new MusicAccountError(
      "Your Pin switched music providers, but your account could not record it. Try again.",
    );
  }
  return summaryShape(value);
}

/** Where a played track's cover is, as Cosmos resolves it. */
export async function musicArtworkUrl(
  provider: string,
  id: string,
): Promise<string> {
  const body = objectRecord(
    await webapiGet(
      `/music/artwork/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`,
    ),
  );
  const url = typeof body?.url === "string" ? body.url : "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new Error();
  } catch {
    throw new MusicAccountError("Album artwork is unavailable.", 404);
  }
  return url;
}
