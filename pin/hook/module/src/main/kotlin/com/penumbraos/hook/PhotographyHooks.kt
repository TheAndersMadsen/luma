package com.penumbraos.hook

import android.util.Log

/**
 * Hooks for the photography experience APK (package: humane.experience.photography).
 *
 * The photography process runs the stock MemoryUploadWorkerImpl and
 * AssetUploadWorkerImpl pipeline. Route its service calls to Cosmos and adapt
 * only its scheduling constraints for the operator-owned destination.
 */
object PhotographyHooks {

    private const val TAG = "LumaCompatibility"

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing photography hooks...")

        // Safety: TcmSilencer has no reproduced exact failure justifying its
        // broad constructor suppression.
        // TcmSilencer.install(cl)
        CosmosChannelRouting.install(cl)
        DeviceLocalUploadPolicy.install(cl)

        Log.w(TAG, "Photography hooks installed")
    }
}
