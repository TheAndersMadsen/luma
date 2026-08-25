package com.penumbraos.hook

import android.util.Log

/** Clone transport for stock onboarding without any OPAQUE or DAC bypass. */
internal object CosmosOnboardingTransportHooks {
    fun install(classLoader: ClassLoader) {
        Log.w(HookComponentFactory.TAG, "Installing stock onboarding clone transport")
        ChannelFactoryBypass.install(classLoader)
        CosmosOnboardingAutomation.install(classLoader)
    }
}
