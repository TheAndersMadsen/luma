package com.penumbraos.hook

import android.util.Log

/**
 * Hooks for the krypto APK (package: hu.ma.ne.krypto).
 *
 * The krypto process runs KryptoService which manages Kryptonite KMS,
 * privacy databases, and crypto keys. Its PrivacyClient creates its own
 * ChannelFactory targeting the retired Humane endpoint. Route that channel to
 * Cosmos while leaving stock key and data-protection behavior unchanged.
 */
object KryptoHooks {

    private const val TAG = "LumaCompatibility"

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing krypto hooks...")

        CosmosChannelRouting.install(cl)
        KryptoWorkManagerHooks.install(cl)

        Log.w(TAG, "Krypto hooks installed")
    }
}
