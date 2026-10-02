package com.penumbraos.hook.injector

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols

internal const val STANDALONE_DOCK_SHELL_PACKAGE = "com.android.shell"
internal const val STANDALONE_DOCK_SHELL_RECEIVER = "com.android.shell.HeapDumpReceiver"
internal const val STANDALONE_DOCK_WAKE_ACTION = "com.android.shell.action.DELETE_HEAP_DUMP"

internal fun compatibilityTargets(
    configured: List<String>,
    standaloneDockEnabled: Boolean,
): List<String> = buildList {
    addAll(configured)
    if (standaloneDockEnabled && STANDALONE_DOCK_SHELL_PACKAGE !in configured) {
        add(STANDALONE_DOCK_SHELL_PACKAGE)
    }
}

internal fun shouldRestartCompatibilityTarget(packageName: String, forceRestart: Boolean): Boolean =
    forceRestart && packageName != STANDALONE_DOCK_SHELL_PACKAGE

internal fun shouldWakeStandaloneDockShell(packageName: String, trigger: String): Boolean =
    packageName == STANDALONE_DOCK_SHELL_PACKAGE &&
        trigger == Intent.ACTION_LOCKED_BOOT_COMPLETED

internal data class ConfiguredTargetPlan(
    val applyCompatibility: Boolean,
    val restart: Boolean,
)

internal fun configuredTargetPlan(
    alreadyConfigured: Boolean,
    forceRestart: Boolean,
): ConfiguredTargetPlan = ConfiguredTargetPlan(
    applyCompatibility = !alreadyConfigured,
    restart = forceRestart,
)

/**
 * Applies runtime compatibility to the configured stock packages at boot.
 *
 * Events should fire from within `system_server` before any targets start.
 */
class BootCompatibilityReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "LumaCompatibility"

        /**
         * System property to disable automatic compatibility application at boot.
         * Set via: adb shell setprop debug.penumbra.disable 1
         */
        private const val PROP_DISABLE = "debug.penumbra.disable"

        /**
         * The Compatibility Layer package and meta-data key where it declares
         * which stock packages the loader should configure at boot.
         */
        private const val COMPATIBILITY_PACKAGE = "com.penumbraos.hook"
        private const val META_TARGET_PACKAGES = "com.penumbraos.hook.TARGET_PACKAGES"

        /** Serializes the two asynchronous boot phases and protects boot state. */
        internal val compatibilityWorkLock = Any()

        /**
         * Tracks which packages have already received compatibility this boot.
         * Prevents duplicate application.
         */
        private val configuredPackages = mutableSetOf<String>()
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != Intent.ACTION_BOOT_COMPLETED) {
            return
        }

        val pendingResult = try {
            goAsync()
        } catch (error: Throwable) {
            Log.e(TAG, "BootCompatibilityReceiver.goAsync failed", error)
            return
        }
        try {
            Thread(
                {
                    try {
                        synchronized(compatibilityWorkLock) {
                            handleBoot(context, action)
                        }
                    } catch (error: Throwable) {
                        // CRITICAL: never let an exception escape into system_server.
                        Log.e(TAG, "BootCompatibilityReceiver async work failed", error)
                    } finally {
                        pendingResult.finish()
                    }
                },
                "LumaBootCompatibility",
            ).start()
        } catch (error: Throwable) {
            // Thread construction/start can fail before its finally block owns
            // the PendingResult. Finish it here on every such path.
            Log.e(TAG, "BootCompatibilityReceiver failed to start async work", error)
            pendingResult.finish()
        }
    }

    private fun handleBoot(context: Context, action: String) {
        // Carrier recovery is independent of runtime compatibility. Keep it on this
        // firmware-proven boot path and ahead of the development kill switch
        // so a replacement SIM cannot lose its persistent compatibility values.
        repairCarrierCompatibility(context)

        // Check kill switch
        if (isDisabled()) {
            Log.w(TAG, "Boot compatibility DISABLED via $PROP_DISABLE")
            return
        }

        Log.w(TAG, "Boot compatibility triggered by $action")

        // A failed keep-data update can leave the exact Device Services APK restored at
        // Package Manager's randomized path with its transient platform policy
        // and app-data labels lost. Repair the one pinned UID-1000 package before
        // any normal BOOT_COMPLETED receiver can launch it.
        val storagePhase = when (action) {
            Intent.ACTION_LOCKED_BOOT_COMPLETED ->
                ServerRuntimePolicyRepair.StoragePhase.DEVICE_ENCRYPTED
            Intent.ACTION_BOOT_COMPLETED ->
                ServerRuntimePolicyRepair.StoragePhase.CREDENTIAL_ENCRYPTED
            else -> return
        }
        when (val repair = ServerRuntimePolicyRepair.repair(context, storagePhase)) {
            is ServerRuntimePolicyRepair.Result.Applied -> Log.w(
                TAG,
                "Server runtime policy repaired: overrideChanged=${repair.overrideChanged}, " +
                    "storagePhase=${repair.storagePhase}, flags=0x${repair.appDataFlags.toString(16)}, " +
                    "ceDataInode=${repair.ceDataInode}, targetSdk=${repair.targetSdkVersion}",
            )
            ServerRuntimePolicyRepair.Result.PackageMissing ->
                Log.w(TAG, "Server runtime policy repair skipped: package missing")
            is ServerRuntimePolicyRepair.Result.NotEligible -> Log.e(
                TAG,
                "Server runtime policy repair rejected: sharedUserId=${repair.sharedUserId}, " +
                    "uid=${repair.appUid ?: -1}",
            )
            is ServerRuntimePolicyRepair.Result.Failed ->
                Log.e(TAG, "Server runtime policy repair failed: ${repair.message}", repair.error)
        }

        // Initialize PMS references
        RuntimeCompatibilityApplier.ensureInitialized()
        if (!RuntimeCompatibilityApplier.isInitialized) {
            Log.e(
                TAG,
                "RuntimeCompatibilityApplier failed to initialize; skipping boot compatibility",
            )
            return
        }

        applyConfiguredTargets(
            context = context,
            forceRestart = action == Intent.ACTION_BOOT_COMPLETED,
            trigger = action,
        )

        disableMemfaultDaemons()

        Log.w(TAG, "Boot compatibility complete")
    }

    private fun repairCarrierCompatibility(context: Context) {
        val result = synchronized(CarrierCompatibility.workLock) {
            CarrierCompatibility.repair(context)
        }
        CarrierCompatibilityReceiver.logResult(result)
    }

    /**
     * Apply compatibility to the exact generated target list. The explicit post-install
     * broadcast calls this after PMS initialization, using the
     * same target source and process-local configured set as boot broadcasts.
     */
    internal fun applyConfiguredTargets(
        context: Context,
        forceRestart: Boolean,
        trigger: String,
    ) {
        if (isDisabled()) {
            Log.w(TAG, "Compatibility application DISABLED via $PROP_DISABLE")
            return
        }

        val targetPackages = compatibilityTargets(
            loadTargetPackages(context),
            standaloneDockEnabled(context),
        )
        if (targetPackages.isEmpty()) {
            Log.e(TAG, "No target packages found; skipping compatibility for $trigger")
            return
        }
        Log.w(TAG, "Target packages from Compatibility Layer APK for $trigger: $targetPackages")

        for (packageName in targetPackages) {
            try {
                applyToPackage(context, packageName, forceRestart, trigger)
            } catch (error: Throwable) {
                Log.e(TAG, "Failed to apply compatibility to $packageName", error)
            }
        }
    }

    /**
     * Stop Memfault native daemons by setting their property gates to "0".
     *
     * memfault-structured-logd is gated by:
     *   persist.system.memfault.bort.enabled=1 AND persist.system.memfault.structured.enabled=1
     * Setting either to "0" triggers init to stop the service.
     */
    private fun disableMemfaultDaemons() {
        val props = mapOf(
            "persist.system.memfault.bort.enabled" to "0",
            "persist.system.memfault.structured.enabled" to "0",
        )

        try {
            val sysPropClass = Class.forName("android.os.SystemProperties")
            val setMethod = sysPropClass.getDeclaredMethod("set", String::class.java, String::class.java)

            for ((key, value) in props) {
                try {
                    setMethod.invoke(null, key, value)
                    Log.w(TAG, "Set $key=$value")
                } catch (t: Throwable) {
                    Log.w(TAG, "Failed to set $key: ${t.message}")
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to access SystemProperties for memfault daemon disable", t)
        }
    }

    /**
     * Apply compatibility to one target package. On BOOT_COMPLETED,
     * also force-stop and relaunch if the target was already running unchanged.
     */
    private fun applyToPackage(
        context: Context,
        packageName: String,
        forceRestart: Boolean,
        trigger: String,
    ) {
        val plan = configuredTargetPlan(
            alreadyConfigured = packageName in configuredPackages,
            // INFERRED Luma behavior. Stock
            // com.android.shell.HeapDumpReceiver.onReceive() handles
            // BOOT_COMPLETED. Killing Shell during that delivery could stop
            // the detached runner before it owns the boot attempt.
            forceRestart = shouldRestartCompatibilityTarget(packageName, forceRestart),
        )
        if (!plan.applyCompatibility) {
            Log.w(TAG, "Compatibility already applied to $packageName this boot; skipping")
        } else {
            val success = RuntimeCompatibilityApplier.applyTo(packageName)
            if (!success) {
                Log.w(TAG, "Compatibility application returned false for $packageName (may not be installed)")
                return
            }

            configuredPackages.add(packageName)
            Log.w(TAG, "Applied compatibility to $packageName")
        }

        if (shouldWakeStandaloneDockShell(packageName, trigger)) {
            // Stock reference: com.android.shell.HeapDumpReceiver.onReceive()
            // accepts com.android.shell.action.DELETE_HEAP_DUMP. Luma uses an
            // explicit delivery (INFERRED) after patching Shell during locked
            // boot so the UID-2000 runner does not depend on the first unlock.
            val wake = Intent(STANDALONE_DOCK_WAKE_ACTION).setComponent(
                ComponentName(STANDALONE_DOCK_SHELL_PACKAGE, STANDALONE_DOCK_SHELL_RECEIVER),
            )
            context.sendBroadcast(wake)
            Log.w(TAG, "Started the standalone dock Shell boundary during locked boot")
        }

        // On BOOT_COMPLETED: targets may already be running from a LOCKED_BOOT_COMPLETED
        // launch that happened before compatibility was applied. Restart it so
        // the process picks up the Compatibility Layer.
        // On LOCKED_BOOT_COMPLETED: targets haven't started yet, no restart needed.
        if (plan.restart) {
            Log.w(TAG, "Force-restarting $packageName to pick up compatibility after BOOT_COMPLETED")
            Thread {
                try {
                    forceStopAndRelaunch(context, packageName)
                } catch (error: Throwable) {
                    Log.e(TAG, "Relaunch failed for $packageName", error)
                }
            }.start()
        }
    }

    private fun forceStopAndRelaunch(context: Context, packageName: String) {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val forceStop = am.javaClass.getDeclaredMethod(
            "forceStopPackage", String::class.java
        )
        forceStop.invoke(am, packageName)

        Thread.sleep(500)

        val launchIntent = context.packageManager.getLaunchIntentForPackage(packageName)
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launchIntent)
            Log.w(TAG, "Relaunched $packageName via launch intent")
        } else {
            Log.w(TAG, "No launch intent for $packageName, relying on system auto-restart")
        }
    }

    /**
     * Read the target package list from the Compatibility Layer manifest.
     * Its APK declares which packages need runtime compatibility via:
     *   <meta-data android:name="com.penumbraos.hook.TARGET_PACKAGES"
     *              android:value="pkg1,pkg2,..." />
     */
    private fun loadTargetPackages(context: Context): List<String> {
        return try {
            val appInfo = context.packageManager.getApplicationInfo(
                COMPATIBILITY_PACKAGE, PackageManager.GET_META_DATA
            )
            val csv = appInfo.metaData?.getString(META_TARGET_PACKAGES)
            if (csv.isNullOrBlank()) {
                Log.e(TAG, "No $META_TARGET_PACKAGES meta-data found in $COMPATIBILITY_PACKAGE")
                emptyList()
            } else {
                csv.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            }
        } catch (e: PackageManager.NameNotFoundException) {
            Log.e(
                TAG,
                "Compatibility Layer ($COMPATIBILITY_PACKAGE) not installed; cannot read target packages",
                e,
            )
            emptyList()
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to read target packages from $COMPATIBILITY_PACKAGE", t)
            emptyList()
        }
    }

    /**
     * Luma-owned, fail-closed gate for the boot-scoped standalone dock path.
     * The value stays in Settings.Global on the Pin and is sampled again by
     * the detached shell runner before it consumes the boot attempt.
     */
    private fun standaloneDockEnabled(context: Context): Boolean = try {
        Settings.Global.getInt(
            context.contentResolver,
            TierASymbols.FeatureFlags.LumaSettingsGlobal.ROOT_ACCESS_ENABLED,
            0,
        ) == 1
    } catch (error: Throwable) {
        Log.e(TAG, "Standalone dock gate unavailable; leaving Shell untouched", error)
        false
    }

    /**
     * Check the debug.penumbra.disable system property via reflection.
     * SystemProperties is on the boot classpath but hidden from the SDK.
     */
    private fun isDisabled(): Boolean {
        return try {
            val sysPropClass = Class.forName("android.os.SystemProperties")
            val getMethod = sysPropClass.getDeclaredMethod("get", String::class.java, String::class.java)
            val value = getMethod.invoke(null, PROP_DISABLE, "") as String
            value == "1"
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to read $PROP_DISABLE, assuming not disabled", t)
            false
        }
    }
}
