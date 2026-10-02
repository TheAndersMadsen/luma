package com.penumbraos.hook

import android.util.Log
import java.io.File

/**
 * Restores the stock food experience's original local boundaries.
 *
 * Food runs in its own on-demand process. Its nested agent can be selected by
 * Ironman, but the actual GetFoodItem and Capture calls are created here, so
 * redirecting only Ironman leaves the final provider/storage calls pointed at
 * the retired Humane gateway. Food also uses ephemeral AIBus envelopes and an
 * exact FoodLog data-protection contract. Install only those known Food
 * boundaries. Unrelated Krypton channels and protection domains remain stock.
 */
object FoodHooks {
    private const val TAG = "LumaCompatibility"

    fun install(
        classLoader: ClassLoader,
        packageName: String,
        processName: String,
        sourceApk: File?,
    ) {
        Log.w(TAG, "Installing food hooks...")
        installContained("Food channel factory") { CosmosChannelRouting.install(classLoader) }
        installContained("Food request envelope") {
            FoodEnvelopeCompatibility.installFoodOnly(classLoader)
        }
        installContained("Food persistence envelope") {
            LocalDataEnvelopeAdapter.installFoodOnly(classLoader)
        }
        installAuditedHooks(classLoader, packageName, processName, sourceApk)
        Log.w(TAG, "Food hooks installed")
    }

    private fun installAuditedHooks(
        classLoader: ClassLoader,
        packageName: String,
        processName: String,
        sourceApk: File?,
    ) {
        val auditedApk = try {
            FoodTaoDeadlineHooks.verifyAuditedFoodApk(sourceApk)
        } catch (error: Throwable) {
            Log.e(TAG, "  Food APK verification failed; keeping stock deadlines", error)
            null
        }
        if (auditedApk == null) {
            Log.e(TAG, "  Food audited hooks refused: stock APK identity did not match")
            return
        }
        installContained("Food Tao deadline") {
            FoodTaoDeadlineHooks.installAudited(
                classLoader,
                packageName,
                processName,
                auditedApk,
            )
        }
        installContained("Food round-trip evidence") {
            FoodRoundTripEvidenceHooks.installAudited(
                classLoader,
                packageName,
                processName,
                auditedApk,
            )
        }
    }

    private inline fun installContained(name: String, install: () -> Unit) {
        try {
            install()
        } catch (error: Throwable) {
            Log.e(TAG, "  $name hook failed; continuing with remaining Food hooks", error)
        }
    }
}
