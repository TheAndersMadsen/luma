package com.penumbraos.hook

import android.util.Log

/**
 * Hooks for the settings experience APK (package: humane.experience.settings).
 */
object SettingsHooks {

    private const val TAG = "PenumbraHook"

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing settings hooks...")

        // Safety: TcmSilencer has no reproduced exact failure justifying its
        // broad constructor suppression.
        // TcmSilencer.install(cl)
        ConnectivityCheckBypass.install(cl)
        CellularSettingsCompatibilityHooks.install(cl)
        // Safety: EsimSettingsHooks relaxes the eSIM QR parser across a
        // prohibited cellular trust boundary.
        // EsimSettingsHooks.install(cl)

        Log.w(TAG, "Settings hooks installed")
    }
}
