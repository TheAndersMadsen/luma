import type {
  InstallInspectionResult,
  ManagedPackageVersionSnapshot,
} from "../domain/inspection";
import type { ManagedPackageRole } from "../domain/types";

export const MANAGED_PACKAGE_ROLE_ORDER: readonly ManagedPackageRole[] = [
  "installer",
  "hook",
  "server",
  "loader",
];

export function formatManagedPackageRole(role: ManagedPackageRole) {
  return {
    installer: "Device Installer",
    hook: "Compatibility Layer",
    server: "Device Services",
    loader: "Compatibility Loader",
  }[role];
}

export function getDisplayedPackageVersion(
  versionName: string | null,
  installed: boolean,
) {
  if (!installed) {
    return "Not installed";
  }

  return versionName ?? "Unreadable";
}

export type ManagedPackageStatusTone = "default" | "success" | "warning";

export function getManagedPackageStatusText(
  pkg: ManagedPackageVersionSnapshot,
) {
  if (!pkg.installed) {
    return "Not installed";
  }

  if (!pkg.healthy) {
    return "Not working";
  }

  /*
   * A package the device's own installer will not keep-data-update is not
   * "Up to date" and not merely "Update available", the update it is being
   * offered cannot run. It outranks every version verdict below for the same
   * reason "Not working" does: the version is true but it is not the fact that
   * decides what happens next. See ../domain/keepDataEligibility.
   */
  if (pkg.keepDataUpdateVerdict === "foreign-artifact") {
    return "Update blocked";
  }

  if (pkg.keepDataUpdateVerdict === "unreadable") {
    return "Install location unreadable";
  }

  if (pkg.keepDataUpdateVerdict === "may-continue") {
    return "Data carry-over unverified";
  }

  if (pkg.versionComparison === "older") {
    return "Update available";
  }

  if (pkg.versionComparison === "newer") {
    return "Newer";
  }

  if (pkg.versionComparison === "unreadable") {
    return "Version unreadable";
  }

  if (pkg.versionComparison === "equal") {
    return "Up to date";
  }

  return "";
}

export function getManagedPackageStatusTone(
  pkg: ManagedPackageVersionSnapshot,
): ManagedPackageStatusTone {
  if (hasProblematicManagedPackageState(pkg)) {
    return "warning";
  }

  if (pkg.installed && pkg.healthy && pkg.versionComparison === "equal") {
    return "success";
  }

  return "default";
}

export function hasProblematicManagedPackageState(
  pkg: ManagedPackageVersionSnapshot,
) {
  return (
    !pkg.installed ||
    !pkg.healthy ||
    pkg.keepDataUpdateVerdict === "foreign-artifact" ||
    pkg.keepDataUpdateVerdict === "unreadable" ||
    pkg.keepDataUpdateVerdict === "may-continue" ||
    pkg.versionComparison === "older" ||
    pkg.versionComparison === "newer" ||
    pkg.versionComparison === "unreadable"
  );
}

export function getManagedPackageSnapshots(
  inspection: InstallInspectionResult | null,
): ManagedPackageVersionSnapshot[] {
  if (!inspection) {
    return [];
  }

  return MANAGED_PACKAGE_ROLE_ORDER.map((role) => inspection.packages[role]);
}

export function getUnreadableManagedPackages(
  inspection: InstallInspectionResult | null,
): ManagedPackageVersionSnapshot[] {
  return getManagedPackageSnapshots(inspection).filter(
    (pkg) =>
      pkg.installed &&
      (pkg.versionComparison === "unreadable" || !pkg.versionReadable),
  );
}
