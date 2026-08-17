package com.penumbraos.hook

import android.util.Log

/**
 * Hooks for the photography experience APK (package: humane.experience.photography).
 *
 * The photography process runs the upload pipeline (MemoryUploadWorkerImpl,
 * AssetUploadWorkerImpl) which encrypts data via DataProtectorWrapper before
 * sending it to the server. We install the encryption bypass hooks here so
 * thumbnails, locations, and file uploads arrive as plaintext.
 */
object PhotographyHooks {

    private const val TAG = "PenumbraHook"

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing photography hooks...")

        // Safety: TcmSilencer has no reproduced exact failure justifying its
        // broad constructor suppression.
        // TcmSilencer.install(cl)
        ChannelFactoryBypass.install(cl)
        PhotographyUploadPolicyBypass.install(cl)
        // Safety: DataProtectorBypass converts protected payloads broadly to
        // plaintext and trusts forgeable markers. Safe children must
        // be split before this wrapper can be reintroduced.
        // DataProtectorBypass.install(cl)

        Log.w(TAG, "Photography hooks installed")
    }
}
