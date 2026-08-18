/*
 * Wearer settings — privacy toggles, saved Wi-Fi, and the wearer-visible
 * feature flags. Owns the protocol access and shaping; the routes translate
 * these results into their stable HTTP bodies.
 */

import {
  COSMOS_ADMIN_ENABLED,
  COSMOS_ENABLED,
  COSMOS_WEBAPI,
  Services,
  SessionExpiredError,
  adminAuthHeaders,
  call,
  cosmosDeadlineSignal,
} from "../cosmos";

/*
 * Settings → Privacy toggles, backed by `PublicPrivacyService`.
 *
 *   GET  → GetSettings   (PrivacySettingInfo{ name, status, value }[])
 *   POST → UpdateSettings (PrivacySetting{ name, value }[] → SettingStateResponse[])
 *
 * `GetSettingsRequest.names` is a repeated string; an empty list asks for every
 * setting the backend knows. Each `PrivacySettingInfo` carries a `name` and a
 * string `value` (the stock Pin uses "on"/"off"); the human label is derived from the
 * name on the client. Labels/manager metadata live on `PrivacySettingConfiguration`
 * (GetConfiguration), a separate RPC we deliberately do not fan out to here.
 */

export interface PrivacySetting {
  name: string;
  value: string;
  status?: string;
}

interface GetSettingsResponse {
  settings?: Array<{ name?: string; value?: string; status?: string }>;
}

/**
 * The four outcomes a settings read or write can have, told apart so a route
 * can keep answering each with its established body: `absent` (nothing is
 * configured to answer — not retryable), `expired` (the wearer's Keycloak grant
 * died behind their Center cookie — only they can fix it), `degraded` (the
 * backend is configured and did not answer), `live` (the backend answered).
 */
export type SettingsRead<T> =
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "degraded" }
  | { kind: "live"; value: T };

export async function getPrivacySettings(): Promise<SettingsRead<PrivacySetting[]>> {
  if (!COSMOS_ENABLED) return { kind: "absent" };
  try {
    const res = await call<{ names: string[] }, GetSettingsResponse>(
      Services.privacy,
      "GetSettings",
      { names: [] },
    );

    const settings: PrivacySetting[] = (res.settings ?? [])
      .map((s) => ({
        name: (s.name ?? "").trim(),
        value: s.value ?? "",
        status: s.status,
      }))
      .filter((s) => s.name.length > 0);
    return { kind: "live", value: settings };
  } catch (error) {
    // An expired Keycloak grant behind a still-valid Center cookie is the
    // wearer's problem, not the backend's. A bare catch here reported it as
    // "PublicPrivacyService.GetSettings did not answer" — a claim that the
    // backend is down — while the Wi-Fi read answered the IDENTICAL error with
    // 401 + reauthenticate. One expiry, one answer.
    if (error instanceof SessionExpiredError) return { kind: "expired" };
    return { kind: "degraded" };
  }
}

interface UpdateSettingsResponse {
  results?: Array<{ name?: string; status?: string }>;
}

/**
 * Normalise a privacy toggle value to the stock wire vocabulary.
 *
 * The stock key-upload predicate joins configuration and settings by exact
 * string equality. Its observed values are "on"/"off", so persisting the
 * browser's raw booleans as "true"/"false" silently disables every matching
 * key-manager gate even though the toggle looks enabled in Center.
 */
export function privacySettingValue(value: unknown): string {
  return typeof value === "boolean" ? (value ? "on" : "off") : String(value ?? "");
}

export async function updatePrivacySetting(
  name: string,
  value: string,
): Promise<SettingsRead<{ ok: boolean; status: string | null }>> {
  if (!COSMOS_ENABLED) return { kind: "absent" };
  try {
    const res = await call<
      { settings: Array<{ name: string; value: string }> },
      UpdateSettingsResponse
    >(Services.privacy, "UpdateSettings", { settings: [{ name, value }] });

    const result = (res.results ?? [])[0];
    const status = result?.status ?? null;
    const ok = status === "SETTING_SUCCESS" || status === "SETTING_UPDATED";
    return { kind: "live", value: { ok, status } };
  } catch (error) {
    // Same expiry, same answer as the read above: a toggle that failed because
    // the wearer needs to sign in again must say so, or the pane reverts the
    // switch and blames a backend that is fine.
    if (error instanceof SessionExpiredError) return { kind: "expired" };
    return { kind: "degraded" };
  }
}

/*
 * "Saved Wi-Fi Networks" on Settings → My Ai Pin.
 *
 * Reads `WifiConfigService.ListSecureWifiConfigs`. On the wire that response is
 * `repeated humane.common.encryption.EncryptedData secure_wifi_configs`
 * (contracts/wire/humane/account.proto) — SEALED ENVELOPES, not `WifiConfig`
 * rows. `WifiConfig{ uuid, authorization_type, network_ssid, password, hidden }`
 * is the plaintext *inside* one, and Cosmos replays the stored response verbatim
 * (services/account.rs), so envelopes are what actually arrive here.
 *
 * Center cannot open these and must not try: the envelopes are sealed under the
 * DEVICE's key, and Center's own channel key is unrelated (trying it is what
 * once made every device-created note look permanently encrypted). So the honest
 * answer is the one the notes surface already gives for sealed rows — the read
 * succeeded, here is how many there are, and this dashboard does not hold the
 * key. The Pin's own `/api/devices/status` report is where legible SSIDs come
 * from.
 */

/** `humane.common.encryption.EncryptedData`, as proto-loader surfaces it. */
interface SealedWifiConfig {
  encryptionInformation?: { kid?: Buffer | string };
  data?: Buffer | Uint8Array;
}

interface ListSecureWifiConfigsResponse {
  secureWifiConfigs?: SealedWifiConfig[];
}

export async function getSealedWifiSummary(): Promise<SettingsRead<{ sealedCount: number }>> {
  if (!COSMOS_ENABLED) return { kind: "absent" };
  try {
    const res = await call<Record<string, never>, ListSecureWifiConfigsResponse>(
      Services.wifi,
      "ListSecureWifiConfigs",
      {},
    );

    // Count the envelopes; never decode them. An entry with no payload is not a
    // saved network, it is a malformed row, and counting it would restate the
    // original bug in the other direction.
    const sealedCount = (res.secureWifiConfigs ?? []).filter(
      (config) => (config.data?.length ?? 0) > 0,
    ).length;
    return { kind: "live", value: { sealedCount } };
  } catch (error) {
    // An expired grant is the wearer's problem to fix, not the backend's, so
    // say so and let the client re-authenticate. Swallowing it into the generic
    // "did not answer" arm is what disguised a routine session expiry as an
    // unreachable service for as long as this surface has existed.
    if (error instanceof SessionExpiredError) return { kind: "expired" };
    return { kind: "degraded" };
  }
}

/*
 * Wearer-visible feature flags.
 *
 * The flag store is the admin REST surface, so the allowlist below is the whole
 * of what a wearer can see or change through Center. Everything else on
 * /demo-api/flags stays operator-only.
 */

export const WEARER_FEATURES = new Set([
  "touchcode_enabled",
  "touchcode_timeout_millis",
  "vision_custom_gesture_enabled",
  "quick_actions_remapping_enabled",
  "music_interstitials_enabled",
  "tickle",
  "cmu_ultra_enabled",
  "cmu_ultra_chime_enabled",
  "vision_actions_enabled",
  "fitness_tracker_enabled",
  "fitness_tracker_extra_data_enabled",
  "esim_qr_scanner_enabled",
  "network_reset_enabled",
]);

export const WEARER_FEATURES_AVAILABLE = () => Boolean(COSMOS_ADMIN_ENABLED && COSMOS_WEBAPI);

/** The wearer-visible slice of the flag catalog, or null when it did not answer. */
export async function readWearerFeatures(): Promise<Array<{ name?: string }> | null> {
  if (!WEARER_FEATURES_AVAILABLE()) return null;
  const response = await fetch(`${COSMOS_WEBAPI}/demo-api/flags`, {
    headers: adminAuthHeaders(),
    cache: "no-store",
    signal: cosmosDeadlineSignal(),
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => [])) as Array<{ name?: string }>;
  return body.filter((flag) => flag.name && WEARER_FEATURES.has(flag.name));
}

/** Write (PUT) or clear (DELETE) one allowlisted flag. */
export async function writeWearerFeature(
  name: string,
  value: unknown,
  method: "PUT" | "DELETE",
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; unconfigured: true }
  | { ok: false; unconfigured?: false; status?: number }
> {
  if (!WEARER_FEATURES_AVAILABLE()) return { ok: false, unconfigured: true };
  const response = await fetch(`${COSMOS_WEBAPI}/demo-api/flags/${encodeURIComponent(name)}`, {
    method,
    headers: { ...adminAuthHeaders(), "content-type": "application/json" },
    body: method === "PUT" ? JSON.stringify({ value }) : undefined,
    cache: "no-store",
    signal: cosmosDeadlineSignal(),
  }).catch(() => null);
  if (!response?.ok) return { ok: false, status: response?.status };
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: true, result };
}

/**
 * Ask the push plane to nudge the Pin's feature-flag sync. Best-effort: the
 * flag write has already landed, so a failed nudge only means the device picks
 * it up on its next scheduled sync.
 */
export async function queueFeatureSync(accountSub: string): Promise<"push_queued" | "next_sync"> {
  if (!COSMOS_WEBAPI) return "next_sync";
  const response = await fetch(`${COSMOS_WEBAPI}/demo-api/admin/push`, {
    method: "POST",
    headers: { ...adminAuthHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      account_sub: accountSub,
      app_name: "humane.feature-flags",
      data_payload: [],
      expiration_seconds: 86_400,
    }),
    cache: "no-store",
    signal: cosmosDeadlineSignal(),
  }).catch(() => null);
  return response?.ok ? "push_queued" : "next_sync";
}
