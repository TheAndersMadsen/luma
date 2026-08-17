package com.penumbraos.hook

import java.io.File
import java.util.UUID
import java.util.regex.Pattern
import android.os.IBinder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FitnessHistoryHooksTest {
    @Test
    fun `fitness stream wire contract is pinned to server v2`() {
        assertEquals("com.penumbraos.server.fitness.bridge.v2", FitnessMirrorContract.BRIDGE_DESCRIPTOR)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION, FitnessMirrorContract.TRANSACTION_BEGIN)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION + 1, FitnessMirrorContract.TRANSACTION_FINISH)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION + 2, FitnessMirrorContract.TRANSACTION_ABORT)
        assertEquals(0x50464E32, FitnessMirrorContract.STREAM_MAGIC)
        assertEquals(1, FitnessMirrorContract.STREAM_VERSION)
        assertEquals(64 * 1024, FitnessMirrorContract.MAX_FRAME_BYTES)
        assertEquals(1, FitnessMirrorContract.FILE_ID_BY_NAME[FitnessMirrorContract.SUMMARY])
        assertEquals(2, FitnessMirrorContract.FILE_ID_BY_NAME[FitnessMirrorContract.LOCATION])
        assertEquals(3, FitnessMirrorContract.FILE_ID_BY_NAME[FitnessMirrorContract.SENSOR])
    }

    @Test
    fun `stop safety bypasses only the base fitness flag inside stock stop resolution`() {
        assertTrue(
            FitnessHistoryHooks.shouldBypassFitnessStopGate(
                stopDepth = 1,
                featureName = "FITNESS_TRACKER_ENABLED",
            ),
        )
        assertTrue(
            FitnessHistoryHooks.shouldBypassFitnessStopGate(
                stopDepth = 2,
                featureName = "FITNESS_TRACKER_ENABLED",
            ),
        )
        assertFalse(
            FitnessHistoryHooks.shouldBypassFitnessStopGate(
                stopDepth = 0,
                featureName = "FITNESS_TRACKER_ENABLED",
            ),
        )
        assertFalse(
            FitnessHistoryHooks.shouldBypassFitnessStopGate(
                stopDepth = 1,
                featureName = "FITNESS_TRACKER_EXTRA_DATA_ENABLED",
            ),
        )
        assertFalse(
            FitnessHistoryHooks.shouldBypassFitnessStopGate(
                stopDepth = 1,
                featureName = null,
            ),
        )
    }

    @Test
    fun `automatic fitness bug report is suppressed only inside stock stop resolution`() {
        assertTrue(
            FitnessHistoryHooks.shouldSuppressFitnessBugReport(
                stopDepth = 1,
                description = "Fitness tracking session data",
            ),
        )
        assertTrue(
            FitnessHistoryHooks.shouldSuppressFitnessBugReport(
                stopDepth = 2,
                description = "Fitness tracking session data",
            ),
        )
        assertFalse(
            FitnessHistoryHooks.shouldSuppressFitnessBugReport(
                stopDepth = 0,
                description = "Fitness tracking session data",
            ),
        )
        assertFalse(
            FitnessHistoryHooks.shouldSuppressFitnessBugReport(
                stopDepth = 1,
                description = "user-requested bug",
            ),
        )
        assertFalse(
            FitnessHistoryHooks.shouldSuppressFitnessBugReport(
                stopDepth = 1,
                description = null,
            ),
        )
    }

    @Test
    fun `fitness recovery recognizes only exact stock stop phrases`() {
        for (utterance in listOf(
            "stop tracking my workout",
            "end recording this bike ride",
            "finish activity tracking",
        )) {
            assertTrue(utterance, FitnessHistoryHooks.isExactFitnessStopPhrase(utterance))
        }
        for (utterance in listOf(
            "start tracking my workout",
            "stop tracking my workout and reboot",
            "please stop tracking my workout",
            "why did you stop tracking my workout",
        )) {
            assertFalse(utterance, FitnessHistoryHooks.isExactFitnessStopPhrase(utterance))
        }
    }

    @Test
    fun `fitness recovery adds the stock stop regex idempotently`() {
        val compiledRegexes = mutableMapOf<String, List<Pattern>>()
        val groupNamesByRegex = mutableMapOf<Pattern, List<String>>()

        assertTrue(
            FitnessHistoryHooks.ensureFitnessStopRegex(
                compiledRegexes,
                groupNamesByRegex,
            ),
        )
        val patterns = compiledRegexes.getValue("StopActivityTracker")
        assertEquals(1, patterns.size)
        assertTrue(patterns.single().matcher("stop tracking my hike").matches())
        assertEquals(emptyList<String>(), groupNamesByRegex[patterns.single()])
        assertFalse(
            FitnessHistoryHooks.ensureFitnessStopRegex(
                compiledRegexes,
                groupNamesByRegex,
            ),
        )
    }

    @Test
    fun `fitness recovery adds the stop schema once without adding start`() {
        var containsStop = false
        var addCount = 0
        val catalog = Any()

        assertTrue(
            FitnessHistoryHooks.ensureFitnessStopSchema(
                catalog,
                containsSchema = { containsStop },
                addSchema = {
                    containsStop = true
                    addCount++
                },
            ),
        )
        assertFalse(
            FitnessHistoryHooks.ensureFitnessStopSchema(
                catalog,
                containsSchema = { containsStop },
                addSchema = { addCount++ },
            ),
        )
        assertEquals(1, addCount)
    }

    @Test
    fun `stop safety keeps the stock stop implementation and scopes the flag override`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/FitnessHistoryHooks.kt",
        ).readText()

        assertTrue(source.contains("getDeclaredMethod(\"resolve\", stopAction)"))
        assertTrue(source.contains("getDeclaredMethod(\"getBoolValue\", feature)"))
        assertTrue(source.contains("getDeclaredMethod(\"submitAsync\", String::class.java)"))
        assertTrue(source.contains("CompletableFuture.completedFuture(null)"))
        assertTrue(source.contains("Activity tracking stopped."))
        assertTrue(source.contains("override fun afterHookedMethod(param: MethodHookParam)"))
        assertTrue(source.contains("param.throwable == null && param.result == false"))
        assertTrue(source.contains("stopResolveDepth.remove()"))
        assertFalse(source.contains("stop.invoke("))
        assertFalse(source.contains("param.result = VoiceActions"))
    }

    @Test
    fun `producer mirror is scoped to stock writers and never reopens completed files`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/FitnessHistoryHooks.kt",
        ).readText()

        assertTrue(source.contains("FileSystemWrapper"))
        assertTrue(source.contains("createFileWriter"))
        assertTrue(source.contains("writeToFile"))
        assertTrue(source.contains("param.throwable != null"))
        assertTrue(source.contains("ParcelFileDescriptor.AutoCloseOutputStream"))
        assertFalse(source.contains("ParcelFileDescriptor.open("))
        assertFalse(source.contains("FileInputStream("))
        assertFalse(source.contains("MODE_READ_ONLY"))
        assertTrue(source.contains("val tracker = startAttemptOwner.get() ?: return"))
        assertTrue(source.contains("startAttemptCaptures.remove(param.thisObject)"))
        assertTrue(source.contains("abortAndDiscard(it, \"stock start did not select"))
        assertTrue(source.contains("abortAndDiscard(capture, \"stock start stream was incomplete\")"))
    }

    @Test
    fun `pre-encode bound rejects a huge string before byte array allocation`() {
        val capture = FitnessSessionCapture(
            sessionId = UUID.randomUUID().toString(),
            directory = "/data/user/0/hu.ma.ne.ironman/files/activity_data/test",
            maxPendingBytes = 8,
            maxFrameBytes = 4,
            maxQueuedFrames = 4,
        )
        assertTrue(capture.registerFile(FitnessMirrorContract.SUMMARY))
        assertFalse(capture.canEncode(FitnessMirrorContract.SUMMARY, 3, 3))
        assertTrue(capture.canEncode(FitnessMirrorContract.SUMMARY, 2, 3))

        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/FitnessHistoryHooks.kt",
        ).readText()
        assertTrue(
            source.indexOf("binding.capture.canEncode") <
                source.indexOf("content.toByteArray(producerCharset)"),
        )
    }

    @Test
    fun `bounded producer queue aborts once without blocking stock writes`() {
        val capture = FitnessSessionCapture(
            sessionId = UUID.randomUUID().toString(),
            directory = "/data/user/0/hu.ma.ne.ironman/files/activity_data/test",
            maxPendingBytes = 8,
            maxFrameBytes = 4,
            maxQueuedFrames = 4,
        )
        assertTrue(capture.registerFile(FitnessMirrorContract.SUMMARY))
        assertTrue(capture.registerFile(FitnessMirrorContract.LOCATION))
        assertTrue(capture.markStarted(1_000))
        assertTrue(capture.append(FitnessMirrorContract.SUMMARY, byteArrayOf(1, 2, 3, 4)))
        assertTrue(capture.append(FitnessMirrorContract.LOCATION, byteArrayOf(5, 6, 7, 8)))

        // A producer never waits for the consumer. Crossing the pending-byte bound clears the
        // partial mirror and emits one terminal abort; later terminal attempts are ignored.
        assertFalse(capture.append(FitnessMirrorContract.LOCATION, byteArrayOf(9)))
        assertFalse(capture.abort("second abort"))
        assertFalse(capture.complete(2_000))
        val terminal = capture.take()
        assertTrue(terminal is FitnessStreamEvent.Abort)
        assertEquals("fitness producer bounds exceeded", (terminal as FitnessStreamEvent.Abort).reason)
    }

    @Test
    fun `successful mirror declares exact byte counts once`() {
        val capture = FitnessSessionCapture(
            sessionId = UUID.randomUUID().toString(),
            directory = "/data/user/0/hu.ma.ne.ironman/files/activity_data/test",
        )
        assertTrue(capture.registerFile(FitnessMirrorContract.SUMMARY))
        assertTrue(capture.registerFile(FitnessMirrorContract.LOCATION))
        assertTrue(capture.markStarted(1_000))
        assertTrue(capture.append(FitnessMirrorContract.SUMMARY, byteArrayOf(1, 2)))
        assertTrue(capture.append(FitnessMirrorContract.LOCATION, byteArrayOf(3, 4, 5)))
        assertTrue(capture.complete(2_000))
        assertFalse(capture.complete(2_001))
        assertFalse(capture.abort("late abort"))

        assertTrue(capture.take() is FitnessStreamEvent.Frame)
        assertTrue(capture.take() is FitnessStreamEvent.Frame)
        val terminal = capture.take() as FitnessStreamEvent.Complete
        assertEquals(
            mapOf(
                FitnessMirrorContract.SUMMARY to 2L,
                FitnessMirrorContract.LOCATION to 3L,
            ),
            terminal.files.associate { it.filename to it.sizeBytes },
        )
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
