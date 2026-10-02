import type {
  DetectedPackageConflict,
  KnownPackageConflictCleanupCommand,
  KnownPackageConflictDefinition,
} from "./types";
import {
  listInstalledPackages,
  matchesPackagePattern,
  type AdbSessionTransport,
} from "../device";
import { PACKAGES } from "../generated/tier-a-symbols";

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

export const KNOWN_PACKAGE_CONFLICTS: readonly KnownPackageConflictDefinition[] =
  [
    {
      id: "penumbra-v0",
      label: "PenumbraOS v0",
      packageIds: [
        "com.penumbraos.mabl",
        "com.penumbraos.plugins.*",
        "com.penumbraos.sdk.*",
        "com.penumbraos.bridge*",
        "com.penumbraos.pinitd",
      ],
      cleanupCommands: SHARED_CLEANUP_COMMANDS,
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
  const installedPackages = await listInstalledPackages(transport);

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
      } satisfies DetectedPackageConflict;
    });

  return conflictResults.filter(
    (conflict): conflict is DetectedPackageConflict => conflict !== null,
  );
}
