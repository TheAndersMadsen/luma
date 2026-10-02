package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method

/**
 * Makes disabling stock transcription-audio attachment immediately revoking.
 *
 * The installed AndroidTranscriber snapshots SERVER_TRANSCRIPTION_SAVE_ENABLED
 * at start(), then conditionally calls TranscriptionResponse.Builder.setAudioData
 * from RecognitionListener.onResults(). A true-to-false change during an active
 * utterance can therefore otherwise attach the captured PCM after the new flag
 * snapshot has been applied. This hook re-reads the Binder-backed flag only at
 * that exact attachment boundary. The enabled path and null/clear calls remain
 * stock-owned and untouched.
 */
object TranscriptionSaveFlagHooks {
    private const val TAG = "LumaCompatibility"
    private const val RESPONSE_BUILDER =
        "humane.system.transcription.TranscriptionResponse\$Builder"
    private const val FEATURE_MANAGER = "humaneinternal.featureflag.FeatureFlagManager"
    private const val TRANSCRIPTION_SAVE_FEATURE = "SERVER_TRANSCRIPTION_SAVE_ENABLED"

    fun install(classLoader: ClassLoader) {
        try {
            val builderClass = classLoader.loadClass(RESPONSE_BUILDER)
            val setAudioData = builderClass.getDeclaredMethod(
                "setAudioData",
                ByteArray::class.java,
            ).apply { isAccessible = true }
            check(setAudioData.returnType == builderClass) {
                "unexpected TranscriptionResponse.Builder.setAudioData return type"
            }
            val liveFlag = LiveTranscriptionSaveFlag.create(classLoader)

            XposedBridge.hookMethod(setAudioData, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val audio = param.args.getOrNull(0) as? ByteArray ?: return
                    if (shouldSkipAudioAttachment(audio, liveFlag::enabled)) {
                        // The installed setter returns this Builder. Returning the
                        // receiver skips only this attachment without passing null,
                        // copying/mutating PCM, or changing the surrounding result.
                        param.result = param.thisObject
                    }
                }
            })
            Log.w(TAG, "  TranscriptionSaveFlagHooks installed on exact audio attachment setter")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "  TranscriptionSaveFlagHooks install failed: ${error.javaClass.simpleName}",
            )
        }
    }

    /** True means skip only setAudioData and return its Builder receiver. */
    internal fun shouldSkipAudioAttachment(
        audio: ByteArray?,
        readEnabled: () -> Boolean,
    ): Boolean {
        // A null call is the stock clear contract and must always delegate. A
        // non-null attachment fails closed when the live Binder read is missing,
        // malformed, or throws.
        if (audio == null) return false
        return !runCatching(readEnabled).getOrDefault(false)
    }

    private class LiveTranscriptionSaveFlag private constructor(
        private val sharedInstance: Method?,
        private val getBoolValue: Method?,
        private val feature: Any?,
    ) {
        fun enabled(): Boolean {
            val shared = sharedInstance
                ?: throw IllegalStateException("missing shared feature manager")
            val getter = getBoolValue
                ?: throw IllegalStateException("missing transcription-save getter")
            val flag = feature
                ?: throw IllegalStateException("missing transcription-save feature")
            val manager = shared.invoke(null)
                ?: throw IllegalStateException("missing feature manager instance")
            return getter.invoke(manager, flag) as? Boolean
                ?: throw IllegalStateException("invalid transcription-save value")
        }

        companion object {
            fun create(classLoader: ClassLoader): LiveTranscriptionSaveFlag = try {
                val managerClass = classLoader.loadClass(FEATURE_MANAGER)
                val featureClass = classLoader.loadClass("$FEATURE_MANAGER\$Feature")
                val sharedInstance = managerClass.getDeclaredMethod(
                    "sharedInstance",
                ).apply { isAccessible = true }
                val getBoolValue = managerClass.getDeclaredMethod(
                    "getBoolValue",
                    featureClass,
                ).apply { isAccessible = true }
                val feature = featureClass.getDeclaredField(
                    TRANSCRIPTION_SAVE_FEATURE,
                ).apply { isAccessible = true }.get(null)
                LiveTranscriptionSaveFlag(sharedInstance, getBoolValue, feature)
            } catch (error: Throwable) {
                Log.e(
                    TAG,
                    "  Transcription-save live flag reader unavailable: ${error.javaClass.simpleName}",
                )
                LiveTranscriptionSaveFlag(null, null, null)
            }
        }
    }
}
