package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * Block Microsoft Cognitive Services Speech SDK telemetry.
 *
 * The embedded TTS engine (HumaneTTSService -> EmbeddedSpeechConfig) triggers
 * TelemetryManager.getSingleton() on every config creation. The singleton's
 * constructor loads libMicrosoft.CognitiveServices.Speech.extension.telemetry.so
 * and creates an HttpClient that phones home to mobile.events.data.microsoft.com
 * via the 1DS (One Data Strategy) protocol.
 */
object MsTelemetryBypass {

    private const val TAG = "PenumbraHook"

    fun install(cl: ClassLoader) {
        val className = "com.microsoft.cognitiveservices.speech.util.TelemetryManager"
        val clazz = try {
            cl.loadClass(className)
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $className not found, skipping MS telemetry bypass")
            return
        }

        // Pre-populate the static volatile `singleton` field with a dummy instance
        // so getSingleton() never enters the synchronized init block.
        try {
            val singletonField = clazz.getDeclaredField("singleton")
            singletonField.isAccessible = true

            // Allocate an instance without calling the constructor.
            // The constructor creates an HttpClient (which calls native createClientInstance()).
            // We want to skip all of that.
            val unsafeClass = Class.forName("sun.misc.Unsafe")
            val theUnsafe = unsafeClass.getDeclaredField("theUnsafe")
            theUnsafe.isAccessible = true
            val unsafe = theUnsafe.get(null)
            val allocateInstance = unsafeClass.getDeclaredMethod("allocateInstance", Class::class.java)
            val dummyInstance = allocateInstance.invoke(unsafe, clazz)

            singletonField.set(null, dummyInstance)
            Log.w(TAG, "  TelemetryManager.singleton pre-populated with dummy instance")
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to pre-populate TelemetryManager singleton: ${t.message}")
            Log.w(TAG, "  Falling back to hooking getSingleton()")
            installFallbackHook(clazz)
            return
        }

        // Belt-and-suspenders: also hook getSingleton() so if anything resets the
        // field, we still block the real initialization.
        try {
            val method = clazz.getDeclaredMethod("getSingleton")
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    // Return the current field value (our dummy) without entering
                    // the synchronized block that loads the native telemetry lib.
                    try {
                        val field = clazz.getDeclaredField("singleton")
                        field.isAccessible = true
                        val current = field.get(null)
                        if (current != null) {
                            param.result = current
                        }
                    } catch (_: Throwable) {
                        // If field access fails, let the original run — it will
                        // find the pre-populated singleton and return early anyway.
                    }
                }
            })
            Log.w(TAG, "  Hooked TelemetryManager.getSingleton() (belt-and-suspenders)")
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to hook getSingleton (non-fatal, field pre-population should suffice): ${t.message}")
        }

        Log.w(TAG, "  MS Speech SDK telemetry bypass installed")
    }

    /**
     * Fallback: if Unsafe allocation fails, hook getSingleton() to return a
     * bare Object cast — the return value is never meaningfully used by callers.
     */
    private fun installFallbackHook(clazz: Class<*>) {
        try {
            val method = clazz.getDeclaredMethod("getSingleton")
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                private var dummyInstance: Any? = null

                override fun beforeHookedMethod(param: MethodHookParam) {
                    if (dummyInstance == null) {
                        // First call: let it run to create the singleton normally,
                        // but we'll hook HttpClient to neuter it.
                        return
                    }
                    param.result = dummyInstance
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    if (dummyInstance == null && param.result != null) {
                        // Capture the first result so subsequent calls skip init
                        dummyInstance = param.result
                    }
                }
            })
            Log.w(TAG, "  Hooked TelemetryManager.getSingleton() (fallback mode)")

            // Also neuter HttpClient.createClientInstance() to prevent native init
            neuterHttpClient(clazz.classLoader!!)
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to install fallback MS telemetry hook: ${t.message}")
        }
    }

    /**
     * Hook HttpClient.createClientInstance() to no-op, preventing the native
     * telemetry transport from initializing.
     */
    private fun neuterHttpClient(cl: ClassLoader) {
        try {
            val httpClientClass = cl.loadClass("com.microsoft.cognitiveservices.speech.util.HttpClient")
            HookUtils.hookMethodBefore(
                httpClientClass,
                "createClientInstance",
                emptyArray(),
            ) { param ->
                param.result = null
                // Don't log on every call — this fires during construction
            }
            Log.w(TAG, "  Hooked HttpClient.createClientInstance() -> no-op")
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to hook HttpClient.createClientInstance(): ${t.message}")
        }
    }
}
