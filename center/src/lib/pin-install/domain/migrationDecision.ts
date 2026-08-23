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

export const PIN_RELEASE_SIGNER_IDENTITY = "dd07f452";

export interface RetainedInstallerIdentity {
  readonly packageName: typeof MANAGED_PACKAGES.installer;
  readonly versionName: string;
  readonly signerIdentity: string;
}

interface InPlaceMigrationDecision {
  readonly kind: "routine-in-place";
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
      pkg.signerIdentity === PIN_RELEASE_SIGNER_IDENTITY)
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
      compareInstallVersions(pkg.versionName, target.version) !== null &&
      compareInstallVersions(pkg.versionName, target.version)! <= 0)
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
 * inspected device. Any state outside a verified release profile fails
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
  const installerVersionOrdering = compareInstallVersions(
    installer.versionName,
    target.version,
  );
  const installerVersionKnown =
    installerVersionOrdering !== null && installerVersionOrdering <= 0;

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

  if (installerVersionOrdering === null || installerVersionOrdering > 0) {
    return blocked(
      "The healthy installer is not a supported release version at or below the selected target.",
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
