import {
  classifyKeepDataUpdate,
  describeKeepDataUpdateRefusal,
} from "./keepDataEligibility";
import { MANAGED_PACKAGES } from "./managedPackages";
import type { InstallInspectionResult } from "./inspection";
import type { ManagedPackageRole } from "./types";
import { compareInstallVersions } from "./versions";
import type { ResolvedInstallTarget } from "../releases/assets";

export const IN_PLACE_PACKAGE_ROLES = ["hook", "server", "injector"] as const;
export type InPlacePackageRole = (typeof IN_PLACE_PACKAGE_ROLES)[number];

/**
 * observed: the exact healthy legacy package set on the operator-owned Ai Pin
 * for which the first canonical migration is implemented.
 *
 * These are versionNAMEs, because that is the field every comparison below
 * reads (`pkg.versionName === LEGACY_MIGRATION_PROFILE.versions[role]`). They
 * previously held that device's versionCODEs — 20260807 and 2026080802 — which
 * are real values from the same packages but a different field, so no installed
 * package could ever match and `decideInstallMigration` refused every install on
 * the one device this profile exists to describe. Re-read from the device on
 * 2026-08-11 (serial 1H4MPA42230112) with `dumpsys package <pkg>`:
 *
 *   com.penumbraos.systeminjector   versionName=carry-2026.08.07    versionCode=20260807
 *   com.penumbraos.hook             versionName=carry-2026.08.07    versionCode=20260807
 *   com.penumbraos.server           versionName=carry-2026.08.08.2  versionCode=2026080802
 *   com.penumbraos.hook.injector    versionName=carry-2026.08.07    versionCode=20260807
 *
 * Note these names do NOT parse as release versions (`parseInstallVersion`
 * wants YYYY-MM-DD.N): the legacy builds predate that scheme, which is exactly
 * why the migration matches them literally instead of comparing ordinally.
 */
export const LEGACY_MIGRATION_PROFILE = Object.freeze({
  signerIdentity: "dd07f452",
  versions: Object.freeze({
    installer: "carry-2026.08.07",
    hook: "carry-2026.08.07",
    server: "carry-2026.08.08.2",
    injector: "carry-2026.08.07",
  } satisfies Readonly<Record<ManagedPackageRole, string>>),
});

/**
 * Is this installed version one the legacy migration is allowed to update from?
 *
 * Three answers, and the third is why this function exists:
 *  - the exact legacy versionName, which does not parse as a release version
 *    because those builds predate the scheme;
 *  - the target itself, i.e. the role is already done;
 *  - ANY published release version at or below the target.
 *
 * That third case is a device left mid-migration — some roles updated, the
 * batch interrupted before the rest. It is not exotic: an install that pushes
 * 200 MiB per role and restarts system_server has a real window in which to be
 * interrupted, and that is exactly how this Pin reached hook and injector at
 * 2026-08-11.1 with a legacy installer and no server. Admitting only "legacy or
 * target" left such a device permanently blocked by the very rule meant to
 * protect it, with no path forward but a hand-driven recovery.
 *
 * It stays strict about what it is protecting against — a package of UNKNOWN
 * provenance. A version that parses as a release version and is not newer than
 * the target is one this installer published and installed. A version that does
 * not parse, or that is newer than what we are installing, still refuses: the
 * first is not ours, and the second would be a silent downgrade.
 */
function isKnownLegacyMigrationVersion(
  role: InPlacePackageRole,
  installedVersion: string | null,
  targetVersion: string,
): boolean {
  if (installedVersion === LEGACY_MIGRATION_PROFILE.versions[role]) return true;
  if (installedVersion === targetVersion) return true;
  if (!installedVersion) return false;
  const ordering = compareInstallVersions(installedVersion, targetVersion);
  return ordering !== null && ordering < 0;
}

export interface RetainedInstallerIdentity {
  readonly packageName: typeof MANAGED_PACKAGES.installer;
  readonly versionName: string;
  readonly signerIdentity: string;
}

interface InPlaceMigrationDecision {
  readonly kind: "legacy-in-place" | "routine-in-place";
  readonly reason: string;
  readonly rolesToInstall: readonly InPlacePackageRole[];
  readonly retainedInstaller: RetainedInstallerIdentity;
}

interface BootstrapRecoveryDecision {
  readonly kind: "bootstrap-recovery";
  readonly reason: string;
  readonly rolesToInstall: readonly InPlacePackageRole[];
  readonly retainedInstaller: null;
}

interface BlockedMigrationDecision {
  readonly kind: "blocked";
  readonly reason: string;
  readonly rolesToInstall: readonly [];
  readonly retainedInstaller: null;
}

export type InstallMigrationDecision =
  | InPlaceMigrationDecision
  | BootstrapRecoveryDecision
  | BlockedMigrationDecision;

const EXPECTED_PACKAGE_BY_ROLE: Readonly<Record<ManagedPackageRole, string>> =
  Object.freeze({
    installer: MANAGED_PACKAGES.installer,
    hook: MANAGED_PACKAGES.hook,
    server: MANAGED_PACKAGES.server,
    injector: MANAGED_PACKAGES.injector,
  });

function blocked(reason: string): BlockedMigrationDecision {
  return {
    kind: "blocked",
    reason,
    rolesToInstall: [],
    retainedInstaller: null,
  };
}

function targetIsExactAndVerified(
  target: ResolvedInstallTarget,
  inspection: InstallInspectionResult,
): boolean {
  const inspectedTarget = inspection.target;
  if (
    target.manifestVerified !== true ||
    inspectedTarget?.manifestVerified !== true ||
    inspectedTarget.releaseId !== target.releaseId ||
    inspectedTarget.version !== target.version ||
    inspectedTarget.manifestUrl !== target.manifestUrl
  ) {
    return false;
  }

  return (
    target.artifacts.installerApk.package === MANAGED_PACKAGES.installer &&
    target.artifacts.exploitApk.package === MANAGED_PACKAGES.exploitHelper &&
    target.artifacts.hookApk.package === MANAGED_PACKAGES.hook &&
    target.artifacts.serverApk.package === MANAGED_PACKAGES.server &&
    target.artifacts.injectorApk.package === MANAGED_PACKAGES.injector
  );
}

function installedRoleHasExpectedIdentity(
  inspection: InstallInspectionResult,
  role: ManagedPackageRole,
): boolean {
  const pkg = inspection.packages[role];
  return (
    !pkg.installed ||
    (pkg.packageName === EXPECTED_PACKAGE_BY_ROLE[role] &&
      pkg.signerIdentity === LEGACY_MIGRATION_PROFILE.signerIdentity)
  );
}

function roleIsKnownForRecovery(
  inspection: InstallInspectionResult,
  target: ResolvedInstallTarget,
  role: InPlacePackageRole,
): boolean {
  const pkg = inspection.packages[role];
  return (
    !pkg.installed ||
    (pkg.healthy &&
      (pkg.versionName === LEGACY_MIGRATION_PROFILE.versions[role] ||
        pkg.versionName === target.version))
  );
}

/**
 * The reason an in-place plan over `roles` could not run, or null.
 *
 * A keep-data in-place update is not something this code performs — it asks the
 * installer already on the device to perform it, and that installer refuses any
 * package it does not own (see ./keepDataEligibility, mirroring
 * StagingSafety.kt:26-34). It checks every package of the batch that is still
 * installed and answers UPDATE_NOT_ELIGIBLE for the first one it does not own
 * (StagingProvider.kt:548-585); one refusal fails the batch. So the roles this
 * decision is about to put in that batch have to be checked here, BEFORE the
 * plan promises an update, rather than after 200+ MiB of APKs have crossed the
 * cable.
 *
 * Only roles that are both installed and in the batch are checked, which is the
 * provider's own condition: it looks at `installedPackageState(packageName)` for
 * the packages it was handed, so a package that is absent, or present but not
 * being installed, is never examined. This is also why the bootstrap-recovery
 * path is exempt — it uninstalls the managed packages first, and a package that
 * is gone is installed fresh rather than updated in place. That exemption must
 * never be selected as a fallback for a refusal while the installer is healthy.
 */
function findKeepDataUpdateRefusal(
  inspection: InstallInspectionResult,
  target: ResolvedInstallTarget,
  roles: readonly InPlacePackageRole[],
): string | null {
  for (const role of roles) {
    const pkg = inspection.packages[role];
    if (!pkg.installed) {
      continue;
    }

    const verdict = classifyKeepDataUpdate({
      packageName: pkg.packageName,
      appId: pkg.appId,
      baseApkPath: pkg.baseApkPath,
      versionName: pkg.versionName,
      targetVersion: target.version,
    });
    // A randomized /data/app/~~... path is not installer-owned. Even if the
    // provider labels its shape "may-continue", the host cannot prove the
    // provider-only continuity evidence, so it stops before transferring APKs.
    // Do not turn this refusal into bootstrap recovery: that would uninstall
    // managed packages and risk FBE-scoped identity and app data.
    if (verdict === "eligible") {
      continue;
    }

    return describeKeepDataUpdateRefusal({
      packageName: pkg.packageName,
      verdict,
      appId: pkg.appId,
      baseApkPath: pkg.baseApkPath,
    });
  }

  return null;
}

export function inspectionRequiresBootstrapRecovery(
  inspection: InstallInspectionResult | null,
): boolean {
  const installer = inspection?.packages.installer;
  return installer !== undefined && (!installer.installed || !installer.healthy);
}

/**
 * implemented: derive the only mutation path the installer may use for the
 * inspected device. Any state outside a proved legacy/canonical profile fails
 * closed.
 */
export function decideInstallMigration(options: {
  readonly target: ResolvedInstallTarget;
  readonly inspection: InstallInspectionResult | null | undefined;
}): InstallMigrationDecision {
  const { target, inspection } = options;
  if (!inspection) {
    return blocked("A current device inspection is required before installation.");
  }
  if (!targetIsExactAndVerified(target, inspection)) {
    return blocked("The inspected release target is stale or was not verified.");
  }
  if (inspection.targetResolutionFailed || inspection.installActionsBlocked) {
    return blocked(
      inspection.installActionsBlockedReason ??
        "Release target resolution did not complete.",
    );
  }
  if (!inspection.device.recognizedAiPin) {
    return blocked("The connected device is not a recognized Humane Ai Pin.");
  }
  if (inspection.readiness.credentialState.state !== "unlocked") {
    return blocked("The Ai Pin must be unlocked before package migration.");
  }
  if (inspection.helperPresentUnexpectedly) {
    return blocked("The bootstrap helper is present unexpectedly.");
  }
  if (inspection.hasDetectedConflicts || inspection.detectedConflicts.length > 0) {
    return blocked("Known conflicting packages must be removed first.");
  }

  for (const role of Object.keys(EXPECTED_PACKAGE_BY_ROLE) as ManagedPackageRole[]) {
    const pkg = inspection.packages[role];
    if (pkg.packageName !== EXPECTED_PACKAGE_BY_ROLE[role]) {
      return blocked(`Managed package identity for ${role} is unexpected.`);
    }
    if (!installedRoleHasExpectedIdentity(inspection, role)) {
      return blocked(`Signer identity for ${pkg.packageName} is missing or unexpected.`);
    }
  }

  const installer = inspection.packages.installer;
  const installerVersionKnown =
    installer.versionName === LEGACY_MIGRATION_PROFILE.versions.installer ||
    installer.versionName === target.version;

  if (!installer.installed || !installer.healthy) {
    if (installer.installed && !installerVersionKnown) {
      return blocked(
        "The unhealthy installer does not match a supported recovery baseline.",
      );
    }
    if (
      !IN_PLACE_PACKAGE_ROLES.every((role) =>
        roleIsKnownForRecovery(inspection, target, role),
      )
    ) {
      return blocked(
        "Managed packages do not match a supported bootstrap recovery baseline.",
      );
    }
    return {
      kind: "bootstrap-recovery",
      reason: installer.installed
        ? "The installer is present but unhealthy."
        : "The installer is missing.",
      rolesToInstall: IN_PLACE_PACKAGE_ROLES,
      retainedInstaller: null,
    };
  }

  if (!installer.versionName || !installer.signerIdentity) {
    return blocked("The healthy installer identity is incomplete.");
  }
  const retainedInstaller: RetainedInstallerIdentity = {
    packageName: MANAGED_PACKAGES.installer,
    versionName: installer.versionName,
    signerIdentity: installer.signerIdentity,
  };

  if (installer.versionName === LEGACY_MIGRATION_PROFILE.versions.installer) {
    for (const role of IN_PLACE_PACKAGE_ROLES) {
      const pkg = inspection.packages[role];
      if (pkg.installed && !pkg.healthy) {
        return blocked(
          `Legacy ${role} state does not match its exact migration baseline.`,
        );
      }
      if (pkg.installed && !isKnownLegacyMigrationVersion(role, pkg.versionName, target.version)) {
        return blocked(
          `Legacy ${role} state does not match its exact migration baseline.`,
        );
      }
    }

    const rolesToInstall = IN_PLACE_PACKAGE_ROLES.filter(
      (role) => inspection.packages[role].versionName !== target.version,
    );
    const refusal = findKeepDataUpdateRefusal(inspection, target, rolesToInstall);
    if (refusal) {
      return blocked(refusal);
    }

    return {
      kind: "legacy-in-place",
      reason: "The exact supported legacy package profile is installed.",
      rolesToInstall,
      retainedInstaller,
    };
  }

  const installerVersionOrdering = compareInstallVersions(
    installer.versionName,
    target.version,
  );
  if (installerVersionOrdering === null || installerVersionOrdering > 0) {
    return blocked(
      "The healthy installer is neither a supported canonical version at or below the selected target nor the supported legacy baseline.",
    );
  }

  for (const role of IN_PLACE_PACKAGE_ROLES) {
    const pkg = inspection.packages[role];
    if (!pkg.installed) {
      continue;
    }
    const comparison = compareInstallVersions(pkg.versionName, target.version);
    if (!pkg.healthy || comparison === null || comparison > 0) {
      return blocked(
        `Canonical ${role} state is unhealthy, unreadable, or newer than the selected target.`,
      );
    }
  }

  const forceRuntimeRefresh = inspection.actionState.action === "Reinstall";
  const rolesToInstall = forceRuntimeRefresh
    ? IN_PLACE_PACKAGE_ROLES
    : IN_PLACE_PACKAGE_ROLES.filter(
        (role) => inspection.packages[role].versionName !== target.version,
      );
  const refusal = findKeepDataUpdateRefusal(inspection, target, rolesToInstall);
  if (refusal) {
    return blocked(refusal);
  }

  return {
    kind: "routine-in-place",
    reason: "The canonical installer is healthy and is not newer than the selected target.",
    rolesToInstall,
    retainedInstaller,
  };
}
