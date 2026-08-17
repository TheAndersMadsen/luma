/*
 * The data source behind our /api routes.
 *
 * Every function returns Center's own wire shape, so the UI never learns which
 * backend answered. When nothing is configured, or when Cosmos does not answer,
 * wearer-owned collections are empty and carry explicit absent/degraded
 * provenance. Runtime sample data is never substituted for a wearer's data.
 *
 * Humane ran TWO APIs and so does the clone, so this file talks to both:
 *
 *   REST  (CARRY_WEBAPI_BASE_URL)  — what .Center itself called
 *     captures  -> GET /capture/captures     Spring Data Page<MemoryDto>
 *     notes     -> GET /notes                Spring Data Page<NoteDto>
 *
 *   gRPC  (CARRY_ENDPOINT_<WORKLOAD>)       — what the Pin calls
 *     my-data events    -> DeviceEventsHistoryService.QueryEvents
 *     my-data overview  -> derived from QueryEvents counts
 *     memory delete     -> CaptureService.DeleteMemory
 *
 * The split is not a convenience. The decompiled device source has no capture
 * listing RPC in any of three independently compiled copies of CaptureServiceGrpc,
 * and the string `webapi` appears in no APK — listing only ever existed on the
 * web side. Reading captures over gRPC would be inventing history.
 */

import { ChannelKeyUnavailableError, channelKey, channelKeyForSealed } from "./channel";
import { open as openEnvelope, seal } from "./envelope";
import type { DataFallback, DataState } from "./headers";
import {
  CARRY_ENABLED,
  CARRY_WEBAPI,
  CARRY_WEBAPI_ENABLED,
  ContractsUnavailableError,
  ORIGINATORS,
  Services,
  SessionExpiredError,
  call,
  structToJson,
  webapiGet,
  webapiGetForUser,
  webapiHeaders,
  webapiPost,
  type DomainKey,
  type SpringPage,
} from "./cosmos";
import { logWarn } from "./log";
import type {
  AiMicRecord,
  CaptureRecord,
  DashboardContent,
  MyDataOverviewEntry,
  NoteRecord,
} from "@/lib/types";

export type SourceName = "carry" | "fixtures";

export interface Sourced<T> {
  data: T;
  /** Legacy wire value, still emitted as an alias. Branch on `state`. */
  source: SourceName;
  /**
   * live     — carry answered and this is the wearer's own current data
   * absent   — carry is not configured here, so there is no counterpart at all
   * degraded — carry IS configured and did not answer; `data` is a stand-in
   */
  state: DataState;
  /** What is standing in. Runtime wearer-data fallbacks are always empty. */
  fallback?: DataFallback;
  /** Set when carry was configured but the call failed, so the UI can say so. */
  degraded?: string;
  /**
   * The one degraded cause the WEARER can fix, distinguished from the ones they
   * cannot.
   *
   * Without it every consumer of a `Sourced` had to read `degraded` prose to
   * tell "your Keycloak grant expired, sign in again" from "the backend is
   * down", so the routes answered 502 and the panes blamed a healthy Cosmos —
   * while api/settings/wifi answered the identical error with 401 +
   * reauthenticate. Set only by `failedGrpc`/`failedWebapi` below, and only for
   * `SessionExpiredError`.
   */
  reauthenticate?: true;
  /**
   * How many rows the backend says exist, when `data` is one capped page of
   * them.
   *
   * Cosmos clamps every list to 200 (`MAX_PAGE_SIZE` in capture_api.rs) and
   * Center asks for no page beyond the first, so a wearer past that number holds
   * more than any Center surface can show. The Spring envelope has always
   * carried the honest count beside the rows — deliberately, `StorePage.total`
   * is a separate store count and not `content.len()` — and every list here
   * dropped it on the way through. The counts and the "nothing matched" empty
   * states then read as facts about the wearer's data when they were facts about
   * the first page. This carries the number so a surface can qualify itself; My
   * Data has said "at least N — totals are counted up to that point and no
   * further" for exactly this reason for a long time.
   */
  total?: number;
}

/** carry answered. */
function live<T>(data: T, degraded?: string): Sourced<T> {
  return { data, source: "carry", state: "live", degraded };
}

/**
 * carry is not configured in this deployment. Not a failure and not something a
 * retry can fix — there is simply no backend here.
 */
function unconfigured<T>(data: T, fallback: DataFallback, degraded?: string): Sourced<T> {
  return { data, source: "fixtures", state: "absent", fallback, degraded };
}

/**
 * carry IS configured and did not answer.
 *
 * The caller receives an honest empty value plus `x-data-state: degraded` and
 * `x-data-fallback: empty`. We never make an outage look successful by serving
 * demo or recovered wearer data.
 */
function failed<T>(data: T, degraded: string, fallback: DataFallback): Sourced<T> {
  return { data, source: "fixtures", state: "degraded", fallback, degraded };
}

/**
 * The wearer's session died behind their cookie.
 *
 * One sentence and one machine-readable flag for the whole seam, so a route can
 * answer 401 + `reauthenticate` instead of a 502 that accuses the backend. Same
 * words `describe()` uses, because the same condition must never read as two
 * different things on two panes.
 */
const SESSION_EXPIRED = "Your session expired — sign in again to reload this.";

function expired<T>(data: T): Sourced<T> {
  return {
    data,
    source: "fixtures",
    state: "degraded",
    fallback: "empty",
    degraded: SESSION_EXPIRED,
    reauthenticate: true,
  };
}

/**
 * A failed gRPC call, with the expiry told apart from the outage.
 *
 * Every `catch` in this file that degrades a workload call goes through here.
 * The bug this closes is not a missing typed error — it is that the typed error
 * existed and was flattened into prose the moment it reached `describe()`, so
 * the layer that could act on it (the route) never saw it.
 */
function failedGrpc<T>(data: T, error: unknown): Sourced<T> {
  if (error instanceof SessionExpiredError) return expired(data);
  return failed(data, describe(error), "empty");
}

/** The REST half of the same rule; `describeWebapi` names the plane, not the wearer. */
function failedWebapi<T>(data: T, error: unknown): Sourced<T> {
  if (error instanceof SessionExpiredError) return expired(data);
  return failed(data, describeWebapi(error), "empty");
}

/**
 * google.protobuf.Timestamp → ISO string, or "" when there is no timestamp.
 *
 * `creation_time` is an optional submessage and every layer beneath Center
 * treats its absence as genuine: the proto declares it optional, proto-loader
 * yields null, the Cosmos store columns are nullable and it orders such rows
 * NULLS LAST. Center was the only layer that invented a value — this returned
 * `new Date().toISOString()`, i.e. NOW — on the one surface whose whole job is
 * telling the wearer what was recorded and when.
 *
 * What that did: the row rendered with today's date and was counted in My Data's
 * "Today" tile, while `timestampMs` — the other reader of the same field, ten
 * lines down — scored it 0 and sorted it to the very bottom of the list. So the
 * wearer saw a today-stamped row at the end of a newest-first list, and a Today
 * counter that included an event which may be years old. Two helpers over one
 * field, disagreeing about the absent case, and both of them guessing.
 *
 * Empty string rather than null keeps `EventEnvelope.userCreatedAt` a string for
 * every consumer; `formatTimestamp` renders it as "Time unknown" and the Today
 * filter cannot count it, because an unparseable date compares false.
 */
function tsToIso(ts: { seconds?: string | number; nanos?: number } | undefined): string {
  if (!ts?.seconds) return "";
  const ms = Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
  return new Date(ms).toISOString();
}

/* ---------------------------------------------------- webapi deletes ------ */

/**
 * What a delete actually did, in the backend's own word.
 *
 * Never inferred from a 2xx. The REST contract answers **200 for "there was
 * nothing of yours to delete" too**, so a status code cannot tell the two apart
 * and treating the happy code as done is precisely the silent lie this whole
 * path exists to stop. A privacy product may not say "deleted" on a guess.
 */
export interface Deleted {
  deleted: boolean;
}

/** No REST plane here at all, so nothing was — or could be — removed. */
const WEBAPI_UNSET_FOR_DELETE =
  "CARRY_WEBAPI_BASE_URL is unset - there is no backend here to delete from, so nothing was deleted";

/**
 * The backend answered, and answered `false`: no row of this wearer's matched.
 *
 * Not an error and not a success. It is what a delete against recovered sample
 * data looks like, and what a second click after a first delete looks like.
 */
const NOTHING_MATCHED =
  "carry found nothing to delete for this account - it may already be gone, or it was never stored here";

/**
 * `webapiGet`'s counterpart — the one delete verb the REST webapi speaks.
 *
 * Same base URL, same deadline, and the same wearer identity: without
 * `webapiHeaders` the clone resolves its demo principal, and a delete aimed at
 * the wrong partition either misses silently or lands where it was never this
 * caller's to land. The backend scopes every delete to the principal it
 * resolves, so identity here is a correctness property, not a nicety.
 *
 * The body is frozen by contract:
 *
 *   200 {"deleted": true}   a row existed for this principal and is gone
 *   200 {"deleted": false}  nothing matched for this principal
 *   500                     store outage ONLY — never "not found"
 *
 * So the boolean is returned rather than collapsed into thrown/not-thrown.
 * Anything else throws and the caller reports a failure — never a delete.
 */
async function webapiDelete(path: string): Promise<boolean> {
  // Headers first, then the deadline — same reason as webapiGet: written the
  // other way round, the timeout is spent on the auth hop and a slow Keycloak is
  // reported to the wearer as a webapi that timed out.
  const headers = await webapiHeaders();
  const res = await fetch(`${CARRY_WEBAPI}${path}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(Number(process.env.CARRY_DEADLINE_MS ?? 8000)),
    cache: "no-store",
    headers,
  });
  // Same message stem webapiGet throws, so describeWebapi reads it the same way.
  if (!res.ok) throw new Error(`webapi ${path} -> ${res.status}`);

  const body = (await res.json().catch(() => null)) as { deleted?: unknown } | null;
  // A 200 carrying no `deleted` field is a backend that is not speaking this
  // contract. Report the outage rather than telling a wearer their data is gone.
  if (!body || typeof body.deleted !== "boolean") {
    throw new Error(`webapi ${path} -> 200 without a "deleted" field`);
  }
  return body.deleted;
}

/* ------------------------------------------------------------------ notes -- */

/** Authenticated `.Center` projection returned by `GET /notes`. */
import { mapCarryNote, type CarryNoteDto } from "@/lib/noteMapping";

/**
 * The stock page size the `.Center` client asked for, and the default for every
 * list here, so /api/capture/notes and /api/capture/captures still mirror the
 * original verbatim.
 *
 * It is a DEFAULT rather than a constant because the Memories dashboard renders
 * three note slots and one photo tile, and used to download two hundred of each
 * — every note decrypted server side on the way — every five seconds to fill
 * them. A caller that needs the whole page still asks for the whole page.
 */
const STOCK_PAGE_SIZE = 200;

/**
 * Read notes through Carry's authenticated web projection.
 *
 * The device-facing gRPC response must remain ciphertext, and Center's local
 * channel key is unrelated to a physical Pin's key. Trying that local key made
 * every device-created note look permanently encrypted. The web endpoint keeps
 * ciphertext at rest and returns title/text only after Carry verifies the web
 * bearer and opens the envelope with the owning device key.
 */
export async function getNotesPage(
  size: number = STOCK_PAGE_SIZE,
): Promise<Sourced<SpringPage<CarryNoteDto>>> {
  const emptyPage: SpringPage<CarryNoteDto> = {
    content: [],
    number: 0,
    size: 0,
    totalElements: 0,
    totalPages: 0,
    last: true,
    first: true,
    numberOfElements: 0,
    empty: true,
  };
  // Authenticated wearer data must never be replaced by recovered sample notes.
  if (!CARRY_WEBAPI_ENABLED) {
    return unconfigured(
      emptyPage,
      "empty",
      "CARRY_WEBAPI_BASE_URL is unset - this Center cannot read the wearer's notes",
    );
  }
  try {
    const page = await webapiGet<SpringPage<CarryNoteDto>>(
      `/notes?size=${boundedPageSize(size)}&sort=createdAt,DESC`,
    );
    const sealedCount = page.content.filter((note) => note.sealed !== false).length;
    // Sealed is a fourth, separate idea: the content exists and is end-to-end
    // encrypted. The read succeeded, so the state is live.
    return live(
      page,
      sealedCount
        ? `${sealedCount} note(s) sealed under a key this dashboard does not hold`
        : undefined,
    );
  } catch (error) {
    return failedWebapi(emptyPage, error);
  }
}

export async function getNotes(size: number = STOCK_PAGE_SIZE): Promise<Sourced<NoteRecord[]>> {
  const page = await getNotesPage(size);
  return { ...page, data: page.data.content.map(mapCarryNote) };
}

/**
 * Cosmos clamps a page to `MAX_PAGE_SIZE` (capture_api.rs) and rejects nothing,
 * so an out-of-range ask is silently reinterpreted. Bound it here too, where the
 * caller can still be told what it will get.
 */
function boundedPageSize(size: number): number {
  if (!Number.isFinite(size)) return STOCK_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(size), 1), STOCK_PAGE_SIZE);
}

/**
 * Seals the note under the wearer's channel key, which is the only way to write
 * one.
 *
 * Every failure here is `degraded`, never `unconfigured`. Carry IS configured —
 * the `CARRY_ENABLED` guard above already answered that question — so `absent`
 * would be a false claim about the deployment, and it is the one state
 * /api/health and SourceBadge read as healthy. A wearer whose note did not save
 * must see a surface that says something went wrong.
 */
export async function createNote(input: { title?: string; text: string }): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) {
    return unconfigured(null, "empty", "carry not configured; note not persisted");
  }
  try {
    const channel = await channelKey();
    const body = Buffer.from(JSON.stringify({ title: input.title, text: input.text }), "utf8");
    await call(Services.notes, "CreateNote", {
      encryptedNote: {
        data: seal(channel.kid, channel.key, body),
        encryptionInformation: { kid: channel.kid },
      },
    });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/**
 * One capture frame, opened. The clone hands back the sealed envelope and the
 * key stays here, so the server never needs the plaintext to serve a picture.
 */
export async function getCaptureFrame(
  uuid: string,
  index: number,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!CARRY_WEBAPI_ENABLED) return null;
  try {
    // Same wearer identity as every other webapi read, or the frame resolves in
    // the demo account rather than the caller's and 404s. Resolved BEFORE the
    // deadline is started, so the clock covers the backend call rather than
    // being spent on a slow token refresh.
    const headers = await webapiHeaders();
    const res = await fetch(`${CARRY_WEBAPI}/capture/memory/${encodeURIComponent(uuid)}/thumbnail/${index}`, {
      cache: "no-store",
      headers,
      /*
       * The only webapi call in this file that had no deadline. Every sibling —
       * webapiGet, webapiPost, webapiDelete, getCaptureOriginal twenty lines
       * down — bounds the same host at CARRY_DEADLINE_MS; nothing says this one
       * is meant to be different (the prose that calls it "deliberately
       * different" is about buffering, not timeouts).
       *
       * With a Cosmos that accepts the connection and then stops answering, each
       * of the dozen tiles on a grid parked on undici's 300s default: twelve
       * route handlers and twelve upstream sockets held for five minutes each
       * against a backend that is already sick, three times over as the browser
       * retried, while nginx had already 504'd the wearer at 65s. A TimeoutError
       * lands in the catch below, is not a SessionExpiredError, and so returns
       * null — the route's 404 and the tile's honest "Media unavailable", which
       * is what should have happened in the first place.
       */
      signal: AbortSignal.timeout(Number(process.env.CARRY_DEADLINE_MS ?? 8000)),
    });
    if (!res.ok) return null;
    const payload = Buffer.from(await res.arrayBuffer());
    const projection = res.headers.get("x-carry-projection");
    const servedType = res.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";

    // Carry releases plaintext only after verifying the web Bearer and
    // authenticating the stock Capture/Thumbnail HMSA binding. Do not run that
    // JPEG through Center's unrelated HMCT channel key.
    if (projection === "opened" && servedType.startsWith("image/")) {
      return { bytes: payload, contentType: servedType };
    }

    // Backward-compatible clone-authored HMCT path. Older/local backends return
    // application/octet-stream and leave decryption to this BFF.
    //
    // Resolved from the envelope's OWN kid, not from this request's current key:
    // a frame sealed before the derived kid changed shape is still this wearer's
    // frame, and opening it with the wrong key of theirs fails the GCM tag and
    // is then reported below as if the capture were the problem.
    const channel = await channelKeyForSealed(payload);
    const bytes = openEnvelope(channel.key, payload);
    return { bytes, contentType: sniff(bytes) };
  } catch (error) {
    // A bare `catch {}` here is what re-hid the failure the typed error was
    // introduced to make visible: an expired Keycloak grant became "frame
    // unavailable", i.e. a claim about the capture, on a pane whose sibling
    // (api/settings/wifi) answers the identical error with 401 + reauthenticate.
    // Rethrow the one the caller can act on, and leave a trace for the rest —
    // this used to be the only image path in Center that could fail silently.
    if (error instanceof SessionExpiredError) throw error;
    logWarn(`capture frame ${uuid}/${index} could not be opened`, error);
    return null;
  }
}

/** A capture body still in flight, plus the type the projection declared. */
export interface CaptureStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

/**
 * The same bytes, in the one shape `BodyInit` accepts.
 *
 * `new Response(buffer)` works perfectly at runtime, but TypeScript rejects it:
 * a Node `Buffer` is `Uint8Array<ArrayBufferLike>`, which could in principle be
 * backed by a `SharedArrayBuffer`, and `BufferSource` will not take that. The
 * obvious appeasement — `new Response(new Uint8Array(bytes))` — satisfies the
 * type by ALLOCATING AND COPYING the entire picture on every request, which is
 * what these routes used to do.
 *
 * This takes a view over the same memory instead (honouring `byteOffset`, since
 * `Buffer.allocUnsafe` hands out slices of a shared pool) and asserts the one
 * fact the type system cannot see: bytes that came from `fetch` or
 * `Buffer.concat` are never shared-memory backed.
 */
export function responseBytes(bytes: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ) as Uint8Array<ArrayBuffer>;
}

/**
 * Open the full-resolution file the stock photography worker uploaded.
 *
 * Returned as a STREAM. Every check this makes reads response headers — the
 * `x-carry-projection` verdict and the content type — and none of them reads the
 * body, so there is no reason to hold a full-resolution original in the BFF's
 * heap before handing it on. `getCaptureFrame` above is deliberately different:
 * its legacy HMCT branch opens an envelope over the whole buffer and must
 * materialise it.
 */
export async function getCaptureOriginal(
  uuid: string,
  file: number,
): Promise<CaptureStream | null> {
  if (!CARRY_WEBAPI_ENABLED) return null;
  // Headers first, then the deadline — see webapiGet.
  const headers = await webapiHeaders();
  const res = await fetch(
    `${CARRY_WEBAPI}/capture/memory/${encodeURIComponent(uuid)}/file/${file}`,
    {
      signal: AbortSignal.timeout(Number(process.env.CARRY_DEADLINE_MS ?? 8000)),
      cache: "no-store",
      headers,
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`capture original projection -> ${res.status}`);
  const contentType = assertOpenedImage(res, "capture original");
  if (!res.body) throw new Error("capture original projection returned no body");
  return { body: res.body, contentType };
}

/**
 * Open a frame for the wearer named by a verified public share capability.
 *
 * Buffered, unlike the original above, and deliberately: the public
 * `/share/{token}` page inlines this frame as a `data:` URI, so the bytes have
 * to exist in full on the server either way. Streaming it would only move the
 * copy, not remove it.
 */
export async function getSharedCaptureFrame(
  uuid: string,
  index: number,
  userId: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!CARRY_WEBAPI_ENABLED) return null;
  const res = await webapiGetForUser(
    `/capture/memory/${encodeURIComponent(uuid)}/thumbnail/${index}`,
    userId,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`shared capture projection -> ${res.status}`);
  const contentType = assertOpenedImage(res, "shared capture");
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType };
}

/**
 * The projection verdict, decided from headers alone.
 *
 * A response that is sealed or not an image is refused rather than forwarded:
 * releasing it would mean serving ciphertext (or whatever else) under an
 * `image/*` promise. Cancelling the body is what stops that refusal from leaking
 * the connection it just declined to read.
 */
function assertOpenedImage(res: Response, what: string): string {
  const contentType = res.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (res.headers.get("x-carry-projection") !== "opened" || !contentType.startsWith("image/")) {
    void res.body?.cancel().catch(() => undefined);
    throw new Error(`${what} projection returned sealed or non-image data`);
  }
  return contentType;
}

/** Content type from the bytes themselves — the envelope carries no hint. */
function sniff(bytes: Buffer): string {
  const head = bytes.subarray(0, 16).toString("latin1");
  if (head.startsWith("\x89PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (head.startsWith("RIFF")) return "image/webp";
  if (head.trimStart().startsWith("<svg") || head.trimStart().startsWith("<?xml")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

export async function deleteAllNotes(): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) {
    return unconfigured(null, "empty", "carry not configured; nothing deleted");
  }
  try {
    await call(Services.notes, "DeleteAllNotes", {});
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/**
 * One note, deleted — the thing the notes surface could not do.
 *
 * Until now the only delete this backend held was `DeleteAllNotes`: a wearer who
 * wanted one note gone had to drop every note they had ever written. The single
 * delete is REST, not gRPC, and deliberately so — `.Center` was a web app and
 * called the webapi; inventing an RPC in the recovered protos would be inventing
 * history (see the frozen delete contract).
 *
 * Reads and single-row deletes use the same authenticated REST plane, so both
 * resolve the same bearer to the same wearer partition.
 */
export async function deleteNote(uuid: string): Promise<Sourced<Deleted>> {
  if (!CARRY_WEBAPI_ENABLED) {
    return unconfigured({ deleted: false }, "empty", WEBAPI_UNSET_FOR_DELETE);
  }
  try {
    const deleted = await webapiDelete(`/notes/${encodeURIComponent(uuid)}`);
    // `live` either way: the backend answered. The DEGRADED clause on the false
    // arm is what stops the caller reading a truthful "nothing matched" as done.
    return deleted ? live({ deleted: true }) : live({ deleted: false }, NOTHING_MATCHED);
  } catch (error) {
    return failedWebapi({ deleted: false }, error);
  }
}

/* ----------------------------------------------------------- my data ------ */

interface CarryEvent {
  eventIdentifier?: { value?: string };
  originatorIdentifier?: string;
  creationTime?: { seconds?: string | number; nanos?: number };
  /** google.protobuf.Struct — wire form, decode with structToJson. */
  eventData?: unknown;
  eventType?: string;
}

/** Maps a carry NotableEvent onto .Center's `{uuid, userCreatedAt, data:{eventData}}`. */
function toCenterEvent(e: CarryEvent) {
  return {
    uuid: e.eventIdentifier?.value ?? crypto.randomUUID(),
    userCreatedAt: tsToIso(e.creationTime),
    // event_data is a protobuf Struct on the wire; the UI wants plain JSON.
    data: { eventData: structToJson(e.eventData) },
  };
}

/**
 * QueryEvents does not promise an order. The dashboard renders the first Ai Mic
 * row, so order it here once for every consumer: newest first, then UUID as a
 * stable tie-breaker for events created in the same clock tick.
 */
function compareEventsNewestFirst(a: CarryEvent, b: CarryEvent): number {
  const aMs = timestampMs(a.creationTime);
  const bMs = timestampMs(b.creationTime);
  if (aMs !== bMs) return bMs - aMs;
  return (b.eventIdentifier?.value ?? "").localeCompare(a.eventIdentifier?.value ?? "");
}

function timestampMs(ts: CarryEvent["creationTime"]): number {
  const seconds = Number(ts?.seconds ?? 0);
  if (!Number.isFinite(seconds)) return 0;
  return seconds * 1000 + Math.floor((ts?.nanos ?? 0) / 1e6);
}

const NOTABLE_EVENTS_UNSET =
  "Carry gRPC is unset - this Center cannot read the wearer's notable events";

export async function getEvents(domain: DomainKey, max = 200): Promise<Sourced<unknown[]>> {
  // Never substitute recovered wearer data on an authenticated My Data route.
  // Empty + provenance is both safe and loud in the UI.
  if (!CARRY_ENABLED) return unconfigured([], "empty", NOTABLE_EVENTS_UNSET);
  try {
    const res = await call<
      { filters: { eventOriginatorId: string }; maxResults: number },
      { events?: CarryEvent[] }
    >(Services.events, "QueryEvents", {
      filters: { eventOriginatorId: ORIGINATORS[domain] },
      maxResults: max,
    });
    return live([...(res.events ?? [])].sort(compareEventsNewestFirst).map(toCenterEvent));
  } catch (error) {
    return failedGrpc([], error);
  }
}

/**
 * Forget one notable event — the trash control on every My Data row.
 *
 * That control has been rendered since the recovered original and has never had
 * a backend: `events.proto` carries only QueryEvents / Ingest / IngestBatch, so
 * there is no delete RPC to call and the button sat disabled. The clone's webapi
 * now exposes `DELETE /event/:id`, scoped to the caller's principal, which is
 * how the real .Center must have done it — it was a web app talking REST.
 *
 * Events are read over gRPC and deleted over REST, so the two planes have to
 * agree on who the wearer is. They do: `webapiHeaders` forwards the same Bearer
 * (or the same static principal) that `requestMetadata` sends, and the backend
 * collapses both to one `U:<user>` partition.
 */
export async function deleteEvent(eventIdentifier: string): Promise<Sourced<Deleted>> {
  if (!CARRY_WEBAPI_ENABLED) {
    return unconfigured({ deleted: false }, "empty", WEBAPI_UNSET_FOR_DELETE);
  }
  try {
    const deleted = await webapiDelete(`/event/${encodeURIComponent(eventIdentifier)}`);
    return deleted ? live({ deleted: true }) : live({ deleted: false }, NOTHING_MATCHED);
  } catch (error) {
    return failedWebapi({ deleted: false }, error);
  }
}

const OVERVIEW_META: Array<{ key: DomainKey; label: string; href: string }> = [
  { key: "AI_MIC", label: "Ai Mic", href: "/my-data/ai-mic" },
  { key: "CALL", label: "Calls", href: "/my-data/calls" },
  { key: "MUSIC", label: "Music", href: "/my-data/music" },
  { key: "TRANSLATION", label: "Translation", href: "/my-data/translation" },
];

/**
 * How far one overview tile counts.
 *
 * `DeviceEventsHistoryService` carries QueryEvents, Ingest and IngestBatch and
 * nothing else, so there is no count RPC: a total here is the LENGTH of what
 * came back, and every event that comes back is web-plane decrypted server side
 * (`project_event_for_web`) to produce one integer. The cap bounds that work; it
 * does not make it cheap, and past the cap the total is a floor rather than a
 * count — which is why reaching it is now said out loud instead of quietly
 * plateauing. Retiring both properly needs a counting endpoint on Cosmos.
 */
const OVERVIEW_MAX_RESULTS = 1000;

export async function getMyDataOverview(): Promise<Sourced<MyDataOverviewEntry[]>> {
  if (!CARRY_ENABLED) return unconfigured([], "empty", NOTABLE_EVENTS_UNSET);
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const entries = await Promise.all(
      OVERVIEW_META.map(async (meta) => {
        const res = await call<
          { filters: { eventOriginatorId: string }; maxResults: number },
          { events?: CarryEvent[] }
        >(Services.events, "QueryEvents", {
          filters: { eventOriginatorId: ORIGINATORS[meta.key] },
          maxResults: OVERVIEW_MAX_RESULTS,
        });
        const events = res.events ?? [];
        // An event with no creation time is not evidence that it happened today.
        // It used to be counted as one, because tsToIso substituted the current
        // time for the missing value.
        const today = events.filter((e) => {
          const when = new Date(tsToIso(e.creationTime));
          return !Number.isNaN(when.getTime()) && when >= startOfDay;
        }).length;
        return { ...meta, today, total: events.length };
      }),
    );

    // The store returns newest first, so a capped domain has counted its recent
    // events exactly and stopped; the tile's "Total" is then a lower bound. Say
    // which domains that applies to rather than reporting the cap as a count.
    const capped = entries.filter((entry) => entry.total >= OVERVIEW_MAX_RESULTS);
    return live(
      entries,
      capped.length > 0
        ? `${capped.map((entry) => entry.label).join(", ")}: at least ${OVERVIEW_MAX_RESULTS} events - totals are counted up to that point and no further`
        : undefined,
    );
  } catch (error) {
    return failedGrpc([], error);
  }
}

/**
 * Is the gRPC plane answering, for this wearer?
 *
 * /api/health used to ask this by calling `getMyDataOverview()` — four
 * QueryEvents at a thousand results each, every one of them decrypted server
 * side — from the SourceBadge in the chrome of every page, every 60 seconds,
 * to decide a single boolean. That made the honesty endpoint the heaviest call
 * in the system and put it first in line to blow CARRY_DEADLINE_MS, at which
 * point the badge reports a healthy backend as unreachable.
 *
 * One originator, one result, and a one-hour window so the store's WHERE clause
 * does the narrowing rather than a truncate after the fact. It exercises the
 * same service, the same metadata and the same wearer identity the panes use, so
 * it fails exactly when they do. Carries no data — the answer is the state.
 */
export async function getGrpcHealth(): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) return unconfigured(null, "empty", NOTABLE_EVENTS_UNSET);
  const since = Math.floor(Date.now() / 1000) - 3600;
  try {
    await call<
      {
        filters: { eventOriginatorId: string; eventStartTime: { seconds: string; nanos: number } };
        maxResults: number;
      },
      { events?: CarryEvent[] }
    >(Services.events, "QueryEvents", {
      filters: {
        eventOriginatorId: ORIGINATORS.AI_MIC,
        eventStartTime: { seconds: String(since), nanos: 0 },
      },
      maxResults: 1,
    });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/* ---------------------------------------------------------- memories ------ */

/**
 * Captures, read over the clone's REST webapi.
 *
 * There is no gRPC listing RPC and there never was: three independently
 * compiled copies of `CaptureServiceGrpc` agree on the same 11 methods, all
 * create/delete/upload. Listing existed only on the web side, which is where
 * this reads from — `GET /capture/captures`, the path .Center itself called.
 *
 * Bodies stay sealed. The API returns the capture *index* — what exists, its
 * type, when, whether the upload finished — never decrypted bytes.
 */
interface MemoryDto {
  uuid: string;
  id: number;
  deviceLocalId: string;
  type: "PHOTO" | "VIDEO" | "FOODLOG" | "NOTE";
  userCreatedAt: number | null;
  createdAt: number;
  uploadComplete: boolean;
  deleted: boolean;
  thumbnailCount: number;
  frameCount: number;
  bestFrameIndex: number | null;
  bestFrameMethod: string | null;
  bestFrameReason: string | null;
  hasLocation: boolean;
  burstCount: number;
  sealed: boolean;
}

/**
 * Not a failure: the REST half simply is not deployed here. The UI still needs
 * an explanation so an empty result does not imply the wearer has no captures.
 */
const WEBAPI_UNSET =
  "CARRY_WEBAPI_BASE_URL is unset - this Center cannot read the wearer's captures";

function memoryDtoToCapture(m: MemoryDto): CaptureRecord {
  return {
    uuid: m.uuid,
    userCreatedAt: new Date((m.userCreatedAt ?? m.createdAt) * 1000).toISOString(),
    data: {
      thumbnail: { fileUUID: "", accessToken: "" },
      memoryType: m.type,
      uploadComplete: m.uploadComplete,
      thumbnailCount: m.thumbnailCount,
      frameCount: m.frameCount,
      bestFrameIndex: m.bestFrameIndex ?? undefined,
      bestFrameMethod: m.bestFrameMethod ?? undefined,
      bestFrameReason: m.bestFrameReason ?? undefined,
      sealed: m.sealed,
    },
  };
}

/**
 * `size` defaults to the stock page the `.Center` client asked for, so
 * /api/capture/captures still mirrors the original. It is a parameter because
 * the Memories dashboard renders ONE photo tile and used to fetch two hundred
 * capture rows every five seconds to fill it.
 */
export async function getCaptures(
  size: number = STOCK_PAGE_SIZE,
): Promise<Sourced<CaptureRecord[]>> {
  if (!CARRY_WEBAPI_ENABLED) return unconfigured([], "empty", WEBAPI_UNSET);
  try {
    const page = await webapiGet<SpringPage<MemoryDto>>(
      `/capture/captures?size=${boundedPageSize(size)}`,
    );
    const data = page.content.map(memoryDtoToCapture);
    // `totalElements` is the store's own count, not this page's length, so it is
    // the only thing here that can tell a wearer their library is bigger than
    // the grid. Dropping it is what let the capture surfaces present one capped
    // page as the whole of someone's photos.
    return { ...live(data), total: page.totalElements };
  } catch (error) {
    return failedWebapi([], error);
  }
}

export async function getCapture(uuid: string): Promise<CaptureRecord | null> {
  if (!CARRY_WEBAPI_ENABLED) return null;
  const memory = await webapiGet<MemoryDto>(`/capture/memory/${encodeURIComponent(uuid)}`);
  return memoryDtoToCapture(memory);
}

export interface BestFrameResult {
  frame: number;
  method: "vision_v1" | "quality_v1" | "manual" | string;
  reason: string;
}

/** Ask Carry to rank an already-uploaded burst; it caches the answer. */
export async function rankCapture(uuid: string, force = false): Promise<BestFrameResult> {
  if (!CARRY_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return webapiPost<BestFrameResult>(
    `/capture/memory/${encodeURIComponent(uuid)}/best_photo${force ? "?force=true" : ""}`,
  );
}

/** Wearer override of the automatic choice; every original remains stored. */
export async function setCaptureBestFrame(
  uuid: string,
  frame: number,
): Promise<BestFrameResult> {
  if (!CARRY_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return webapiPost<BestFrameResult>(
    `/capture/memory/${encodeURIComponent(uuid)}/bestFrame?frame=${frame}`,
  );
}

/**
 * Is the REST plane answering? The smallest question that exercises the same
 * host, the same auth and the same path the capture grid reads.
 *
 * This exists because /api/health used to probe the gRPC plane alone. The two
 * are separate processes on separate ports with different credentials
 * (`webapiHeaders` sends no CARRY_EDGE_TOKEN), so a healthy gRPC side says
 * nothing about whether captures are the wearer's own. With the REST side down,
 * the capture surface stays empty and reports its degraded state.
 *
 * `size=1` is the smallest question, and — unlike when this comment was first
 * written — it is now genuinely the cheapest one. Cosmos used to materialise
 * every capture the wearer owned, one filesystem read apiece for the best-frame
 * metadata, and slice the page afterwards, so `size=1` cost exactly what
 * `size=200` cost. The window is resolved before the store is asked anything now
 * (`PageQuery::window`, capture_api.rs) and reaches SQL as `LIMIT/OFFSET`
 * (`memory_page`, store_postgres.rs), so this probe is one `COUNT(*)`, one
 * one-row `SELECT` of index columns only, and one best-frame read.
 *
 * The `COUNT(*)` is what is left: the Spring envelope has to report how many
 * rows exist even on an empty final page, so a liveness probe still pays for a
 * number nothing here reads. Retiring that needs the Cosmos half this cannot
 * reach — a real liveness route.
 *
 * Carries no data — the answer is the state, not the page.
 */
export async function getWebapiHealth(): Promise<Sourced<null>> {
  if (!CARRY_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  try {
    await webapiGet<SpringPage<MemoryDto>>("/capture/captures?size=1");
    return live(null);
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/**
 * `DeleteMemoryResponse.status` — the backend's own word for what it did.
 *
 * SUCCESS and NOT_FOUND both mean the capture is gone (NOT_FOUND is what a
 * concurrent delete looks like). Everything else is the backend saying, inside
 * a perfectly successful gRPC response, that it did NOT delete this — an
 * unwritable object store answers FAILURE with the wearer's bytes intact. That
 * used to be reported as a completed delete: the tile vanished and the capture
 * came back on the next refetch.
 */
const DELETE_DONE = new Set(["DELETE_MEMORY_STATUS_SUCCESS", "DELETE_MEMORY_STATUS_NOT_FOUND"]);

/** Read after the word "carry", so each reads as a sentence about the backend. */
const DELETE_REFUSED: Record<string, string> = {
  DELETE_MEMORY_STATUS_FAILURE: "answered FAILURE: it deleted nothing",
  DELETE_MEMORY_STATUS_NOT_AUTHORIZED:
    "answered NOT_AUTHORIZED: this account may not delete that capture",
  DELETE_MEMORY_STATUS_UNSPECIFIED: "returned no delete status, so nothing is confirmed deleted",
};

export async function deleteMemory(uuid: string): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) {
    return unconfigured(null, "empty", "carry not configured; nothing deleted");
  }
  try {
    // proto-loader is configured with enums:"String" and defaults:true, so this
    // is always a string, UNSPECIFIED when the backend left the field unset.
    const res = await call<{ memoryUuid: string }, { status?: string } | null>(
      Services.capture,
      "DeleteMemory",
      { memoryUuid: uuid },
    );
    const status = res?.status ?? "DELETE_MEMORY_STATUS_UNSPECIFIED";
    if (DELETE_DONE.has(status)) return live(null);
    return failed(null, `carry ${DELETE_REFUSED[status] ?? `answered ${status}`}`, "empty");
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/* --------------------------------------------------------- dashboard ------ */

/** One part's own provenance, carried in the body so a page can branch per card. */
export interface PartProvenance {
  state: DataState;
  fallback?: DataFallback;
  degraded?: string;
}

/**
 * Per-part provenance, keyed the way the payload is.
 *
 * The aggregate state answers "is anything on this screen not the wearer's own
 * data" — it cannot answer "did the captures backend work", because captures
 * come from the REST webapi and the other four come from gRPC workloads that
 * fail independently. A page that renders one part must branch on that part.
 */
export interface DashboardProvenance {
  captures: PartProvenance;
  notes: PartProvenance;
  aiMic: PartProvenance;
  music: PartProvenance;
  calls: PartProvenance;
}

/** The dashboard body, plus the provenance of each part inside it. */
export type DashboardBody = DashboardContent & { provenance: DashboardProvenance };

/**
 * How many rows each part of the aggregate fetches.
 *
 * The SHAPE of this response is stock and stays stock; only the volume is the
 * caller's business. The Memories dashboard renders fixed slots — one photo, one
 * Ai Mic row, two music rows, three notes, one call — and fetched five hundred
 * records every five seconds to fill eight of them, decrypting every note and
 * every event server side on the way. A caller that needs the full page (the
 * Captures grid, the Notes list) asks for it explicitly; everything else asks
 * for what it renders.
 */
export interface DashboardLimits {
  captures?: number;
  notes?: number;
  aiMic?: number;
  music?: number;
  calls?: number;
}

function provenanceOf(part: Sourced<unknown>): PartProvenance {
  return { state: part.state, fallback: part.fallback, degraded: part.degraded };
}

/** degraded beats absent beats live: the aggregate is only as true as its weakest part. */
function worstState(states: DataState[]): DataState {
  if (states.includes("degraded")) return "degraded";
  if (states.includes("absent")) return "absent";
  return "live";
}

export async function getDashboardContent(
  limits: DashboardLimits = {},
): Promise<Sourced<DashboardBody>> {
  const [captures, notes, aiMic, music, calls] = await Promise.all([
    getCaptures(limits.captures ?? STOCK_PAGE_SIZE),
    getNotes(limits.notes ?? STOCK_PAGE_SIZE),
    getEvents("AI_MIC", limits.aiMic ?? STOCK_PAGE_SIZE),
    getEvents("MUSIC", limits.music ?? STOCK_PAGE_SIZE),
    getEvents("CALL", limits.calls ?? STOCK_PAGE_SIZE),
  ]);

  const parts: Array<{ label: string; part: Sourced<unknown> }> = [
    { label: "captures", part: captures },
    { label: "notes", part: notes },
    { label: "Ai Mic", part: aiMic },
    { label: "music", part: music },
    { label: "calls", part: calls },
  ];

  /*
   * The aggregate is the WEAKEST part, captures included.
   *
   * It used to derive `anyCarry` from the four gRPC parts only and treat
   * anything short of "degraded" as healthy, which produced two lies at once:
   * an unconfigured webapi rode inside a "live" aggregate — and a "live"
   * aggregate then dropped `fallback`, so /api/capture/memories asserted live
   * while its own REST plane was absent. Per-part provenance prevents that even
   * though the safe fallback is now always empty.
   */
  const state = worstState(parts.map((p) => p.part.state));
  const anyCarry = parts.some((p) => p.part.source === "carry");

  // Runtime data is never replaced with fixtures. Any non-live part is empty.
  const fallback: DataFallback | undefined =
    state === "live" ? undefined : "empty";

  const data: DashboardBody = {
    photos: captures.data,
    notes: notes.data,
    aiSessions: aiMic.data as AiMicRecord[],
    playTrackEvents: music.data as DashboardContent["playTrackEvents"],
    phoneCalls: calls.data as DashboardContent["phoneCalls"],
    health: [],
    provenance: {
      captures: provenanceOf(captures),
      notes: provenanceOf(notes),
      aiMic: provenanceOf(aiMic),
      music: provenanceOf(music),
      calls: provenanceOf(calls),
    },
  };

  return {
    data,
    source: anyCarry ? "carry" : "fixtures",
    state,
    fallback,
    degraded: summarizeParts(parts),
  };
}

/**
 * One sentence naming WHICH parts are not the wearer's own data.
 *
 * Failures name the first broken plane. Absent parts carry an explanation too,
 * so an empty result never means "none" when Center cannot reach its source.
 */
function summarizeParts(parts: Array<{ label: string; part: Sourced<unknown> }>): string | undefined {
  const broken = parts.filter((p) => p.part.state === "degraded");
  if (broken.length > 0) {
    const others = broken.length > 1 ? ` (and ${broken.length - 1} more)` : "";
    return `${broken[0].label}: ${broken[0].part.degraded ?? "carry did not answer"}${others}`;
  }

  // A live part can still have something to say — a sealed note, for instance.
  return parts.map((p) => p.part.degraded).find(Boolean);
}

/** gRPC status codes worth naming, so a failure says what to fix. */
const GRPC_CODE: Record<number, string> = {
  12: "UNIMPLEMENTED — that service isn't registered on this workload",
  14: "UNAVAILABLE — workload not reachable",
  4: "DEADLINE_EXCEEDED",
  16: "UNAUTHENTICATED",
  7: "PERMISSION_DENIED",
};

function describe(error: unknown): string {
  // Name the one failure a wearer can actually act on. Left to the generic
  // paths, an expired Keycloak grant reaches the workload as a call with no
  // identity and comes back as "UNAVAILABLE — workload not reachable:
  // authenticated edge principal required", which reads as a broken deployment
  // and is why this went unrecognised: the deployment was fine and the wearer
  // only needed to sign in again.
  //
  // The same sentence `failedGrpc`/`failedWebapi` use, from the same constant:
  // two wordings of one condition is how this seam got into trouble in the first
  // place, and `describe()` is still reachable from callers that build their own
  // result rather than going through those helpers.
  if (error instanceof SessionExpiredError) return SESSION_EXPIRED;
  // Two Center-side conditions that must never be dressed as a backend outage.
  // A missing channel key is a wearer/identity problem and a missing contracts
  // directory is a deployment problem in THIS process; both used to fall through
  // to "carry error: …", which sends every reader to look at a healthy Cosmos.
  if (error instanceof ChannelKeyUnavailableError || error instanceof ContractsUnavailableError) {
    return error.message;
  }
  if (error && typeof error === "object" && "code" in error) {
    const e = error as { code?: number; details?: string };
    const named = e.code !== undefined ? GRPC_CODE[e.code] : undefined;
    const detail = e.details && e.details.length > 0 ? `: ${e.details}` : "";
    return `carry ${named ?? `error ${e.code}`}${detail}`;
  }
  return error instanceof Error ? `carry error: ${error.message}` : "carry unreachable";
}

/**
 * The REST half fails differently — an HTTP status or an AbortSignal timeout,
 * never a gRPC code — so say webapi rather than passing it through `describe`,
 * which would label it "carry error" and hide which plane went quiet.
 */
function describeWebapi(error: unknown): string {
  const e = error as { name?: string; message?: string } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return "carry webapi timed out";
  }
  // webapiGet's own message already begins "webapi <path> -> <status>".
  const message = e?.message?.replace(/^webapi\s+/, "");
  return message ? `carry webapi error: ${message}` : "carry webapi unreachable";
}


/* ----------------------------------------------------------- account ------ */

export interface AccountDetails {
  /** From AccountInfo — the only personal fields this backend actually holds. */
  preferredName: string | null;
  pronunciation: string | null;
  /** True when the wearer has sealed bio data we hold no key for. */
  hasSecureBioData: boolean;
}

/**
 * Settings -> Details.
 *
 * `UserInformationService.GetUserPersonalDetails` returns `AccountInfo`, which
 * carries exactly two fields: preferred name and pronunciation. .Center also
 * showed first/last name, username and MFA, but those came from the account
 * service (Keycloak), not from this API — so they have no source here and the
 * page says so rather than inventing a name.
 */
export async function getAccountDetails(): Promise<Sourced<AccountDetails | null>> {
  if (!CARRY_ENABLED) return unconfigured(null, "empty", "carry not configured");
  try {
    const res = await call<
      Record<string, never>,
      {
        accountInfo?: { preferredName?: string; pronunciation?: string };
        secureBioData?: { data?: Uint8Array | string };
      }
    >(Services.account, "GetUserPersonalDetails", {});

    const info = res.accountInfo ?? {};
    const trimmed = (v?: string) => (v && v.trim().length > 0 ? v : null);
    return live({
      preferredName: trimmed(info.preferredName),
      pronunciation: trimmed(info.pronunciation),
      hasSecureBioData: Boolean(res.secureBioData?.data),
    });
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/* ---------------------------------------------------------- contacts ------ */

export interface ContactRecord {
  id: string;
  displayName: string;
  phoneNumbers: string[];
  emails: string[];
  trusted: boolean;
  emergency: boolean;
  organization: string | null;
}

export interface ContactDraft {
  displayName: string;
  phoneNumbers?: string[];
  emails?: string[];
  trusted?: boolean;
  emergency?: boolean;
  organization?: string | null;
}

interface CarryContact {
  id?: string;
  name?: { firstName?: string; lastName?: string; nickname?: string; displayName?: string };
  phoneNumbers?: Array<{ value?: string; type?: string }>;
  telephoneNumbers?: string[];
  emails?: Array<{ value?: string; type?: string }>;
  trusted?: boolean;
  emergency?: boolean;
  organization?: { name?: string };
}

/**
 * Settings -> Contacts. The original had All and Trusted tabs, which
 * `Contact.trusted` supports directly.
 *
 * Contacts arrive plaintext here; `ContactList.encrypted_contacts` is the sealed
 * variant and is left alone — nothing in the recovered .Center client suggests
 * the dashboard read that arm.
 */
export async function getContacts(search = ""): Promise<Sourced<ContactRecord[]>> {
  // No contact fixtures exist, so this is an empty list — not sample data.
  // Tagging it "fixtures" was exactly the overloading that made a failed call
  // and a genuinely empty backend indistinguishable.
  if (!CARRY_ENABLED) return unconfigured([], "empty");
  try {
    const res = await call<{ searchTerm: string }, { contacts?: CarryContact[] }>(
      Services.contacts,
      "GetContacts",
      { searchTerm: search },
    );

    const data = (res.contacts ?? []).map<ContactRecord>((c) => {
      const name = c.name ?? {};
      const display =
        name.displayName?.trim() ||
        [name.firstName, name.lastName].filter(Boolean).join(" ").trim() ||
        name.nickname?.trim() ||
        "Unnamed";
      return {
        id: c.id ?? display,
        displayName: display,
        phoneNumbers: [
          ...(c.phoneNumbers ?? []).map((p) => p.value ?? "").filter(Boolean),
          ...(c.telephoneNumbers ?? []),
        ],
        emails: (c.emails ?? []).map((e) => e.value ?? "").filter(Boolean),
        trusted: Boolean(c.trusted),
        emergency: Boolean(c.emergency),
        organization: c.organization?.name?.trim() || null,
      };
    });
    return live(data);
  } catch (error) {
    return failedGrpc([], error);
  }
}

function carryContact(input: ContactDraft, id = ""): CarryContact {
  const displayName = input.displayName.trim();
  return {
    id,
    name: { displayName },
    phoneNumbers: (input.phoneNumbers ?? []).map((value) => ({ value: value.trim(), type: "other" })),
    emails: (input.emails ?? []).map((value) => ({ value: value.trim(), type: "other" })),
    trusted: Boolean(input.trusted),
    emergency: Boolean(input.emergency),
    organization: input.organization?.trim() ? { name: input.organization.trim() } : undefined,
  };
}

/** Create one or more wearer-owned contacts and let Carry assign stable ids. */
export async function createContacts(inputs: ContactDraft[]): Promise<Sourced<number>> {
  if (!CARRY_ENABLED) return unconfigured(0, "empty");
  try {
    const response = await call<{ contacts: CarryContact[] }, { contacts?: CarryContact[] }>(
      Services.contacts,
      "CreateContacts",
      { contacts: inputs.map((input) => carryContact(input)) },
    );
    return live(response.contacts?.length ?? inputs.length);
  } catch (error) {
    return failedGrpc(0, error);
  }
}

/** Update exactly one contact. The service upserts by its stable contact id. */
export async function updateContact(id: string, input: ContactDraft): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) return unconfigured(null, "empty");
  try {
    await call(Services.contacts, "UpdateContacts", { contacts: [carryContact(input, id)] });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}

/** Delete a wearer-owned contact and emit the tombstone the Pin sync consumes. */
export async function deleteContact(id: string): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) return unconfigured(null, "empty");
  try {
    await call(Services.contacts, "DeleteContacts", { ids: [id] });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}
