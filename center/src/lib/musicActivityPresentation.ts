import type { ActivityMusic } from "./pin-device/types";
import type { MusicRecord } from "./types";

export type PresentedMusicProvider =
  | "spotify"
  | "youtube_music"
  | "apple_music"
  | "tidal";

export type MusicActivityPresentation = {
  record: MusicRecord;
  activity: ActivityMusic | null;
  provider: PresentedMusicProvider | null;
  artwork: string | null;
};

const MAX_MATCH_DISTANCE_MS = 30 * 60 * 1_000;

/** Recovered TIDAL artwork contract: UUID path segments and a square size. */
function tidalArtworkUrl(albumArtUuid: string, size = 160): string | null {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(albumArtUuid)) return null;
  return `https://resources.tidal.com/images/${albumArtUuid.replaceAll("-", "/")}/${size}x${size}.jpg`;
}

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function timestampMs(value: string): number {
  if (/^\d{1,12}$/u.test(value)) return Number(value) * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function musicProviderFromTrackId(trackId: string): PresentedMusicProvider | null {
  if (/^youtube_music:[A-Za-z0-9_-]{11}$/u.test(trackId)) return "youtube_music";
  if (/^tidal:[A-Za-z0-9_-]{1,256}$/u.test(trackId)) return "tidal";
  if (/^apple_music:[A-Za-z0-9_-]{1,256}$/u.test(trackId)) return "apple_music";
  if (/^[A-Za-z0-9]{22}$/u.test(trackId)) return "spotify";
  return null;
}

export function musicProviderLabel(provider: PresentedMusicProvider | null): string {
  switch (provider) {
    case "youtube_music": return "YouTube Music";
    case "spotify": return "Spotify";
    case "apple_music": return "Apple Music";
    case "tidal": return "TIDAL";
    default: return "Music";
  }
}

export function musicArtworkPath(
  provider: PresentedMusicProvider | null,
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

function sameTrack(record: MusicRecord, activity: ActivityMusic): boolean {
  const event = record.data.eventData;
  if (!normalized(event.trackTitle) || normalized(event.trackTitle) !== normalized(activity.title)) {
    return false;
  }
  const eventArtist = normalized(event.artistName);
  return !eventArtist || activity.artists.some((artist) => normalized(artist) === eventArtist);
}

export function musicActivityPresentations(
  records: MusicRecord[],
  activities: ActivityMusic[],
): MusicActivityPresentation[] {
  const unused = new Map(activities.map((activity) => [activity.id, activity]));
  return records.map((record) => {
    const eventTime = timestampMs(record.userCreatedAt);
    const match = [...unused.values()]
      .filter((activity) => activity.status !== "failed" && sameTrack(record, activity))
      .map((activity) => ({
        activity,
        distance: Math.abs(timestampMs(activity.started_at) - eventTime),
      }))
      .filter(({ distance }) => distance <= MAX_MATCH_DISTANCE_MS)
      .sort((left, right) => left.distance - right.distance || right.activity.id - left.activity.id)[0]
      ?.activity ?? null;
    if (match) unused.delete(match.id);

    const event = record.data.eventData;
    const provider = (match ? musicProviderFromTrackId(match.track_id) : null) ??
      (event.albumArtUuid ? "tidal" : null);
    const artwork = provider === "tidal" && event.albumArtUuid
      ? tidalArtworkUrl(event.albumArtUuid)
      : match
        ? musicArtworkPath(provider, match.track_id)
        : null;
    return { record, activity: match, provider, artwork };
  });
}
