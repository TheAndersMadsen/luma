package com.penumbraos.hook

import android.util.Log

/** Clone transport for stock onboarding without any OPAQUE or DAC bypass. */
internal object CarryOnboardingTransportHooks {
    fun install(classLoader: ClassLoader) {
        Log.w(HookComponentFactory.TAG, "Installing stock onboarding clone transport")
        ChannelFactoryBypass.installRemoteOnly(classLoader)
        CarryOnboardingAutomation.install(classLoader)
    }
}
