import type {
  SpotifySearchResponse,
  SpotifySearchTrack,
  SpotifyStatusResponse,
  SpotifyStatusState,
  MusicProvider,
} from "../types";

export const DEFAULT_SPOTIFY_DEVICE_NAME = "Ai Pin";

const SPOTIFY_STATUS_STATES: readonly SpotifyStatusState[] = [
  "disabled",
  "not_configured",
  "pairing",
  "ready",
  "error",
];
const MUSIC_PROVIDERS: readonly MusicProvider[] = [
  "spotify",
  "youtube_music",
  "apple_music",
  "tidal",
];

export class InvalidSpotifyResponseError extends Error {
  constructor(path: string, expected: string) {
    super(`Invalid Spotify response: ${path} must be ${expected}`);
    this.name = "InvalidSpotifyResponseError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidSpotifyResponseError(path, "an object");
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!hasOwn(value, key) || value[key] === null) return undefined;
  if (typeof value[key] !== "boolean") {
    throw new InvalidSpotifyResponseError(key, "a boolean");
  }
  return value[key];
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!hasOwn(value, key) || value[key] === null) return undefined;
  if (typeof value[key] !== "string") {
    throw new InvalidSpotifyResponseError(key, "a string");
  }
  return value[key];
}

function optionalTimestamp(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!hasOwn(value, key) || value[key] === null) return undefined;
  const timestamp = value[key];
  if (typeof timestamp === "string") return timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  throw new InvalidSpotifyResponseError(key, "a timestamp");
}

/**
 * Validate the Spotify status boundary and materialize safe-off defaults for
 * early/older server responses that omit newly-added non-secret fields.
 */
export function normalizeSpotifyStatusResponse(
  input: unknown,
): SpotifyStatusResponse {
  const root = record(input, "status");
  const stateValue = optionalString(root, "state");
  if (
    stateValue !== undefined &&
    !SPOTIFY_STATUS_STATES.includes(stateValue as SpotifyStatusState)
  ) {
    throw new InvalidSpotifyResponseError("state", "a supported state");
  }

  const engineReadyValue = optionalBoolean(root, "engine_ready");
  const engineReady = engineReadyValue ?? false;
  const enabled =
    optionalBoolean(root, "enabled") ??
    (stateValue !== undefined && stateValue !== "disabled");
  const state =
    (stateValue as SpotifyStatusState | undefined) ??
    (engineReady ? "ready" : enabled ? "not_configured" : "disabled");
  const deviceName = optionalString(root, "device_name")?.trim();
  const username = optionalString(root, "username")?.trim();
  const lastError = optionalString(root, "last_error")?.trim();
  const pairingExpiresAt = optionalTimestamp(root, "pairing_expires_at");
  const providerValue = optionalString(root, "active_provider") ?? "spotify";
  if (!MUSIC_PROVIDERS.includes(providerValue as MusicProvider)) {
    throw new InvalidSpotifyResponseError("active_provider", "a supported music provider");
  }

  return {
    active_provider: providerValue as MusicProvider,
    enabled,
    experimental_acknowledged:
      optionalBoolean(root, "experimental_acknowledged") ?? false,
    state,
    device_name: deviceName || DEFAULT_SPOTIFY_DEVICE_NAME,
    ...(username ? { username } : {}),
    engine_ready: engineReadyValue ?? state === "ready",
    ...(pairingExpiresAt ? { pairing_expires_at: pairingExpiresAt } : {}),
    ...(lastError ? { last_error: lastError } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeArtists(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .map((artist) => {
      if (typeof artist === "string") return stringValue(artist);
      if (artist && typeof artist === "object" && !Array.isArray(artist)) {
        return stringValue((artist as Record<string, unknown>).name);
      }
      return undefined;
    })
    .filter((artist): artist is string => Boolean(artist));
}

function normalizeAlbum(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return stringValue((value as Record<string, unknown>).name);
  }
  return undefined;
}

function normalizeTrack(value: unknown): SpotifySearchTrack | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = stringValue(item.id) ?? stringValue(item.uri);
  const title = stringValue(item.title) ?? stringValue(item.name);
  if (!id || !title) return null;

  const artists = normalizeArtists(item.artists ?? item.artist);
  const album = normalizeAlbum(item.album);
  const duration = item.duration_ms;
  const explicit = item.explicit;

  return {
    id,
    title,
    artists,
    ...(album ? { album } : {}),
    ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0
      ? { duration_ms: duration }
      : {}),
    ...(typeof explicit === "boolean" ? { explicit } : {}),
  };
}

/** Normalize current and early server search envelopes into bounded track rows. */
export function normalizeSpotifySearchResponse(
  input: unknown,
): SpotifySearchResponse {
  const candidates = Array.isArray(input)
    ? input
    : (() => {
        const root = record(input, "search");
        const items = root.items ?? root.tracks ?? root.results;
        if (!Array.isArray(items)) {
          throw new InvalidSpotifyResponseError(
            "search.items",
            "an array",
          );
        }
        return items;
      })();

  return {
    items: candidates
      .slice(0, 50)
      .map(normalizeTrack)
      .filter((item): item is SpotifySearchTrack => item !== null),
  };
}
