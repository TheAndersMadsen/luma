package com.penumbraos.hook.injector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Broadcast receiver that starts the ADB WiFi bridge.
 * Runs inside system_server.
 *
 * Usage:
 *   adb shell am broadcast -a com.penumbraos.hook.ADB_BRIDGE -n com.penumbraos.hook.injector/.AdbBridgeReceiver
 */
class AdbBridgeReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "AdbWifiBridge"
        const val ACTION_ADB_BRIDGE = "com.penumbraos.hook.ADB_BRIDGE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (intent.action != ACTION_ADB_BRIDGE) return

            Log.w(TAG, "ADB_BRIDGE broadcast received, starting bridge on background thread")

            val appContext = context.applicationContext
            Thread({
                try {
                    AdbWifiBridge.start(appContext)
                } catch (t: Throwable) {
                    Log.e(TAG, "Bridge thread failed", t)
                }
            }, "adb-bridge-init").apply {
                isDaemon = true
                uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, e ->
                    Log.e(TAG, "Uncaught on ${thread.name}", e)
                }
                start()
            }
        } catch (t: Throwable) {
            // CRITICAL: never let an exception escape onReceive in system_server
            Log.e(TAG, "AdbBridgeReceiver.onReceive failed", t)
        }
    }
}
