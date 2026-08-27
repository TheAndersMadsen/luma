import { createHash, randomBytes } from "node:crypto";

import {
  readMusicAccountRecord,
  updateMusicAccountRecord,
  type TidalCredentials,
} from "./musicProviderStore";
import type { YoutubeTrack } from "./youtubeMusic";

const AUTHORIZE_URL = "https://login.tidal.com/authorize";
const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const API_ORIGIN = "https://openapi.tidal.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 128 * 1024;
const TIDAL_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SCOPES = "user.read collection.read collection.write playback";
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
  const raw = process.env.REVIVAL_MUSIC_GATEWAY_ORIGIN?.trim() ?? "";
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
  const signals = [
    AbortSignal.timeout(TIDAL_REQUEST_TIMEOUT_MS),
    operationSignal,
    requestSignal ?? undefined,
  ]
    .filter((signal): signal is AbortSignal => signal !== undefined)
    .filter((signal, index, all) => all.indexOf(signal) === index);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
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

export async function tidalConnectionStatus(subject: string): Promise<{
  configured: boolean;
  state: "not_configured" | "not_connected" | "connecting" | "connected" | "error";
}> {
  try {
    clientId();
  } catch {
    return { configured: false, state: "not_configured" };
  }
  try {
    const record = await readMusicAccountRecord(subject);
    const credentials = record.tidal?.credentials;
    if (
      credentials?.access_token &&
      (credentials.expires_at > Date.now() + 60_000 || Boolean(credentials.refresh_token))
    ) {
      return { configured: true, state: "connected" };
    }
    if (record.tidal?.pending && record.tidal.pending.expires_at > Date.now()) {
      return { configured: true, state: "connecting" };
    }
    return { configured: true, state: "not_connected" };
  } catch {
    return { configured: true, state: "error" };
  }
}

export async function startTidalConnection(subject: string): Promise<string> {
  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const redirectUri = `${publicOrigin()}/api/settings/services/music/tidal/callback`;
  await updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      ...record.tidal,
      pending: { state, verifier, redirect_uri: redirectUri, expires_at: Date.now() + 10 * 60_000 },
    },
  }));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const scopes = requestedScopes();
  if (scopes) url.searchParams.set("scope", scopes);
  return url.toString();
}

function stringField(record: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = record[name];
  if (typeof value === "string" && value && value.length <= 16_384) return value;
  if (required) throw new TidalMusicError("TIDAL returned invalid credentials.");
  return undefined;
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
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: fields,
    cache: "no-store",
    redirect: "error",
    signal,
  }).catch(() => null);
  if (!response) {
    if (signal.aborted) throw new TidalMusicError("TIDAL could not be reached.");
    throw new TidalMusicError("TIDAL sign-in could not be completed.", 502);
  }
  if (!response.ok) {
    if (response.status === 400 && fields.get("grant_type") === "refresh_token") {
      let value: unknown;
      try {
        value = await boundedResponseJson(response, MAX_TOKEN_RESPONSE_BYTES, signal);
      } catch {
        if (signal.aborted) throw new TidalMusicError("TIDAL could not be reached.");
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
    if (signal.aborted) throw new TidalMusicError("TIDAL could not be reached.");
    throw new TidalMusicError("TIDAL sign-in could not be completed.", 502);
  }
  let value: unknown;
  try {
    value = await boundedResponseJson(response, MAX_TOKEN_RESPONSE_BYTES, signal);
  } catch (error) {
    if (signal.aborted) {
      throw new TidalMusicError("TIDAL could not be reached.");
    }
    throw error;
  }
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!body) throw new TidalMusicError("TIDAL returned invalid credentials.");
  const expires = Number(body.expires_in);
  return {
    access_token: stringField(body, "access_token", true)!,
    ...(stringField(body, "refresh_token") ? { refresh_token: stringField(body, "refresh_token") } : {}),
    expires_at: Date.now() + Math.max(60, Number.isFinite(expires) ? expires : 3600) * 1_000,
    ...(typeof body.user_id === "number" || typeof body.user_id === "string" ? { user_id: String(body.user_id) } : {}),
    ...(typeof (body.countryCode ?? body.country_code) === "string"
      ? { country_code: String(body.countryCode ?? body.country_code).toUpperCase() }
      : {}),
    ...(stringField(body, "scope") ? { scope: stringField(body, "scope") } : {}),
    ...(stringField(body, "token_type") ? { token_type: stringField(body, "token_type") } : {}),
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
  await updateMusicAccountRecord(subject, (current) => {
    if (sessionEpoch(subject) !== epoch || current.tidal?.pending?.state !== state) {
      throw new TidalMusicError("TIDAL sign-in was cancelled.", 409);
    }
    return {
      ...current,
      tidal: { credentials, connected_at: new Date().toISOString() },
    };
  });
}

export async function disconnectTidal(subject: string): Promise<void> {
  invalidateSession(subject);
  await updateMusicAccountRecord(subject, (record) => {
    const { tidal: _tidal, ...rest } = record;
    return { ...rest, version: 1 };
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
        return pending ? { ...rest, tidal: { pending }, version: 1 } : { ...rest, version: 1 };
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
    const latest = (await waitForSignal(readMusicAccountRecord(subject), signal)).tidal?.credentials;
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
  const current = (await waitForSignal(readMusicAccountRecord(subject), signal)).tidal?.credentials;
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
  const auth = await credentials(subject, operationSignal);
  const url = new URL(path, `${API_ORIGIN}/v2/`);
  if (url.origin !== API_ORIGIN) throw new TidalMusicError("TIDAL request is invalid.", 400);
  const signal = tidalRequestSignal(operationSignal, init?.signal);
  const response = await fetch(url, {
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
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new TidalMusicError("Reconnect TIDAL in Center.", 401);
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

function tracksFromDocument(value: unknown, limit: number): YoutubeTrack[] {
  if (!value || typeof value !== "object") return [];
  const document = value as { data?: unknown; included?: unknown[] };
  const included = Array.isArray(document.included) ? document.included : [];
  const resources = [...(Array.isArray(document.data) ? document.data : document.data ? [document.data] : []), ...included];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const raw of resources) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.type === "string" && typeof item.id === "string") byKey.set(`${item.type}:${item.id}`, item);
  }
  return resources.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (item.type !== "tracks" || typeof item.id !== "string") return [];
    const attributes = item.attributes && typeof item.attributes === "object" ? item.attributes as Record<string, unknown> : {};
    const title = typeof attributes.title === "string" ? attributes.title.trim() : "";
    if (!title) return [];
    const relationships = item.relationships && typeof item.relationships === "object" ? item.relationships as Record<string, unknown> : {};
    const names = (name: string) => {
      const relationship = relationships[name] as { data?: unknown } | undefined;
      const refs = Array.isArray(relationship?.data) ? relationship!.data : relationship?.data ? [relationship.data] : [];
      return refs.flatMap((ref) => {
        if (!ref || typeof ref !== "object") return [];
        const typed = ref as { type?: unknown; id?: unknown };
        const related = typeof typed.type === "string" && typeof typed.id === "string" ? byKey.get(`${typed.type}:${typed.id}`) : undefined;
        const attrs = related?.attributes as Record<string, unknown> | undefined;
        const nameValue = attrs?.name ?? attrs?.title;
        return typeof nameValue === "string" && nameValue.trim() ? [nameValue.trim()] : [];
      });
    };
    return [{
      id: `tidal:${item.id}`,
      title,
      artists: names("artists"),
      album: names("albums")[0] ?? "",
      duration_ms: isoDurationMs(attributes.duration),
      track_number: typeof attributes.trackNumber === "number" ? attributes.trackNumber : 0,
      disc_number: typeof attributes.volumeNumber === "number" ? attributes.volumeNumber : 0,
      explicit: attributes.explicit === true,
    }];
  }).filter((track, index, all) => all.findIndex((candidate) => candidate.id === track.id) === index).slice(0, limit);
}

function resourceIdsFromDocument(value: unknown, type: string, limit: number): string[] {
  if (!value || typeof value !== "object") return [];
  const document = value as { data?: unknown; included?: unknown[] };
  const resources = [
    ...(Array.isArray(document.data) ? document.data : document.data ? [document.data] : []),
    ...(Array.isArray(document.included) ? document.included : []),
  ];
  const ids: string[] = [];
  for (const raw of resources) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { type?: unknown; id?: unknown };
    if (item.type !== type || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(item.id)) continue;
    if (!ids.includes(item.id)) ids.push(item.id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function countryCodeFromUser(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const attributes = (data as { attributes?: unknown }).attributes;
  if (!attributes || typeof attributes !== "object") return null;
  const country = (attributes as { country?: unknown }).country;
  return typeof country === "string" && /^[A-Za-z]{2}$/u.test(country)
    ? country.toUpperCase()
    : null;
}

async function tidalCountryCode(subject: string, auth: TidalCredentials): Promise<string> {
  const configured = process.env.TIDAL_COUNTRY_CODE?.trim() ?? "";
  if (configured) {
    if (!/^[A-Za-z]{2}$/u.test(configured)) {
      throw new TidalMusicError("TIDAL country code is invalid.", 409);
    }
    return configured.toUpperCase();
  }
  if (/^[A-Za-z]{2}$/u.test(auth.country_code ?? "")) return auth.country_code!.toUpperCase();
  if (!auth.user_id) throw new TidalMusicError("Reconnect TIDAL to select your catalog region.", 401);

  const country = countryCodeFromUser(
    await tidalApi(subject, `users/${encodeURIComponent(auth.user_id)}`),
  );
  if (!country) throw new TidalMusicError("TIDAL did not return an account country.", 502);
  await updateMusicAccountRecord(subject, (record) => {
    const current = record.tidal?.credentials;
    if (!current) return record;
    return {
      ...record,
      tidal: {
        ...record.tidal,
        credentials: { ...current, country_code: country },
      },
    };
  });
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
): Promise<YoutubeTrack[]> {
  const ordered = ids.slice(0, limit).map(tidalId);
  if (!ordered.length) return [];
  const parameters = new URLSearchParams({
    "filter[id]": ordered.join(","),
    include: "artists,albums",
    countryCode,
  });
  const tracks = tracksFromDocument(await tidalApi(subject, `tracks?${parameters.toString()}`), limit);
  const byId = new Map(tracks.map((track) => [tidalId(track.id), track]));
  return ordered.flatMap((id) => byId.get(id) ?? []);
}

async function relationshipTracks(
  subject: string,
  path: string,
  includedRelationship: string,
  countryCode: string,
  limit: number,
): Promise<YoutubeTrack[]> {
  const relationship = await tidalApi(
    subject,
    catalogPath(path, countryCode, includedRelationship),
  );
  return tracksByIds(subject, resourceIdsFromDocument(relationship, "tracks", limit), countryCode, limit);
}

async function searchResourceId(
  subject: string,
  query: string,
  type: "albums" | "artists" | "playlists",
  countryCode: string,
): Promise<string | null> {
  const relationship = await tidalApi(
    subject,
    catalogPath(
      `searchresults/${encodeURIComponent(query)}/relationships/${type}`,
      countryCode,
      type,
    ),
  );
  return resourceIdsFromDocument(relationship, type, 1)[0] ?? null;
}

function tidalId(value: string): string {
  const id = value.startsWith("tidal:") ? value.slice(6) : value;
  if (!id || id.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(id)) throw new TidalMusicError("TIDAL track id is invalid.", 400);
  return id;
}

export async function queryTidal(subject: string, request: { kind: string; primary?: string; secondary?: string; ids?: string[]; limit: number }): Promise<YoutubeTrack[]> {
  const limit = Math.max(1, Math.min(100, request.limit));
  const auth = await credentials(subject);
  const countryCode = await tidalCountryCode(subject, auth);
  if (request.kind === "favorites") {
    if (!auth.user_id) throw new TidalMusicError("Reconnect TIDAL to enable your library.", 401);
    return relationshipTracks(
      subject,
      `userCollections/${encodeURIComponent(auth.user_id)}/relationships/tracks`,
      "tracks",
      countryCode,
      limit,
    );
  }
  if (request.kind === "ids" && request.ids?.length) {
    return tracksByIds(subject, request.ids, countryCode, limit);
  }
  if ((request.kind === "radio" || request.kind === "recommendations") && request.primary) {
    const relationship = request.kind === "radio" ? "radio" : "similarTracks";
    return relationshipTracks(
      subject,
      `tracks/${encodeURIComponent(tidalId(request.primary))}/relationships/${relationship}`,
      relationship,
      countryCode,
      limit,
    );
  }
  if (request.kind === "album_id" && request.primary) {
    return relationshipTracks(
      subject,
      `albums/${encodeURIComponent(collectionId(request.primary, "album"))}/relationships/items`,
      "items",
      countryCode,
      limit,
    );
  }

  const query = [request.primary, request.secondary].filter(Boolean).join(" ").trim()
    || (request.kind === "featured" || request.kind === "top_hits" ? "top hits" : "");
  if (!query) return [];

  const collection = request.kind === "album" || request.kind === "album_artist"
    ? { type: "albums" as const, endpoint: "albums" as const, relationship: "items" }
    : request.kind === "artist"
      ? { type: "artists" as const, endpoint: "artists" as const, relationship: "tracks" }
      : request.kind === "playlist"
        ? { type: "playlists" as const, endpoint: "playlists" as const, relationship: "items" }
        : null;
  if (collection) {
    const id = await searchResourceId(subject, query, collection.type, countryCode);
    if (!id) return [];
    return relationshipTracks(
      subject,
      `${collection.endpoint}/${encodeURIComponent(id)}/relationships/${collection.relationship}`,
      collection.relationship,
      countryCode,
      limit,
    );
  }

  const relationship = request.kind === "featured" || request.kind === "top_hits"
    ? "topHits"
    : "tracks";
  return relationshipTracks(
    subject,
    `searchresults/${encodeURIComponent(query)}/relationships/${relationship}`,
    relationship,
    countryCode,
    limit,
  );
}

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
  ) as { data?: { attributes?: { url?: unknown; trackPresentation?: unknown } } };
  const url = body?.data?.attributes?.url;
  if (body?.data?.attributes?.trackPresentation !== "FULL") {
    throw new TidalMusicError("TIDAL did not authorize full-track playback.", 403);
  }
  if (typeof url !== "string" || !isAllowedTidalStream(url)) throw new TidalMusicError("TIDAL returned an unexpected stream origin.", 502);
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

export async function saveTidalTrack(subject: string, id: string): Promise<void> {
  const auth = await credentials(subject);
  if (!auth.user_id) throw new TidalMusicError("Reconnect TIDAL to enable your library.", 401);
  await tidalApi(subject, `userCollections/${encodeURIComponent(auth.user_id)}/relationships/tracks`, {
    method: "POST",
    body: JSON.stringify({ data: [{ type: "tracks", id: tidalId(id) }] }),
  });
}
