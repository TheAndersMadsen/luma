import type { MusicRecord } from "@/lib/contracts/events";
import { MUSIC_PROVIDERS, type MusicProvider } from "@/lib/contracts/music";

/*
 * Where a played track came from: Cosmos derives it from the track's own
 * `trackID` (stock `Track.emitNotableEvent` records every track as "TIDAL"),
 * so Center only maps it to a label, an icon and a cover.
 */
export type MusicPresentation = {
  record: MusicRecord;
  provider: MusicProvider | null;
  artwork: string | null;
};

/** Recovered TIDAL artwork contract: UUID path segments and a square size. */
function tidalArtworkUrl(albumArtUuid: string, size = 160): string | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(albumArtUuid)) return null;
  return `https://resources.tidal.com/images/${albumArtUuid.replaceAll("-", "/")}/${size}x${size}.jpg`;
}

export function musicProviderLabel(provider: MusicProvider | null): string {
  return provider ? MUSIC_PROVIDERS[provider].label : "Music";
}

/**
 * The same-origin cover route for a Luma provider track. The route holds the
 * provider credentials the lookup needs, so the id never leaves Center.
 */
export function musicArtworkPath(
  provider: MusicProvider | null,
  trackId: string,
): string | null {
  if (provider === "youtube_music") {
    const id = trackId.startsWith("youtube_music:") ? trackId.slice(14) : "";
    return /^[A-Za-z0-9_-]{11}$/u.test(id)
      ? `/api/settings/services/music/artwork/youtube_music/${encodeURIComponent(id)}`
      : null;
  }
  if (provider === "spotify" && /^[A-Za-z0-9]{22}$/u.test(trackId)) {
    return `/api/settings/services/music/artwork/spotify/${encodeURIComponent(trackId)}`;
  }
  return null;
}

/** One music row as the dashboard and My Data show it. */
export function musicPresentation(record: MusicRecord): MusicPresentation {
  const event = record.data.eventData;
  const provider = event.provider ?? null;
  const artwork =
    provider === "tidal"
      ? event.albumArtUuid
        ? tidalArtworkUrl(event.albumArtUuid)
        : null
      : musicArtworkPath(provider, event.trackID ?? "");
  return { record, provider, artwork };
}
