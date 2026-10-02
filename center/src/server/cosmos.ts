/*
 * Center's shared HTTP and gRPC transport to Cosmos.
 *
 * Domain modules use the recovered web API for cloud records and stock gRPC
 * services for device-shaped operations. Both forward the wearer's Bearer;
 * Cosmos verifies it and authorizes access to the account partition.
 *
 * Local single-identity setups can use COSMOS_PRINCIPAL with the edge proof.
 * Transport deadlines and identity failures stay here. Feature modules map
 * HTTP refusals to application outcomes.
 */

import {
  AUTH_ENABLED,
  AuthUnavailableError,
  openTokens,
  readTokenCookie,
  refreshTokens,
  sealTokens,
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionFromTokens,
  setTokenCookies,
  signSession,
  verifySession,
} from "@/server/auth";
import { logWarn } from "@/server/log";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { cookies } from "next/headers";
import path from "node:path";

/**
 * Where the recovered wire contracts live.
 *
 * `contracts/wire`, not `cosmos/contracts`: the latter has never existed in this
 * tree, so the default resolved to a missing directory and `loadSync` threw
 * ENOENT deep inside the first gRPC call. Every pane that reads a workload,
 * contacts, account details, my-data, note creation, memory delete, then
 * rendered "cosmos error: …", i.e. the wording reserved for a backend outage,
 * for what was a stale path inside Center. Only the container ever set the
 * override (`COSMOS_CONTRACTS_DIR=/app/contracts`), so the documented
 * `pnpm dev` flow was the one that broke.
 */
const PROTO_ROOT = path.resolve(
  process.env.COSMOS_CONTRACTS_DIR ??
    path.join(process.cwd(), "..", "contracts", "wire"),
);

/**
 * Each Cosmos workload registers a different set of gRPC services. Center
 * reaches the workloads directly, so every service resolves its own endpoint,
 * COSMOS_ENDPOINT_<WORKLOAD> if set, else COSMOS_GRPC_ENDPOINT.
 */
export const WORKLOADS = {
  aiBus: "AI_BUS",
  notableEvents: "NOTABLE_EVENTS",
  contacts: "CONTACTS",
  account: "ACCOUNT",
} as const;

type WorkloadKey = (typeof WORKLOADS)[keyof typeof WORKLOADS];

const DEFAULT_ENDPOINT = process.env.COSMOS_GRPC_ENDPOINT ?? "";

function endpointFor(workload: WorkloadKey): string {
  return process.env[`COSMOS_ENDPOINT_${workload}`] ?? DEFAULT_ENDPOINT;
}

/**
 * Cosmos's **web** surface, distinct from its gRPC.
 *
 * Humane ran two APIs: the Pin spoke gRPC to `api.prod.humane.cloud`, and
 * `.Center` spoke REST to `webapi.prod.humane.cloud`. The decompiled device
 * source confirms the split, `webapi` appears nowhere in any APK, and
 * CaptureService has no listing RPC in any of the three independently compiled
 * copies. So captures and notes are read over REST, exactly as .Center did, and
 * only the device-shaped calls go over gRPC.
 */
export const COSMOS_WEBAPI = (process.env.COSMOS_WEBAPI_BASE_URL ?? "").replace(/\/$/, "");
export const COSMOS_WEBAPI_ENABLED = COSMOS_WEBAPI.length > 0;

/**
 * Operator token for Cosmos's admin surface (`/demo-api/admin/*`).
 *
 * Cosmos fails those endpoints closed when no token is set, so the console is
 * only reachable when the operator has configured one here AND on the backend,
 * the same secret on both ends. Held server-side and injected by the BFF. It must
 * never reach the browser.
 */
export const COSMOS_ADMIN_TOKEN = process.env.COSMOS_ADMIN_TOKEN ?? "";
export const COSMOS_ADMIN_ENABLED = COSMOS_WEBAPI_ENABLED && COSMOS_ADMIN_TOKEN.length > 0;

/** Authorization header for the admin surface, empty when no token is configured. */
export function adminAuthHeaders(): Record<string, string> {
  return COSMOS_ADMIN_TOKEN ? { authorization: `Bearer ${COSMOS_ADMIN_TOKEN}` } : {};
}

/**
 * Identity for a REST (webapi) call, the SAME wearer the gRPC path forwards.
 *
 * Without this, `webapiGet` sent no principal, so Cosmos's capture API fell
 * back to its demo account and the dashboard showed that account's captures no
 * matter who was logged in, and a Pin writing under `U:<sub>` was invisible.
 * A logged-in wearer forwards their Bearer token. A single-identity deployment
 * forwards the static principal under the header the capture API reads
 * (`x-forwarded-client-cert`, the backend default), which the backend collapses
 * through `from_device_cn` to the same `U:<user>` the device writes under.
 * Cosmos believes that header only beside the edge proof, so it travels with
 * COSMOS_EDGE_TOKEN exactly as the gRPC metadata does.
 */
export async function webapiHeaders(): Promise<Record<string, string>> {
  const bearer = await requestBearer();
  if (bearer) return { authorization: `Bearer ${bearer}` };
  if (PRINCIPAL) return { "x-forwarded-client-cert": PRINCIPAL, ...edgeProofHeaders() };
  // The gRPC twin (requestMetadata) leaves the same log, because an outbound
  // call with no identity is the signature of a silent auth failure either way.
  logWarn("cosmos: outbound webapi carries no wearer identity");
  return {};
}

/**
 * Proof this request traversed a trusted front door. Cosmos workloads believe a
 * caller-asserted edge principal only beside this shared secret
 * (COSMOS_EDGE_TOKEN): the Envoy edge injects it for a Pin, and the Center, a
 * co-located trusted BFF that reaches the workloads directly on the internal
 * network, must present it the same way. Unset (local development-insecure)
 * sends nothing.
 */
export function edgeProofHeaders(): Record<string, string> {
  const edgeToken = process.env.COSMOS_EDGE_TOKEN?.trim();
  if (!edgeToken) return {};
  // This header name is an external wire ABI shared with the backend. Any
  // configured override must match the backend's edge-header setting.
  return { [process.env.COSMOS_EDGE_TOKEN_HEADER?.trim() || "x-cosmos-edge-token"]: edgeToken };
}

/**
 * The deadline every call to Cosmos is meant to contain.
 *
 * `webapiGet`/`webapiPost`/`webapiDelete` each spelled this
 * out inline, and the route handlers that talk to `/demo-api` directly, device
 * status, device pairing, the Features pane, the Ai Mic status probe, spelled
 * it out nowhere at all, so they were bounded only by undici's 300s default.
 * With a Cosmos that goes SLOW rather than down, those routes' carefully written
 * degraded contracts (`state: "degraded"`, an `unread` count, an honest retry)
 * never got to run: nginx cut the wearer off at 65s while the handler and its
 * upstream socket stayed alive for minutes, and the 30s poll behind them kept
 * stacking more onto a backend that was already struggling.
 *
 * One helper so a new route has an obvious right way to do this.
 */
export function cosmosDeadlineSignal(fallbackMs = 8000): AbortSignal {
  return AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? fallbackMs));
}

export async function webapiGet(path: string): Promise<unknown> {
  return (await webapiGetWithHeaders(path)).body;
}

/**
 * `webapiGet`, keeping Cosmos's response headers for the few reads that answer
 * part of their result in one (the food log counts the entries it could not
 * open in `x-cosmos-sealed`).
 */
export async function webapiGetWithHeaders(
  path: string,
): Promise<{ body: unknown; headers: Headers }> {
  // Headers FIRST, deadline second. Object-literal properties evaluate in order,
  // so with `signal:` written above `headers: await webapiHeaders()` the 8s clock
  // started before the auth hop, and a Keycloak refresh slower than that handed
  // `fetch` a signal that had already fired. The failure then arrived as "cosmos
  // webapi timed out", which sends the wearer and whoever is on call to a Cosmos
  // that was answering perfectly the whole time.
  const headers = await webapiHeaders();
  const res = await fetch(`${COSMOS_WEBAPI}${path}`, {
    signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 8000)),
    cache: "no-store",
    headers,
  });
  if (!res.ok) throw webapiError(path, res.status, headers);
  return { body: await res.json(), headers: res.headers };
}

/** HTTP status is control flow. The diagnostic message may change independently. */
export class CosmosHttpError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`webapi ${path} -> ${status}`);
    this.name = "CosmosHttpError";
  }
}

// A rejected wearer bearer requires reconnection, rather than an outage retry.
export function webapiError(path: string, status: number, headers: Record<string, string>) {
  if (status === 401 && headers.authorization) return rejectedIdentity(`webapi ${path}`);
  return new CosmosHttpError(path, status);
}

// `reason` is the gRPC status text, which names the check that failed (the
// webapi plane logs its own). It never carries the token.
function rejectedIdentity(call: string, reason?: string): SessionExpiredError {
  logWarn(`cosmos: ${call} refused this session's identity; the wearer must sign in again`, reason || undefined);
  return new SessionExpiredError();
}

/**
 * Authenticated web-plane mutation that answers JSON. Credentials remain inside
 * the BFF. A `204` answers `undefined`. Any other non-2xx throws with the same
 * `webapi <path> -> <status>` stem `webapiGet` uses, so `describeWebapi` reads
 * both alike. Deletes under the frozen `{"deleted": bool}` contract use
 * `webapiDelete` (provenance.ts) instead.
 */
export async function webapiRequest(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers = await webapiHeaders();
  const res = await fetch(`${COSMOS_WEBAPI}${path}`, {
    method,
    signal: AbortSignal.timeout(
      Number(process.env.COSMOS_DEADLINE_MS ?? 20000),
    ),
    cache: "no-store",
    headers:
      body === undefined
        ? headers
        : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw webapiError(path, res.status, headers);
  if (res.status === 204) return undefined;
  return await res.json();
}

export function webapiPost(path: string, body?: unknown): Promise<unknown> {
  return webapiRequest("POST", path, body);
}

export function webapiPut(path: string, body?: unknown): Promise<unknown> {
  return webapiRequest("PUT", path, body);
}

/** Headers a byte-range proxy relays from Cosmos. Nothing else crosses. */
const STREAMED_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

/** One `bytes=<start>-<end>` range. Anything else is served whole. */
const SINGLE_BYTE_RANGE = /^bytes=(\d{1,15})?-(\d{1,15})?$/;

/**
 * Stream one web-plane body, a video, or any file too large to buffer,
 * honouring the browser's `Range` so a `<video>` can seek, and hand back a
 * `Response` a route can return as is.
 *
 * The deadline bounds the wait for Cosmos's headers only. `AbortSignal.timeout`
 * on the fetch itself would also abort the body mid-stream, cutting off any
 * download slower than the deadline. The body stops when the browser does:
 * cancelling the returned stream cancels the upstream one.
 *
 * Only a single `bytes=` range is forwarded. Only a `200`/`206` body is
 * relayed. Any other status is returned without Cosmos's error text.
 */
export async function webapiStream(
  path: string,
  request: { range?: string | null; method?: "GET" | "HEAD" } = {},
): Promise<Response> {
  const method = request.method ?? "GET";
  const range = request.range?.trim();
  const headers = await webapiHeaders();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("cosmos webapi timed out", "TimeoutError")),
    Number(process.env.COSMOS_DEADLINE_MS ?? 8000),
  );
  let upstream: Response;
  try {
    upstream = await fetch(`${COSMOS_WEBAPI}${path}`, {
      method,
      signal: deadline.signal,
      cache: "no-store",
      headers: range && SINGLE_BYTE_RANGE.test(range) && range !== "bytes=-"
        ? { ...headers, range }
        : headers,
    });
  } finally {
    clearTimeout(timer);
  }
  const relayed = new Headers({ "cache-control": "private, no-store" });
  for (const name of STREAMED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) relayed.set(name, value);
  }
  const relayBody = method === "GET" && (upstream.status === 200 || upstream.status === 206);
  if (!relayBody) await upstream.body?.cancel();
  // A dropped GET body takes its description with it: a relayed length with
  // no bytes behind it leaves the browser waiting for a body that never comes.
  // A HEAD keeps both, because describing the body is all a HEAD answer does.
  if (!relayBody && method === "GET") {
    relayed.delete("content-length");
    relayed.delete("content-type");
  }
  return new Response(relayBody ? upstream.body : null, {
    status: upstream.status,
    headers: relayed,
  });
}

export const COSMOS_ENDPOINT = DEFAULT_ENDPOINT;
export const COSMOS_ENABLED =
  DEFAULT_ENDPOINT.length > 0 ||
  Object.values(WORKLOADS).some((w) => (process.env[`COSMOS_ENDPOINT_${w}`] ?? "").length > 0);

/** Which workload serves each service in the Cosmos runtime. */
const SERVICE_WORKLOAD: Record<string, WorkloadKey> = {
  "humane.events.DeviceEventsHistoryService": WORKLOADS.notableEvents,
  "humane.contacts.ContactsRPCService": WORKLOADS.contacts,
  "humane.account.WifiConfigService": WORKLOADS.account,
  "humane.privacy.grpc.pub.PublicPrivacyService": WORKLOADS.aiBus,
};

// Must match the backend's own default (`config.rs` EDGE_PRINCIPAL_HEADER).
// It did not: this said `x-cosmos-authenticated-principal` while the workloads
// read `x-forwarded-client-cert`, so under edge-authenticated the principal we
// send is simply not seen, the call is rejected for having NO principal, which
// looks identical to a failed auth and hides the real cause. Harmless against a
// development-insecure backend (which synthesises a principal regardless), which
// is exactly why it survived unnoticed.
const PRINCIPAL_HEADER =
  process.env.COSMOS_PRINCIPAL_METADATA ?? "x-forwarded-client-cert";
const PRINCIPAL = process.env.COSMOS_PRINCIPAL ?? "";
const DEADLINE_MS = Number(process.env.COSMOS_DEADLINE_MS ?? 8000);

/**
 * The wearer still holds a Center session cookie, but the Keycloak grant behind
 * it can no longer be refreshed, the realm reaps an SSO session after 30
 * minutes idle while this cookie lasts 12 hours, so a wearer who steps away
 * comes back "logged in" to an identity the workloads will not accept. The same
 * error covers a session whose encrypted token cookie cannot be opened at all.
 *
 * This is deliberately not raised when there is simply no session. That case
 * keeps returning the ordinary degraded response rather than a misleading 401.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("The Keycloak grant behind this session expired; re-authentication is required.");
    this.name = "SessionExpiredError";
  }
}

/**
 * Center cannot read the .proto files it needs to speak to anything.
 *
 * A Center misconfiguration, not a Cosmos outage, and the two must never share
 * a sentence. Untyped, this surfaced as a bare ENOENT that `describe()` rendered
 * as "cosmos error: …", pointing every reader at a healthy backend. The resolved
 * path is carried so the message can name what to fix.
 */
export class ContractsUnavailableError extends Error {
  readonly root: string;

  constructor(root: string, cause: unknown) {
    super(
      `Center cannot load its protocol definitions from ${root} (set COSMOS_CONTRACTS_DIR)`,
      { cause },
    );
    this.name = "ContractsUnavailableError";
    this.root = root;
  }
}

type AnyClient = grpc.Client & Record<string, Function>;

let packageCache: grpc.GrpcObject | null = null;

function loadPackage(): grpc.GrpcObject {
  if (packageCache) return packageCache;
  let definition: protoLoader.PackageDefinition;
  try {
    definition = protoLoader.loadSync(
      [
        "humane/events.proto",
        "humane/contacts.proto",
        "humane/account.proto",
        "humane/privacy/grpc/pub.proto",
      ],
      {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [PROTO_ROOT],
      },
    );
  } catch (error) {
    throw new ContractsUnavailableError(PROTO_ROOT, error);
  }
  packageCache = grpc.loadPackageDefinition(definition);
  return packageCache;
}

const clients = new Map<string, AnyClient>();

/** Resolves a service by fully-qualified name, e.g. "humane.events.DeviceEventsHistoryService". */
function getClient(fqName: string): AnyClient {
  const existing = clients.get(fqName);
  if (existing) return existing;

  const pkg = loadPackage();
  const ctor = fqName
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], pkg);

  if (typeof ctor !== "function") {
    throw new Error(`cosmos: service ${fqName} not found in the vendored protos`);
  }

  const workload = SERVICE_WORKLOAD[fqName];
  const address = workload ? endpointFor(workload) : DEFAULT_ENDPOINT;
  if (!address) {
    throw new Error(
      `cosmos: no endpoint for ${fqName} — set COSMOS_ENDPOINT_${workload ?? "…"} or COSMOS_GRPC_ENDPOINT`,
    );
  }

  const credentials = process.env.COSMOS_GRPC_TLS === "1"
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();

  const client = new (ctor as new (...args: unknown[]) => AnyClient)(address, credentials);
  clients.set(fqName, client);
  return client;
}

/**
 * Per-request call metadata. When a wearer is logged in, forward their Keycloak
 * access token as `Authorization: Bearer`, the backend verifies it against
 * Keycloak's JWKS and resolves the `U:<sub>` partition, the SAME one their Pin
 * reaches. With no session (local dev, or a non-request context) fall back to
 * the static principal, so the device-only demo keeps working unchanged.
 */
export async function requestMetadata(): Promise<grpc.Metadata> {
  const md = new grpc.Metadata();
  const bearer = await requestBearer();
  if (bearer) {
    md.set("authorization", `Bearer ${bearer}`);
  } else if (PRINCIPAL) {
    md.set(PRINCIPAL_HEADER, PRINCIPAL);
  } else {
    // Neither identity exists, so this call goes out anonymous and the workload
    // will refuse it for want of an edge principal. That is legitimate for the
    // device-only demo, but in a deployment that expects wearer identity it is
    // the signature of a silent auth failure, and it produced no log line on
    // either side, the workload just answers UNAVAILABLE and looks healthy.
    logWarn("cosmos: outbound gRPC carries no wearer identity");
  }
  // Cosmos workloads gate EVERY gRPC call behind the edge proof. Without it
  // every call is rejected ("authenticated edge principal required") and the UI
  // silently falls back to fixtures.
  for (const [name, value] of Object.entries(edgeProofHeaders())) md.set(name, value);
  return md;
}

/**
 * The logged-in wearer's Keycloak access token, refreshed if it is about to
 * expire. Reads the encrypted tokens cookie set at login. Returns null outside a
 * request scope or when nobody is logged in, so the caller falls back to the
 * static principal. A VERIFIED session whose token store cannot be opened is not
 * "nobody": it raises SessionExpiredError instead. A session cookie that does
 * not verify, or any cookie at all while sign-in is off (local `next dev`
 * after a Keycloak run leaves one behind), is nobody: signing in again could
 * not cure it, so it must not be answered as an expiry.
 */
async function requestBearer(): Promise<string | null> {
  let sawSession = false;
  try {
    const jar = await cookies();
    sawSession = AUTH_ENABLED && (await verifySession(jar.get(SESSION_COOKIE)?.value)) !== null;
    let tokens = await openTokens(readTokenCookie(jar));
    if (!tokens) {
      // A signed-in browser whose encrypted bearer cookie cannot be opened is
      // NOT the same as nobody being logged in: the middleware admits the
      // wearer's session, and returning null sent every call out anonymous, or
      // under the static principal, with no log at all. Only signing in again
      // can produce an identity, so raise the expiry exactly as a grant that
      // cannot be refreshed does.
      if (sawSession) throw new SessionExpiredError();
      return null;
    }
    sawSession = true;

    const now = Math.floor(Date.now() / 1000);
    if (tokens.expiresAt - now < 60) {
      const refreshed = await refreshTokens(tokens.refreshToken);
      // Send no token rather than a dead one. This is NOT the same as having no
      // session: the wearer holds a valid Center cookie whose Keycloak grant has
      // died underneath it, and the only cure is re-authentication. Returning
      // null here used to make the call go out with no identity at all, which
      // the workloads reported as a missing edge principal, a message that
      // describes a broken topology and sent every reader looking at the wrong
      // layer. Raise it instead so the route can answer 401 and the browser can
      // re-authenticate, which is what the code here always intended.
      if (!refreshed) throw new SessionExpiredError();
      refreshed.idToken ??= tokens.idToken;
      tokens = refreshed;
      // Persist the rotated token so the next request need not refresh again.
      // Cookie writes throw outside a route/action. That is fine, this request
      // still uses the fresh token in hand.
      try {
        setTokenCookies(jar, await sealTokens(refreshed), sessionCookieOptions);
        const session = sessionFromTokens(refreshed);
        if (session) jar.set(SESSION_COOKIE, await signSession(session, refreshed.expiresAt), sessionCookieOptions);
      } catch {
        // Not a route/action context. Token used but not stored.
      }
    }
    return tokens.accessToken || null;
  } catch (error) {
    if (error instanceof SessionExpiredError || error instanceof AuthUnavailableError) throw error;
    // No request scope (cookies() threw), or a session whose token read failed
    // some other way. Distinguish it in the log from the one silent null above,
    // because these used to look identical from the outside and left no trace
    // on either side.
    logWarn(
      `cosmos: no wearer identity for this call (${sawSession ? "session read but token unusable" : "no request scope"})`,
    );
    return null;
  }
}

/** Unary call with a deadline. Rejects rather than hanging if the backend is down. */
export async function call(
  service: string,
  method: string,
  request: object,
): Promise<unknown> {
  const md = await requestMetadata();
  return new Promise((resolve, reject) => {
    let client: AnyClient;
    try {
      client = getClient(service);
    } catch (error) {
      reject(error);
      return;
    }

    const fn = client[method];
    if (typeof fn !== "function") {
      reject(new Error(`cosmos: ${service} has no method ${method}`));
      return;
    }

    const deadline = new Date(Date.now() + DEADLINE_MS);
    fn.call(
      client,
      request,
      md,
      { deadline },
      (error: grpc.ServiceError | null, response: unknown) => {
        // UNAUTHENTICATED to the wearer's own Bearer: the same verdict as a
        // webapi 401 (see `webapiError`).
        if (
          error?.code === grpc.status.UNAUTHENTICATED &&
          md.get("authorization").length > 0
        ) {
          reject(rejectedIdentity(`${service}.${method}`, error.details));
        } else if (error) reject(error);
        else resolve(response);
      },
    );
  });
}

export const Services = {
  events: "humane.events.DeviceEventsHistoryService",
  contacts: "humane.contacts.ContactsRPCService",
  wifi: "humane.account.WifiConfigService",
  /** Privacy settings: GetSettings / UpdateSettings. */
  privacy: "humane.privacy.grpc.pub.PublicPrivacyService",
} as const;
