/*
 * The sentences the update surface says, in one place, so the banner and the
 * Software updates page never disagree. Pure: no fetch, no window.
 */

import type { LastUpdate, LatestRelease, UpdateCheck, UpdateOverview } from "./contracts/updates";
import { compareInstallVersions } from "./pin-install/domain/versions";

/** The one command that updates a server by hand. */
export const UPDATE_COMMAND = "./luma update production";
export const UPDATE_SOURCE_COMMAND = "./luma setup production --update-source https://…";
export const AUTO_UPDATES_COMMAND = "./luma setup production --auto-updates on|off";

/** "Sep 29, 2026", or `null` for anything that is not a date. */
export function formatReleaseDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "Sep 29, 2026 at 3:12 AM" (UTC, and says so), or `null`. */
export function formatReleaseMoment(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = formatReleaseDate(iso);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" });
  return `${day} at ${time} UTC`;
}

export type UpdateTone = "live" | "warning" | "danger" | "info";

/** What the last update did, in plain words, with the tone it deserves. */
export function describeLastUpdate(last: LastUpdate | null): { tone: UpdateTone; sentence: string } {
  if (!last) return { tone: "info", sentence: "No update has run on this server yet." };
  const when = formatReleaseMoment(last.finishedAt ?? last.startedAt);
  const on = when ? ` on ${when}` : "";
  const to = last.to ? ` to Luma ${last.to}` : "";
  const previous = last.from ? `your previous version, Luma ${last.from},` : "your previous version";
  switch (last.outcome) {
    case "updated":
      return {
        tone: "live",
        sentence: last.from && last.to ? `Updated from Luma ${last.from} to ${last.to}${on}.` : `Updated${to}${on}.`,
      };
    case "rolled-back":
      return {
        tone: "warning",
        sentence: `The update${to}${on} failed and ${previous} was restored. Nothing was lost.`,
      };
    case "failed":
      return {
        tone: "danger",
        sentence: `The update${to}${on} failed. Your Center kept running ${last.from ? `Luma ${last.from}` : "its previous version"}. Nothing was lost.`,
      };
  }
}

/** What the update source answered, as one sentence. */
export function describeCheck(check: UpdateCheck): { tone: UpdateTone; sentence: string } {
  switch (check.outcome) {
    case "up-to-date":
      return { tone: "live", sentence: `Your server runs the latest release, Luma ${check.latest.version}.` };
    case "update-available":
      return { tone: "info", sentence: `Luma ${check.latest.version} is available.` };
    case "unknown-version":
      return {
        tone: "warning",
        sentence: `The update source offers Luma ${check.latest.version}, but this server did not say which release it runs, so they cannot be compared.`,
      };
    case "source-unreachable":
      return { tone: "warning", sentence: "Center couldn’t get a release from the update source just now. It tries again in a few minutes." };
    case "source-unknown":
      return { tone: "info", sentence: "This server has no update source, so it never checks for updates." };
  }
}

/** What happens next once an update is available. */
export function describeNextStep(
  autoUpdates: "on" | "off" | "unknown",
  request?: { supported: boolean },
): string {
  if (autoUpdates === "on") return "It installs itself tonight; your Center may pause for a minute.";
  return request?.supported
    ? "Install it here with Install now; your Center may pause for a few minutes."
    : `To install it, run ${UPDATE_COMMAND} on your server.`;
}

/** Where the banner sends the operator. */
export const UPDATES_SETTINGS_HREF = "/settings/updates";
export const PIN_SOFTWARE_HREF = "/settings/pin/install";

/** What the operator's banner says, or `null` when there is nothing new. */
export interface UpdateNotice {
  /** Names the versions shown. Dismissing remembers it, so a newer release shows again. */
  readonly key: string;
  readonly center: { readonly latest: LatestRelease; readonly autoUpdates: UpdateOverview["autoUpdates"] } | null;
  readonly pin: { readonly offered: string; readonly onPin: string } | null;
}

/**
 * The banner's content from the server's overview and the Pin release this
 * browser last read over USB. Newer Pin apps are named only when that read
 * exists and is older than what the server now offers. The comparison is the
 * installer's own (`compareInstallVersions`).
 */
export function updateNotice(overview: UpdateOverview, pinReleaseOnPin: string | null): UpdateNotice | null {
  const center =
    overview.check.outcome === "update-available"
      ? { latest: overview.check.latest, autoUpdates: overview.autoUpdates }
      : null;
  const offered = overview.current.pinVersion;
  const pin =
    offered && pinReleaseOnPin && compareInstallVersions(pinReleaseOnPin, offered) === -1
      ? { offered, onPin: pinReleaseOnPin }
      : null;
  if (!center && !pin) return null;
  return { key: `center:${center?.latest.version ?? "-"}|pin:${pin?.offered ?? "-"}`, center, pin };
}
