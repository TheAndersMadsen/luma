/**
 * The single seam between the installer brain and the WebUSB/ADB device layer.
 *
 * Every symbol the installer needs from `@/lib/pin-device` is re-exported here
 * and imported from here by the rest of `@/lib/pin-install`, so the device
 * area is consumed through exactly one module and only through its public
 * exports. If the device area relocates its barrel, this file is the only edit.
 *
 * Nothing in this module executes at import time; the device layer is
 * SSR-import-safe (no top-level window/document/navigator access), so pulling
 * it in from a server-rendered module graph is harmless. WebUSB is only ever
 * touched from "use client" callers that actually open a session.
 */

export {
  AdbDeviceStepTimeoutError,
  AdbTransportRecoveredDisconnectError,
  BATCH_INSTALL_TIMEOUT_MS,
  DEVICE_STEP_TIMEOUT_MS,
  createTimedAdbSessionTransport,
  withDeviceStepTimeout,
} from "@/lib/pin-device/adb";
export type {
  AdbConnectionInfo,
  AdbPtySession,
  AdbSessionTransport,
  CommandStreamController,
  CommandStreamLine,
  ShellResult,
} from "@/lib/pin-device/adb";

export { getDeviceIdentity } from "@/lib/pin-device/adb";
export type { DeviceIdentity } from "@/lib/pin-device/adb";

export {
  disablePackageForUser,
  enablePackageForUser,
  getInstalledPackageMetadata,
  listInstalledPackages,
  matchesPackagePattern,
  packageExists,
  setHomeActivity,
  uninstallPackage,
  waitForReadablePackageMetadata,
} from "@/lib/pin-device/adb";
export type {
  InstalledPackageMetadata,
  PackageEnableDisableResult,
} from "@/lib/pin-device/adb";

export { inspectPackageQueryability } from "@/lib/pin-device/adb";
export type {
  DeviceCredentialState,
  DeviceReadinessResult,
  PackageReadinessResult,
} from "@/lib/pin-device/adb";

export {
  bootstrapInstaller,
  stageSystemApkBatchInstall,
  stageSystemApkInstall,
} from "@/lib/pin-device/adb";
export type {
  BootstrapInstallerAssets,
  StageSystemApkInstallResult,
  SystemInstallerProgressEvent,
} from "@/lib/pin-device/adb";

export { createDeviceLogLine } from "@/lib/pin-device/adb";
export type { DeviceLogLine } from "@/lib/pin-device/adb";

export { getBrowserSupport } from "@/lib/pin-device/adb";
export type { BrowserSupportResult } from "@/lib/pin-device/adb";
