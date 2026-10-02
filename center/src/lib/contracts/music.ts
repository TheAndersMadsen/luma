import * as z from "zod/mini";

export const musicProviderSchema = z.enum([
  "spotify",
  "youtube_music",
  "apple_music",
  "tidal",
]);
export type MusicProvider = z.infer<typeof musicProviderSchema>;

/**
 * What each provider is to Luma. `pinPlayback`: the Pin has a runtime that can
 * play it. `gateway`: Center hosts its catalog and stream gateway (Spotify's
 * catalog is the Pin's own adapter). Apple Music can be linked but not played.
 */
export const MUSIC_PROVIDERS = {
  spotify: { label: "Spotify", pinPlayback: true, gateway: false },
  youtube_music: { label: "YouTube Music", pinPlayback: true, gateway: true },
  apple_music: { label: "Apple Music", pinPlayback: false, gateway: false },
  tidal: { label: "TIDAL", pinPlayback: true, gateway: true },
} as const satisfies Record<MusicProvider, { label: string; pinPlayback: boolean; gateway: boolean }>;

/** Normalized catalog result consumed by the stock music gateway. */
export const musicTrackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string(),
  duration_ms: z.int().check(z.nonnegative()),
  track_number: z.int().check(z.nonnegative()),
  disc_number: z.int().check(z.nonnegative()),
  explicit: z.boolean(),
});
export type MusicTrack = z.infer<typeof musicTrackSchema>;
const linkSchema = z.object({
  linked: z.boolean(),
  connected_at: z.optional(z.string()),
});
/** The public account summary deliberately has no credential fields. */
export const musicAccountSummarySchema = z.object({
  active_provider: musicProviderSchema,
  youtube_music: linkSchema,
  apple_music: linkSchema,
  tidal: z.object({ ...linkSchema.shape, connecting: z.boolean() }),
});
export type MusicAccountSummary = z.infer<typeof musicAccountSummarySchema>;

export const spotifyPinStateSchema = z.enum([
  "disabled",
  "not_configured",
  "pairing",
  "ready",
  "error",
]);
export type SpotifyPinState = z.infer<typeof spotifyPinStateSchema>;
const unavailableReasonSchema = z.enum([
  "not_configured",
  "pin_not_paired",
  "pairing_unconfirmed",
  "pin_unavailable",
  "pin_update_required",
]);
export type SpotifyUnavailableReason = z.infer<typeof unavailableReasonSchema>;
export const musicProviderStatusSchema = z.object({
  youtube_music: z.object({
    configured: z.boolean(),
    state: z.enum(["not_connected", "pairing", "connected", "error"]),
    device_code: z.optional(
      z.object({
        user_code: z.string(),
        verification_url: z.url(),
        expires_at: z.number(),
      }),
    ),
    ad_filtering: z.literal("pear_newpipe"),
  }),
  tidal: z.object({
    configured: z.boolean(),
    state: z.enum([
      "not_configured",
      "not_connected",
      "connecting",
      "connected",
      "error",
    ]),
  }),
  apple_music: z.object({
    configured: z.boolean(),
    state: z.enum([
      "not_configured",
      "not_connected",
      "connected_playback_runtime_required",
      "error",
    ]),
  }),
});
export type MusicProviderStatus = z.infer<typeof musicProviderStatusSchema>;
export const spotifyStatusSchema = z.object({
  active_provider: musicProviderSchema,
  pin_active_provider: z.optional(musicProviderSchema),
  providers: z.optional(musicProviderStatusSchema),
  enabled: z.boolean(),
  experimental_acknowledged: z.boolean(),
  state: z.union([spotifyPinStateSchema, z.literal("unavailable")]),
  device_name: z.string(),
  engine_ready: z.boolean(),
  username: z.optional(z.string()),
  pairing_expires_at: z.optional(z.number()),
  last_error: z.optional(z.string()),
  unavailable_reason: z.optional(unavailableReasonSchema),
  fallback_setup: z.optional(z.boolean()),
});
export type SpotifyStatus = z.infer<typeof spotifyStatusSchema>;
export const spotifySearchTrackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.optional(z.string()),
  duration_ms: z.optional(z.int().check(z.nonnegative())),
  explicit: z.optional(z.boolean()),
});
export type SpotifySearchTrack = z.infer<typeof spotifySearchTrackSchema>;
export const spotifySearchResultSchema = z.object({
  items: z.array(spotifySearchTrackSchema),
});
export type SpotifySearchResult = z.infer<typeof spotifySearchResultSchema>;
