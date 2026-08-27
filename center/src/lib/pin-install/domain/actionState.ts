import type {
  InstallActionState,
  InstallActionStateInput,
  ManagedPackageInspection,
} from "./types";

function isPackageMissing(pkg: ManagedPackageInspection) {
  return !pkg.installed;
}

function isPackageBroken(pkg: ManagedPackageInspection) {
  return pkg.installed && !pkg.healthy;
}

function hasUnreadableVersion(pkg: ManagedPackageInspection) {
  return pkg.installed && pkg.versionComparison === "unreadable";
}

function isOlderThanTarget(pkg: ManagedPackageInspection) {
  return pkg.installed && pkg.versionComparison === "older";
}

function isNewerThanTarget(pkg: ManagedPackageInspection) {
  return pkg.installed && pkg.versionComparison === "newer";
}

export function deriveInstallActionState(input: InstallActionStateInput): InstallActionState {
  const packages = Object.values(input.packages);
  // A healthy canonical installer is privileged infrastructure, not a normal
  // release payload. Routine installs deliberately retain it at its installed
  // version; only Hook, Server, and Injector move with the selected release.
  // Structural installer failures still select Repair below, but its version
  // must not invent an Update that has no runtime package to update.
  const runtimePackages = packages.filter((pkg) => pkg.role !== "installer");
  const installedPackages = packages.filter((pkg) => pkg.installed);
  const anyInstalled = installedPackages.length > 0;
  const allInstalled = installedPackages.length === packages.length;
  const missingPackages = packages.filter(isPackageMissing);
  const brokenPackages = packages.filter(isPackageBroken);
  const unreadablePackages = runtimePackages.filter(hasUnreadableVersion);
  const olderPackages = runtimePackages.filter(isOlderThanTarget);
  const newerPackages = runtimePackages.filter(isNewerThanTarget);
  const reasons: string[] = [];

  if (!anyInstalled) {
    reasons.push("No managed packages are installed.");
    return {
      action: "Install",
      warnings: {
        newerThanTarget: false,
        unreadableVersion: false,
      },
      reasons,
    };
  }

  if (missingPackages.length > 0) {
    reasons.push("One or more managed packages are missing.");
  }

  if (brokenPackages.length > 0) {
    reasons.push("One or more managed packages are unhealthy.");
  }

  if (input.helperPresentUnexpectedly) {
    reasons.push("The bootstrap helper is present unexpectedly.");
  }

  if (!input.readinessOk) {
    reasons.push("System-level readiness checks failed.");
  }

  if (!allInstalled || brokenPackages.length > 0 || input.helperPresentUnexpectedly || !input.readinessOk) {
    return {
      action: "Repair",
      warnings: {
        newerThanTarget: false,
        unreadableVersion: unreadablePackages.length > 0,
      },
      reasons,
    };
  }

  if (olderPackages.length > 0 || unreadablePackages.length > 0) {
    if (olderPackages.length > 0) {
      reasons.push("One or more runtime packages are older than the selected target.");
    }

    if (unreadablePackages.length > 0) {
      reasons.push("One or more runtime package versions are unreadable.");
    }

    return {
      action: "Update",
      warnings: {
        newerThanTarget: newerPackages.length > 0,
        unreadableVersion: unreadablePackages.length > 0,
      },
      reasons,
    };
  }

  if (newerPackages.length > 0) {
    reasons.push("One or more runtime packages are newer than the selected target.");
  } else {
    reasons.push("All runtime packages match the selected target; the healthy installer is retained separately.");
  }

  return {
    action: "Reinstall",
    warnings: {
      newerThanTarget: newerPackages.length > 0,
      unreadableVersion: false,
    },
    reasons,
  };
}
