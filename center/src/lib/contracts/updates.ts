/*
 * Luma's own update surface (INFERRED: humane.center had no self-hosted
 * update flow). Three shapes meet here:
 *
 *   1. The version manifest another Center serves at `GET /api/version` and
 *      this Center polls (`versionManifestSchema`).
 *   2. The status file `./luma update production --check|--auto` writes on
 *      the server (`updateStatusFileSchema`), read-only for Center.
 *   3. What the operator's browser is told (`UpdateOverview`), which the
 *      banner and the Software updates page render.
 *
 * Every field is optional-safe: an absent value renders as unknown, never as
 * a crash.
 */

import * as z from "zod/mini";

/** A Center release version: `X.Y.Z`. */
const RELEASE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u;

export const MAX_RELEASE_NOTES_CHARS = 2000;

const trimmedString = (max: number) => z.string().check(z.trim(), z.maxLength(max));

/** A field an older Center or the server's status file may omit or set to `null`. Readers treat both as unknown. */
const absent = <T extends z.ZodMiniType>(schema: T) => z.optional(z.nullable(schema));

/** One release a manifest advertises as newest, with the manifest's nested `pin`. */
const advertisedReleaseSchema = z.object({
  version: trimmedString(32),
  tag: absent(trimmedString(64)),
  pin: absent(
    z.object({
      version: trimmedString(32),
      versionCode: z.nullable(z.number().check(z.int(), z.nonnegative())),
    }),
  ),
  notes: absent(z.string().check(z.maxLength(MAX_RELEASE_NOTES_CHARS))),
  publishedAt: absent(z.string().check(z.maxLength(64))),
});

/**
 * What `GET /api/version` serves, and what this Center reads back from its
 * update source. This Center always sends every key (`null` when unset). A
 * source running an older Center may omit the release fields. `latest` names
 * the release the source advertises as newest — for a Luma Center, the newest
 * published upstream release, which it serves whether or not it runs it yet.
 */
export const versionManifestSchema = z.object({
  product: trimmedString(64),
  release: trimmedString(128),
  environment: trimmedString(32),
  version: absent(trimmedString(32)),
  tag: absent(trimmedString(64)),
  pin: absent(
    z.object({
      version: trimmedString(32),
      versionCode: z.nullable(z.number().check(z.int(), z.nonnegative())),
    }),
  ),
  notes: absent(z.string().check(z.maxLength(MAX_RELEASE_NOTES_CHARS))),
  publishedAt: absent(z.string().check(z.maxLength(64))),
  latest: absent(advertisedReleaseSchema),
});
export type VersionManifest = z.infer<typeof versionManifestSchema>;

/** One release as the update source describes it. */
export const latestReleaseSchema = z.object({
  version: trimmedString(32),
  tag: z.nullable(trimmedString(64)),
  pinVersion: z.nullable(trimmedString(32)),
  notes: z.nullable(z.string().check(z.maxLength(MAX_RELEASE_NOTES_CHARS))),
  publishedAt: z.nullable(z.string().check(z.maxLength(64))),
});
export type LatestRelease = z.infer<typeof latestReleaseSchema>;

export const lastUpdateSchema = z.object({
  startedAt: absent(z.string().check(z.maxLength(64))),
  finishedAt: absent(z.string().check(z.maxLength(64))),
  from: absent(trimmedString(32)),
  to: absent(trimmedString(32)),
  outcome: z.enum(["updated", "failed", "rolled-back"]),
  message: absent(z.string().check(z.maxLength(2000))),
});
export type LastUpdate = z.infer<typeof lastUpdateSchema>;

/** One release as the status file names it. Only the version is required. */
const statusReleaseSchema = z.object({
  version: trimmedString(32),
  tag: absent(trimmedString(64)),
  pinVersion: absent(trimmedString(32)),
  notes: absent(z.string().check(z.maxLength(MAX_RELEASE_NOTES_CHARS))),
  publishedAt: absent(z.string().check(z.maxLength(64))),
});

/**
 * `LUMA_UPDATE_STATUS_FILE`, written by the server's `./luma update production`.
 * Center only reads it. A field the server omits reads as unknown. A
 * different `schemaVersion` is not read at all.
 */
export const updateStatusFileSchema = z.object({
  schemaVersion: z.literal(1),
  checkedAt: absent(z.string().check(z.maxLength(64))),
  source: absent(z.string().check(z.maxLength(512))),
  current: absent(
    z.object({
      version: absent(trimmedString(32)),
      tag: absent(trimmedString(64)),
      pinVersion: absent(trimmedString(32)),
    }),
  ),
  latest: absent(statusReleaseSchema),
  autoUpdates: absent(z.enum(["on", "off"])),
  lastUpdate: absent(lastUpdateSchema),
});
export type UpdateStatusFile = z.infer<typeof updateStatusFileSchema>;

/**
 * The typed outcome of one update check. `source-unknown` means no
 * `LUMA_UPDATE_SOURCE`; `unknown-version` means this Center has no
 * `LUMA_RELEASE_VERSION` to compare, so the source's answer is shown but not
 * judged.
 */
export const updateCheckSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("up-to-date"), checkedAt: z.string(), latest: latestReleaseSchema }),
  z.object({ outcome: z.literal("update-available"), checkedAt: z.string(), latest: latestReleaseSchema }),
  z.object({ outcome: z.literal("unknown-version"), checkedAt: z.string(), latest: latestReleaseSchema }),
  z.object({ outcome: z.literal("source-unreachable"), checkedAt: z.string() }),
  z.object({ outcome: z.literal("source-unknown") }),
]);
export type UpdateCheck = z.infer<typeof updateCheckSchema>;

/** What the operator's browser receives from `GET /api/admin/updates`. */
export const updateOverviewSchema = z.object({
  current: z.object({
    release: z.string(),
    version: z.nullable(z.string()),
    tag: z.nullable(z.string()),
    pinVersion: z.nullable(z.string()),
    notes: z.nullable(z.string()),
    publishedAt: z.nullable(z.string()),
  }),
  source: z.nullable(z.string()),
  autoUpdates: z.enum(["on", "off", "unknown"]),
  check: updateCheckSchema,
  lastUpdate: z.nullable(lastUpdateSchema),
});
export type UpdateOverview = z.infer<typeof updateOverviewSchema>;

export function parseReleaseVersion(value: string | null | undefined): [number, number, number] | null {
  const trimmed = value?.trim() ?? "";
  if (!RELEASE_VERSION.test(trimmed)) return null;
  const [major = 0, minor = 0, patch = 0] = trimmed.split(".").map((part) => Number.parseInt(part, 10));
  return [major, minor, patch];
}

/**
 * `X.Y.Z` order; `null` when either side is not a release version, so a
 * caller never treats an unparseable string as older or newer.
 */
export function compareReleaseVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): -1 | 0 | 1 | null {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}
