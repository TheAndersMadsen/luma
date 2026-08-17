import type {
  InstallInspectionResult,
  ManagedPackageVersionSnapshot,
} from "../domain/inspection";
import type { ManagedPackageRole } from "../domain/types";

export const MANAGED_PACKAGE_ROLE_ORDER: readonly ManagedPackageRole[] = [
  "installer",
  "hook",
  "server",
  "injector",
];

export function formatManagedPackageRole(role: ManagedPackageRole) {
  return role.charAt(0).toUpperCase() + role.slice(1);
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
    return "Not Installed";
  }

  if (!pkg.healthy) {
    return "Unhealthy";
  }

  /*
   * A package the device's own installer will not keep-data-update is not
   * "Up to Date" and not merely "Update Available" — the update it is being
   * offered cannot run. It outranks every version verdict below for the same
   * reason "Unhealthy" does: the version is true but it is not the fact that
   * decides what happens next. See ../domain/keepDataEligibility.
   */
  if (pkg.keepDataUpdateVerdict === "foreign-artifact") {
    return "Update Blocked";
  }

  if (pkg.keepDataUpdateVerdict === "unreadable") {
    return "APK Path Unreadable";
  }

  if (pkg.versionComparison === "older") {
    return "Update Available";
  }

  if (pkg.versionComparison === "newer") {
    return "Newer";
  }

  if (pkg.versionComparison === "unreadable") {
    return "Unreadable";
  }

  if (pkg.versionComparison === "equal") {
    return "Up to Date";
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
