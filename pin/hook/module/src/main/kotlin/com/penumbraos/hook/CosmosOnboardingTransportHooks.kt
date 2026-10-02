package com.penumbraos.hook

import android.util.Log

/** Clone transport for stock onboarding with OPAQUE and DAC behavior left unchanged. */
internal object CosmosOnboardingTransportHooks {
    fun install(classLoader: ClassLoader) {
        Log.w(HookComponentFactory.TAG, "Installing stock onboarding clone transport")
        runCatching { CosmosChannelRouting.install(classLoader) }.onFailure { error ->
            Log.e(
                HookComponentFactory.TAG,
                "Stock onboarding channel routing hook unavailable (${error.javaClass.simpleName})",
            )
        }
        CosmosOnboardingAutomation.install(classLoader)
    }
}
