package com.penumbraos.hook

import android.app.Application
import android.net.Uri
import android.os.IBinder
import android.util.Log
import com.penumbraos.stockaibus.contract.StockAiBusContract
import com.penumbraos.stockaibus.contract.StockAiBusDelegatingBinder
import com.penumbraos.stockaibus.contract.TierASymbols
import java.lang.reflect.Proxy
import java.util.Collections
import java.util.WeakHashMap

/** Installs selected local AI Bus calls at stock `AiBridge.installAiBus`. */
object StockAiBusBridgeInstallHooks {
    private const val TAG = "PenumbraHook"
    internal const val PROVIDER_URI = "content://com.penumbraos.server.grpcauth"
    internal const val PROVIDER_METHOD = "GET_AIBUS_BRIDGE"
    internal const val PROVIDER_RESULT = "binder"
    internal const val TRANSACTION_SYNAPSE_UNDERSTANDING =
        StockAiBusContract.TRANSACTION_SYNAPSE_UNDERSTANDING
    internal const val TRANSACTION_ENCRYPTED_NEARBY_SEARCH =
        TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_NEARBY_SEARCH
    private val LOCAL_TRANSACTION_CODES = setOf(
        TRANSACTION_SYNAPSE_UNDERSTANDING,
        TRANSACTION_ENCRYPTED_NEARBY_SEARCH,
    )

    private val installedClassLoaders = Collections.synchronizedSet(
        Collections.newSetFromMap(WeakHashMap<ClassLoader, Boolean>()),
    )

    fun install(classLoader: ClassLoader) {
        if (!installedClassLoaders.add(classLoader)) return
        try {
            val aiBridgeClass = classLoader.loadClass("humaneinternal.system.coordination.AiBridge")
            val aiBusInterface =
                classLoader.loadClass(TierASymbols.Binder.AiBusBridge.DESCRIPTOR)
            val asBinder = aiBusInterface.getMethod("asBinder")
            HookUtils.hookMethodBefore(
                aiBridgeClass,
                "installAiBus",
                arrayOf(aiBusInterface),
            ) { param ->
                val original = param.args.getOrNull(0) ?: return@hookMethodBefore
                val originalBinder = asBinder.invoke(original) as? IBinder
                    ?: return@hookMethodBefore
                val bridgeBinder = StockAiBusDelegatingBinder(
                    original = originalBinder,
                    localBinder = ::fetchReadyLocalBinder,
                    localTransactionCodes = LOCAL_TRANSACTION_CODES,
                )
                param.args[0] = Proxy.newProxyInstance(
                    aiBusInterface.classLoader,
                    arrayOf(aiBusInterface),
                ) { proxy, method, args ->
                    when (method.name) {
                        "asBinder" -> bridgeBinder
                        "toString" -> "PenumbraDelegatingAiBusBridge"
                        "hashCode" -> System.identityHashCode(proxy)
                        "equals" -> proxy === args?.getOrNull(0)
                        else -> method.invoke(original, *(args ?: emptyArray()))
                    }
                }
                Log.w(
                    TAG,
                    "  Installed stock IAiBusBridge delegator; Understand and Nearby are local when ready",
                )
            }
        } catch (error: Throwable) {
            installedClassLoaders.remove(classLoader)
            Log.e(TAG, "  Failed to install stock IAiBusBridge delegator", error)
        }
    }

    internal fun shouldUseLocalTransaction(code: Int, localReady: Boolean): Boolean =
        localReady && code in LOCAL_TRANSACTION_CODES

    private fun fetchReadyLocalBinder(): IBinder? = runCatching {
        val application = currentApplication()
        application.contentResolver.call(
            Uri.parse(PROVIDER_URI),
            PROVIDER_METHOD,
            null,
            null,
        )?.getBinder(PROVIDER_RESULT)
    }.getOrNull()

    private fun currentApplication(): Application {
        val activityThread = Class.forName("android.app.ActivityThread")
        return activityThread.getDeclaredMethod("currentApplication").invoke(null) as? Application
            ?: throw IllegalStateException("Application context is not attached")
    }
}
