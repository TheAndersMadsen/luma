/*
 * gRPC bridge from Center to the Cosmos backend.
 *
 * .Center spoke REST to webapi.prod.humane.cloud; the Pin spoke gRPC to
 * api.prod.humane.cloud. Cosmos implements the compatible gRPC side, so this
 * module is the translation seam: our /api routes serve .Center's REST contract
 * and call Cosmos's gRPC services underneath.
 *
 * Auth: with COSMOS_AUTH_MODE=development-insecure the server synthesises a
 * principal and no metadata is required. Under edge-authenticated, Istio injects
 * the principal — set COSMOS_PRINCIPAL to forward one in local testing.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  SESSION_TTL_SECONDS,
  openTokens,
  readTokenCookie,
  refreshTokens,
  sealTokens,
  setTokenCookies,
} from "@/server/auth";
import { logWarn } from "@/server/log";

/**
 * Where the recovered wire contracts live.
 *
 * `contracts/wire`, not `cosmos/contracts`: the latter has never existed in this
 * tree, so the default resolved to a missing directory and `loadSync` threw
 * ENOENT deep inside the first gRPC call. Every pane that reads a workload —
 * contacts, account details, my-data, note creation, memory delete — then
 * rendered "cosmos error: …", i.e. the wording reserved for a backend outage,
 * for what was a stale path inside Center. Only the container ever set the
 * override (`COSMOS_CONTRACTS_DIR=/app/contracts`), so the documented
 * `npm run dev` flow was the one that broke.
 */
const PROTO_ROOT = path.resolve(
  process.env.COSMOS_CONTRACTS_DIR ??
    path.join(process.cwd(), "..", "contracts", "wire"),
);

/**
 * Cosmos is a service topology: each workload registers a different set
 * of gRPC services, and in production Istio routes by service name. Locally you
 * run one process per workload, so every service resolves its own endpoint —
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
 * source confirms the split — `webapi` appears nowhere in any APK, and
 * CaptureService has no listing RPC in any of the three independently compiled
 * copies. So captures and notes are read over REST, exactly as .Center did, and
 * only the device-shaped calls go over gRPC.
 */
export const COSMOS_WEBAPI = (process.env.COSMOS_WEBAPI_BASE_URL ?? "").replace(/\/$/, "");
export const COSMOS_WEBAPI_ENABLED = COSMOS_WEBAPI.length > 0;

/**
 * Operator token for Cosmos's admin surface (`/demo-api/admin/*`, `/demo-api/flags`).
 *
 * Cosmos fails those endpoints closed when no token is set, so the console is
 * only reachable when the operator has configured one here AND on the backend —
 * the same secret on both ends. Held server-side and injected by the BFF; it must
 * never reach the browser.
 */
export const COSMOS_ADMIN_TOKEN = process.env.COSMOS_ADMIN_TOKEN ?? "";
export const COSMOS_ADMIN_ENABLED = COSMOS_WEBAPI_ENABLED && COSMOS_ADMIN_TOKEN.length > 0;
const COSMOS_CENTER_PROJECTION_TOKEN = process.env.COSMOS_CENTER_PROJECTION_TOKEN?.trim() ?? "";

/** Authorization header for the admin surface, empty when no token is configured. */
export function adminAuthHeaders(): Record<string, string> {
  return COSMOS_ADMIN_TOKEN ? { authorization: `Bearer ${COSMOS_ADMIN_TOKEN}` } : {};
}

/** Spring Data `Page<T>` — the envelope .Center's Spring Boot backend returned. */
export interface SpringPage<T> {
  content: T[];
  number: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
  first: boolean;
  numberOfElements: number;
  empty: boolean;
}

/**
 * Identity for a REST (webapi) call — the SAME wearer the gRPC path forwards.
 *
 * Without this, `webapiGet` sent no principal, so Cosmos's capture API fell
 * back to its demo account and the dashboard showed that account's captures no
 * matter who was logged in — and a Pin writing under `U:<sub>` was invisible.
 * A logged-in wearer forwards their Bearer token; local dev forwards the static
 * principal under the header the capture API reads (`x-forwarded-client-cert`,
 * the backend default), which the backend collapses through `from_device_cn` to
 * the same `U:<user>` the device writes under.
 */
export async function webapiHeaders(): Promise<Record<string, string>> {
  const bearer = await requestBearer();
  if (bearer) return { authorization: `Bearer ${bearer}` };
  if (PRINCIPAL) return { "x-forwarded-client-cert": PRINCIPAL };
  return {};
}

/**
 * The deadline every call to Cosmos is meant to contain.
 *
 * `webapiGet`/`webapiPost`/`webapiDelete`/`getCaptureOriginal` each spelled this
 * out inline, and the route handlers that talk to `/demo-api` directly — device
 * status, device pairing, the Features pane, the Ai Mic status probe — spelled
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

export async function webapiGet<T>(path: string): Promise<T> {
  // Headers FIRST, deadline second. Object-literal properties evaluate in order,
  // so with `signal:` written above `headers: await webapiHeaders()` the 8s clock
  // started before the auth hop — and a Keycloak refresh slower than that handed
  // `fetch` a signal that had already fired. The failure then arrived as "cosmos
  // webapi timed out", which sends the wearer and whoever is on call to a Cosmos
  // that was answering perfectly the whole time.
  const headers = await webapiHeaders();
  const res = await fetch(`${COSMOS_WEBAPI}${path}`, {
    signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 8000)),
    cache: "no-store",
    headers,
  });
  if (!res.ok) throw new Error(`webapi ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Authenticated web-plane mutation; credentials remain inside the BFF. */
export async function webapiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await webapiHeaders();
  const res = await fetch(`${COSMOS_WEBAPI}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 20000)),
    cache: "no-store",
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`webapi ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Server-to-server read for an already verified, signed public capability. */
export async function webapiGetForUser(path: string, userId: string): Promise<Response> {
  if (!COSMOS_CENTER_PROJECTION_TOKEN) {
    throw new Error("COSMOS_CENTER_PROJECTION_TOKEN is required for public shares");
  }
  return fetch(`${COSMOS_WEBAPI}${path}`, {
    signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 8000)),
    cache: "no-store",
    // This header is generated inside the BFF from a signed capability. It is
    // never copied from the public request.
    headers: {
      "x-forwarded-client-cert": `U:${userId}`,
      "x-cosmos-web-projection-token": COSMOS_CENTER_PROJECTION_TOKEN,
    },
  });
}

export const COSMOS_ENDPOINT = DEFAULT_ENDPOINT;
export const COSMOS_ENABLED =
  DEFAULT_ENDPOINT.length > 0 ||
  Object.values(WORKLOADS).some((w) => (process.env[`COSMOS_ENDPOINT_${w}`] ?? "").length > 0);

/** Which workload serves each service in the Cosmos runtime. */
const SERVICE_WORKLOAD: Record<string, WorkloadKey> = {
  "humane.capture.CaptureService": WORKLOADS.aiBus,
  "humane.capture.TestingAutomationService": WORKLOADS.aiBus,
  "humane.events.DeviceEventsHistoryService": WORKLOADS.notableEvents,
  "humane.events.EventsIngestService": WORKLOADS.notableEvents,
  "humane.contacts.ContactsRPCService": WORKLOADS.contacts,
  "humane.account.UserInformationService": WORKLOADS.account,
  "humane.account.WifiConfigService": WORKLOADS.account,
  "humane.privacy.grpc.pub.PublicPrivacyService": WORKLOADS.aiBus,
};

// Must match the backend's own default (`config.rs` EDGE_PRINCIPAL_HEADER).
// It did not: this said `x-cosmos-authenticated-principal` while the workloads
// read `x-forwarded-client-cert`, so under edge-authenticated the principal we
// send is simply not seen — the call is rejected for having NO principal, which
// looks identical to a failed auth and hides the real cause. Harmless against a
// development-insecure backend (which synthesises a principal regardless), which
// is exactly why it survived unnoticed.
const PRINCIPAL_HEADER =
  process.env.COSMOS_PRINCIPAL_METADATA ?? "x-forwarded-client-cert";
const PRINCIPAL = process.env.COSMOS_PRINCIPAL ?? "";
const DEADLINE_MS = Number(process.env.COSMOS_DEADLINE_MS ?? 8000);

/**
 * The wearer still holds a Center session cookie, but the Keycloak grant behind
 * it can no longer be refreshed — the realm reaps an SSO session after 30
 * minutes idle while this cookie lasts 12 hours, so a wearer who steps away
 * comes back "logged in" to an identity the workloads will not accept.
 *
 * This is deliberately not raised when there is simply no session; that case
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
 * A Center misconfiguration, not a Cosmos outage — and the two must never share
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
        "humane/capture.proto",
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
 * access token as `Authorization: Bearer` — the backend verifies it against
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
    // either side — the workload just answers UNAVAILABLE and looks healthy.
    logWarn("cosmos: outbound gRPC carries no wearer identity");
  }
  // Proof this request traversed a trusted front door. Cosmos workloads gate
  // EVERY gRPC call behind this shared secret (COSMOS_EDGE_TOKEN): the Envoy edge
  // injects it for a Pin, and the Center — a co-located trusted BFF that reaches
  // the workloads directly on the internal network — must present it the same
  // way. Without it every call is rejected ("authenticated edge principal
  // required") and the UI silently falls back to fixtures. Unset (local
  // development-insecure) ⇒ omitted, unchanged.
  const edgeToken = process.env.COSMOS_EDGE_TOKEN?.trim();
  if (edgeToken) {
    // This header name is an external wire ABI shared with the backend. Any
    // configured override must match the backend's edge-header setting.
    md.set(process.env.COSMOS_EDGE_TOKEN_HEADER?.trim() || "x-cosmos-edge-token", edgeToken);
  }
  return md;
}

/**
 * The logged-in wearer's Keycloak access token, refreshed if it is about to
 * expire. Reads the encrypted tokens cookie set at login; returns null outside a
 * request scope or when nobody is logged in, so the caller falls back to the
 * static principal.
 */
async function requestBearer(): Promise<string | null> {
  let sawSession = false;
  try {
    const jar = await cookies();
    let tokens = await openTokens(readTokenCookie(jar));
    if (!tokens) return null;
    sawSession = true;

    const now = Math.floor(Date.now() / 1000);
    if (tokens.expiresAt - now < 60) {
      const refreshed = await refreshTokens(tokens.refreshToken);
      // Send no token rather than a dead one. This is NOT the same as having no
      // session: the wearer holds a valid Center cookie whose Keycloak grant has
      // died underneath it, and the only cure is re-authentication. Returning
      // null here used to make the call go out with no identity at all, which
      // the workloads reported as a missing edge principal — a message that
      // describes a broken topology and sent every reader looking at the wrong
      // layer. Raise it instead so the route can answer 401 and the browser can
      // re-authenticate, which is what the code here always intended.
      if (!refreshed) throw new SessionExpiredError();
      tokens = refreshed;
      // Persist the rotated token so the next request need not refresh again.
      // Cookie writes throw outside a route/action; that is fine — this request
      // still uses the fresh token in hand.
      try {
        setTokenCookies(jar, await sealTokens(refreshed), {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: SESSION_TTL_SECONDS,
        });
      } catch {
        // Not a route/action context; token used but not stored.
      }
    }
    return tokens.accessToken || null;
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    // No request scope (cookies() threw) — nothing to forward. Distinguish it in
    // the log from the two silent nulls above, because all three used to look
    // identical from the outside and none of them left a trace on either side.
    logWarn(
      `cosmos: no wearer identity for this call (${sawSession ? "session read but token unusable" : "no request scope"})`,
    );
    return null;
  }
}

/** Unary call with a deadline; rejects rather than hanging if the backend is down. */
export async function call<TReq extends object, TRes>(
  service: string,
  method: string,
  request: TReq,
): Promise<TRes> {
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
      (error: grpc.ServiceError | null, response: TRes) => {
        if (error) reject(error);
        else resolve(response);
      },
    );
  });
}

export const Services = {
  capture: "humane.capture.CaptureService",
  /** Notes live in Cosmos, not on CaptureService. */
  notes: "humane.capture.TestingAutomationService",
  events: "humane.events.DeviceEventsHistoryService",
  /** Write side: the device — and now the Center Ai Mic chat — ingests NotableEvents here. */
  eventsIngest: "humane.events.EventsIngestService",
  contacts: "humane.contacts.ContactsRPCService",
  account: "humane.account.UserInformationService",
  wifi: "humane.account.WifiConfigService",
  /** Channel-key lifecycle: EstablishWrappingKeys / ImportKeys. */
  privacy: "humane.privacy.grpc.pub.PublicPrivacyService",
} as const;

/**
 * Experience identifiers, verbatim from .Center's own payload. Cosmos stores
 * the same string on NotableEvent.originator_identifier, so these are the join
 * between the two systems.
 */
export const ORIGINATORS = {
  AI_MIC: "humane.experience.answers",
  MUSIC: "humane.experience.music",
  CALL: "humane.experience.dialer",
  TRANSLATION: "humane.experience.translation",
} as const;

export type DomainKey = keyof typeof ORIGINATORS;

/* ------------------------------------------------ google.protobuf.Struct -- */
/*
 * NotableEvent.event_data is a Struct, which proto-loader surfaces in its wire
 * form ({ fields: { k: { stringValue } } }). .Center's UI expects plain JSON, so
 * every read decodes and every write encodes.
 */

type StructValue = Record<string, unknown>;

export function structToJson(struct: unknown): StructValue {
  const fields = (struct as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!fields) return {};
  const out: StructValue = {};
  for (const [key, value] of Object.entries(fields)) out[key] = valueToJson(value);
  return out;
}

function valueToJson(value: unknown): unknown {
  const v = value as Record<string, unknown> | undefined;
  if (!v) return null;
  if (v.kind && typeof v.kind === "string") {
    // oneofs:true surfaces the selected field name in `kind`
    return valueOfKind(v, v.kind as string);
  }
  for (const kind of [
    "stringValue",
    "numberValue",
    "boolValue",
    "structValue",
    "listValue",
    "nullValue",
  ]) {
    if (kind in v) return valueOfKind(v, kind);
  }
  return null;
}

function valueOfKind(v: Record<string, unknown>, kind: string): unknown {
  switch (kind) {
    case "nullValue":
      return null;
    case "structValue":
      return structToJson(v.structValue);
    case "listValue":
      return ((v.listValue as { values?: unknown[] })?.values ?? []).map(valueToJson);
    default:
      return v[kind];
  }
}

export function jsonToStruct(json: StructValue): { fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) fields[key] = jsonToValue(value);
  return { fields };
}

function jsonToValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: "NULL_VALUE" };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(jsonToValue) } };
  return { structValue: jsonToStruct(value as StructValue) };
}

/* ---------------------------------------------------- Ai Mic persistence -- */

type IngestStream = {
  on(event: string, cb: (arg?: unknown) => void): void;
  write(value: unknown): void;
  end(): void;
};

/**
 * Persist one assistant turn as a NotableEvent — the way a Pin does after an
 * interaction — so a `.Center` Ai Mic ask lands in `/my-data/ai-mic` and survives
 * a reload, instead of living only in the chat's React state. Same shape the
 * seeder and a real device write: a plaintext `eventData` Struct
 * `{ request, response }`. The originator stays `humane.experience.answers`,
 * while the observed Ai Mic event type is `humane.respond`.
 * `EventsIngestService.Ingest` is a stream
 * (upsert keyed on `eventIdentifier`); we write the single event and half-close.
 *
 * Best-effort by contract: the wearer already heard the answer, so a persistence
 * failure must never surface as a failed turn — callers swallow the rejection.
 * Pass `md` captured in request scope: the streaming caller's `flush` can run
 * after the cookie async-context is gone.
 */
export async function ingestAnswerEvent(
  qa: { request: string; response: string },
  md?: grpc.Metadata,
): Promise<void> {
  const metadata = md ?? (await requestMetadata());
  const client = getClient(Services.eventsIngest) as unknown as {
    Ingest?: (metadata: grpc.Metadata, options: object) => IngestStream;
  };
  const ingest = client.Ingest;
  if (typeof ingest !== "function") {
    throw new Error("cosmos: EventsIngestService has no Ingest method");
  }
  const now = Date.now();
  const event = {
    eventIdentifier: { value: randomUUID() },
    originatorIdentifier: ORIGINATORS.AI_MIC,
    creationTime: { seconds: String(Math.floor(now / 1000)), nanos: (now % 1000) * 1_000_000 },
    eventType: "humane.respond",
    eventData: jsonToStruct({ request: qa.request, response: qa.response }),
    deviceIsLocked: false,
  };
  await new Promise<void>((resolve, reject) => {
    const stream = ingest.call(client, metadata, {
      deadline: new Date(Date.now() + DEADLINE_MS),
    });
    stream.on("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
    stream.on("end", () => resolve());
    stream.on("data", () => {});
    stream.write(event);
    stream.end();
  });
}
