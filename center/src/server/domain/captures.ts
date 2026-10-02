/*
 * Captures, read and changed over Cosmos's `capture` webapi, the surface
 * humane.center itself called (recovered `api-client.js`, module 87044).
 *
 * Humane ran TWO APIs and so does the clone. The decompiled device source has no
 * capture listing RPC in any of three independently compiled copies of
 * CaptureServiceGrpc, and the string `webapi` appears in no APK, listing only
 * ever existed on the web side. Every capture action here, the deletes included,
 * therefore goes over REST with the wearer's Bearer. Cosmos owns every filter,
 * count and share capability, and this module only reshapes what it answers.
 */

import type {
  CaptureDetailRecord,
  CaptureFiles,
  CaptureRecord,
  PendingCapture,
  ShareLink,
} from "@/lib/contracts/captures";
import {
  bestFrameResultSchema,
  bulkDeletedSchema,
  bulkUpdatedSchema,
  captureFilesSchema,
  memoryDetailDtoSchema,
  memoryDtoSchema,
  pendingCaptureDtoSchema,
  shareLinkSchema,
  type BestFrameResult,
  type BulkDeleted,
  type MemoryDetailDto,
  type MemoryDto,
} from "@/lib/contracts/captures";
import type { FoodLogEntry } from "@/lib/contracts/food";
import { foodLogEntryDtoSchema } from "@/lib/contracts/food";
import { springPageSchema } from "@/lib/contracts/pagination";
import { parseResponse } from "@/lib/contracts/parse";
import * as z from "zod/mini";
import {
  COSMOS_WEBAPI,
  COSMOS_WEBAPI_ENABLED,
  SessionExpiredError,
  webapiError,
  webapiGet,
  webapiGetWithHeaders,
  webapiHeaders,
  webapiPost,
} from "../cosmos";
import { logWarn } from "../log";
import {
  STOCK_PAGE_SIZE,
  boundedPageSize,
  failedWebapi,
  live,
  unconfigured,
  webapiDelete,
  type Sourced,
} from "./provenance";

/**
 * One capture frame, opened by Cosmos.
 *
 * Cosmos releases plaintext only after verifying the web Bearer and
 * authenticating the stock Capture/Thumbnail HMSA binding, and says so with
 * `x-cosmos-projection: opened`. Anything else is not a picture this BFF may
 * serve, so it is refused rather than guessed at.
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
       * Bounded like every sibling. With a Cosmos that accepts the connection
       * and then stops answering, each tile on a grid would otherwise park on
       * undici's 300s default. A TimeoutError lands in the catch below, is not a
       * SessionExpiredError, and so returns null, the route's 404 and the
       * tile's honest "Media unavailable".
       */
      signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 8000)),
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      const refusal = webapiError(`/capture/memory/${uuid}/thumbnail/${index}`, res.status, headers);
      if (refusal instanceof SessionExpiredError) throw refusal;
      return null;
    }
    const contentType = assertOpenedImage(res, "capture frame");
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType };
  } catch (error) {
    // Rethrow the one failure the caller can act on, and leave a trace for the
    // rest, an image path that fails silently is how an expired grant once
    // became "frame unavailable".
    if (error instanceof SessionExpiredError) throw error;
    logWarn(`capture frame ${uuid}/${index} could not be opened`, error);
    return null;
  }
}

/**
 * The same bytes, in the one shape `BodyInit` accepts.
 *
 * `new Response(buffer)` works perfectly at runtime, but TypeScript rejects it:
 * a Node `Buffer` is `Uint8Array<ArrayBufferLike>`, which could in principle be
 * backed by a `SharedArrayBuffer`, and `BufferSource` will not take that. The
 * obvious appeasement, `new Response(new Uint8Array(bytes))`, satisfies the
 * type by ALLOCATING AND COPYING the entire picture on every request.
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

/* ------------------------------------------------------------ sharing ------ */

/**
 * What a public share link resolved to, split the way the recipient needs it:
 *
 *   invalid   the link itself does not open: forged, retargeted, expired, the
 *             capture is gone, or this server no longer has sharing set up
 *             (Cosmos's 501). A retry cannot help.
 *   degraded  Cosmos could not answer. The memory may be perfectly fine.
 */
export type SharedResolution =
  | { status: "ok"; bytes: Buffer; contentType: string }
  | { status: "invalid" }
  | { status: "degraded" };

/** The parts of a stock share link, bounded before anything is asked. */
const SHARE_UUID = /^[A-Za-z0-9-]{1,64}$/;
const SHARE_EXPIRY = /^\d{1,12}$/;
const SHARE_SIGNATURE = /^[A-Za-z0-9_-]{16,512}$/;

/**
 * Resolve a public share link, `/humane.center/share/capture/{uuid}?expiry&signature`,
 * the shape stock Messages parses, to the frame it shows.
 *
 * Cosmos is the one share authority: the link's signature is its capability,
 * so this presents nothing of its own, no Bearer and no identity, and Cosmos
 * decides. The read is `/share/capture/{uuid}/thumbnail` on the internal
 * network. The edge never publishes it.
 *
 * Buffered on purpose: the public page inlines the frame as a `data:` URI, so
 * the bytes exist in full on the server either way.
 */
export async function resolveSharedCapture(
  uuid: string,
  expiry: string | undefined,
  signature: string | undefined,
): Promise<SharedResolution> {
  if (
    !SHARE_UUID.test(uuid) ||
    !expiry ||
    !SHARE_EXPIRY.test(expiry) ||
    !signature ||
    !SHARE_SIGNATURE.test(signature)
  ) {
    return { status: "invalid" };
  }
  if (!COSMOS_WEBAPI_ENABLED) return { status: "degraded" };
  const query = new URLSearchParams({ expiry, signature });
  try {
    const res = await fetch(
      `${COSMOS_WEBAPI}/share/capture/${encodeURIComponent(uuid)}/thumbnail?${query}`,
      {
        signal: AbortSignal.timeout(Number(process.env.COSMOS_DEADLINE_MS ?? 8000)),
        cache: "no-store",
      },
    );
    if (res.status === 404 || res.status === 501) {
      void res.body?.cancel().catch(() => undefined);
      return { status: "invalid" };
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      logWarn(`shared capture ${uuid} could not be read`, new Error(`share -> ${res.status}`));
      return { status: "degraded" };
    }
    const contentType = assertOpenedImage(res, "shared capture");
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 ? { status: "ok", bytes, contentType } : { status: "invalid" };
  } catch (error) {
    logWarn(`shared capture ${uuid} could not be read`, error);
    return { status: "degraded" };
  }
}

/**
 * The web share button: Cosmos mints the same stock-shaped link the Pin's
 * `GetMemoryShareLink` does, for a capture the wearer owns.
 */
export async function createCaptureShareLink(uuid: string): Promise<ShareLink> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return parseResponse(
    shareLinkSchema,
    await webapiPost(`/capture/memory/${encodeURIComponent(uuid)}/share-link`),
  );
}

/* ----------------------------------------------------------- captures ------ */

/**
 * Captures, read over the clone's REST webapi.
 *
 * Bodies stay sealed. The API returns the capture *index*, what exists, its
 * type, when, where its upload stands, never decrypted bytes.
 */

/** `GET /capture/memory/{uuid}`: the index plus what `CreateMemory` carried. */

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
      uploadState: m.uploadState,
      thumbnailCount: m.thumbnailCount,
      frameCount: m.frameCount,
      durationSec: m.durationSec,
      favorite: m.favorite ?? false,
      tags: m.tags ?? [],
      bestFrameIndex: m.bestFrameIndex ?? undefined,
      bestFrameMethod: m.bestFrameMethod ?? undefined,
      bestFrameReason: m.bestFrameReason ?? undefined,
      visualSearchReady: m.visualSearchReady,
      sealed: m.sealed,
    },
  };
}

function detailToCapture(m: MemoryDetailDto): CaptureDetailRecord {
  return {
    ...memoryDtoToCapture(m),
    details: {
      gmtOffsetHours: m.gmtOffsetHours,
      format: m.format,
      lutName: m.lutName,
      frames: m.frames ?? [],
      hasLocation: m.hasLocation,
    },
  };
}

/** One page of the grid, and where it sits in the wearer's whole library. */
export type CapturePage = Sourced<CaptureRecord[]> & { page: number; last: boolean };

/**
 * One page of the wearer's photos and videos, newest first.
 *
 * `size` defaults to the stock page the `.Center` client asked for, so
 * /api/capture/captures still mirrors the original. It is a parameter because
 * the Memories dashboard renders ONE photo tile. `page` walks past the first
 * 200; `favorites` is the recovered `onlyContainingFavorited` filter, which
 * Cosmos applies in the store so a page is never short.
 */
export async function getCaptures(
  size: number = STOCK_PAGE_SIZE,
  options: { page?: number; favorites?: boolean } = {},
): Promise<CapturePage> {
  const number = Math.max(0, Math.trunc(options.page ?? 0)) || 0;
  if (!COSMOS_WEBAPI_ENABLED) {
    return {
      ...unconfigured([], "empty", WEBAPI_UNSET),
      page: number,
      last: true,
    };
  }
  try {
    const page = parseResponse(
      springPageSchema(memoryDtoSchema),
      await webapiGet(
        `/capture/captures?page=${number}&size=${boundedPageSize(size)}` +
          (options.favorites ? "&onlyContainingFavorited=true" : ""),
      ),
    );
    const data = page.content.map(memoryDtoToCapture);
    // `totalElements` is the store's own count, not this page's length, so it is
    // the only thing here that can tell a wearer their library is bigger than
    // the grid.
    return {
      ...live(data),
      total: page.totalElements,
      page: number,
      last: page.last,
    };
  } catch (error) {
    return { ...failedWebapi([], error), page: number, last: true };
  }
}

/** Search every capture in Cosmos, including its private visual index. */
export async function searchCaptures(
  query: string,
  page = 0,
  size = 200,
  options: { favorites?: boolean } = {},
): Promise<
  Sourced<CaptureRecord[]> & {
    visualIndex?: "ready" | "building" | "unavailable";
    visualPending?: number;
  }
> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured([], "empty", WEBAPI_UNSET);
  try {
    const path =
      `/capture/search?query=${encodeURIComponent(query)}&page=${Math.max(0, page)}&size=${boundedPageSize(size)}` +
      (options.favorites ? "&onlyContainingFavorited=true" : "");
    const headers = await webapiHeaders();
    const response = await fetch(`${COSMOS_WEBAPI}${path}`, {
      signal: AbortSignal.timeout(
        Number(process.env.COSMOS_DEADLINE_MS ?? 8000),
      ),
      cache: "no-store",
      headers,
    });
    if (!response.ok) throw webapiError(path, response.status, headers);
    const result = parseResponse(
      springPageSchema(memoryDtoSchema),
      await response.json(),
    );
    const visualIndex = response.headers.get("x-cosmos-visual-index");
    return {
      ...live(result.content.map(memoryDtoToCapture)),
      total: result.totalElements,
      visualIndex:
        visualIndex === "ready" ||
        visualIndex === "building" ||
        visualIndex === "unavailable"
          ? visualIndex
          : undefined,
      visualPending:
        Number.parseInt(
          response.headers.get("x-cosmos-visual-pending") ?? "0",
          10,
        ) || 0,
    };
  } catch (error) {
    return failedWebapi([], error);
  }
}

/** One capture with its camera details, so a deep-linked detail is real. */
export async function getCapture(
  uuid: string,
): Promise<CaptureDetailRecord | null> {
  if (!COSMOS_WEBAPI_ENABLED) return null;
  const memory = parseResponse(
    memoryDetailDtoSchema,
    await webapiGet(`/capture/memory/${encodeURIComponent(uuid)}`),
  );
  return detailToCapture(memory);
}

/** Ask Cosmos to rank an already-uploaded burst. It caches the answer. */
export async function rankCapture(
  uuid: string,
  force = false,
): Promise<BestFrameResult> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return parseResponse(
    bestFrameResultSchema,
    await webapiPost(
      `/capture/memory/${encodeURIComponent(uuid)}/best_photo${force ? "?force=true" : ""}`,
    ),
  );
}

/** Wearer override of the automatic choice. Every original remains stored. */
export async function setCaptureBestFrame(
  uuid: string,
  frame: number,
): Promise<BestFrameResult> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return parseResponse(
    bestFrameResultSchema,
    await webapiPost(
      `/capture/memory/${encodeURIComponent(uuid)}/bestFrame?frame=${frame}`,
    ),
  );
}

/** Recovered `favoriteMemory` / `unFavoriteMemory`: the capture as it now reads. */
export async function setCaptureFavorite(
  uuid: string,
  favorite: boolean,
): Promise<CaptureDetailRecord> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  const memory = parseResponse(
    memoryDetailDtoSchema,
    await webapiPost(
      `/capture/memory/${encodeURIComponent(uuid)}/${favorite ? "favorite" : "unfavorite"}`,
    ),
  );
  return detailToCapture(memory);
}

/** Recovered `bulkFavoriteMemories` / `bulkUnFavoriteMemories`: how many changed. */
export async function setCapturesFavorite(
  uuids: string[],
  favorite: boolean,
): Promise<number> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  const result = parseResponse(
    bulkUpdatedSchema,
    await webapiPost(
      `/capture/memory/${favorite ? "bulk-favorite" : "bulk-unfavorite"}`,
      { memoryUUIDs: uuids },
    ),
  );
  return result.updated;
}

/** Recovered `tagMemory`: add the wearer's tag. The capture as it now reads. */
export async function addCaptureTag(
  uuid: string,
  text: string,
): Promise<CaptureDetailRecord> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  const memory = parseResponse(
    memoryDetailDtoSchema,
    await webapiPost(`/capture/memory/${encodeURIComponent(uuid)}/tag`, {
      text,
    }),
  );
  return detailToCapture(memory);
}

/** Recovered `removeTagMemory`, under the `{"deleted": bool}` contract. */
export async function removeCaptureTag(uuid: string, tag: string): Promise<boolean> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return webapiDelete(
    `/capture/memory/${encodeURIComponent(uuid)}/tag/${encodeURIComponent(tag)}`,
  );
}

/** The full-resolution files Cosmos holds for one capture. */
export async function getCaptureOriginals(uuid: string): Promise<CaptureFiles> {
  if (!COSMOS_WEBAPI_ENABLED) throw new Error(WEBAPI_UNSET);
  return parseResponse(
    captureFilesSchema,
    await webapiGet(`/capture/memory/${encodeURIComponent(uuid)}/originals`),
  );
}

/**
 * Is the REST plane answering? The smallest question that exercises the same
 * host, the same auth and the same path the capture grid reads.
 *
 * The REST and gRPC sides are separate processes on separate ports with
 * different credentials, so a healthy gRPC side says nothing about whether
 * captures are the wearer's own. `size=1` is one `COUNT(*)` and one one-row
 * `SELECT` of index columns in Cosmos (`memory_page`).
 *
 * Carries no data, the answer is the state, not the page.
 */
export async function getWebapiHealth(): Promise<Sourced<null>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  try {
    parseResponse(
      springPageSchema(memoryDtoSchema),
      await webapiGet("/capture/captures?size=1"),
    );
    return live(null);
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/* ------------------------------------------------------------ deletes ------ */

/** The words the capture surfaces use when a delete removed nothing. */
const NOTHING_TO_DELETE = "cosmos not configured; nothing deleted";

/**
 * Recovered `deleteWebapiMemory`, `DELETE /capture/memory/{uuid}`, the same
 * delete the Pin's `DeleteMemory` runs, frames first.
 *
 * `{"deleted": false}` means Cosmos holds no such capture for this wearer,
 * what a second click looks like, so it is a completed delete too. A failure
 * is never reported as one.
 */
export async function deleteMemory(uuid: string): Promise<Sourced<null>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", NOTHING_TO_DELETE);
  try {
    await webapiDelete(`/capture/memory/${encodeURIComponent(uuid)}`);
    return live(null);
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/** What a bulk delete did to each capture it was given. */

/** Recovered `bulkDeleteMemories`, `POST /capture/memory/bulk-delete`. */
export async function deleteMemories(
  uuids: string[],
): Promise<Sourced<BulkDeleted | null>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(null, "empty", NOTHING_TO_DELETE);
  try {
    return live(
      parseResponse(
        bulkDeletedSchema,
        await webapiPost("/capture/memory/bulk-delete", { memoryUUIDs: uuids }),
      ),
    );
  } catch (error) {
    return failedWebapi(null, error);
  }
}

/* ---------------------------------------------------- pending captures ------ */

/**
 * Captures the Pin has taken and not uploaded yet, recovered
 * `getPendingMemoryCreates`, fed by the Pin's `DeclareMemoryCreateIntent`.
 */
export async function getPendingCaptures(): Promise<Sourced<PendingCapture[]>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured([], "empty", WEBAPI_UNSET);
  try {
    const pending = parseResponse(
      z.array(pendingCaptureDtoSchema),
      await webapiGet("/capture/pending-memory-creates"),
    );
    return live(
      pending.map((row) => ({
        deviceLocalId: row.deviceLocalId,
        memoryType: row.memoryType,
        delayReason: row.delayReason,
        declaredAt: new Date(row.declaredAt * 1000).toISOString(),
      })),
    );
  } catch (error) {
    return failedWebapi([], error);
  }
}

/**
 * Recovered `deletePendingMemoryCreate`: clear the waiting list. The captures
 * stay on the Pin. One still waiting is declared again the next time it tries.
 */
export async function clearPendingCaptures(): Promise<Sourced<boolean>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(false, "empty", NOTHING_TO_DELETE);
  try {
    return live(await webapiDelete("/capture/pending-memory-creates"));
  } catch (error) {
    return failedWebapi(false, error);
  }
}

/* ----------------------------------------------------------- food log ------ */

/**
 * Recovered `getFoodLog`, `GET /capture/food-log?startTime&endTime`. Cosmos
 * opens the same entries the Pin's `GetFoodLogSummary` reads, so the web and
 * the Pin never disagree about a day. Bounds are ISO instants.
 */
export async function getFoodLog(
  startTime?: string,
  endTime?: string,
): Promise<Sourced<FoodLogEntry[]>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured([], "empty", WEBAPI_UNSET);
  const query = new URLSearchParams();
  if (startTime) query.set("startTime", startTime);
  if (endTime) query.set("endTime", endTime);
  const suffix = query.toString() ? `?${query}` : "";
  try {
    const { body, headers } = await webapiGetWithHeaders(
      `/capture/food-log${suffix}`,
    );
    const entries = parseResponse(z.array(foodLogEntryDtoSchema), body);
    // Cosmos answers every entry it could open and counts the rest in
    // `x-cosmos-sealed` (sealed under a key it has not received). The read
    // succeeded, so the state stays live and the count rides as its note.
    const sealed = Number(headers.get("x-cosmos-sealed") ?? "0");
    return live(
      entries.map((entry) => ({
        loggedAt: new Date(entry.loggedAt * 1000).toISOString(),
        itemName: entry.itemName,
        brand: entry.brand,
        typicalServingSize: entry.typicalServingSize,
        servingsConsumed: entry.servingsConsumed,
        nutritionInfo: entry.nutritionInfo,
      })),
      Number.isSafeInteger(sealed) && sealed > 0
        ? sealedFoodLogNote(sealed)
        : undefined,
    );
  } catch (error) {
    return failedWebapi([], error);
  }
}

/** What Logged today says about entries Cosmos keeps sealed and cannot show yet. */
export function sealedFoodLogNote(sealed: number): string {
  return sealed === 1
    ? "1 entry is encrypted with a key this server doesn't have yet, so it isn't listed. It is kept, and appears once your Pin's key arrives."
    : `${sealed} entries are encrypted with a key this server doesn't have yet, so they aren't listed. They are kept, and appear once your Pin's key arrives.`;
}
