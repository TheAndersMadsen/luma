package com.penumbraos.hook

import android.util.Log
import java.util.Collections
import java.util.WeakHashMap

/** Routes every stock cloud channel to the activated, operator-owned Cosmos edge. */
object CosmosChannelRouting {
    private const val TAG = "LumaCompatibility"

    private val installedClassLoaders = Collections.synchronizedSet(
        Collections.newSetFromMap(WeakHashMap<ClassLoader, Boolean>()),
    )

    private val channelFactoryClasses = listOf(
        "humaneinternal.system.network.ChannelFactory",
        "humane.grandcentral.network.ChannelFactory",
    )

    fun install(classLoader: ClassLoader) {
        if (!installedClassLoaders.add(classLoader)) return

        CosmosRemoteTransport.installDnsResolver(classLoader)
        CosmosRemoteTransport.installNetworkDnsResolver()
        CosmosRemoteTransport.installCloneAttestationIdentity(classLoader)

        var hooked = 0
        for (className in channelFactoryClasses) {
            val factory = try {
                classLoader.loadClass(className)
            } catch (_: ClassNotFoundException) {
                continue
            }
            try {
                factory.getDeclaredMethod("getGatewayUri").isAccessible = true
            } catch (_: NoSuchMethodException) {
                continue
            }

            val cloneTrustInstalled = CosmosRemoteTransport.installCloneTrust(factory)
            HookUtils.hookMethodAfter(factory, "getGatewayUri", emptyArray()) { param ->
                if (param.throwable != null) return@hookMethodAfter
                if (!CosmosRemoteTransport.isEnabled()) {
                    param.throwable = SecurityException(
                        "Cosmos activation is required before stock cloud services can connect",
                    )
                    return@hookMethodAfter
                }
                if (!cloneTrustInstalled) {
                    param.throwable = SecurityException("Cosmos trust is unavailable")
                    return@hookMethodAfter
                }
                val gateway = CosmosRemoteTransport.redirectedGatewayForCurrentProcess(
                    param.result as? String,
                )
                if (gateway == null) {
                    param.throwable = SecurityException("Cosmos refused a non-allowlisted gateway")
                    return@hookMethodAfter
                }
                param.result = gateway
                Log.w(TAG, "  ChannelFactory routed to Cosmos")
            }
            hooked++
        }

        if (hooked == 0) {
            installedClassLoaders.remove(classLoader)
            Log.w(TAG, "  No ChannelFactory classes found")
        }
    }
}
