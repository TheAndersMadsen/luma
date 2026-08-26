package com.penumbraos.hook.injector

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Broadcast receiver for hook injection requests.
 * Runs inside system_server (android:process="system", UID 1000).
 *
 * Workflow:
 *   1. Receives broadcast with target package name
 *   2. Mutates PMS in-memory data to inject hook APK into target's classpath
 *   3. Force-stops the target
 *   4. Relaunches it (now picks up the mutated ApplicationInfo)
 *
 * Usage:
 *   adb shell am broadcast \
 *     -a com.penumbraos.hook.INJECT \
 *     --es package hu.ma.ne.ironman \
 *     -n com.penumbraos.hook.injector/.InjectReceiver
 */
class InjectReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PenumbraInjector"
        const val ACTION_INJECT = "com.penumbraos.hook.INJECT"
        const val ACTION_INJECT_CONFIGURED_TARGETS =
            "com.penumbraos.hook.INJECT_CONFIGURED_TARGETS"
        const val EXTRA_PACKAGE = "package"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_INJECT -> injectOne(context, intent)
            ACTION_INJECT_CONFIGURED_TARGETS -> injectConfiguredTargets(context)
        }
    }

    private fun injectOne(context: Context, intent: Intent) {
        val packageName = intent.getStringExtra(EXTRA_PACKAGE)
        if (packageName.isNullOrBlank()) {
            Log.e(TAG, "Missing 'package' extra")
            return
        }

        Log.w(TAG, "Received INJECT request for: $packageName")

        try {
            // Initialize PMS references on first use
            PackageInjector.ensureInitialized()

            if (!PackageInjector.isInitialized) {
                Log.e(TAG, "PackageInjector failed to initialize, ignoring request")
                return
            }

            // Inject immediately — mutates PMS in-memory data
            val success = PackageInjector.inject(packageName)
            if (!success) {
                Log.e(TAG, "Injection failed for $packageName")
                return
            }

            // Force-stop and relaunch on a background thread so we don't block
            // the broadcast handler
            Thread {
                try {
                    forceStopAndRelaunch(context, packageName)
                } catch (t: Throwable) {
                    Log.e(TAG, "Force-stop/relaunch failed for $packageName", t)
                }
            }.start()
        } catch (t: Throwable) {
            Log.e(TAG, "InjectReceiver.onReceive failed", t)
        }
    }

    private fun injectConfiguredTargets(context: Context) {
        val pendingResult = goAsync()
        val applicationContext = context.applicationContext ?: context
        try {
            Thread(
                {
                    try {
                        synchronized(BootInjectionReceiver.injectionWorkLock) {
                            PackageInjector.ensureInitialized()
                            if (!PackageInjector.isInitialized) {
                                Log.e(TAG, "PackageInjector failed to initialize configured targets")
                                return@synchronized
                            }
                            BootInjectionReceiver().injectConfiguredTargets(
                                context = applicationContext,
                                forceRestart = isBootCompleted(),
                                trigger = "explicit post-install activation",
                            )
                        }
                    } catch (error: Throwable) {
                        Log.e(TAG, "Configured target injection failed", error)
                    } finally {
                        pendingResult.finish()
                    }
                },
                "PenumbraConfiguredTargetInjection",
            ).start()
        } catch (error: Throwable) {
            pendingResult.finish()
            Log.e(TAG, "Failed to schedule configured target injection", error)
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

    private fun forceStopAndRelaunch(context: Context, packageName: String) {
        Log.w(TAG, "Force-stopping $packageName...")

        // forceStopPackage is @SystemApi, not in the compile SDK. Use reflection.
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val forceStop = am.javaClass.getDeclaredMethod(
            "forceStopPackage", String::class.java
        )
        forceStop.invoke(am, packageName)

        // Let the process fully die before relaunching
        Thread.sleep(500)

        Log.w(TAG, "Relaunching $packageName...")
        val launchIntent = context.packageManager.getLaunchIntentForPackage(packageName)
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launchIntent)
            Log.w(TAG, "Launched via launch intent")
        } else {
            // For services like ironman that have no launcher activity:
            // Android will auto-restart persistent/foreground services after force-stop.
            // If that doesn't happen, we could start CentralService explicitly.
            Log.w(TAG, "No launch intent for $packageName, relying on system auto-restart")
        }
    }
}
