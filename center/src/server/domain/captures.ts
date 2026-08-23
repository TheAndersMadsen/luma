/*
 * Captures and memories, read over the clone's REST webapi and deleted over the
 * stock gRPC Capture service.
 *
 * Humane ran TWO APIs and so does the clone. The decompiled device source has no
 * capture listing RPC in any of three independently compiled copies of
 * CaptureServiceGrpc, and the string `webapi` appears in no APK — listing only
 * ever existed on the web side. Reading captures over gRPC would be inventing
 * history.
 */

import { channelKeyForSealed } from "../channel";
import { open as openEnvelope } from "../envelope";
import {
  COSMOS_ENABLED,
  COSMOS_WEBAPI,
  COSMOS_WEBAPI_ENABLED,
  Services,
  SessionExpiredError,
  call,
  webapiGet,
  webapiGetForUser,
  webapiHeaders,
  webapiPost,
  type SpringPage,
} from "../cosmos";
import { logWarn } from "../log";
import type { CaptureRecord } from "@/lib/types";
import {
  STOCK_PAGE_SIZE,
  boundedPageSize,
  failed,
  failedGrpc,
  failedWebapi,
  live,
  unconfigured,
  type Sourced,
} from "./provenance";

/**
 * One capture frame, opened. The clone hands back the sealed envelope and the
 * key stays here, so the server never needs the plaintext to serve a picture.
 */
export async function getCaptureFrame(
  uuid: string,
  index: number,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!COSMOS_WEBAPI_ENABLED) return null;
  try {
    // Same wearer identity as every other webapi read, or the frame resolves in
    // the demo account rather than the caller's and 404s. Resolved BEFORE the
    // deadline is started, so the clock covers the backend call rather than
    // being spent on a slow token refresh.
    const headers = await webapiHeaders();
    const res = await fetch(`${COSMOS_WEBAPI}/capture/memory/${encodeURIComponent(uuid)}/thumbnail/${index}`, {
      cache: "no-store",
      headers,
      /*
       * The only webapi call in this seam that had no deadline. Every sibling —
       * webapiGet, webapiPost, webapiDelete, getCaptureOriginal twenty lines
       * down — bounds the same host at COSMOS_DEADLINE_MS; nothing says this one
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
      signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 8000)),
    });
    if (!res.ok) return null;
    const payload = Buffer.from(await res.arrayBuffer());
    const projection = res.headers.get("x-cosmos-projection");
    const servedType = res.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";

    // Cosmos releases plaintext only after verifying the web Bearer and
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
 * `x-cosmos-projection` verdict and the content type — and none of them reads the
 * body, so there is no reason to hold a full-resolution original in the BFF's
 * heap before handing it on. `getCaptureFrame` above is deliberately different:
 * its legacy HMCT branch opens an envelope over the whole buffer and must
 * materialise it.
 */
export async function getCaptureOriginal(
  uuid: string,
  file: number,
): Promise<CaptureStream | null> {
  if (!COSMOS_WEBAPI_ENABLED) return null;
  // Headers first, then the deadline — see webapiGet.
  const headers = await webapiHeaders();
  const res = await fetch(
    `${COSMOS_WEBAPI}/capture/memory/${encodeURIComponent(uuid)}/file/${file}`,
    {
      signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 8000)),
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
  if (!COSMOS_WEBAPI_ENABLED) return null;
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
  if (res.headers.get("x-cosmos-projection") !== "opened" || !contentType.startsWith("image/")) {
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

/**
 * Captures, read over the clone's REST webapi.
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
  "COSMOS_WEBAPI_BASE_URL is unset - this Center cannot read the wearer's captures";

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
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured([], "empty", WEBAPI_UNSET);
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
  if (!COSMOS_WEBAPI_ENABLED) return null;
  const memory = await webapiGet<MemoryDto>(`/capture/memory/${encodeURIComponent(uuid)}`);
  return memoryDtoToCapture(memory);
}

export interface BestFrameResult {
  frame: number;
  method: "vision_v1" | "quality_v1" | "manual" | string;
  reason: string;
}

/** Ask Cosmos to rank an already-uploaded burst; it caches the answer. */
export async function rankCapture(uuid: string, force = false): Promise<BestFrameResult> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return webapiPost<BestFrameResult>(
    `/capture/memory/${encodeURIComponent(uuid)}/best_photo${force ? "?force=true" : ""}`,
  );
}

/** Wearer override of the automatic choice; every original remains stored. */
export async function setCaptureBestFrame(
  uuid: string,
  frame: number,
): Promise<BestFrameResult> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
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
 * (`webapiHeaders` sends no COSMOS_EDGE_TOKEN), so a healthy gRPC side says
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
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
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

/** Read after the word "cosmos", so each reads as a sentence about the backend. */
const DELETE_REFUSED: Record<string, string> = {
  DELETE_MEMORY_STATUS_FAILURE: "answered FAILURE: it deleted nothing",
  DELETE_MEMORY_STATUS_NOT_AUTHORIZED:
    "answered NOT_AUTHORIZED: this account may not delete that capture",
  DELETE_MEMORY_STATUS_UNSPECIFIED: "returned no delete status, so nothing is confirmed deleted",
};

export async function deleteMemory(uuid: string): Promise<Sourced<null>> {
  if (!COSMOS_ENABLED) {
    return unconfigured(null, "empty", "cosmos not configured; nothing deleted");
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
    return failed(null, `cosmos ${DELETE_REFUSED[status] ?? `answered ${status}`}`, "empty");
  } catch (error) {
    return failedGrpc(null, error);
  }
}
