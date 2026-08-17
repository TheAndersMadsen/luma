package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamingSpeechFlagHooksTest {
    @Test
    fun `same live gate follows false true false and reports disabled exactly once`() {
        val enabled = AtomicBoolean(false)
        val timeoutMillis = AtomicInteger(5_000)
        val timeoutReads = AtomicInteger(0)
        val enabledReads = AtomicInteger(0)
        val disabledErrors = mutableListOf<Throwable>()
        var providerCalls = 0

        fun invoke() {
            val error = StreamingSpeechFlagHooks.disabledStreamingError(
                {
                    timeoutReads.incrementAndGet()
                    timeoutMillis.get()
                },
                {
                    enabledReads.incrementAndGet()
                    enabled.get()
                },
            )
            if (
                StreamingSpeechFlagHooks.notifyDisabledOnce(
                    error,
                    disabledErrors::add,
                )
            ) {
                return
            }
            providerCalls++
        }

        invoke()
        assertEquals(1, disabledErrors.size)
        assertEquals(0, providerCalls)

        enabled.set(true)
        invoke()
        assertEquals(1, disabledErrors.size)
        assertEquals(1, providerCalls)

        enabled.set(false)
        invoke()
        assertEquals(2, disabledErrors.size)
        assertEquals(1, providerCalls)
        assertEquals(3, timeoutReads.get())
        assertEquals(3, enabledReads.get())
        disabledErrors.forEach { error ->
            assertEquals(Throwable::class.java, error.javaClass)
            assertEquals(StreamingSpeechFlagHooks.DISABLED_ERROR_MESSAGE, error.message)
        }
    }

    @Test
    fun `only exact known stock-disabled values intercept and read failures delegate`() {
        val zeroTimeout = StreamingSpeechFlagHooks.disabledStreamingError(
            { 0 },
            { true },
        )
        assertEquals(StreamingSpeechFlagHooks.DISABLED_ERROR_MESSAGE, zeroTimeout?.message)

        for (timeout in listOf(-1, Int.MIN_VALUE)) {
            assertNull(
                StreamingSpeechFlagHooks.disabledStreamingError(
                    { timeout },
                    { true },
                ),
            )
        }

        val knownDisabledWithNegativeTimeout = StreamingSpeechFlagHooks.disabledStreamingError(
            { -1 },
            { false },
        )
        assertEquals(
            StreamingSpeechFlagHooks.DISABLED_ERROR_MESSAGE,
            knownDisabledWithNegativeTimeout?.message,
        )

        var enabledReads = 0
        val timeoutFailure = StreamingSpeechFlagHooks.disabledStreamingError(
            { throw IllegalStateException("feature service unavailable") },
            {
                enabledReads++
                true
            },
        )
        assertNull(timeoutFailure)
        assertEquals(0, enabledReads)

        val enabledFailure = StreamingSpeechFlagHooks.disabledStreamingError(
            { 5_000 },
            { throw IllegalStateException("feature service unavailable") },
        )
        assertNull(enabledFailure)
    }

    @Test
    fun `raw flag assignments require exact key type and value`() {
        val timeoutKey = "server_side_speech_synthesis_timeout_millis"
        val enabledKey = "server_side_speech_synthesis_streaming_enabled"

        assertEquals(
            5_000,
            StreamingSpeechFlagHooks.parseTimeoutAssignment(
                timeoutKey,
                StreamingSpeechFlagHooks.RawFlagAssignment(timeoutKey, 2, "5000"),
            ),
        )
        assertEquals(
            true,
            StreamingSpeechFlagHooks.parseStreamingEnabledAssignment(
                enabledKey,
                StreamingSpeechFlagHooks.RawFlagAssignment(enabledKey, 0, "true"),
            ),
        )
        assertEquals(
            false,
            StreamingSpeechFlagHooks.parseStreamingEnabledAssignment(
                enabledKey,
                StreamingSpeechFlagHooks.RawFlagAssignment(enabledKey, 0, "false"),
            ),
        )

        assertNull(StreamingSpeechFlagHooks.parseTimeoutAssignment(timeoutKey, null))
        assertNull(
            StreamingSpeechFlagHooks.parseTimeoutAssignment(
                timeoutKey,
                StreamingSpeechFlagHooks.RawFlagAssignment("wrong", 2, "5000"),
            ),
        )
        assertNull(
            StreamingSpeechFlagHooks.parseTimeoutAssignment(
                timeoutKey,
                StreamingSpeechFlagHooks.RawFlagAssignment(timeoutKey, 0, "5000"),
            ),
        )
        for (value in listOf(null, "", " 5000", "5000 ", "5_000", "5.0")) {
            assertNull(
                StreamingSpeechFlagHooks.parseTimeoutAssignment(
                    timeoutKey,
                    StreamingSpeechFlagHooks.RawFlagAssignment(timeoutKey, 2, value),
                ),
            )
        }
        assertNull(
            StreamingSpeechFlagHooks.parseStreamingEnabledAssignment(
                enabledKey,
                StreamingSpeechFlagHooks.RawFlagAssignment("wrong", 0, "true"),
            ),
        )
        assertNull(
            StreamingSpeechFlagHooks.parseStreamingEnabledAssignment(
                enabledKey,
                StreamingSpeechFlagHooks.RawFlagAssignment(enabledKey, 2, "true"),
            ),
        )
        for (value in listOf(null, "", "TRUE", "False", "1", "0", " true")) {
            assertNull(
                StreamingSpeechFlagHooks.parseStreamingEnabledAssignment(
                    enabledKey,
                    StreamingSpeechFlagHooks.RawFlagAssignment(enabledKey, 0, value),
                ),
            )
        }
    }

    @Test
    fun `enabled positive call delegates untouched and observer failure still short circuits`() {
        val request = Any()
        val observer = Any()
        var delegatedRequest: Any? = null
        var delegatedObserver: Any? = null
        var notifications = 0

        val enabledError = StreamingSpeechFlagHooks.disabledStreamingError(
            { 5_000 },
            { true },
        )
        assertFalse(
            StreamingSpeechFlagHooks.notifyDisabledOnce(enabledError) {
                notifications++
            },
        )
        if (enabledError == null) {
            delegatedRequest = request
            delegatedObserver = observer
        }
        assertNull(enabledError)
        assertSame(request, delegatedRequest)
        assertSame(observer, delegatedObserver)
        assertEquals(0, notifications)

        val disabledError = StreamingSpeechFlagHooks.disabledStreamingError(
            { 5_000 },
            { false },
        )
        assertTrue(
            StreamingSpeechFlagHooks.notifyDisabledOnce(disabledError) {
                notifications++
                throw IllegalStateException("observer rejected callback")
            },
        )
        assertEquals(1, notifications)
    }

    @Test
    fun `source hooks only exact speech signature and preserves other Ironman hooks`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/StreamingSpeechFlagHooks.kt",
        ).readText()
        val ironman = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()

        assertTrue(source.contains("humaneinternal.system.aibus.AIBusService"))
        assertEquals(
            "humane.aibus.TextToSpeechRequest",
            TierASymbols.ProtoKids.TEXT_TO_SPEECH_REQUEST,
        )
        assertTrue(
            source.contains("TierASymbols.ProtoKids.TEXT_TO_SPEECH_REQUEST"),
        )
        assertTrue(source.contains("io.grpc.stub.StreamObserver"))
        assertEquals(
            "streamingTextToSpeech",
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAMING_TEXT_TO_SPEECH,
        )
        assertTrue(
            source.contains(
                "TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAMING_TEXT_TO_SPEECH,",
            ),
        )
        assertEquals(
            "onError",
            TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_ERROR,
        )
        assertTrue(
            source.contains("TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_ERROR,"),
        )
        assertTrue(source.contains("Throwable::class.java"))
        assertTrue(source.contains("streamingTextToSpeech.returnType == Void.TYPE"))
        assertTrue(source.contains("observerOnError.returnType == Void.TYPE"))
        assertTrue(source.contains("SERVER_SPEECH_SYNTHESIS_STREAMING_ENABLED"))
        assertTrue(source.contains("SERVER_SPEECH_SYNTHESIS_TIMEOUT_MILLIS"))
        assertTrue(source.contains("\"getFlagAssignment\""))
        assertTrue(source.contains("String::class.java"))
        assertTrue(source.contains("\"key\""))
        assertFalse(source.contains("\"getIntValue\""))
        assertFalse(source.contains("\"getBoolValue\""))
        assertTrue(source.contains("param.result = null"))
        assertEquals(1, Regex("observerOnError\\.invoke\\(").findAll(source).count())
        assertEquals(1, Regex("XposedBridge\\.hookMethod\\(").findAll(source).count())
        assertEquals(
            1,
            Regex("StreamingSpeechFlagHooks\\.install\\(cl\\)").findAll(ironman).count(),
        )
        assertTrue(ironman.contains("TickleIntentCompatibilityHooks.install(cl)"))

        assertFalse(source.contains("hookAllMethods"))
        assertFalse(source.contains("setServerFlags"))
        assertFalse(source.contains("sendBroadcast"))
        assertFalse(source.contains("android.provider.Settings"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
