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
  const installedPackages = packages.filter((pkg) => pkg.installed);
  const anyInstalled = installedPackages.length > 0;
  const allInstalled = installedPackages.length === packages.length;
  const missingPackages = packages.filter(isPackageMissing);
  const brokenPackages = packages.filter(isPackageBroken);
  const unreadablePackages = packages.filter(hasUnreadableVersion);
  const olderPackages = packages.filter(isOlderThanTarget);
  const newerPackages = packages.filter(isNewerThanTarget);
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
      reasons.push("One or more managed packages are older than the selected target.");
    }

    if (unreadablePackages.length > 0) {
      reasons.push("One or more managed package versions are unreadable.");
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
    reasons.push("One or more managed packages are newer than the selected target.");
  } else {
    reasons.push("All managed packages match the selected target.");
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
