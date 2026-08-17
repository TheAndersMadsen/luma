package com.penumbraos.hook

import android.util.Log

/**
 * Restores the stock food experience's original local boundaries.
 *
 * Food runs in its own on-demand process. Its nested agent can be selected by
 * Ironman, but the actual GetFoodItem and Capture calls are created here, so
 * redirecting only Ironman leaves the final provider/storage calls pointed at
 * the retired Humane gateway. Food also uses ephemeral AIBus envelopes and an
 * exact FoodLog data-protection contract. Install only those known Food
 * boundaries; unrelated Krypton channels and protection domains remain stock.
 */
object FoodHooks {
    private const val TAG = "PenumbraHook"

    fun install(classLoader: ClassLoader) {
        Log.w(TAG, "Installing food hooks...")
        ChannelFactoryBypass.install(classLoader)
        EphemeralProtectionBypass.installFoodOnly(classLoader)
        DataProtectorBypass.installFoodOnly(classLoader)
        Log.w(TAG, "Food hooks installed")
    }
}
