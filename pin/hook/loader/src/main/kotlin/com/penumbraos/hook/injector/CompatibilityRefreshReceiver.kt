package com.penumbraos.hook.injector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Refreshes runtime compatibility for the generated target list after a
 * release update. Runs inside system_server (android:process="system", UID 1000).
 */
class CompatibilityRefreshReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "LumaCompatibility"
        // Existing release control-protocol value. Callers explicitly target this receiver.
        const val ACTION_REFRESH_CONFIGURED_TARGETS =
            "com.penumbraos.hook.INJECT_CONFIGURED_TARGETS"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REFRESH_CONFIGURED_TARGETS) return
        refreshConfiguredTargets(context)
    }

    private fun refreshConfiguredTargets(context: Context) {
        val pendingResult = goAsync()
        val applicationContext = context.applicationContext ?: context
        try {
            Thread(
                {
                    try {
                        synchronized(BootCompatibilityReceiver.compatibilityWorkLock) {
                            RuntimeCompatibilityApplier.ensureInitialized()
                            if (!RuntimeCompatibilityApplier.isInitialized) {
                                Log.e(TAG, "RuntimeCompatibilityApplier failed to initialize configured targets")
                                return@synchronized
                            }
                            BootCompatibilityReceiver().applyConfiguredTargets(
                                context = applicationContext,
                                forceRestart = isBootCompleted(),
                                trigger = "explicit post-install activation",
                            )
                        }
                    } catch (error: Throwable) {
                        Log.e(TAG, "Configured-target compatibility refresh failed", error)
                    } finally {
                        pendingResult.finish()
                    }
                },
                "LumaCompatibilityRefresh",
            ).start()
        } catch (error: Throwable) {
            pendingResult.finish()
            Log.e(TAG, "Failed to schedule configured-target compatibility refresh", error)
        }
    }

    private fun isBootCompleted(): Boolean {
        return try {
            val systemProperties = Class.forName("android.os.SystemProperties")
            val get = systemProperties.getDeclaredMethod(
                "get",
                String::class.java,
                String::class.java,
            )
            get.invoke(null, "sys.boot_completed", "0") == "1"
        } catch (error: Throwable) {
            Log.w(TAG, "Failed to read boot completion state; not restarting targets", error)
            false
        }
    }

}
