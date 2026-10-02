import { createHash, randomBytes } from "node:crypto";
import * as z from "zod/mini";
import type { MusicAccountSummary, MusicTrack } from "@/lib/contracts/music";
import { readMusicAccountRecord, updateMusicAccountRecord } from "./musicAccounts";
import type { TidalCredentials } from "./musicCredentials";

const AUTHORIZE_URL = "https://login.tidal.com/authorize";
const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const API_ORIGIN = "https://openapi.tidal.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 128 * 1024;
const TIDAL_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SCOPES = "user.read collection.read collection.write search.read playback";
const sessionEpochs = new Map<string, number>();
type TidalRefreshFlight = {
  controller: AbortController;
  epoch: number;
  promise: Promise<TidalCredentials>;
  grantDispatched: { value: boolean };
  sourceAccessToken: string;
  settled: boolean;
  waiters: number;
};
const refreshFlights = new Map<string, TidalRefreshFlight>();

export class TidalMusicError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = "TidalMusicError";
    this.status = status;
  }
}

class TidalRefreshRejectedError extends TidalMusicError {
  constructor() {
    super("Reconnect TIDAL in Center.", 401);
  }
}

function clientId(): string {
  const value = process.env.TIDAL_CLIENT_ID?.trim() ?? "";
  if (!value || value.length > 256 || /\s/u.test(value)) {
    throw new TidalMusicError("TIDAL is not configured by this Center operator.", 409);
  }
  return value;
}

function publicOrigin(): string {
  const raw = process.env.LUMA_MUSIC_GATEWAY_ORIGIN?.trim() ?? "";
  try {
    const value = new URL(raw);
    if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/" || value.search || value.hash) {
      throw new Error("invalid origin");
    }
    return value.origin;
  } catch {
    throw new TidalMusicError("The public Center music origin is not configured.", 409);
  }
}

function requestedScopes(): string {
  const value = process.env.TIDAL_SCOPES?.trim() || DEFAULT_SCOPES;
  if (value.length > 1024 || /[\r\n]/u.test(value)) throw new TidalMusicError("TIDAL scopes are invalid.", 409);
  return value;
}

function sessionEpoch(subject: string): number {
  return sessionEpochs.get(subject) ?? 0;
}

function invalidateSession(subject: string): void {
  sessionEpochs.set(subject, sessionEpoch(subject) + 1);
}

function tidalRequestSignal(
  operationSignal?: AbortSignal,
  requestSignal?: AbortSignal | null,
): AbortSignal {
  const timeout = AbortSignal.timeout(TIDAL_REQUEST_TIMEOUT_MS);
  const signals = [
    timeout,
    operationSignal,
    requestSignal ?? undefined,
  ]
    .filter((signal): signal is AbortSignal => signal !== undefined)
    .filter((signal, index, all) => all.indexOf(signal) === index);
  return signals.length === 1 ? timeout : AbortSignal.any(signals);
}

function waitForSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * `link` is the wearer's TIDAL account as Cosmos reports it, or null when
 * Cosmos could not say. Cosmos counts a grant as linked while its token is
 * usable or renewable.
 */
export function tidalConnectionStatus(link: MusicAccountSummary["tidal"] | null): {
  configured: boolean;
  state: "not_configured" | "not_connected" | "connecting" | "connected" | "error";
} {
  try {
    clientId();
  } catch {
    return { configured: false, state: "not_configured" };
  }
  if (!link) return { configured: true, state: "error" };
  if (link.linked) return { configured: true, state: "connected" };
  if (link.connecting) return { configured: true, state: "connecting" };
  return { configured: true, state: "not_connected" };
}

export async function startTidalConnection(subject: string): Promise<string> {
  // INFERRED: validate operator configuration before Cosmos records a sign-in
  // that cannot reach TIDAL, so the account never gets stuck as connecting.
  const configuredClientId = clientId();
  const scopes = requestedScopes();
  const redirectUri = `${publicOrigin()}/api/settings/services/music/tidal/callback`;
  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  await updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      ...record.tidal,
      pending: { state, verifier, redirect_uri: redirectUri, expires_at: Date.now() + 10 * 60_000 },
    },
  }));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", configuredClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (scopes) url.searchParams.set("scope", scopes);
  return url.toString();
}

async function boundedResponseJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TidalMusicError("TIDAL returned an oversized response.", 502);
  }
  if (!response.body) throw new TidalMusicError("TIDAL returned an invalid response.", 502);
  signal?.throwIfAborted();
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TidalMusicError("TIDAL returned an oversized response.", 502);
      }
      chunks.push(value);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TidalMusicError("TIDAL returned an invalid response.", 502);
  }
}

// TIDAL's authorization response uses a numeric lifetime in seconds:
// https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization
const tidalTokenSchema = z.object({
  access_token: z.string().check(z.minLength(1)),
  refresh_token: z.optional(z.string().check(z.minLength(1))),
  expires_in: z.int().check(z.positive(), z.maximum(8_000_000_000_000)),
  user_id: z.optional(z.union([z.string(), z.int()])),
  countryCode: z.optional(z.string().check(z.regex(/^[A-Za-z]{2}$/u))),
  country_code: z.optional(z.string().check(z.regex(/^[A-Za-z]{2}$/u))),
  scope: z.optional(z.string()),
  token_type: z.optional(z.string()),
});

async function tokenRequest(
  fields: URLSearchParams,
  operationSignal?: AbortSignal,
  markRequestDispatched?: () => void,
): Promise<TidalCredentials> {
  const secret = process.env.TIDAL_CLIENT_SECRET?.trim();
  if (secret) fields.set("client_secret", secret);
  const signal = tidalRequestSignal(operationSignal);
  markRequestDispatched?.();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: fields,
    cache: "no-store",
    redirect: "error",
    signal,
  }).catch(() => null);
  if (!response) {
    if (signal.aborted)
      throw new TidalMusicError("TIDAL could not be reached.");
    throw new TidalMusicError("TIDAL sign-in could not be completed.", 502);
  }
  if (!response.ok) {
    if (
      response.status === 400 &&
      fields.get("grant_type") === "refresh_token"
    ) {
      let value: unknown;
      try {
        value = await boundedResponseJson(
          response,
          MAX_TOKEN_RESPONSE_BYTES,
          signal,
        );
      } catch {
        if (signal.aborted)
          throw new TidalMusicError("TIDAL could not be reached.");
        throw new TidalMusicError("TIDAL sign-in could not be completed.", 502);
      }
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).error === "invalid_grant"
      ) {
        throw new TidalRefreshRejectedError();
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    if (signal.aborted)
      throw new TidalMusicError("TIDAL could not be reached.");
    throw new TidalMusicError("TIDAL sign-in could not be completed.", 502);
  }
  let value: unknown;
  try {
    value = await boundedResponseJson(
      response,
      MAX_TOKEN_RESPONSE_BYTES,
      signal,
    );
  } catch (error) {
    if (signal.aborted) {
      throw new TidalMusicError("TIDAL could not be reached.");
    }
    throw error;
  }
  const parsed = tidalTokenSchema.safeParse(value);
  if (!parsed.success)
    throw new TidalMusicError("TIDAL returned invalid credentials.");
  const body = parsed.data;
  const country = body.countryCode ?? body.country_code;
  return {
    access_token: body.access_token,
    ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    expires_at: Date.now() + body.expires_in * 1_000,
    ...(body.user_id !== undefined ? { user_id: String(body.user_id) } : {}),
    ...(country ? { country_code: country.toUpperCase() } : {}),
    ...(body.scope ? { scope: body.scope } : {}),
    ...(body.token_type ? { token_type: body.token_type } : {}),
  };
}

export async function finishTidalConnection(subject: string, code: string, state: string): Promise<void> {
  const epoch = sessionEpoch(subject);
  const record = await readMusicAccountRecord(subject);
  const pending = record.tidal?.pending;
  if (!pending || pending.expires_at <= Date.now() || pending.state !== state || !code || code.length > 4096) {
    throw new TidalMusicError("TIDAL sign-in expired or did not match this Center session.", 400);
  }
  const fields = new URLSearchParams({
    client_id: clientId(),
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirect_uri,
    code_verifier: pending.verifier,
  });
  const scopes = requestedScopes();
  if (scopes) fields.set("scope", scopes);
  const credentials = await tokenRequest(fields);
  if (sessionEpoch(subject) !== epoch) {
    throw new TidalMusicError("TIDAL sign-in was cancelled.", 409);
  }
  // Only an accepted replacement grant cancels older credential work. Merely
  // opening/abandoning sign-in must preserve a dispatched refresh rotation.
  invalidateSession(subject);
  const replacementEpoch = sessionEpoch(subject);
  await updateMusicAccountRecord(subject, (current) => {
    if (sessionEpoch(subject) !== replacementEpoch || current.tidal?.pending?.state !== state) {
      throw new TidalMusicError("TIDAL sign-in was cancelled.", 409);
    }
    return {
      ...current,
      tidal: { credentials, connected_at: new Date().toISOString() },
    };
  });
}

/**
 * Forget the sign-in `state` started once TIDAL's callback reports it failed or
 * was cancelled, so Cosmos stops reporting TIDAL as connecting for the rest of
 * the ten-minute window. A newer sign-in (another `state`) and a linked account
 * are left alone.
 */
export async function abandonTidalConnection(subject: string, state: string): Promise<void> {
  if (!state) return;
  const record = await readMusicAccountRecord(subject);
  if (record.tidal?.pending?.state !== state) return;
  await updateMusicAccountRecord(subject, (current) => {
    if (current.tidal?.pending?.state !== state) return current;
    const { pending: _pending, ...tidal } = current.tidal;
    if (tidal.credentials) return { ...current, tidal };
    const { tidal: _tidal, ...rest } = current;
    return rest;
  });
}

export async function disconnectTidal(subject: string): Promise<void> {
  invalidateSession(subject);
  await updateMusicAccountRecord(subject, (record) => {
    const { tidal: _tidal, ...rest } = record;
    return rest;
  });
}

async function rotateCredentials(
  subject: string,
  current: TidalCredentials,
  epoch: number,
  signal: AbortSignal,
  markGrantDispatched: () => void,
): Promise<TidalCredentials> {
  const fields = new URLSearchParams({
    client_id: clientId(),
    grant_type: "refresh_token",
    refresh_token: current.refresh_token!,
  });
  const scopes = requestedScopes();
  if (scopes) fields.set("scope", scopes);
  let refreshed: TidalCredentials;
  try {
    refreshed = await tokenRequest(fields, signal, markGrantDispatched);
  } catch (error) {
    if (error instanceof TidalRefreshRejectedError) {
      await waitForSignal(updateMusicAccountRecord(subject, (record) => {
        signal.throwIfAborted();
        const latest = record.tidal?.credentials;
        if (
          sessionEpoch(subject) !== epoch ||
          !latest ||
          latest.access_token !== current.access_token
        ) {
          throw new TidalMusicError("TIDAL was disconnected while refreshing.", 401);
        }
        const pending = record.tidal?.pending;
        const { tidal: _tidal, ...rest } = record;
        return pending ? { ...rest, tidal: { pending } } : rest;
      }), signal);
    }
    throw error;
  }
  signal?.throwIfAborted();
  if (!refreshed.refresh_token) refreshed.refresh_token = current.refresh_token;
  if (!refreshed.user_id) refreshed.user_id = current.user_id;
  if (!refreshed.country_code) refreshed.country_code = current.country_code;
  await waitForSignal(updateMusicAccountRecord(subject, (record) => {
    signal.throwIfAborted();
    const latest = record.tidal?.credentials;
    if (
      sessionEpoch(subject) !== epoch ||
      !latest ||
      latest.access_token !== current.access_token
    ) {
      throw new TidalMusicError("TIDAL was disconnected while refreshing.", 401);
    }
    return {
      ...record,
      tidal: {
        ...record.tidal,
        credentials: refreshed,
        connected_at: record.tidal?.connected_at ?? new Date().toISOString(),
      },
    };
  }), signal);
  return refreshed;
}

async function sharedCredentialRefresh(
  subject: string,
  current: TidalCredentials,
  epoch: number,
  signal?: AbortSignal,
): Promise<TidalCredentials> {
  let flight = refreshFlights.get(subject);
  if (
    !flight ||
    flight.settled ||
    flight.controller.signal.aborted ||
    flight.epoch !== epoch ||
    flight.sourceAccessToken !== current.access_token
  ) {
    signal?.throwIfAborted();
    const latest = (await waitForSignal(readMusicAccountRecord(subject, signal), signal)).tidal?.credentials;
    signal?.throwIfAborted();
    if (sessionEpoch(subject) !== epoch || !latest) {
      throw new TidalMusicError("Reconnect TIDAL in Center.", 401);
    }
    if (latest.access_token !== current.access_token) {
      if (latest.expires_at > Date.now() + 60_000) return latest;
      if (!latest.refresh_token) throw new TidalMusicError("Reconnect TIDAL in Center.", 401);
      return sharedCredentialRefresh(subject, latest, epoch, signal);
    }

    flight = refreshFlights.get(subject);
    if (
      !flight ||
      flight.settled ||
      flight.controller.signal.aborted ||
      flight.epoch !== epoch ||
      flight.sourceAccessToken !== current.access_token
    ) {
      const controller = new AbortController();
      const grantDispatched = { value: false };
      const promise = rotateCredentials(
        subject,
        current,
        epoch,
        controller.signal,
        () => {
          grantDispatched.value = true;
        },
      );
      flight = {
        controller,
        epoch,
        promise,
        grantDispatched,
        sourceAccessToken: current.access_token,
        settled: false,
        waiters: 0,
      };
      refreshFlights.set(subject, flight);
      const finish = () => {
        flight!.settled = true;
        if (refreshFlights.get(subject) === flight) refreshFlights.delete(subject);
      };
      void promise.then(finish, finish);
    }
  }

  flight.waiters += 1;
  try {
    return await waitForSignal(flight.promise, signal);
  } catch (error) {
    if (signal?.aborted) throw new TidalMusicError("TIDAL could not be reached.");
    throw error;
  } finally {
    flight.waiters -= 1;
    if (
      !flight.settled &&
      flight.waiters === 0 &&
      !flight.grantDispatched.value &&
      !flight.controller.signal.aborted
    ) {
      flight.controller.abort(signal?.reason);
    }
  }
}

async function credentials(subject: string, signal?: AbortSignal): Promise<TidalCredentials> {
  signal?.throwIfAborted();
  const epoch = sessionEpoch(subject);
  const current = (await waitForSignal(readMusicAccountRecord(subject, signal), signal)).tidal?.credentials;
  signal?.throwIfAborted();
  if (!current) throw new TidalMusicError("Connect TIDAL in Center.", 401);
  if (current.expires_at > Date.now() + 60_000) return current;
  if (!current.refresh_token) throw new TidalMusicError("Reconnect TIDAL in Center.", 401);
  return sharedCredentialRefresh(subject, current, epoch, signal);
}

async function tidalApi(
  subject: string,
  path: string,
  init?: RequestInit,
  operationSignal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(path, `${API_ORIGIN}/v2/`);
  if (url.origin !== API_ORIGIN) throw new TidalMusicError("TIDAL request is invalid.", 400);
  const epoch = sessionEpoch(subject);
  let auth = await credentials(subject, operationSignal);
  let renewed = false;
  let response: Response | null;
  let signal: AbortSignal;
  for (;;) {
    signal = tidalRequestSignal(operationSignal, init?.signal);
    response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        accept: "application/vnd.api+json",
        ...(init?.body ? { "content-type": "application/vnd.api+json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
      redirect: "error",
      signal,
    }).catch(() => null);
    if (!response) throw new TidalMusicError("TIDAL could not be reached.");
    if (response.status !== 401 || renewed || !auth.refresh_token) break;
    // TIDAL revoked the token before its expiry (a password change or a
    // signed-out session). Renew it once, as an expired token would be, and
    // retry. A refused renewal unlinks the account (TidalRefreshRejectedError).
    await response.body?.cancel().catch(() => undefined);
    renewed = true;
    auth = await sharedCredentialRefresh(subject, auth, epoch, operationSignal);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new TidalMusicError("Reconnect TIDAL in Center.", 401);
    // A 403 is TIDAL refusing this request (scope, subscription, region), not
    // a lost sign-in, so it must not tell the owner to reconnect.
    if (response.status === 403) throw new TidalMusicError("TIDAL refused that request.", 403);
    if (response.status === 429) throw new TidalMusicError("TIDAL is busy. Try again shortly.", 429);
    throw new TidalMusicError("TIDAL could not complete that request.", 502);
  }
  if (response.status === 204) return null;
  try {
    return await boundedResponseJson(response, MAX_RESPONSE_BYTES, signal);
  } catch (error) {
    if (signal.aborted) throw new TidalMusicError("TIDAL could not be reached.");
    throw error;
  }
}

function isoDurationMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1_000, Math.round(value * 1_000));
  if (typeof value !== "string") return 180_000;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/u.exec(value);
  if (!match) return 180_000;
  return Math.max(1_000, Math.round((Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1_000));
}

// JSON:API resource fields used by this adapter. Other resource attributes stay
// opaque. Only tracks, names and their relationships enter the application.
const resourceIdSchema = z.object({
  type: z.string(),
  id: z.string().check(z.regex(/^[A-Za-z0-9_-]{1,256}$/u)),
});
const relationshipSchema = z.object({
  data: z.nullish(z.union([resourceIdSchema, z.array(resourceIdSchema)])),
});
const resourceSchema = z.object({
  ...resourceIdSchema.shape,
  attributes: z.optional(
    z.object({
      title: z.optional(z.string()),
      name: z.optional(z.string()),
      duration: z.optional(z.union([z.string(), z.number()])),
      trackNumber: z.optional(z.int().check(z.nonnegative())),
      volumeNumber: z.optional(z.int().check(z.nonnegative())),
      explicit: z.optional(z.boolean()),
    }),
  ),
  relationships: z.optional(z.record(z.string(), relationshipSchema)),
});
const catalogDocumentSchema = z.object({
  data: z.nullable(z.union([resourceSchema, z.array(resourceSchema)])),
  included: z.optional(z.array(resourceSchema)),
});
function catalogResources(value: unknown) {
  const parsed = catalogDocumentSchema.safeParse(value);
  if (!parsed.success)
    throw new TidalMusicError("TIDAL returned an unreadable catalog.", 502);
  const { data, included = [] } = parsed.data;
  return [...(Array.isArray(data) ? data : data ? [data] : []), ...included];
}

function tracksFromDocument(value: unknown, limit: number): MusicTrack[] {
  const resources = catalogResources(value);
  const byKey = new Map(
    resources.map((item) => [`${item.type}:${item.id}`, item]),
  );
  const seen = new Set<string>();
  return resources
    .flatMap((item) => {
      if (
        item.type !== "tracks" ||
        !item.attributes?.title?.trim() ||
        seen.has(item.id)
      )
        return [];
      seen.add(item.id);
      const attributes = item.attributes;
      const names = (name: string) => {
        const data = item.relationships?.[name]?.data;
        return (Array.isArray(data) ? data : data ? [data] : []).flatMap(
          (ref) => {
            const attrs = byKey.get(`${ref.type}:${ref.id}`)?.attributes;
            const label = (attrs?.name ?? attrs?.title)?.trim();
            return label ? [label] : [];
          },
        );
      };
      return [
        {
          id: `tidal:${item.id}`,
          title: attributes.title!.trim(),
          artists: names("artists"),
          album: names("albums")[0] ?? "",
          duration_ms: isoDurationMs(attributes.duration),
          track_number: attributes.trackNumber ?? 0,
          disc_number: attributes.volumeNumber ?? 0,
          explicit: attributes.explicit === true,
        },
      ];
    })
    .slice(0, limit);
}

function resourceIdsFromDocument(
  value: unknown,
  type: string,
  limit: number,
): string[] {
  return [
    ...new Set(
      catalogResources(value)
        .filter((item) => item.type === type)
        .map((item) => item.id),
    ),
  ].slice(0, limit);
}

const userCountrySchema = z.object({
  data: z.object({
    attributes: z.object({
      country: z.string().check(z.regex(/^[A-Za-z]{2}$/u)),
    }),
  }),
});
function countryCodeFromUser(value: unknown): string | null {
  const parsed = userCountrySchema.safeParse(value);
  return parsed.success
    ? parsed.data.data.attributes.country.toUpperCase()
    : null;
}

async function tidalCountryCode(
  subject: string,
  auth: TidalCredentials,
  signal?: AbortSignal,
): Promise<string> {
  const configured = process.env.TIDAL_COUNTRY_CODE?.trim() ?? "";
  if (configured) {
    if (!/^[A-Za-z]{2}$/u.test(configured)) {
      throw new TidalMusicError("TIDAL country code is invalid.", 409);
    }
    return configured.toUpperCase();
  }
  if (/^[A-Za-z]{2}$/u.test(auth.country_code ?? "")) return auth.country_code!.toUpperCase();
  const epoch = sessionEpoch(subject);
  // The official users resource accepts `me`. OAuth grants need not carry a
  // user_id. https://tidal-music.github.io/tidal-api-reference/
  const country = countryCodeFromUser(
    await tidalApi(subject, `users/${encodeURIComponent(auth.user_id ?? "me")}`, undefined, signal),
  );
  if (!country) throw new TidalMusicError("TIDAL did not return an account country.", 502);
  await updateMusicAccountRecord(subject, (record) => {
    const current = record.tidal?.credentials;
    if (!current || sessionEpoch(subject) !== epoch) {
      throw new TidalMusicError("TIDAL country lookup was cancelled.", 409);
    }
    return {
      ...record,
      tidal: {
        ...record.tidal,
        credentials: { ...current, country_code: country },
      },
    };
  }, signal);
  return country;
}

function catalogPath(pathname: string, countryCode: string, include?: string): string {
  const parameters = new URLSearchParams({ countryCode });
  if (include) parameters.set("include", include);
  return `${pathname}?${parameters.toString()}`;
}

function collectionId(value: string, type: "album" | "artist" | "playlist"): string {
  const prefixes = [`tidal:${type}:`, `tidal_${type}:`];
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  const id = prefix ? value.slice(prefix.length) : value;
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(id)) {
    throw new TidalMusicError(`TIDAL ${type} id is invalid.`, 400);
  }
  return id;
}

async function tracksByIds(
  subject: string,
  ids: string[],
  countryCode: string,
  limit: number,
  signal?: AbortSignal,
): Promise<MusicTrack[]> {
  const ordered = ids.slice(0, limit).map(tidalId);
  if (!ordered.length) return [];
  // TIDAL's /tracks filter[id] accepts at most twenty IDs per request. All
  // batches share the caller's deadline and are assembled in requested order.
  // https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
  const tracks: MusicTrack[] = [];
  for (let offset = 0; offset < ordered.length; offset += 20) {
    const parameters = new URLSearchParams({
      "filter[id]": ordered.slice(offset, offset + 20).join(","),
      include: "artists,albums",
      countryCode,
    });
    tracks.push(...tracksFromDocument(
      await tidalApi(subject, `tracks?${parameters.toString()}`, undefined, signal),
      20,
    ));
  }
  const byId = new Map(tracks.map((track) => [tidalId(track.id), track]));
  return ordered.flatMap((id) => byId.get(id) ?? []);
}

async function relationshipTracks(
  subject: string,
  path: string,
  includedRelationship: string,
  countryCode: string,
  limit: number,
  signal?: AbortSignal,
): Promise<MusicTrack[]> {
  // Artist tracks require collapseBy. NONE preserves every catalog item.
  // https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
  const queryPath = catalogPath(path, countryCode, includedRelationship) +
    (path.startsWith("artists/") && includedRelationship === "tracks" ? "&collapseBy=NONE" : "");
  const relationship = await tidalApi(
    subject,
    queryPath,
    undefined,
    signal,
  );
  return tracksByIds(
    subject,
    resourceIdsFromDocument(relationship, "tracks", limit),
    countryCode,
    limit,
    signal,
  );
}

// INFERRED provider mapping, using TIDAL's official GET /searchResults query
// and its relationship identifiers. Search-result IDs are opaque, never the
// query text. https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
const searchResultsSchema = z.object({
  data: z.array(z.object({
    type: z.literal("searchResults"),
    relationships: z.record(z.string(), relationshipSchema),
  })),
});

async function searchResourceIds(
  subject: string,
  query: string,
  relationship: "albums" | "artists" | "playlists" | "tracks" | "topHits",
  type: "albums" | "artists" | "playlists" | "tracks",
  countryCode: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  if (query.length > 256) throw new TidalMusicError("TIDAL search is too long.", 400);
  const parameters = new URLSearchParams({
    "filter[query]": query,
    countryCode,
    include: relationship,
  });
  const document = await tidalApi(
    subject,
    `searchResults?${parameters.toString()}`,
    undefined,
    signal,
  );
  const parsed = searchResultsSchema.safeParse(document);
  if (!parsed.success) throw new TidalMusicError("TIDAL returned an unreadable catalog.", 502);
  return [...new Set(parsed.data.data.flatMap((result) => {
    const data = result.relationships[relationship]?.data;
    return (Array.isArray(data) ? data : data ? [data] : [])
      .filter((item) => item.type === type).map((item) => item.id);
  }))].slice(0, limit);
}

function tidalId(value: string): string {
  const id = value.startsWith("tidal:") ? value.slice(6) : value;
  if (!id || id.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(id)) throw new TidalMusicError("TIDAL track id is invalid.", 400);
  return id;
}

/** `signal` ends every TIDAL and Cosmos request this lookup makes. */
export async function queryTidal(
  subject: string,
  request: {
    kind: string;
    primary?: string;
    secondary?: string;
    ids?: string[];
    limit: number;
  },
  signal?: AbortSignal,
): Promise<MusicTrack[]> {
  const limit = Math.max(1, Math.min(100, request.limit));
  const auth = await credentials(subject, signal);
  const countryCode = await tidalCountryCode(subject, auth, signal);
  if (request.kind === "favorites") {
    // Official authenticated collection resource: `me` binds to this grant.
    // https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
    const relationship = await tidalApi(
      subject,
      "userCollectionTracks/me/relationships/items?include=items",
      undefined,
      signal,
    );
    return tracksByIds(
      subject,
      resourceIdsFromDocument(relationship, "tracks", limit),
      countryCode,
      limit,
      signal,
    );
  }
  if (request.kind === "ids" && request.ids?.length) {
    return tracksByIds(subject, request.ids, countryCode, limit, signal);
  }
  if (
    (request.kind === "radio" || request.kind === "recommendations") &&
    request.primary
  ) {
    const relationship = request.kind === "radio" ? "radio" : "similarTracks";
    return relationshipTracks(
      subject,
      `tracks/${encodeURIComponent(tidalId(request.primary))}/relationships/${relationship}`,
      relationship,
      countryCode,
      limit,
      signal,
    );
  }
  if (request.kind === "album_id" && request.primary) {
    return relationshipTracks(
      subject,
      `albums/${encodeURIComponent(collectionId(request.primary, "album"))}/relationships/items`,
      "items",
      countryCode,
      limit,
      signal,
    );
  }

  const query =
    [request.primary, request.secondary].filter(Boolean).join(" ").trim() ||
    (request.kind === "featured" || request.kind === "top_hits"
      ? "top hits"
      : "");
  if (!query) return [];

  const collection =
    request.kind === "album" || request.kind === "album_artist"
      ? {
          type: "albums" as const,
          endpoint: "albums" as const,
          relationship: "items",
        }
      : request.kind === "artist"
        ? {
            type: "artists" as const,
            endpoint: "artists" as const,
            relationship: "tracks",
          }
        : request.kind === "playlist"
          ? {
              type: "playlists" as const,
              endpoint: "playlists" as const,
              relationship: "items",
            }
          : null;
  if (collection) {
    const [id] = await searchResourceIds(
      subject,
      query,
      collection.type,
      collection.type,
      countryCode,
      1,
      signal,
    );
    if (!id) return [];
    return relationshipTracks(
      subject,
      `${collection.endpoint}/${encodeURIComponent(id)}/relationships/${collection.relationship}`,
      collection.relationship,
      countryCode,
      limit,
      signal,
    );
  }

  const relationship =
    request.kind === "featured" || request.kind === "top_hits"
      ? "topHits"
      : "tracks";
  return tracksByIds(
    subject,
    await searchResourceIds(subject, query, relationship, "tracks", countryCode, limit, signal),
    countryCode,
    limit,
    signal,
  );
}

const trackFileSchema = z.object({
  data: z.object({
    attributes: z.object({ url: z.string(), trackPresentation: z.string() }),
  }),
});

export async function tidalStreamUrl(
  subject: string,
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = await tidalApi(
    subject,
    `trackFiles/${encodeURIComponent(tidalId(id))}?formats=AACLC&usage=PLAYBACK`,
    undefined,
    signal,
  );
  const parsed = trackFileSchema.safeParse(body);
  if (!parsed.success)
    throw new TidalMusicError(
      "TIDAL returned an unreadable playback response.",
      502,
    );
  const { url, trackPresentation } = parsed.data.data.attributes;
  if (trackPresentation !== "FULL") {
    throw new TidalMusicError(
      "TIDAL did not authorize full-track playback.",
      403,
    );
  }
  if (typeof url !== "string" || !isAllowedTidalStream(url))
    throw new TidalMusicError(
      "TIDAL returned an unexpected stream origin.",
      502,
    );
  return url;
}

export function isAllowedTidalStream(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    const configured = (process.env.TIDAL_STREAM_HOST_SUFFIXES ?? "tidal.com,tdlcdn.com,akamaihd.net")
      .split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    return url.protocol === "https:" && !url.username && !url.password && configured.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export async function saveTidalTrack(
  subject: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  // Official collection write; `me` avoids trusting an optional token user id.
  // https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
  await tidalApi(subject, "userCollectionTracks/me/relationships/items", {
    method: "POST",
    body: JSON.stringify({ data: [{ type: "tracks", id: tidalId(id) }] }),
  }, signal);
}
