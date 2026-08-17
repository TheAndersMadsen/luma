import { getSharedCaptureFrame } from "@/server/source";
import { verifyShareToken } from "@/server/shareToken";

/*
 * Resolver for the PUBLIC share view (a marketed .Center capability: a
 * `/share/{token}` link opens one shared memory with NO login).
 *
 * Shared by the BFF route (`/api/share/[token]`) and the public page
 * (`/share/[token]`) so neither makes an internal HTTP hop. The signed,
 * expiring capability names one wearer and memory; the BFF presents its internal
 * projection token to Carry, which authenticates and opens that thumbnail.
 *
 * Two entry points: `resolveSharedThumbnail` says WHY it failed (the page needs
 * that), `getSharedThumbnail` is the bytes-or-null form the binary route wants.
 */

export interface SharedThumbnail {
  bytes: Buffer;
  contentType: string;
}

/**
 * Why a share link did not open, split two ways.
 *
 * This used to be one `null`. Every failure — an undecodable token, a backend
 * an unavailable frame, a transport error, a timeout — told the
 * recipient "this shared memory is no longer available", i.e. that the wearer's
 * memory was gone. Two of those three are our end being down.
 *
 *   invalid   the link itself is not resolvable: the token does not decode, or
 *             the backend authoritatively answered that there is no such share.
 *             A retry cannot help and the copy must not imply one.
 *   degraded  we could not ask, or the backend could not answer — transport or
 *             a throw. The memory may be perfectly fine. Offer a
 *             retry.
 */
export type SharedResolution =
  | { status: "ok"; content: SharedThumbnail }
  | { status: "invalid" }
  | { status: "degraded"; detail?: string };

/** Content type sniffed from the bytes themselves when the response lacks one. */
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
 * Resolve a shared memory's decrypted thumbnail, saying WHICH failure happened.
 *
 * Never throws and never 500s: every path returns one of the three states
 * above, so the public page can tell a recipient the difference between "this
 * link isn't valid" and "we couldn't load this right now".
 */
export async function resolveSharedThumbnail(token: string): Promise<SharedResolution> {
  const capability = await verifyShareToken(token);
  if (!capability) return { status: "invalid" };

  try {
    const frame = await getSharedCaptureFrame(capability.memoryUuid, 0, capability.userId);
    if (!frame || frame.bytes.length === 0) return { status: "invalid" };
    // `frame.bytes` is already an owned Buffer read from the projection; copying
    // it again here duplicated a whole frame to change nothing about it.
    const { bytes } = frame;
    return { status: "ok", content: { bytes, contentType: frame.contentType || sniff(bytes) } };
  } catch (error) {
    return {
      status: "degraded",
      detail: error instanceof Error ? error.message : "the request could not be completed",
    };
  }
}

/**
 * The bytes-or-nothing form retained for callers that do not need to distinguish
 * an invalid capability from a temporarily unavailable backend.
 */
export async function getSharedThumbnail(token: string): Promise<SharedThumbnail | null> {
  const resolved = await resolveSharedThumbnail(token);
  return resolved.status === "ok" ? resolved.content : null;
}
