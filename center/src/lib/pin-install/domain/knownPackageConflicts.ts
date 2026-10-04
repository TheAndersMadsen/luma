import type {
  DetectedPackageConflict,
  KnownPackageConflictCleanupCommand,
  KnownPackageConflictDefinition,
} from "./types";
import { MANAGED_PACKAGES } from "./managedPackages";
import {
  listInstalledPackages,
  matchesPackagePattern,
  type AdbSessionTransport,
} from "../device";
import { PACKAGES, PACKAGE_SETS } from "../generated/tier-a-symbols";

export const PREINSTALL_CLEANUP_COMMANDS: readonly KnownPackageConflictCleanupCommand[] =
  [
    {
      argv: ["pm", "enable", "--user", "0", PACKAGES.ironman],
      description: "Re-enable Humane Ironman",
    },
    {
      argv: ["pm", "enable", "--user", "0", PACKAGES.onboarding],
      description: "Re-enable Humane Onboarding",
    },
    {
      argv: ["pm", "enable", "--user", "0", PACKAGES.system_navigation],
      description: "Re-enable Humane System Navigation",
    },
    {
      argv: [`setprop persist.log.tag ""`],
      description: "Remove PenumbraOS v0 expanded logging",
    },
  ];

const SHARED_CLEANUP_COMMANDS: readonly KnownPackageConflictCleanupCommand[] = [
  {
    argv: ["reboot"],
    description: "Reboot device",
  },
];

/*
 * pinitd's Zygote exploit sets the Settings.Global
 * hidden_api_blacklist_exemptions key, and a crash can leave it set, which
 * upstream documents as a boot-loop hazard (PenumbraOS/penumbra installer
 * `penumbra.yml` uninstalls `com.penumbraos.mabl.*` for the same suite).
 * Deleting an absent key is harmless, so the delete runs before the reboot.
 */
const PENUMBRA_V0_CLEANUP_COMMANDS: readonly KnownPackageConflictCleanupCommand[] =
  [
    {
      argv: ["settings", "delete", "global", "hidden_api_blacklist_exemptions"],
      description:
        "Remove pinitd's exploit residue that can boot-loop the Pin",
    },
    {
      argv: ["reboot"],
      description: "Reboot device",
    },
  ];

export const KNOWN_PACKAGE_CONFLICTS: readonly KnownPackageConflictDefinition[] =
  [
    {
      id: "penumbra-v0",
      label: "PenumbraOS v0",
      packageIds: [
        "com.penumbraos.mabl*",
        "com.penumbraos.cli",
        "com.penumbraos.adbd",
        "com.penumbraos.plugins.*",
        "com.penumbraos.sdk.*",
        "com.penumbraos.bridge*",
        "com.penumbraos.pinitd",
      ],
      cleanupCommands: PENUMBRA_V0_CLEANUP_COMMANDS,
      cleanupFilePaths: ["/sdcard/penumbra", "/data/local/tmp/bin"],
    },
    {
      id: "fusionos",
      label: "FusionOS",
      packageIds: ["com.ghost.fuionwebhost", "com.ghost.fusion*"],
      cleanupCommands: SHARED_CLEANUP_COMMANDS,
    },
    {
      id: "openpin",
      label: "OpenPin",
      packageIds: ["org.openpin.primaryapp"],
      cleanupCommands: SHARED_CLEANUP_COMMANDS,
      cleanupFilePaths: [
        "/data/local/tmp/openpin-daemon",
        "/data/local/tmp/pty_exec",
      ],
    },
  ];

function createDefaultWarningCopy(conflict: KnownPackageConflictDefinition) {
  return `${conflict.label} may interfere with install. Removing the detected packages before continuing is recommended.`;
}

export function getDetectedConflictPackageIds(
  conflicts: readonly DetectedPackageConflict[],
): string[] {
  return [
    ...new Set(conflicts.flatMap((conflict) => conflict.installedPackageIds)),
  ];
}

export function formatDetectedPackageConflict(
  conflict: DetectedPackageConflict,
) {
  return `${conflict.label} (${conflict.installedPackageIds.join(", ")})`;
}

export function formatDetectedPackageConflicts(
  conflicts: readonly DetectedPackageConflict[],
): string {
  return conflicts
    .map((conflict) => {
      return `${conflict.label}:\n    ${conflict.installedPackageIds.join("\n    ")}`;
    })
    .join("\n\n");
}

export async function detectKnownPackageConflicts(
  transport: AdbSessionTransport,
  definitions: readonly KnownPackageConflictDefinition[] = KNOWN_PACKAGE_CONFLICTS,
): Promise<DetectedPackageConflict[]> {
  return matchKnownPackageConflicts(
    await listInstalledPackages(transport),
    definitions,
  );
}

export function matchKnownPackageConflicts(
  installedPackages: readonly string[],
  definitions: readonly KnownPackageConflictDefinition[] = KNOWN_PACKAGE_CONFLICTS,
): DetectedPackageConflict[] {
  const conflictResults: Array<DetectedPackageConflict | null> =
    definitions.map((definition) => {
      const installedPackageIds = [
        ...new Set(
          definition.packageIds.flatMap((pattern) =>
            installedPackages.filter((packageName) =>
              matchesPackagePattern(packageName, pattern),
            ),
          ),
        ),
      ];

      if (installedPackageIds.length === 0) {
        return null;
      }

      return {
        id: definition.id,
        label: definition.label,
        packageIds: definition.packageIds,
        installedPackageIds,
        warningCopy:
          definition.warningCopy ?? createDefaultWarningCopy(definition),
        cleanupCommands: definition.cleanupCommands ?? [],
        cleanupFilePaths: definition.cleanupFilePaths,
      } satisfies DetectedPackageConflict;
    });

  return conflictResults.filter(
    (conflict): conflict is DetectedPackageConflict => conflict !== null,
  );
}

/** Stock packages the tier-a registry names, plus Android's own namespaces. */
const KNOWN_STOCK_PACKAGES: ReadonlySet<string> = new Set([
  ...PACKAGE_SETS.center_vendor_packages,
  ...PACKAGE_SETS.hook_targets,
  ...PACKAGE_SETS.host_query_packages,
  ...Object.values(PACKAGES),
  "android",
]);

export function isKnownStockPackageName(packageName: string): boolean {
  return (
    KNOWN_STOCK_PACKAGES.has(packageName) ||
    packageName.startsWith("com.android.") ||
    packageName.startsWith("com.google.")
  );
}

/**
 * Advisory only: installed packages that are neither Luma's, a known conflict,
 * nor known stock. Nothing removes them automatically; Center only lists them.
 */
export function classifyUnrecognizedPackages(
  installedPackages: readonly string[],
  matchedConflictPackageIds: readonly string[],
): string[] {
  const known = new Set<string>([
    ...Object.values(MANAGED_PACKAGES),
    ...matchedConflictPackageIds,
  ]);
  return installedPackages
    .filter((packageName) => !known.has(packageName) && !isKnownStockPackageName(packageName))
    .sort();
}
