import type { InstallControllerState } from "../app/state";
import { getManagedPackageSnapshots } from "./managedPackages";

/**
 * The only thing the support bundle needs from the install controller. Declared
 * structurally here rather than imported from the controller hook, so this
 * module stays framework-free and SSR-import-safe; the real controller is
 * assignable to it unchanged.
 */
export interface SupportBundleLogSource {
  getLogcatContent(): Promise<string>;
}

export interface SupportBundleFile {
  readonly fileName: string;
  readonly label?: string;
  readonly mimeType: string;
  readonly download: () => Promise<string>;
}

interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

interface SerializedOperationResult {
  readonly kind: "install" | "uninstall" | "remove-conflicts";
  readonly result: {
    readonly success: boolean;
    readonly warnings: readonly unknown[];
    readonly error: SerializedError | null;
    readonly failedPhase?: string | null;
    readonly deviceChangesStarted?: boolean;
    readonly removedPackageIds?: readonly string[];
  };
}

export interface InstallSupportBundle {
  readonly schemaVersion: number;
  readonly capturedAt: string;
  readonly app: {
    readonly surface: "install";
  };
  readonly browserSupport: InstallControllerState["browserSupport"];
  readonly browserContext: {
    readonly href: string | null;
    readonly userAgent: string | null;
    readonly language: string | null;
  };
  readonly connection: InstallControllerState["connection"];
  readonly stateSummary: {
    readonly stage: InstallControllerState["stage"];
    readonly error: InstallControllerState["error"];
    readonly isBusy: InstallControllerState["isBusy"];
  };
  readonly inspection: InstallControllerState["inspection"];
  readonly target: InstallControllerState["target"];
  readonly targetLock: InstallControllerState["targetLock"];
  readonly lastOperationResult: SerializedOperationResult | null;
  readonly progressEntries: InstallControllerState["progressEntries"];
}

function serializeError(error: unknown): SerializedError | null {
  if (!(error instanceof Error)) {
    return error == null
      ? null
      : {
          name: "Error",
          message: String(error),
          stack: null,
        };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
  };
}

function serializeOperationResult(
  result: InstallControllerState["lastOperationResult"],
): SerializedOperationResult | null {
  if (!result) {
    return null;
  }

  if (result.kind === "install") {
    return {
      kind: result.kind,
      result: {
        success: result.result.success,
        warnings: result.result.warnings,
        error: serializeError(result.result.error),
        failedPhase: result.result.failedPhase,
        deviceChangesStarted: result.result.deviceChangesStarted,
      },
    };
  }

  return {
    kind: result.kind,
    result: {
      success: result.result.success,
      warnings: result.result.warnings,
      error: serializeError(result.result.error),
      removedPackageIds:
        "removedPackageIds" in result.result ? result.result.removedPackageIds : undefined,
    },
  };
}

export async function downloadSupportBundleFile(file: SupportBundleFile) {
  const blob = new Blob([await file.download()], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createProgressLogText(state: InstallControllerState) {
  if (state.progressEntries.length === 0) {
    return "No progress entries captured.\n";
  }

  return `${state.progressEntries
    .map((entry) => {
      const progress =
        entry.overallPercent !== null && entry.phasePercent !== null
          ? ` overall=${entry.overallPercent}% phase=${entry.phasePercent}%`
          : "";
      const bytes =
        entry.bytesLoaded !== null
          ? ` bytes=${entry.bytesLoaded}${entry.bytesTotal !== null ? `/${entry.bytesTotal}` : ""}`
          : "";
      return `[${entry.timestamp}] ${entry.phase}: ${entry.message}${progress}${bytes}`;
    })
    .join("\n")}\n`;
}

export function createInstallSupportBundle(
  state: InstallControllerState,
): InstallSupportBundle {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    app: {
      surface: "install",
    },
    browserSupport: state.browserSupport,
    browserContext: {
      href: typeof location !== "undefined" ? location.href : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      language: typeof navigator !== "undefined" ? navigator.language : null,
    },
    connection: state.connection,
    stateSummary: {
      stage: state.stage,
      error: state.error,
      isBusy: state.isBusy,
    },
    inspection: state.inspection,
    target: state.target,
    targetLock: state.targetLock,
    lastOperationResult: serializeOperationResult(state.lastOperationResult),
    progressEntries: state.progressEntries,
  };
}

export function createInstallSupportBundleFiles(
  state: InstallControllerState,
  controller: SupportBundleLogSource,
): SupportBundleFile[] {
  const bundle = createInstallSupportBundle(state);
  const files: SupportBundleFile[] = [
    {
      fileName: "penumbra-logcat.log",
      label: "Logcat Logs",
      mimeType: "text/plain",
      download: controller.getLogcatContent,
    },
    {
      fileName: "install-support-bundle.json",
      mimeType: "application/json",
      download: async () => `${JSON.stringify(bundle, null, 2)}\n`,
    },
    {
      fileName: "progress-log.txt",
      mimeType: "text/plain",
      download: async () => createProgressLogText(state),
    },
  ];

  for (const pkg of getManagedPackageSnapshots(state.inspection)) {
    if (!pkg.rawOutput) {
      continue;
    }

    files.push({
      fileName: `package-${pkg.role}-dumpsys.txt`,
      mimeType: "text/plain",
      download: async () => `${pkg.rawOutput}\n`,
    });
  }

  return files;
}
