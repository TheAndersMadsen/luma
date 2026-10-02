package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/** Keeps stock Respond serialization limited to its two model-facing fields. */
object RespondActionJsonCompatibilityHooks {
    private const val TAG = "LumaCompatibility"

    fun install(classLoader: ClassLoader) {
        try {
            val serializerClass = classLoader.loadClass(
                "humaneinternal.system.tao.ActionToJson",
            )
            val actionClass = classLoader.loadClass(
                "humaneinternal.system.intent.actions.Action",
            )
            val respondClass = classLoader.loadClass(
                "humaneinternal.system.intent.actions.system.RespondAction",
            )
            val jsonObjectClass = classLoader.loadClass("com.google.gson.JsonObject")
            val method = serializerClass.getDeclaredMethod(
                "toInputsObject",
                actionClass,
            ).apply { isAccessible = true }
            val request = respondClass.getMethod("request")
            val response = respondClass.getMethod("response")
            val jsonConstructor = jsonObjectClass.getConstructor()
            val addProperty = jsonObjectClass.getMethod(
                "addProperty",
                String::class.java,
                String::class.java,
            )

            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val action = param.args.getOrNull(0) ?: return
                    if (action.javaClass != respondClass) return

                    try {
                        val responseValue = response.invoke(action) as? String ?: return
                        val fields = projectInputs(
                            request = request.invoke(action) as? String,
                            response = responseValue,
                        )
                        val json = jsonConstructor.newInstance()
                        fields.forEach { (name, value) ->
                            addProperty.invoke(json, name, value)
                        }
                        param.result = json
                    } catch (error: Throwable) {
                        Log.e(
                            TAG,
                            "Respond action JSON projection failed: " +
                                error.javaClass.simpleName,
                        )
                    }
                }
            })
            Log.w(TAG, "  Respond action JSON compatibility installed")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "Respond action JSON compatibility install failed: " +
                    "${error.javaClass.simpleName}: ${error.message}",
            )
        }
    }

    internal fun projectInputs(request: String?, response: String): Map<String, String> =
        linkedMapOf<String, String>().apply {
            request?.let { put("Request", it) }
            put("Response", response)
        }
}
