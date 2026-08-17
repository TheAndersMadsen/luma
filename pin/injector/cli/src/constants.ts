/** Package names and broadcast actions */
export const INSTALLER_PACKAGE = "com.penumbraos.systeminjector";
export const EXPLOIT_PACKAGE = "com.penumbraos.systeminjector.exploit";

export const INSTALLER_ACTION = "com.penumbraos.systeminjector.INSTALL";
export const EXPLOIT_STAGE1_ACTION =
  "com.penumbraos.systeminjector.exploit.STAGE1";
export const EXPLOIT_STAGE2_ACTION =
  "com.penumbraos.systeminjector.exploit.STAGE2";
export const EXPLOIT_RECOVER_STAGE2_ACTION =
  "com.penumbraos.systeminjector.exploit.RECOVER_STAGE2";
export const EXPLOIT_RECOVER_ROLLBACK_ACTION =
  "com.penumbraos.systeminjector.exploit.RECOVER_ROLLBACK";
export const EXPLOIT_STATUS_AUTHORITY =
  "com.penumbraos.systeminjector.exploit.status";
export const EXPLOIT_STATUS_URI = `content://${EXPLOIT_STATUS_AUTHORITY}`;

/** Explicit component targets (bypasses stopped-state restriction on fresh installs) */
export const EXPLOIT_RECEIVER = `${EXPLOIT_PACKAGE}/.InstallReceiver`;
export const INSTALLER_RECEIVER = `${INSTALLER_PACKAGE}/.InstallReceiver`;

/** Default device paths */
export const DEVICE_TMP_DIR = "/data/local/tmp";

/** Content provider authority for staging APKs into system_server's cache */
export const STAGING_AUTHORITY = "com.penumbraos.systeminjector.staging";
export const STAGING_URI = `content://${STAGING_AUTHORITY}`;

/** Polling configuration */
export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 120000;

/** System readiness polling (wait for PackageManagerService after crash) */
export const SYSTEM_READY_TIMEOUT_MS = 60000;
export const SYSTEM_READY_POLL_MS = 2000;
/** Maximum time for the asynchronous installer to patch/sign and kill system_server. */
export const SYSTEM_RESTART_TIMEOUT_MS = 120000;
/** Exploit stages persist a status before requesting a system_server restart. */
export const BOOTSTRAP_STATUS_TIMEOUT_MS = 30000;
/** Extra delay after PMS is detected, to let it finish restoring sessions */
export const SYSTEM_READY_SETTLE_MS = 3000;

/** Default APK locations (relative to project root) */
export const INSTALLER_APK =
  "../installer/build/outputs/apk/release/installer-release.apk";
export const EXPLOIT_APK =
  "../exploit/build/outputs/apk/release/exploit-release.apk";
