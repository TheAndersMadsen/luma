package com.penumbraos.hook

import android.util.Log

/**
 * Prevent Datadog SDK initialization in ironman.
 */
object DatadogBypass {

    private const val TAG = "PenumbraHook"

    fun install(cl: ClassLoader) {
        val className = "humaneinternal.system.utils.DatadogManager"
        val clazz = try {
            cl.loadClass(className)
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $className not found, skipping Datadog bypass")
            return
        }

        // DatadogManager.initialize(Context, DatadogConfiguration, String)
        // DatadogConfiguration is an inner class of DatadogManager.
        val configClass = try {
            cl.loadClass("$className\$DatadogConfiguration")
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $className\$DatadogConfiguration not found, skipping Datadog bypass")
            return
        }

        HookUtils.hookMethodBefore(
            clazz,
            "initialize",
            arrayOf(android.content.Context::class.java, configClass, String::class.java),
        ) { param ->
            param.result = null  // short-circuit: void method, return immediately
            Log.w(TAG, "  DatadogManager.initialize() blocked")
        }

        Log.w(TAG, "  Datadog bypass installed")
    }
}
