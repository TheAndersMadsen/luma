import type {
  CellularServicePayload,
  CellularServiceStatusResponse,
  EsimEidResult,
  EsimEvent,
  EsimProfile,
  EsimProfilesResult,
} from "@/lib/pin-device";
import { PinApiError } from "@/lib/pin-device";
import { deviceErrorMessage } from "./deviceErrorPresentation";

/*
 * The eSIM classification layer, ported from the retired Setup SPA's
 * `EsimSettingsPage.tsx`.
 *
 * The SPA kept these as exported functions ON the page component so its tests
 * could reach them. Here they are a module, so the pane is pure rendering. The
 * one deliberate change: the SPA's `dataSourceNotice` returned JSX. It now
 * returns a `{ tone, text }` descriptor, so this module stays framework-free
 * and the pane renders it through Center's <StatusMessage>.
 */

export type DataState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; value: T }
  | { kind: "empty"; hint?: string }
  | { kind: "error"; message: string }
  | { kind: "timeout" }
  | { kind: "malformed" }
  | { kind: "disconnected" };

export function isTimeoutError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && /timed out|timeout/i.test(error.message))
  );
}

export function classifyApiError(error: unknown): DataState<never> {
  if (isTimeoutError(error)) return { kind: "timeout" };
  if (error instanceof PinApiError) {
    if (error.status === 0) return { kind: "disconnected" };
    return {
      kind: "error",
      message: deviceErrorMessage(error, "Could not load data from the Pin."),
    };
  }
  if (
    error instanceof TypeError &&
    /fetch|network|failed to fetch/i.test(error.message)
  ) {
    return { kind: "disconnected" };
  }
  return { kind: "error", message: "Could not load data from the Pin." };
}

export function classifyCellularResponse(
  result: CellularServiceStatusResponse,
): DataState<CellularServicePayload> {
  if (result.type === "cellular.status_result") {
    const payload = extractCellularStatus(result);
    if (payload) return { kind: "loaded", value: payload };
    return { kind: "malformed" };
  }
  if (result.type === "cellular.status_timeout") return { kind: "timeout" };
  if (result.type === "cellular.status_error") {
    const message =
      result.payload &&
      "message" in result.payload &&
      typeof result.payload.message === "string"
        ? result.payload.message
        : "Cellular status could not be determined.";
    return { kind: "error", message };
  }
  return { kind: "malformed" };
}

export function classifyProfilesResult(
  result: EsimProfilesResult,
): DataState<EsimProfile[]> {
  const profiles = extractProfiles(result);
  if (profiles.length === 0) {
    return { kind: "empty", hint: "No eSIM profiles found on this device." };
  }
  return { kind: "loaded", value: profiles };
}

export function classifyEidResult(
  result: EsimEidResult,
): DataState<{ eid: string | null; imei: string | null }> {
  const eid = extractEid(result);
  const imei = extractImei(result);
  if (!eid && !imei) {
    return { kind: "empty", hint: "Device eSIM identifiers are not available." };
  }
  return { kind: "loaded", value: { eid, imei } };
}

export function labelizeCellularValue(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractCellularStatus(
  result: CellularServiceStatusResponse,
): CellularServicePayload | null {
  if (result.type !== "cellular.status_result") return null;
  const payload = result.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const details = (payload as { details?: unknown }).details;
  // The pane renders these two straight through labelizeCellularValue, which
  // needs strings. Anything else is exactly what "malformed" exists to say.
  if (
    !details ||
    typeof details !== "object" ||
    typeof (details as { service_state?: unknown }).service_state !== "string" ||
    typeof (details as { data_connection_state?: unknown }).data_connection_state !==
      "string"
  ) {
    return null;
  }
  return payload as CellularServicePayload;
}

export function formatSignal(status: CellularServicePayload): string {
  const { signal_level, signal_dbm } = status.details;
  if (signal_level == null && signal_dbm == null) return "Unavailable";
  const level = signal_level == null ? null : `${signal_level}/4`;
  const dbm = signal_dbm == null ? null : `${signal_dbm} dBm`;
  return [level, dbm ? `(${dbm})` : null].filter(Boolean).join(" ");
}

export function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

export function onOff(value: boolean): string {
  return value ? "On" : "Off";
}

function extractProfiles(result: EsimProfilesResult): EsimProfile[] {
  if (Array.isArray(result.profiles)) return result.profiles;
  if (Array.isArray(result.payload?.profiles)) return result.payload.profiles;
  return [];
}

function extractEid(result: EsimEidResult): string | null {
  if (result.eid) return result.eid;
  if (result.payload?.eid) return result.payload.eid;
  return null;
}

function extractImei(result: EsimEidResult): string | null {
  if (result.imei) return result.imei;
  if (result.payload?.imei) return result.payload.imei;
  return null;
}

export function profileTitle(profile: EsimProfile): string {
  return (
    profile.nickname || profile.name || profile.service_provider || "eSIM Profile"
  );
}

export function isTerminalEsimEvent(event: EsimEvent): boolean {
  return [
    "esim.profile_mutation_result",
    "esim.download_result",
    "esim.profiles_result",
    "esim.device_identifiers_result",
  ].includes(event.type);
}

export function esimEventMessage(event: EsimEvent): string {
  const payload = event.payload;
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.phase === "string") {
    const progress =
      typeof payload.progress === "number" ? ` (${payload.progress}%)` : "";
    return `${payload.phase}${progress}`;
  }
  if (typeof payload?.result === "string") return payload.result;
  return event.type;
}

export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function formatStaleness(lastLoadedAt: number): string {
  const elapsed = Date.now() - lastLoadedAt;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * The SPA's `dataSourceNotice`, reduced to a descriptor so this module carries
 * no JSX. `null` means "the data is present, say nothing".
 */
export function describeDataState(
  state: DataState<unknown>,
): { tone: "info" | "warning" | "danger"; text: string } | null {
  switch (state.kind) {
    case "idle":
    case "loaded":
      return null;
    case "loading":
      return { tone: "info", text: "Loading…" };
    case "empty":
      return { tone: "info", text: state.hint ?? "No data available." };
    case "error":
      return { tone: "warning", text: `${state.message} Use Refresh to try again.` };
    case "timeout":
      return {
        tone: "warning",
        text: "The Pin did not answer in time. Check the USB connection and use Refresh to try again.",
      };
    case "malformed":
      return {
        tone: "warning",
        text: "The Pin returned an unexpected response format. Try refreshing.",
      };
    case "disconnected":
      return {
        tone: "danger",
        text: "Not connected to a Pin. Reconnect from the Connect pane.",
      };
  }
}
