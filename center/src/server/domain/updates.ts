/*
 * Settings → Advanced → Software updates, and the operator banner.
 *
 * INFERRED: humane.center never updated itself. This is Luma's own surface.
 * Center asks the Center at `LUMA_UPDATE_SOURCE` for its `/api/version`, the
 * same manifest this Center serves, and compares release versions. The
 * server's `./luma update production --check|--auto` writes a status file
 * Center reads and never writes. Nothing here changes the server: the page
 * names the command the operator runs.
 *
 * One check per hour per process (a failed one is retried after five
 * minutes); "Check now" forces one. The fetch has its own 5 s deadline so a
 * slow source can never hold a page, and the root layout never calls it: the
 * banner asks `GET /api/admin/updates` from the browser.
 */

import { readFile } from "node:fs/promises";

import {
  compareReleaseVersions,
  updateStatusFileSchema,
  versionManifestSchema,
  type LatestRelease,
  type UpdateCheck,
  type UpdateOverview,
  type UpdateStatusFile,
} from "@/lib/contracts/updates";
import { centerRuntimeIdentity } from "@/lib/runtimeIdentity";
import { logWarn } from "@/server/log";

const CHECK_CACHE_MS = 60 * 60 * 1000;
const FAILED_CHECK_CACHE_MS = 5 * 60 * 1000;
const SOURCE_DEADLINE_MS = 5_000;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_STATUS_FILE_BYTES = 64 * 1024;

type Environment = Record<string, string | undefined>;

export interface UpdateSettings {
  /** The https origin this Center polls, or `null` when none (or no valid one) is configured. */
  source: string | null;
  autoUpdates: "on" | "off" | "unknown";
  statusFile: string | null;
}

/** The server-side update settings, read once per call from the environment. */
export function updateSettings(environment: Environment = process.env): UpdateSettings {
  const auto = environment.LUMA_AUTO_UPDATES?.trim().toLowerCase();
  return {
    source: sourceOrigin(environment.LUMA_UPDATE_SOURCE),
    autoUpdates: auto === "on" || auto === "off" ? auto : "unknown",
    statusFile: environment.LUMA_UPDATE_STATUS_FILE?.trim() || null,
  };
}

/** Only an absolute https origin is ever fetched. Anything else is "no source". */
function sourceOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch (error) {
    logWarn("[updates] LUMA_UPDATE_SOURCE is not a URL; update checks are off", error instanceof Error ? error.name : error);
    return null;
  }
}

let cached: { source: string; currentVersion: string | null; at: number; check: UpdateCheck } | null = null;

/** For tests only. */
export function resetUpdateCheckCache(): void {
  cached = null;
}

export interface CheckOptions {
  /** Ignore the hourly cache: the operator pressed "Check now". */
  force?: boolean;
  environment?: Environment;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Ask the update source what it runs, and say how this Center compares. */
export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateCheck> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const { source } = updateSettings(environment);
  if (!source) return { outcome: "source-unknown" };
  const currentVersion = centerRuntimeIdentity(environment).version;

  if (
    !options.force &&
    cached &&
    cached.source === source &&
    cached.currentVersion === currentVersion &&
    now() - cached.at < (cached.check.outcome === "source-unreachable" ? FAILED_CHECK_CACHE_MS : CHECK_CACHE_MS)
  ) {
    return cached.check;
  }

  const check = await fetchCheck(source, currentVersion, options.fetchImpl ?? fetch, new Date(now()).toISOString());
  cached = { source, currentVersion, at: now(), check };
  return check;
}

async function fetchCheck(
  source: string,
  currentVersion: string | null,
  fetchImpl: typeof fetch,
  checkedAt: string,
): Promise<UpdateCheck> {
  let latest: LatestRelease;
  try {
    const response = await fetchImpl(`${source}/api/version`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(SOURCE_DEADLINE_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { outcome: "source-unreachable", checkedAt };
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_MANIFEST_BYTES) return { outcome: "source-unreachable", checkedAt };
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) return { outcome: "source-unreachable", checkedAt };
    const parsed = versionManifestSchema.safeParse(JSON.parse(text));
    // A source that names no release version gives nothing to compare.
    if (!parsed.success || !parsed.data.version) return { outcome: "source-unreachable", checkedAt };
    const manifest = { ...parsed.data, version: parsed.data.version };
    latest = {
      version: manifest.version,
      tag: manifest.tag ?? null,
      pinVersion: manifest.pin?.version ?? null,
      notes: manifest.notes ?? null,
      publishedAt: manifest.publishedAt ?? null,
    };
  } catch (error) {
    logWarn("[updates] the update source did not answer", error instanceof Error ? error.name : error);
    return { outcome: "source-unreachable", checkedAt };
  }

  const comparison = compareReleaseVersions(currentVersion, latest.version);
  if (comparison === null) return { outcome: "unknown-version", checkedAt, latest };
  return comparison < 0
    ? { outcome: "update-available", checkedAt, latest }
    : { outcome: "up-to-date", checkedAt, latest };
}

/**
 * The status file, or `null` when there is none, it is unreadable, or it is
 * not the shape this Center understands. Absence is normal: a server that has
 * never run `./luma update production` has no file.
 */
export async function readUpdateStatus(environment: Environment = process.env): Promise<UpdateStatusFile | null> {
  const { statusFile } = updateSettings(environment);
  if (!statusFile) return null;
  try {
    const text = await readFile(statusFile, "utf8");
    if (text.length > MAX_STATUS_FILE_BYTES) return null;
    const parsed = updateStatusFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    // No file yet is normal: the server has not run an update check.
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      logWarn("[updates] the update status file is unreadable", error instanceof Error ? error.name : error);
    }
    return null;
  }
}

/** Everything the banner and the Software updates page render. */
export async function updateOverview(options: CheckOptions = {}): Promise<UpdateOverview> {
  const environment = options.environment ?? process.env;
  const identity = centerRuntimeIdentity(environment);
  const settings = updateSettings(environment);
  const [check, status] = await Promise.all([checkForUpdate(options), readUpdateStatus(environment)]);
  return {
    current: {
      release: identity.release,
      version: identity.version,
      tag: identity.tag,
      pinVersion: identity.pin?.version ?? null,
      notes: identity.notes,
      publishedAt: identity.publishedAt,
    },
    source: settings.source,
    autoUpdates: settings.autoUpdates === "unknown" && status?.autoUpdates ? status.autoUpdates : settings.autoUpdates,
    check,
    lastUpdate: status?.lastUpdate ?? null,
  };
}
