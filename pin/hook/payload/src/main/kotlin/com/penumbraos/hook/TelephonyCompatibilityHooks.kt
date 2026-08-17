package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * Compatibility fixes for stock telephony experiences on carrier profiles
 * that do not publish their own line number through TelephonyManager.
 */
object TelephonyCompatibilityHooks {
    private const val TAG = "PenumbraTelephony"
    private const val LOCAL_HOST_ADDRESS = "penumbra-self"

    fun hostAddressOrFallback(carrierAddress: String?): String =
        carrierAddress?.takeIf { it.isNotBlank() } ?: LOCAL_HOST_ADDRESS

    fun install(cl: ClassLoader) {
        try {
            val clazz = cl.loadClass("humane.system.TelephonyServices")
            val method = clazz.getDeclaredMethod("getNormalizedHostNumber").apply {
                isAccessible = true
            }

            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    val original = param.result as? String
                    val resolved = hostAddressOrFallback(original)
                    if (resolved != original) {
                        param.result = resolved
                        Log.w(TAG, "Carrier omitted the line number; using a local Messages identity")
                    }
                }
            })
            Log.w(TAG, "  Hooked TelephonyServices.getNormalizedHostNumber()")
        } catch (t: Throwable) {
            Log.w(TAG, "  Telephony host identity hook unavailable: ${t.message}")
        }
    }
}
