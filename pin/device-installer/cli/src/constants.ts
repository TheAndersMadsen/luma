/** Package names and broadcast actions */
export const INSTALLER_PACKAGE = "com.penumbraos.systeminjector";
export const BOOTSTRAP_HELPER_PACKAGE = "com.penumbraos.systeminjector.exploit";

export const INSTALLER_ACTION = "com.penumbraos.systeminjector.INSTALL";
export const BOOTSTRAP_STAGE1_ACTION =
  "com.penumbraos.systeminjector.exploit.STAGE1";
export const BOOTSTRAP_STAGE2_ACTION =
  "com.penumbraos.systeminjector.exploit.STAGE2";
export const BOOTSTRAP_RECOVER_STAGE2_ACTION =
  "com.penumbraos.systeminjector.exploit.RECOVER_STAGE2";
export const BOOTSTRAP_RECOVER_ROLLBACK_ACTION =
  "com.penumbraos.systeminjector.exploit.RECOVER_ROLLBACK";
export const BOOTSTRAP_STATUS_AUTHORITY =
  "com.penumbraos.systeminjector.exploit.status";
export const BOOTSTRAP_STATUS_URI = `content://${BOOTSTRAP_STATUS_AUTHORITY}`;

/** Explicit component targets that work while a fresh install is still stopped. */
export const BOOTSTRAP_RECEIVER = `${BOOTSTRAP_HELPER_PACKAGE}/.InstallReceiver`;
export const INSTALLER_RECEIVER = `${INSTALLER_PACKAGE}/.InstallReceiver`;
export const HOOK_RUNTIME_POLICY_REPAIR_ACTION =
  "com.penumbraos.hook.REPAIR_SERVER_RUNTIME_POLICY";
export const HOOK_RUNTIME_POLICY_REPAIR_RECEIVER =
  "com.penumbraos.hook.injector/.ServerRuntimePolicyRepairReceiver";
export const HOOK_COMPATIBILITY_REFRESH_ACTION =
  "com.penumbraos.hook.INJECT_CONFIGURED_TARGETS";
export const HOOK_COMPATIBILITY_REFRESH_RECEIVER =
  "com.penumbraos.hook.injector/.CompatibilityRefreshReceiver";

/** Default device paths */
export const DEVICE_TMP_DIR = "/data/local/tmp";

/** Content provider authority for staging APKs into system_server's cache */
export const STAGING_AUTHORITY = "com.penumbraos.systeminjector.staging";
export const STAGING_URI = `content://${STAGING_AUTHORITY}`;

/** Polling configuration */
export const POLL_INTERVAL_MS = 3000;
export const POLL_TIMEOUT_MS = 120000;

/** System readiness polling after Android's core services restart. */
export const SYSTEM_READY_TIMEOUT_MS = 60000;
export const SYSTEM_READY_POLL_MS = 2000;
/** Maximum time for the asynchronous installer update and service restart. */
export const SYSTEM_RESTART_TIMEOUT_MS = 120000;
/** Setup steps persist a status before requesting a system_server restart. */
export const BOOTSTRAP_STATUS_TIMEOUT_MS = 30000;
/** Extra delay after PMS is detected, to let it finish restoring sessions */
export const SYSTEM_READY_SETTLE_MS = 3000;

/** Default APK locations (relative to project root) */
export const INSTALLER_APK =
  "../installer/build/outputs/apk/release/installer-release.apk";
export const BOOTSTRAP_APK =
  "../bootstrap/build/outputs/apk/release/bootstrap-release.apk";
