package com.penumbraos.hook

import android.util.Log

/**
 * Hooks for the krypto APK (package: hu.ma.ne.krypto).
 *
 * The krypto process runs KryptoService which manages Kryptonite KMS,
 * privacy databases, and crypto keys. Its PrivacyClient creates its own
 * ChannelFactory targeting api.prod.humane.cloud. We redirect that to
 * the mock server and bypass encryption.
 */
object KryptoHooks {

    private const val TAG = "PenumbraHook"

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing krypto hooks...")

        ChannelFactoryBypass.install(cl)
        // Safety: DataProtectorBypass converts protected payloads broadly to
        // plaintext and trusts forgeable markers. Safe children must
        // be split before this wrapper can be reintroduced.
        // DataProtectorBypass.install(cl)

        Log.w(TAG, "Krypto hooks installed")
    }
}
