package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import com.penumbraos.stockaibus.contract.StockAiBusContract
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * Privacy-preserving correlation logs for the physical vision gesture path.
 *
 * Logs contain only run ids, enum/state names, flags, and response byte counts.
 * They never include an utterance, image bytes, OCR text, or coordinates.
 */
object VisionTraceHooks {
    private const val TAG = "PenumbraVisionTrace"

    /**
     * Stock declares several `analyzeImage` overloads. The one we trace is
     * selected by argument count. Take that count from the contract rather than
     * hardcoding it, so a stock signature change is a contract update in one
     * place instead of a silently non-matching hook here.
     */
    private val analyzeImageArgumentCount: Int =
        StockAiBusContract.argumentCount(StockAiBusContract.TRANSACTION_ANALYZE_IMAGE) ?: 7

    fun install(cl: ClassLoader) {
        hookVoiceRequest(cl)
        hookAnalyzeImage(cl)
    }

    private fun hookVoiceRequest(cl: ClassLoader) {
        runCatching {
            val cls = cl.loadClass("humaneinternal.system.voice.client.VoiceManager")
            val method = cls.declaredMethods.firstOrNull {
                it.name == "understandRouteVoiceAction" && it.parameterTypes.size == 3
            } ?: return@runCatching
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val runId = (param.args.getOrNull(1) as? String).orEmpty().take(64)
                    val vision = (param.args.getOrNull(2) as? Enum<*>)?.name ?: "unknown"
                    Log.w(TAG, "voice_request run=$runId vision=$vision")
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) {
                        Log.w(TAG, "voice_request_failed type=${param.throwable.javaClass.simpleName}")
                    }
                }
            })
        }.onFailure {
            Log.w(TAG, "Voice request trace unavailable: ${it.javaClass.simpleName}")
        }
    }

    private fun hookAnalyzeImage(cl: ClassLoader) {
        runCatching {
            val cls = cl.loadClass("humaneinternal.system.aibus.AiBusBridge")
            val method = cls.declaredMethods.firstOrNull {
                it.name == TierASymbols.Binder.AiBusBridge.WIRE_NAME_ANALYZE_IMAGE &&
                    it.parameterTypes.size == analyzeImageArgumentCount
            } ?: return@runCatching
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val runId = (param.args.getOrNull(2) as? String).orEmpty().take(64)
                    val food = param.args.getOrNull(3) as? Boolean ?: false
                    val genericVision = !(param.args.getOrNull(4) as? Boolean ?: false)
                    Log.w(TAG, "analyze_image_start run=$runId food=$food generic=$genericVision")
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    val bytes = (param.result as? ByteArray)?.size ?: 0
                    val status = if (param.throwable == null) "ok" else "failed"
                    Log.w(TAG, "analyze_image_end status=$status response_bytes=$bytes")
                }
            })
        }.onFailure {
            Log.w(TAG, "AnalyzeImage trace unavailable: ${it.javaClass.simpleName}")
        }
    }
}
