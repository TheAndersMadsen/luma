import type { Location, MemoryRecord } from "@/lib/pin-device";

/*
 * How a memory the Pin is holding is described in Center.
 *
 * Everything here is derived from what `GET /api/memories` actually returns and
 * nothing else. Two habits are deliberate:
 *
 *  - Unknown values are ECHOED, not mapped to a default. `memory_type` and
 *    `status` are TypeScript unions on our side but plain `String` columns on
 *    the device, so a Pin running newer software can legitimately answer with a
 *    type this build has never heard of. Showing it verbatim is how the wearer
 *    (and whoever they send a screenshot to) can tell "Center does not know this
 *    kind" apart from "the Pin said photo".
 *
 *  - Nothing here builds a URL from an id the Pin would refuse. The device
 *    validates every memory id as a canonical hyphenated UUID before it opens a
 *    directory (`validate_memory_id` in pin/runtime/core/src/storage.rs), so a
 *    record whose id does not have that shape has no addressable media and no
 *    detail route; it is listed as a record and nothing more. This mirrors what
 *    `requireCanonicalFitnessSessionId` does for the fitness pane.
 */

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when the Pin's own media store would accept this id. */
export function isCanonicalMemoryId(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

export function memoryTypeLabel(memoryType: string): string {
  switch (memoryType) {
    case "photo":
      return "Photo";
    case "video":
      return "Video";
    case "food_log":
      return "Food log";
    case "note":
      return "Note";
    default:
      return memoryType;
  }
}

/**
 * The upload status, in the wearer's terms.
 *
 * "Uploading" is about the Pin sending a capture to whatever backend it is
 * pointed at; the copy on the device is already complete either way. Saying
 * "waiting to sync" rather than "incomplete" keeps a wearer from reading a
 * pending memory as a corrupt one.
 */
export function memoryStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Waiting to sync";
    case "uploading":
      return "Syncing";
    case "complete":
      return "Synced";
    case "failed":
      return "Sync failed";
    default:
      return status;
  }
}

export type MemoryFileKind = "image" | "video" | "data";

/**
 * What a stored filename can be rendered as.
 *
 * The Pin names capture files `<memory>_<burst>_<file>.jpg` / `.mp4` and writes
 * sidecars (`_imu.bin`, `_timing.bin`) beside a video. Extension is all there is
 * to go on — the list carries no MIME type — so anything unrecognised is
 * "data": offered as a download, never handed to an <img> that would render a
 * broken frame.
 */
export function classifyMemoryFile(filename: string): MemoryFileKind {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "jpg" || extension === "jpeg" || extension === "png") {
    return "image";
  }
  if (extension === "mp4" || extension === "mov" || extension === "webm") {
    return "video";
  }
  return "data";
}

/**
 * Whether a stored filename can be put in a request path as it stands.
 *
 * `PinClient.filePath` interpolates the name without encoding it, and the USB
 * transport writes the result straight into an HTTP request line
 * (`GET <path> HTTP/1.1`). A name containing a space would therefore produce a
 * malformed request, and one containing `/` or `?` would address something other
 * than the file. The Pin's own generator only ever emits
 * `<uuid>_<burst>_<index>.<ext>` and its media store rejects separators on the
 * way in, so this should never fire — but the value still arrives from a
 * device, and a file this build cannot address is a thing to SAY rather than a
 * request to send and misread.
 */
export function isAddressableMemoryFilename(filename: string): boolean {
  if (!filename || filename === "." || filename === "..") return false;
  return [...filename].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return false;
    return !"/\\?#%".includes(character);
  });
}

/** The file a detail view would show full size, or null when there is none. */
export function memoryPrimaryFile(memory: MemoryRecord): string | null {
  return (
    memory.files.find(
      (file) =>
        classifyMemoryFile(file) !== "data" && isAddressableMemoryFilename(file),
    ) ?? null
  );
}

/** True when the Pin says it has at least one frame to show for this memory. */
export function memoryHasThumbnail(memory: MemoryRecord): boolean {
  return memory.thumbnail_count > 0 && isCanonicalMemoryId(memory.uuid);
}

/**
 * The asset key's revision component for this memory's media.
 *
 * A memory that is still uploading answers the same thumbnail path with nothing
 * and then with a frame, so the blob captured on the first read must not be
 * re-served after a refresh observed the change. Status and thumbnail count are
 * the two fields that move while the path does not.
 */
export function memoryAssetRevision(memory: MemoryRecord): string {
  return `${memory.status}:${memory.thumbnail_count}:${memory.files.length}`;
}

/** "Copenhagen" / "55.6761, 12.5683" / null — never a half-formed address. */
export function describeMemoryLocation(location?: Location): string | null {
  if (!location) return null;
  const named = location.human_readable?.trim() || location.full_address?.trim();
  if (named) return named;
  return `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}

/**
 * The sentence in front of a delete.
 *
 * It names the kind, the moment, and what else goes with it, because this is
 * the only copy — the Pin's store is not a cache of something in the account,
 * and `deleteMemory` removes the directory. A wearer who has to ask "which one
 * was that" after pressing the button has been failed by this string.
 */
export function memoryDeleteQuestion(
  memory: MemoryRecord,
  capturedAt: string,
): string {
  const kind = memoryTypeLabel(memory.memory_type).toLowerCase();
  const fileCount = memory.files.length;
  const files =
    fileCount === 0
      ? "its stored files"
      : `${fileCount} stored ${fileCount === 1 ? "file" : "files"}`;
  const synced =
    memory.status === "complete"
      ? " It has already been sent to your account, and that copy is not touched."
      : " It has not been sent anywhere else yet, so this is the only copy.";
  return `Delete this ${kind} from ${capturedAt}? ${files} and every thumbnail are removed from the Pin and cannot be recovered.${synced}`;
}
