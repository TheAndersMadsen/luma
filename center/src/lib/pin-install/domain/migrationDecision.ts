import {
  classifyKeepDataUpdate,
  describeKeepDataUpdateRefusal,
} from "./keepDataEligibility";
import { MANAGED_PACKAGES } from "./managedPackages";
import type { InstallInspectionResult } from "./inspection";
import type { ManagedPackageRole } from "./types";
import { compareInstallVersions } from "./versions";
import type { ResolvedInstallTarget } from "../releases/assets";

export const IN_PLACE_PACKAGE_ROLES = ["hook", "server", "loader"] as const;
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
    loader: MANAGED_PACKAGES.loader,
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
    target.artifacts.bootstrapApk.package === MANAGED_PACKAGES.bootstrapHelper &&
    target.artifacts.hookApk.package === MANAGED_PACKAGES.hook &&
    target.artifacts.serverApk.package === MANAGED_PACKAGES.server &&
    target.artifacts.loaderApk.package === MANAGED_PACKAGES.loader
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
 * A keep-data in-place update is not something this code performs, it asks the
 * installer already on the device to perform it, and that installer refuses any
 * package it does not own (see ./keepDataEligibility, mirroring
 * StagingSafety.kt:26-34). It checks every package of the batch that is still
 * installed and answers UPDATE_NOT_ELIGIBLE for the first one it does not own
 * (StagingProvider.kt:548-585). One refusal fails the batch. So the roles this
 * decision is about to put in that batch have to be checked here, BEFORE the
 * plan promises an update, rather than after 200+ MiB of APKs have crossed the
 * cable.
 *
 * Only roles that are both installed and in the batch are checked, which is the
 * provider's own condition: it looks at `installedPackageState(packageName)` for
 * the packages it was handed, so a package that is absent, or present but not
 * being installed, is never examined. This is also why the bootstrap-recovery
 * path is exempt, it uninstalls the managed packages first, and a package that
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
 * True when every managed package on the device carries a Luma package ID but
 * was signed by another key, the CURRENT-generation PenumbraOS shape. Nothing
 * Luma-signed is installed, so a recovery wipe removes only foreign state;
 * any mixed or unexpected-name profile is deliberately false and fails closed
 * in the per-role identity loop.
 */
export function inspectionHasForeignSigners(
  inspection: InstallInspectionResult | null,
): boolean {
  if (!inspection) {
    return false;
  }
  const installedRoles = (
    Object.keys(EXPECTED_PACKAGE_BY_ROLE) as ManagedPackageRole[]
  ).filter((role) => inspection.packages[role].installed);
  return (
    installedRoles.length > 0 &&
    installedRoles.every((role) => {
      const pkg = inspection.packages[role];
      return (
        pkg.packageName === EXPECTED_PACKAGE_BY_ROLE[role] &&
        pkg.signerIdentity !== PIN_RELEASE_SIGNER_IDENTITY
      );
    })
  );
}

/**
 * The bootstrap path on a Pin that holds nothing of Luma's: no managed package.
 * A Setup Helper left behind by an interrupted bootstrap is not Luma state on
 * the device and does not disqualify it, the recovery's own
 * `cleanupManagedPackages` removes that package first. Display only
 * (INFERRED: Luma's own install copy); the decision above and its confirmation
 * are unchanged.
 */
export function inspectionIsFirstInstall(
  inspection: InstallInspectionResult | null,
): boolean {
  return (
    inspection !== null &&
    inspectionRequiresBootstrapRecovery(inspection) &&
    Object.values(inspection.packages).every((pkg) => !pkg.installed)
  );
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
  // A leftover Setup Helper alone never blocks: a bootstrap that died partway
  // leaves it installed, and every plan below removes it (the recovery's
  // cleanupManagedPackages, or the in-place plan's leftover-helper cleanup).
  if (inspection.hasDetectedConflicts || inspection.detectedConflicts.length > 0) {
    return blocked("Known conflicting packages must be removed first.");
  }

  const installer = inspection.packages.installer;
  const installerVersionOrdering = compareInstallVersions(
    installer.versionName,
    target.version,
  );
  const installerVersionKnown =
    installerVersionOrdering !== null && installerVersionOrdering <= 0;

  /*
   * A Pin running another project's builds under Luma's exact package IDs
   * (CURRENT-generation PenumbraOS) has no Luma-signed package to retain, so
   * the same recovery-baseline gates as a broken installer apply: wipe the
   * managed packages and bootstrap Luma's. Anything that is not exactly that
   * shape (a Luma-signed role beside a foreign one, an unexpected package
   * name, an unreadable version) falls through to the per-role identity loop
   * and fails closed.
   */
  if (inspectionHasForeignSigners(inspection)) {
    if (installer.installed && !installerVersionKnown) {
      return blocked(
        installer.healthy
          ? "The healthy installer is not a supported release version at or below the selected target."
          : "The unhealthy installer does not match a supported recovery baseline.",
      );
    }
    if (
      !IN_PLACE_PACKAGE_ROLES.every((role) =>
        roleIsKnownForRecovery(inspection, target, role),
      )
    ) {
      return blocked(
        "The installed Luma apps do not match a supported Device Installer recovery state.",
      );
    }
    return {
      kind: "bootstrap-recovery",
      reason: "The Pin runs another project's versions of Luma's apps.",
      rolesToInstall: IN_PLACE_PACKAGE_ROLES,
      retainedInstaller: null,
    };
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
        "The installed Luma apps do not match a supported Device Installer recovery state.",
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
