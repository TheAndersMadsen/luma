package com.penumbraos.hook

import android.util.Log

/**
 * Entry point for Tickle app hooks.
 *
 * Installs hooks that make the Tickle launcher fully functional:
 * - Real data (time/weather) instead of hardcoded demo values
 * - Working launcher cards (message/call/capture) that open system apps
 */
object TickleHooks {
    private const val TAG = "LumaCompatibility"

    fun install(classLoader: ClassLoader) {
        Log.w(TAG, "Installing Tickle hooks...")

        TickleOnboardingGuard.install(classLoader)

        try {
            TickleRealDataHooks.install(classLoader)
            Log.w(TAG, "  TickleRealDataHooks installed")
        } catch (t: Throwable) {
            Log.e(TAG, "  TickleRealDataHooks install failed", t)
        }

        try {
            TickleLauncherHooks.install(classLoader)
            Log.w(TAG, "  TickleLauncherHooks installed")
        } catch (t: Throwable) {
            Log.e(TAG, "  TickleLauncherHooks install failed", t)
        }

        Log.w(TAG, "Tickle hooks installation complete")
    }
}
