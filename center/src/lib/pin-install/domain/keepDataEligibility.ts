/**
 * Where a managed package's APK actually lives, and whether the device's own
 * installer will therefore keep its data across an update.
 *
 * This exists because the migration decision was planning an update the device
 * could not perform. The PenumbraOS staging provider only keep-data-updates
 * packages it owns, and it decides ownership from the installed APK path, not
 * from the package name:
 *
 *   pin/injector/installer/src/main/kotlin/com/penumbraos/systeminjector/StagingSafety.kt:26-34
 *     InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate(packageName, uid, sourceDir) =
 *       uid % PER_USER_RANGE == SYSTEM_SHARED_USER_ID &&
 *       sourceDir == "/data/app/$packageName-injected/base.apk"
 *
 * Anything else is refused with `UPDATE_NOT_ELIGIBLE:<pkg>:uid=<n>`
 * (StagingProvider.kt:556-585), and the install batch is all-or-nothing — so a
 * single package at the wrong path fails the whole install, after the APKs have
 * been pushed to the device.
 *
 * observed, 2026-08-10: hook and injector were at their `-injected` paths but
 * com.penumbraos.server had been updated by something else and sat at an
 * Android-randomized path
 * (/data/app/~~VjYu5ht…/com.penumbraos.server-7WySQf…/base.apk). The decision
 * reported all four packages `healthy=yes` and planned a keep-data update of
 * all three runtime packages. The provider refused, and 200+ MiB had already
 * crossed the cable.
 *
 * The provider has one narrow escape hatch for a randomized path
 * (FailedUpdateContinuityPolicy, same file, lines 41-101): an interrupted but
 * already-approved update may be retried when the artifact still on disk is
 * byte-identical to the one being staged. Three of its five conditions —
 * `tracked`, `priorApprovalMatches`, and the installed-APK digest — live in the
 * provider's own device-protected state and are not observable over ADB, so
 * this module cannot decide that hatch. It deliberately does not try to: it
 * only refuses to CLOSE it, by treating a randomized path of the exact shape
 * the hatch admits, on a package already reporting the target version (the only
 * way its installed bytes can equal the staged bytes), as "the provider may
 * still admit this" rather than as a refusal. See `classifyKeepDataUpdate`.
 *
 * Nothing on the device layer captures the APK path: `InstalledPackageMetadata`
 * (src/lib/pin-device/adb/packageManager.ts:23-29) carries versionName, signer,
 * querySucceeded and the raw dump — so the path is read here, out of that raw
 * `dumpsys package <pkg>` text, the same fields the injector CLI reads out of
 * the same command (pin/injector/cli/src/adb.ts:270-310).
 *
 * If StagingSafety.kt changes, this file changes with it.
 */

/** StagingSafety.kt:27-28 — Android's per-user UID range and the system app ID. */
export const PER_USER_RANGE = 100_000;
export const SYSTEM_SHARED_APP_ID = 1000;

/**
 * StagingSafety.kt:45-46 — the provider's own package-name grammar, used to
 * build the randomized-path pattern. Mirrored so the pattern below is anchored
 * to the same shape the provider anchors it to.
 */
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** StagingSafety.kt:85 — one Android-randomized path segment. */
const RANDOMIZED_SEGMENT_TOKEN = "[A-Za-z0-9_-]{1,128}={0,2}";

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The one path the staging provider treats as its own for `packageName`. */
export function injectorOwnedBaseApkPath(packageName: string): string {
  return `/data/app/${packageName}-injected/base.apk`;
}

/**
 * StagingSafety.kt:30-31 — `uid % PER_USER_RANGE == SYSTEM_SHARED_USER_ID`.
 * `null` is what an unreadable dump yields here and is never eligible; the
 * integer check guards the parse, not the Kotlin.
 */
export function isSystemSharedAppId(appId: number | null): boolean {
  return (
    appId !== null &&
    Number.isSafeInteger(appId) &&
    appId % PER_USER_RANGE === SYSTEM_SHARED_APP_ID
  );
}

/**
 * StagingSafety.kt:30-33, `InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate`.
 */
export function isEligibleForKeepDataUpdate(options: {
  readonly packageName: string;
  readonly appId: number | null;
  readonly baseApkPath: string | null;
}): boolean {
  return (
    isSystemSharedAppId(options.appId) &&
    options.baseApkPath === injectorOwnedBaseApkPath(options.packageName)
  );
}

/**
 * StagingSafety.kt:82-91, `FailedUpdateContinuityPolicy.isSafeRandomizedSourceDir`.
 * Shape only — being this shape is necessary for the continuity hatch, never
 * sufficient for it.
 */
export function isSafeRandomizedBaseApkPath(
  packageName: string,
  baseApkPath: string | null,
): boolean {
  if (!PACKAGE_NAME_PATTERN.test(packageName) || baseApkPath === null) {
    return false;
  }

  const pattern = new RegExp(
    `^/data/app/~~${RANDOMIZED_SEGMENT_TOKEN}/${escapeForRegExp(packageName)}-${RANDOMIZED_SEGMENT_TOKEN}/base\\.apk$`,
  );
  return pattern.test(baseApkPath);
}

/**
 * What the staging provider will do with this package if it is put in an
 * install batch while still installed.
 *
 *   eligible       — the injector owns the artifact; a keep-data update works.
 *   may-continue   — a randomized path of the exact shape the failed-update
 *                    continuity hatch admits, on a package already reporting
 *                    the target version. Not decidable from here (see the
 *                    module header); reported so the decision does not forbid
 *                    the one state that hatch exists to admit.
 *   foreign-artifact — some other UID or path. The provider will answer
 *                    UPDATE_NOT_ELIGIBLE and fail the whole batch.
 *   unreadable     — the package dump did not say where the APK is or which
 *                    app ID owns it. Unknown is not eligible.
 */
export type KeepDataUpdateVerdict =
  | "eligible"
  | "may-continue"
  | "foreign-artifact"
  | "unreadable";

export function classifyKeepDataUpdate(options: {
  readonly packageName: string;
  readonly appId: number | null;
  readonly baseApkPath: string | null;
  readonly versionName: string | null;
  readonly targetVersion: string | null;
}): KeepDataUpdateVerdict {
  if (options.appId === null || options.baseApkPath === null) {
    return "unreadable";
  }
  if (isEligibleForKeepDataUpdate(options)) {
    return "eligible";
  }
  if (
    isSystemSharedAppId(options.appId) &&
    isSafeRandomizedBaseApkPath(options.packageName, options.baseApkPath) &&
    options.versionName !== null &&
    options.targetVersion !== null &&
    options.versionName === options.targetVersion
  ) {
    return "may-continue";
  }
  return "foreign-artifact";
}

/**
 * The sentence a human reads instead of `healthy=yes`. The package and the
 * verdict come first because this string is clamped for the install card's
 * notice; the paths are the detail behind it.
 */
export function describeKeepDataUpdateRefusal(options: {
  readonly packageName: string;
  readonly verdict: Extract<KeepDataUpdateVerdict, "foreign-artifact" | "unreadable">;
  readonly appId: number | null;
  readonly baseApkPath: string | null;
}): string {
  const expected = injectorOwnedBaseApkPath(options.packageName);

  if (options.verdict === "unreadable") {
    return (
      `${options.packageName} cannot be updated in place: the device did not report ` +
      `which APK it is running, so it cannot be shown to be the installer's own ` +
      `${expected}. The installer refuses a keep-data update for any package it does not own, ` +
      `and the install batch is all-or-nothing.`
    );
  }

  return (
    `${options.packageName} cannot be updated in place: it is installed at ` +
    `${options.baseApkPath ?? "an unreported path"} (app id ${options.appId ?? "unreported"}), ` +
    `not the installer's own ${expected}. The installer refuses a keep-data update for any ` +
    `package it does not own, and the install batch is all-or-nothing, so this one package ` +
    `would fail the whole install after every APK had been pushed to the device.`
  );
}

/**
 * Read the running APK path out of a `dumpsys package <pkg>` dump.
 *
 * `codePath` is the package's code directory; the provider compares
 * `ApplicationInfo.sourceDir`, which for these packages is `<codePath>/base.apk`
 * — the same construction `baseApkPathForCodePath` makes in
 * pin/injector/cli/src/bootstrap-protocol.ts:273-276.
 *
 * A dump that reports the field more than once with different values (a package
 * present both as a system package and as an update, a truncated dump, two
 * records) is ambiguous, and ambiguous is answered `null` — the same way
 * `parseSignerIdentityFromDumpsys` answers a multi-signer dump.
 */
export function parseInstalledCodePathFromDumpsys(
  rawOutput: string | null | undefined,
): string | null {
  if (!rawOutput) {
    return null;
  }

  const values = new Set<string>();
  for (const match of rawOutput
    .replace(/\r\n/g, "\n")
    .matchAll(/^[ \t]*codePath=(\S+)[ \t]*$/gm)) {
    values.add(match[1]!);
  }

  return values.size === 1 ? [...values][0]! : null;
}

export function parseInstalledBaseApkPathFromDumpsys(
  rawOutput: string | null | undefined,
): string | null {
  const codePath = parseInstalledCodePathFromDumpsys(rawOutput);
  return codePath === null ? null : `${codePath}/base.apk`;
}

/**
 * Read the package's app ID (`userId=` in the dump — Android prints the app ID
 * under that label, which is what the injector CLI reads at
 * pin/injector/cli/src/adb.ts:295-305) and answer `null` on ambiguity.
 */
export function parseInstalledAppIdFromDumpsys(
  rawOutput: string | null | undefined,
): number | null {
  if (!rawOutput) {
    return null;
  }

  const values = new Set<string>();
  for (const match of rawOutput
    .replace(/\r\n/g, "\n")
    .matchAll(/^[ \t]*userId=(\d+)[ \t]*$/gm)) {
    values.add(match[1]!);
  }
  if (values.size !== 1) {
    return null;
  }

  const appId = Number([...values][0]);
  return Number.isSafeInteger(appId) ? appId : null;
}
