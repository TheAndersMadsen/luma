package com.penumbraos.hook

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.telephony.TelephonyManager
import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Field

/** Truthful cellular status for replacement SIMs that do not publish an MSISDN. */
object CellularSettingsCompatibilityHooks {
    private const val TAG = "PenumbraCarrier"
    private const val CELL_SETTINGS_CLASS =
        "humane.experience.settings.ui.cellular.CellSettingsViewController"

    internal fun lineNumberStatus(
        carrierNumber: String?,
        hasValidatedCellular: Boolean,
    ): String? {
        if (!carrierNumber.isNullOrBlank()) return null
        return if (hasValidatedCellular) "LTE connected" else "number unavailable"
    }

    internal fun carrierNameOrFallback(
        stockCarrierName: String?,
        networkOperatorName: String?,
        simOperatorName: String?,
    ): String = sequenceOf(stockCarrierName, networkOperatorName, simOperatorName)
        .mapNotNull { value -> value?.trim()?.takeIf(String::isNotEmpty) }
        .firstOrNull()
        ?: "mobile network"

    fun install(cl: ClassLoader) {
        try {
            val controllerClass = cl.loadClass(CELL_SETTINGS_CLASS)
            val updateMethod = controllerClass.declaredMethods.singleOrNull { method ->
                method.name == "update" && method.parameterCount == 1
            } ?: run {
                Log.w(TAG, "Cellular Settings update hook is unavailable")
                return
            }
            updateMethod.isAccessible = true
            XposedBridge.hookMethod(updateMethod, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    runCatching { updateDisplay(param.thisObject, param.args.getOrNull(0)) }
                        .onFailure { error ->
                            Log.w(TAG, "Cellular Settings compatibility update failed", error)
                        }
                }
            })
            Log.w(TAG, "  Hooked replacement-carrier status in Cellular Settings")
        } catch (error: Throwable) {
            Log.w(TAG, "  Cellular Settings compatibility hook unavailable", error)
        }
    }

    private fun updateDisplay(controller: Any?, dataComponentInfo: Any?) {
        if (controller == null || dataComponentInfo == null) return
        val context = currentApplication() ?: return
        val carrierNumber = callString(dataComponentInfo, "phoneNumber")
        val numberStatus = lineNumberStatus(carrierNumber, hasValidatedCellular(context))
        val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        val carrierName = carrierNameOrFallback(
            stockCarrierName = readField(controller, "mCarrier") as? String,
            networkOperatorName = runCatching { telephonyManager?.networkOperatorName }.getOrNull(),
            simOperatorName = runCatching { telephonyManager?.simOperatorName }.getOrNull(),
        )

        var changed = false
        if (numberStatus != null && readField(controller, "mPhoneNumber") != numberStatus) {
            writeField(controller, "mPhoneNumber", numberStatus)
            changed = true
        }
        if (readField(controller, "mCarrier") != carrierName) {
            writeField(controller, "mCarrier", carrierName)
            changed = true
        }
        if (changed) reloadList(controller)
    }

    @Suppress("DEPRECATION")
    private fun hasValidatedCellular(context: Context): Boolean {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        return runCatching {
            connectivity.allNetworks.any { network ->
                val capabilities = connectivity.getNetworkCapabilities(network) ?: return@any false
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            }
        }.getOrDefault(false)
    }

    private fun currentApplication(): Application? = runCatching {
        Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Application
    }.getOrNull()

    private fun callString(target: Any, methodName: String): String? = runCatching {
        target.javaClass.getMethod(methodName).invoke(target) as? String
    }.getOrNull()

    private fun readField(target: Any, name: String): Any? = runCatching {
        findField(target.javaClass, name)?.get(target)
    }.getOrNull()

    private fun writeField(target: Any, name: String, value: Any?) {
        findField(target.javaClass, name)?.set(target, value)
    }

    private fun findField(type: Class<*>, name: String): Field? {
        var current: Class<*>? = type
        while (current != null) {
            runCatching { current.getDeclaredField(name) }.getOrNull()?.let { field ->
                field.isAccessible = true
                return field
            }
            current = current.superclass
        }
        return null
    }

    private fun reloadList(controller: Any) {
        val provider = readField(controller, "mListViewModelProvider") ?: return
        provider.javaClass.methods.firstOrNull { method ->
            method.name == "reload" && method.parameterCount == 0
        }?.invoke(provider)
    }
}
