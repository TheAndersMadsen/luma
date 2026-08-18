/**
 * The Pin device substrate: a typed client for the Pin's REST API plus the
 * transports that implement it.
 *
 * Ported from the retired standalone Setup SPA (`src/api/**` and
 * `src/install/device/**`). Every module here is framework-free and safe for
 * the server to *import* — none of them touch `window`, `document` or
 * `navigator` at module scope — but the WebUSB session in `./adb` obviously
 * only functions in a browser, so reach it from a `"use client"` file.
 *
 * The ADB substrate is deliberately NOT re-exported here: importing it drags
 * `@yume-chan/adb-daemon-webusb` in, and most consumers of the REST client do
 * not need it. Import from `@/lib/pin-device/adb` when you do.
 */
export {
  AdminTokenRotationUncertainError,
  LanAdminAuthNotEnforcedError,
  PinApiError,
  PinClient,
} from "./client";

export { BufferedPinResponse, RemoteFetchPinTransport } from "./transport";
export type { PinResponseLike, PinTransport } from "./transport";

export { DEFAULT_PIN_PORT, UsbAdbHttpTransport } from "./usbTransport";
export type { UsbAdbHttpTransportSessionOptions } from "./usbTransport";

export {
  InvalidActivityResponseError,
  normalizeActivityResponse,
} from "./normalizers/activity";
export {
  FITNESS_SESSION_FILENAMES,
  InvalidFitnessRequestError,
  InvalidFitnessResponseError,
  isCanonicalFitnessSessionId,
  normalizeFitnessSession,
  normalizeFitnessSessionsResponse,
  requireCanonicalFitnessSessionId,
  requireFitnessSessionFilename,
} from "./normalizers/fitness";
export {
  DEFAULT_SPOTIFY_DEVICE_NAME,
  InvalidSpotifyResponseError,
  normalizeSpotifySearchResponse,
  normalizeSpotifyStatusResponse,
} from "./normalizers/spotify";

export {
  isDebugLoggingEnabled,
  logDebug,
  logError,
  logInfo,
  logWarn,
  redactForLogging,
  setDebugLoggingEnabled,
} from "./logging";
export type { LogMeta } from "./logging";

export type * from "./types";
