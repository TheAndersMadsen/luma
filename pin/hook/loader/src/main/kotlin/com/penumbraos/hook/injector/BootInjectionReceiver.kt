package com.penumbraos.hook.injector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log

/**
 * Automatically injects hooks into all target packages at boot.
 *
 * Events should fire from within `system_server` before any targets start.
 */
class BootInjectionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PenumbraInjector"

        /**
         * System property to disable auto-injection at boot.
         * Set via: adb shell setprop debug.penumbra.disable 1
         */
        private const val PROP_DISABLE = "debug.penumbra.disable"

        /**
         * The hook APK's package name and meta-data key where it declares
         * which packages the injector should target at boot.
         */
        private const val HOOK_PACKAGE = "com.penumbraos.hook"
        private const val META_TARGET_PACKAGES = "com.penumbraos.hook.TARGET_PACKAGES"

        /** Serializes the two asynchronous boot phases and protects boot state. */
        internal val injectionWorkLock = Any()

        /**
         * Tracks which packages we've already injected this boot cycle.
         * Prevents duplicate injections.
         */
        private val injectedPackages = mutableSetOf<String>()
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
            Log.e(TAG, "BootInjectionReceiver.goAsync failed", error)
            return
        }
        try {
            Thread(
                {
                    try {
                        synchronized(injectionWorkLock) {
                            handleBoot(context, action)
                        }
                    } catch (error: Throwable) {
                        // CRITICAL: never let an exception escape into system_server.
                        Log.e(TAG, "BootInjectionReceiver async work failed", error)
                    } finally {
                        pendingResult.finish()
                    }
                },
                "PenumbraBootInjection",
            ).start()
        } catch (error: Throwable) {
            // Thread construction/start can fail before its finally block owns
            // the PendingResult. Finish it here on every such path.
            Log.e(TAG, "BootInjectionReceiver failed to start async work", error)
            pendingResult.finish()
        }
    }

    private fun handleBoot(context: Context, action: String) {
        // Check kill switch
        if (isDisabled()) {
            Log.w(TAG, "Boot injection DISABLED via $PROP_DISABLE")
            return
        }

        Log.w(TAG, "Boot injection triggered by $action")

        // A failed keep-data update can leave the exact Server APK restored at
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
        PackageInjector.ensureInitialized()
        if (!PackageInjector.isInitialized) {
            Log.e(TAG, "PackageInjector failed to initialize, skipping boot injection")
            return
        }

        injectConfiguredTargets(
            context = context,
            forceRestart = action == Intent.ACTION_BOOT_COMPLETED,
            trigger = action,
        )

        disableMemfaultDaemons()

        Log.w(TAG, "Boot injection complete")
    }

    /**
     * Apply the hook to the exact generated target list. The explicit post-install
     * broadcast calls this after PMS initialization, using the
     * same target source and process-local injected set as boot broadcasts.
     */
    internal fun injectConfiguredTargets(
        context: Context,
        forceRestart: Boolean,
        trigger: String,
    ) {
        if (isDisabled()) {
            Log.w(TAG, "Injection DISABLED via $PROP_DISABLE")
            return
        }

        val targetPackages = loadTargetPackages(context)
        if (targetPackages.isEmpty()) {
            Log.e(TAG, "No target packages found, skipping injection for $trigger")
            return
        }
        Log.w(TAG, "Target packages from hook APK for $trigger: $targetPackages")

        for (packageName in targetPackages) {
            try {
                injectPackage(context, packageName, forceRestart)
            } catch (error: Throwable) {
                Log.e(TAG, "Failed to inject $packageName", error)
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
     * Inject a single target package. On BOOT_COMPLETED,
     * also force-stop and relaunch if the target was already running unhooked.
     */
    private fun injectPackage(context: Context, packageName: String, forceRestart: Boolean) {
        if (packageName in injectedPackages) {
            Log.w(TAG, "Already injected $packageName this boot, skipping")
            return
        }

        val success = PackageInjector.inject(packageName)
        if (!success) {
            Log.w(TAG, "Injection returned false for $packageName (may not be installed)")
            return
        }

        injectedPackages.add(packageName)
        Log.w(TAG, "Injected $packageName")

        // On BOOT_COMPLETED: targets may already be running from a LOCKED_BOOT_COMPLETED
        // launch that happened before our injection. Force-stop + relaunch to pick up hooks.
        // On LOCKED_BOOT_COMPLETED: targets haven't started yet, no restart needed.
        if (forceRestart) {
            Log.w(TAG, "Force-restarting $packageName to pick up hooks after BOOT_COMPLETED")
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
     * Read the target package list from the hook APK's manifest <meta-data>.
     * The hook APK declares which packages need injection via:
     *   <meta-data android:name="com.penumbraos.hook.TARGET_PACKAGES"
     *              android:value="pkg1,pkg2,..." />
     */
    private fun loadTargetPackages(context: Context): List<String> {
        return try {
            val appInfo = context.packageManager.getApplicationInfo(
                HOOK_PACKAGE, PackageManager.GET_META_DATA
            )
            val csv = appInfo.metaData?.getString(META_TARGET_PACKAGES)
            if (csv.isNullOrBlank()) {
                Log.e(TAG, "No $META_TARGET_PACKAGES meta-data found in $HOOK_PACKAGE")
                emptyList()
            } else {
                csv.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            }
        } catch (e: PackageManager.NameNotFoundException) {
            Log.e(TAG, "Hook APK ($HOOK_PACKAGE) not installed, cannot read target packages", e)
            emptyList()
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to read target packages from $HOOK_PACKAGE", t)
            emptyList()
        }
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
