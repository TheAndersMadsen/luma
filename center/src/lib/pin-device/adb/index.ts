/**
 * The WebUSB/ADB substrate.
 *
 * One authenticated ADB session per connected Pin carries everything: the
 * Device Installer setup and install, the interactive shell, log streaming,
 * and, through `UsbAdbHttpTransport`, the Pin's entire REST API tunnelled
 * over `localabstract:penumbra_http`.
 *
 * These modules are import-safe on the server (`AdbDaemonWebUsbDeviceManager
 * .BROWSER` resolves to `undefined` under Node rather than throwing), but they
 * can only *do* anything in a secure browser context. Reach them from a
 * `"use client"` module.
 */
export {
  createRemoteAdbAuthenticator,
  DEFAULT_REMOTE_ADB_AUTH_TIMEOUT_MS,
  DEFAULT_REMOTE_ADB_AUTH_URL,
  HttpRemoteAdbAuthClient,
  REMOTE_ADB_NOOP_CREDENTIAL_STORE,
  RemoteSignerAdbAuthStrategy,
} from "./auth";
export type { AdbAuthStrategy, RemoteAdbAuthClient } from "./auth";

export {
  AdbApprovalPendingError,
  AdbDeviceStepTimeoutError,
  AdbTransportRecoveredDisconnectError,
  ADB_APPROVAL_ATTEMPTS,
  UsbDeviceNotChosenError,
  createTimedAdbSessionTransport,
  DEVICE_STEP_TIMEOUT_MS,
  PIN_BRIDGE_ABSTRACT_SERVICE,
  pinBridgeSocketService,
  WebUsbAdbSessionTransport,
  withDeviceStepTimeout,
} from "./transport";
export type {
  AdbConnectionInfo,
  AdbOperatorSessionTransport,
  AdbPtySession,
  AdbSessionPhase,
  AdbSessionStateChange,
  AdbSessionTransport,
  CommandStreamController,
  CommandStreamLine,
  PinBridgeSocketTarget,
  ShellResult,
  ShellWithInputOptions,
  ShellWithInputProgress,
  WebUsbAdbSessionTransportOptions,
} from "./transport";

export { getBrowserSupport } from "./browserSupport";
export type { BrowserSupportResult } from "./browserSupport";

export { getDeviceIdentity } from "./deviceIdentity";
export type { DeviceIdentity } from "./deviceIdentity";

export { createDeviceLogLine } from "./logStream";
export type { DeviceLogLine } from "./logStream";

export { shellCommand, shellSingleQuote } from "./shellQuote";

export {
  extractExactProviderMessage,
  installWithSafeProviderUpdates,
  parseProviderInstallResponse,
} from "./installProtocol";
export type {
  ProviderInstallResponse,
  SafeProviderInstallOperations,
  SafeProviderInstallOptions,
  SafeProviderInstallResult,
} from "./installProtocol";

export {
  DEFAULT_HOME_ACTIVITY,
  disablePackageForUser,
  enablePackageForUser,
  getInstalledPackageMetadata,
  hasExactPackageLine,
  listInstalledPackages,
  MANAGED_PACKAGES,
  matchesPackagePattern,
  PACKAGE_METADATA_POLL_INTERVAL_MS,
  PACKAGE_METADATA_POLL_TIMEOUT_MS,
  packageExists,
  parseInstalledPackageNames,
  parseSignerIdentityFromDumpsys,
  parseVersionNameFromDumpsys,
  SET_HOME_ACTIVITY_MAX_ATTEMPTS,
  SET_HOME_ACTIVITY_RETRY_DELAY_MS,
  setHomeActivity,
  uninstallPackage,
  waitForReadablePackageMetadata,
} from "./packageManager";
export type {
  InstalledPackageMetadata,
  PackageEnableDisableResult,
} from "./packageManager";

export {
  BOOT_COMPLETED_POLL_MS,
  BOOT_COMPLETED_TIMEOUT_MS,
  DEFAULT_SOFT_REBOOT_SETTLE_MS,
  inspectPackageQueryability,
  waitForBootCompleted,
  waitForSoftRebootSettle,
} from "./readiness";
export type {
  DeviceCredentialAvailabilityResult,
  DeviceCredentialState,
  DeviceReadinessResult,
  PackageReadinessResult,
} from "./readiness";

export {
  AFTER_INSTALL_TIMEOUT_MS,
  APK_STAGING_NAME_RE,
  assertPackageManagerReady,
  BATCH_INSTALL_TIMEOUT_MS,
  bootstrapInstaller,
  DEVICE_TMP_DIR,
  BOOTSTRAP_RECEIVER,
  BOOTSTRAP_STAGE1_ACTION,
  BOOTSTRAP_STAGE2_ACTION,
  InvalidApkStagingNameError,
  isInstallerBootstrapped,
  isValidApkStagingName,
  parseAndroidUserIds,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  pollForPackage,
  SOFT_REBOOT_STABILIZATION_MS,
  STAGING_AUTHORITY,
  STAGING_URI,
  stageSystemApkBatchInstall,
  stageSystemApkInstall,
  SYSTEM_READY_POLL_MS,
  SYSTEM_READY_SETTLE_MS,
  SYSTEM_READY_TIMEOUT_MS,
  waitForDeviceReady,
  waitForPackageManagerReady,
  waitForSoftRebootStabilization,
  waitForStagingProviderReady,
} from "./systemInstaller";
export type {
  BootstrapInstallerAssets,
  StageSystemApkBatchInstallItem,
  StageSystemApkBatchInstallOptions,
  StageSystemApkInstallOptions,
  StageSystemApkInstallResult,
  SystemInstallerProgressEvent,
} from "./systemInstaller";
