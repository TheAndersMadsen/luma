package com.penumbraos.hook.injector

import android.content.Context
import android.os.IBinder
import android.os.PersistableBundle

/**
 * Re-applies the replacement-carrier values from the supplied PenumbraOS
 * carrier override when Android's effective carrier configuration lacks them.
 */
internal object CarrierCompatibilityPolicy {
    val requiredOverrides: Map<String, Boolean> = linkedMapOf(
        "carrier_volte_available_bool" to true,
        "carrier_volte_provisioned_bool" to true,
        "carrier_volte_provisioning_required_bool" to false,
        "carrier_vt_available_bool" to true,
        "hide_carrier_network_settings_bool" to false,
    )

    fun needsRepair(effectiveConfig: Map<String, Boolean?>): Boolean =
        requiredOverrides.any { (key, required) -> effectiveConfig[key] != required }
}

internal object CarrierCompatibility {
    internal val workLock = Any()

    sealed interface Result {
        object NoActiveSubscription : Result
        object EffectiveConfigUnavailable : Result
        object AlreadyCompatible : Result
        data class Applied(val changedValueCount: Int) : Result
        data class Failed(val error: Throwable) : Result
    }

    fun repair(context: Context): Result {
        return try {
            val subscriptionId = defaultSubscriptionId()
            if (subscriptionId < 0) return Result.NoActiveSubscription

            val loader = carrierConfigLoader()
            val effectiveConfig = readEffectiveConfig(
                loader = loader,
                subscriptionId = subscriptionId,
                callingPackage = context.packageName,
            ) ?: return Result.EffectiveConfigUnavailable
            val effectiveValues = CarrierCompatibilityPolicy.requiredOverrides.keys.associateWith { key ->
                if (effectiveConfig.containsKey(key)) effectiveConfig.getBoolean(key) else null
            }
            if (!CarrierCompatibilityPolicy.needsRepair(effectiveValues)) {
                return Result.AlreadyCompatible
            }

            val overrides = PersistableBundle().apply {
                CarrierCompatibilityPolicy.requiredOverrides.forEach { (key, value) ->
                    putBoolean(key, value)
                }
            }
            val loaderClass = Class.forName(
                "com.android.internal.telephony.ICarrierConfigLoader",
            )
            val overrideConfig = loaderClass.getMethod(
                "overrideConfig",
                Int::class.javaPrimitiveType,
                PersistableBundle::class.java,
                Boolean::class.javaPrimitiveType,
            )
            val persistent = true
            overrideConfig.invoke(loader, subscriptionId, overrides, persistent)
            loaderClass.getMethod(
                "notifyConfigChangedForSubId",
                Int::class.javaPrimitiveType,
            ).invoke(loader, subscriptionId)
            Result.Applied(
                effectiveValues.count { (key, value) ->
                    value != CarrierCompatibilityPolicy.requiredOverrides.getValue(key)
                }
            )
        } catch (error: Throwable) {
            Result.Failed(error)
        }
    }

    private fun defaultSubscriptionId(): Int {
        val binder = service("isub")
        val stubClass = Class.forName("com.android.internal.telephony.ISub\$Stub")
        val subscriptionService = stubClass
            .getMethod("asInterface", IBinder::class.java)
            .invoke(null, binder)
        return Class.forName("com.android.internal.telephony.ISub")
            .getMethod("getDefaultSubId")
            .invoke(subscriptionService) as Int
    }

    private fun carrierConfigLoader(): Any {
        val binder = service("carrier_config")
        return Class.forName("com.android.internal.telephony.ICarrierConfigLoader\$Stub")
            .getMethod("asInterface", IBinder::class.java)
            .invoke(null, binder)
    }

    private fun readEffectiveConfig(
        loader: Any,
        subscriptionId: Int,
        callingPackage: String,
    ): PersistableBundle? {
        val loaderClass = Class.forName(
            "com.android.internal.telephony.ICarrierConfigLoader",
        )
        val withFeature = loaderClass.methods.firstOrNull { method ->
            method.name == "getConfigForSubIdWithFeature" && method.parameterCount == 3
        }
        if (withFeature != null) {
            return withFeature.invoke(
                loader,
                subscriptionId,
                callingPackage,
                null,
            ) as? PersistableBundle
        }
        val legacy = loaderClass.getMethod(
            "getConfigForSubId",
            Int::class.javaPrimitiveType,
            String::class.java,
        )
        return legacy.invoke(loader, subscriptionId, callingPackage) as? PersistableBundle
    }

    private fun service(name: String): IBinder {
        val binder = Class.forName("android.os.ServiceManager")
            .getMethod("getService", String::class.java)
            .invoke(null, name) as? IBinder
        return requireNotNull(binder) { "$name service is unavailable" }
    }
}
