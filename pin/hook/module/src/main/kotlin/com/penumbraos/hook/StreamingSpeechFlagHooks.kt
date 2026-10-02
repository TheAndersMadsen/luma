package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Field
import java.lang.reflect.Method

/**
 * Repairs stock's disabled streaming-TTS fallthrough without changing its
 * enabled path.
 *
 * The installed AIBusService reports the intended disabled error but then
 * continues into the gRPC stub. This exact-signature before-hook re-reads both
 * stock flags for every invocation, stops the void method before notifying the
 * observer once, and otherwise leaves the original request and observer alone.
 */
object StreamingSpeechFlagHooks {
    private const val TAG = "LumaCompatibility"
    private const val AIBUS_SERVICE = "humaneinternal.system.aibus.AIBusService"
    private const val TTS_REQUEST = TierASymbols.ProtoKids.TEXT_TO_SPEECH_REQUEST
    private const val STREAM_OBSERVER = "io.grpc.stub.StreamObserver"
    private const val FEATURE_MANAGER = "humaneinternal.featureflag.FeatureFlagManager"
    private const val FLAG_ASSIGNMENT = "humane.featureflag.FeatureFlagAssignment"
    private const val STREAMING_FEATURE = "SERVER_SPEECH_SYNTHESIS_STREAMING_ENABLED"
    private const val TIMEOUT_FEATURE = "SERVER_SPEECH_SYNTHESIS_TIMEOUT_MILLIS"
    private const val BOOLEAN_FLAG_TYPE: Byte = 0
    private const val INTEGER_FLAG_TYPE: Byte = 2
    internal const val DISABLED_ERROR_MESSAGE = "Streaming server TTS is disabled!"

    fun install(classLoader: ClassLoader) {
        try {
            val serviceClass = classLoader.loadClass(AIBUS_SERVICE)
            val requestClass = classLoader.loadClass(TTS_REQUEST)
            val observerClass = classLoader.loadClass(STREAM_OBSERVER)
            val streamingTextToSpeech = serviceClass.getDeclaredMethod(
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAMING_TEXT_TO_SPEECH,
                requestClass,
                observerClass,
            ).apply { isAccessible = true }
            check(streamingTextToSpeech.returnType == Void.TYPE) {
                "unexpected StreamingTextToSpeech return type"
            }
            val observerOnError = observerClass.getMethod(
                TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_ERROR,
                Throwable::class.java,
            ).apply { isAccessible = true }
            check(observerOnError.returnType == Void.TYPE) {
                "unexpected StreamObserver.onError return type"
            }
            val liveFlags = LiveStreamingSpeechFlags.create(classLoader)

            XposedBridge.hookMethod(streamingTextToSpeech, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val disabledError = disabledStreamingError(
                        liveFlags::timeoutMillis,
                        liveFlags::streamingEnabled,
                    ) ?: return

                    // Setting the result of this void method prevents the stock
                    // body from invoking gRPC, even if observer notification fails.
                    param.result = null
                    val observer = param.args.getOrNull(1)
                    if (observer == null || !observerClass.isInstance(observer)) {
                        Log.e(TAG, "  Streaming speech disabled without a valid observer")
                        return
                    }
                    notifyDisabledOnce(disabledError) { error ->
                        observerOnError.invoke(observer, error)
                    }
                }
            })
            Log.w(TAG, "  StreamingSpeechFlagHooks installed on exact stock AIBus method")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "  StreamingSpeechFlagHooks install failed: ${error.javaClass.simpleName}",
            )
        }
    }

    /** Null means stock must run untouched, including when either live read is unknown. */
    internal fun disabledStreamingError(
        readTimeoutMillis: () -> Int,
        readStreamingEnabled: () -> Boolean,
    ): Throwable? {
        val knownDisabled = runCatching {
            // Match stock's read order and intercept only its exact, positively
            // known disabled condition. Reflection and Binder failures delegate.
            val timeoutMillis = readTimeoutMillis()
            val streamingEnabled = readStreamingEnabled()
            !streamingEnabled || timeoutMillis == 0
        }.getOrDefault(false)
        return if (knownDisabled) Throwable(DISABLED_ERROR_MESSAGE) else null
    }

    internal data class RawFlagAssignment(
        val key: String?,
        val type: Byte?,
        val value: String?,
    )

    internal fun parseTimeoutAssignment(
        expectedKey: String,
        assignment: RawFlagAssignment?,
    ): Int? {
        if (assignment?.key != expectedKey || assignment.type != INTEGER_FLAG_TYPE) return null
        return assignment.value?.toIntOrNull()
    }

    internal fun parseStreamingEnabledAssignment(
        expectedKey: String,
        assignment: RawFlagAssignment?,
    ): Boolean? {
        if (assignment?.key != expectedKey || assignment.type != BOOLEAN_FLAG_TYPE) return null
        return when (assignment.value) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }

    /** Attempts exactly one observer notification for a disabled invocation. */
    internal fun notifyDisabledOnce(
        error: Throwable?,
        notify: (Throwable) -> Unit,
    ): Boolean {
        error ?: return false
        runCatching { notify(error) }
        return true
    }

    private class LiveStreamingSpeechFlags private constructor(
        private val sharedInstance: Method?,
        private val getFlagAssignment: Method?,
        private val featureKey: Method?,
        private val assignmentClass: Class<*>?,
        private val assignmentKey: Field?,
        private val assignmentType: Field?,
        private val assignmentValue: Field?,
        private val timeoutFeature: Any?,
        private val streamingFeature: Any?,
    ) {
        fun timeoutMillis(): Int {
            val feature = timeoutFeature ?: throw IllegalStateException("missing timeout feature")
            val (expectedKey, assignment) = readAssignment(feature)
            return parseTimeoutAssignment(expectedKey, assignment)
                ?: throw IllegalStateException("invalid timeout assignment")
        }

        fun streamingEnabled(): Boolean {
            val feature = streamingFeature
                ?: throw IllegalStateException("missing streaming feature")
            val (expectedKey, assignment) = readAssignment(feature)
            return parseStreamingEnabledAssignment(expectedKey, assignment)
                ?: throw IllegalStateException("invalid streaming assignment")
        }

        private fun readAssignment(feature: Any): Pair<String, RawFlagAssignment> {
            val shared = sharedInstance ?: throw IllegalStateException("missing shared manager")
            val getter = getFlagAssignment
                ?: throw IllegalStateException("missing raw flag getter")
            val keyGetter = featureKey ?: throw IllegalStateException("missing feature key getter")
            val expectedKey = keyGetter.invoke(feature) as? String
                ?: throw IllegalStateException("invalid feature key")
            val manager = shared.invoke(null)
                ?: throw IllegalStateException("missing manager instance")
            val raw = getter.invoke(manager, expectedKey)
                ?: throw IllegalStateException("missing flag assignment")
            val expectedClass = assignmentClass
                ?: throw IllegalStateException("missing assignment class")
            if (!expectedClass.isInstance(raw)) {
                throw IllegalStateException("unexpected flag assignment class")
            }
            val keyField = assignmentKey ?: throw IllegalStateException("missing assignment key")
            val typeField = assignmentType ?: throw IllegalStateException("missing assignment type")
            val valueField = assignmentValue
                ?: throw IllegalStateException("missing assignment value")
            val rawType = typeField.get(raw) as? Byte
                ?: throw IllegalStateException("invalid assignment type")
            return expectedKey to RawFlagAssignment(
                key = keyField.get(raw) as? String,
                type = rawType,
                value = valueField.get(raw) as? String,
            )
        }

        companion object {
            fun create(classLoader: ClassLoader): LiveStreamingSpeechFlags = try {
                val managerClass = classLoader.loadClass(FEATURE_MANAGER)
                val featureClass = classLoader.loadClass("$FEATURE_MANAGER\$Feature")
                val assignmentClass = classLoader.loadClass(FLAG_ASSIGNMENT)
                val sharedInstance = managerClass.getDeclaredMethod(
                    "sharedInstance",
                ).apply { isAccessible = true }
                val getFlagAssignment = managerClass.getDeclaredMethod(
                    "getFlagAssignment",
                    String::class.java,
                ).apply { isAccessible = true }
                val featureKey = featureClass.getDeclaredMethod("key").apply {
                    isAccessible = true
                }
                val assignmentKey = assignmentClass.getField("key")
                val assignmentType = assignmentClass.getField("type")
                val assignmentValue = assignmentClass.getField("value")
                val timeoutFeature = featureClass.getDeclaredField(
                    TIMEOUT_FEATURE,
                ).apply { isAccessible = true }.get(null)
                val streamingFeature = featureClass.getDeclaredField(
                    STREAMING_FEATURE,
                ).apply { isAccessible = true }.get(null)
                LiveStreamingSpeechFlags(
                    sharedInstance,
                    getFlagAssignment,
                    featureKey,
                    assignmentClass,
                    assignmentKey,
                    assignmentType,
                    assignmentValue,
                    timeoutFeature,
                    streamingFeature,
                )
            } catch (error: Throwable) {
                Log.e(
                    TAG,
                    "  Streaming speech live flag reader unavailable: ${error.javaClass.simpleName}",
                )
                LiveStreamingSpeechFlags(
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                )
            }
        }
    }
}
