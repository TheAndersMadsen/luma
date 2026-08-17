package com.penumbraos.hook

import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class StreamingSpeechPlaybackHooksTest {
    @Test
    fun `open reports unknown length before eos even with zero or buffered bytes`() {
        for (bufferedLength in listOf(0L, 1L, 48L * 1024L, 96L * 1024L)) {
            assertEquals(
                StreamingSpeechPlaybackHooks.UNKNOWN_LENGTH,
                StreamingSpeechPlaybackHooks.openLengthWhileStreaming(bufferedLength) {
                    false
                },
            )
        }
    }

    @Test
    fun `open preserves exact finite result after eos and on state-read failure`() {
        for (finiteLength in listOf(0L, 1L, 48L * 1024L, 96L * 1024L)) {
            assertEquals(
                finiteLength,
                StreamingSpeechPlaybackHooks.openLengthWhileStreaming(finiteLength) { true },
            )
            assertEquals(
                finiteLength,
                StreamingSpeechPlaybackHooks.openLengthWhileStreaming(finiteLength) {
                    throw IllegalStateException("firmware shape changed")
                },
            )
        }
    }

    @Test
    fun `player error releases pending future exceptionally and cannot replace completion`() {
        val pending = CompletableFuture<Boolean>()
        val playbackError = IllegalStateException("decoder rejected stream")
        assertTrue(
            StreamingSpeechPlaybackHooks.completePlaybackError(pending, playbackError),
        )
        assertTrue(pending.isCompletedExceptionally)
        try {
            pending.get(100, TimeUnit.MILLISECONDS)
            fail("playback error should complete the pending future exceptionally")
        } catch (error: ExecutionException) {
            assertSame(playbackError, error.cause)
        }

        val alreadySuccessful = CompletableFuture.completedFuture(true)
        assertFalse(
            StreamingSpeechPlaybackHooks.completePlaybackError(
                alreadySuccessful,
                IllegalStateException("late player error"),
            ),
        )
        assertTrue(alreadySuccessful.get(100, TimeUnit.MILLISECONDS))
    }

    @Test
    fun `interrupted playback completes the pending narrator future normally`() {
        val pending = CompletableFuture<Any?>()
        assertTrue(StreamingSpeechPlaybackHooks.completeInterruptedPlayback(pending))
        assertFalse(pending.isCompletedExceptionally)
        assertEquals(java.lang.Boolean.TRUE, pending.get(100, TimeUnit.MILLISECONDS))
    }

    @Test
    fun `interrupted-playback release never replaces an existing terminal state`() {
        val alreadySuccessful = CompletableFuture<Any?>()
        alreadySuccessful.complete(java.lang.Boolean.TRUE)
        assertFalse(StreamingSpeechPlaybackHooks.completeInterruptedPlayback(alreadySuccessful))

        val alreadyFailed = CompletableFuture<Any?>()
        val terminalError = IllegalStateException("player error already released this future")
        alreadyFailed.completeExceptionally(terminalError)
        assertFalse(StreamingSpeechPlaybackHooks.completeInterruptedPlayback(alreadyFailed))
        assertTrue(alreadyFailed.isCompletedExceptionally)
    }

    @Test
    fun `source validates exact stock shapes and installs both narrow after hooks`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/StreamingSpeechPlaybackHooks.kt",
        ).readText()
        val ironman = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()

        assertTrue(source.contains("humaneinternal.system.narrator.ByteArrayDataSource"))
        assertTrue(
            source.contains("humaneinternal.system.narrator.RemoteTextToSpeech\\\$PlayerListener"),
        )
        assertTrue(source.contains("androidx.media3.datasource.DataSpec"))
        assertTrue(source.contains("androidx.media3.common.PlaybackException"))
        assertTrue(source.contains("getDeclaredMethod(\n                \"open\","))
        assertTrue(source.contains("getDeclaredMethod(\n                \"isStreamEnded\","))
        assertTrue(source.contains("getDeclaredMethod(\n                \"onPlayerError\","))
        assertTrue(source.contains("getDeclaredField(\n                \"mFuture\","))
        assertTrue(source.contains("open.returnType == java.lang.Long.TYPE"))
        assertTrue(source.contains("isStreamEnded.returnType == java.lang.Boolean.TYPE"))
        assertTrue(source.contains("onPlayerError.returnType == Void.TYPE"))
        assertTrue(source.contains("futureField.type == CompletableFuture::class.java"))
        assertTrue(source.contains("if (param.throwable != null) return"))
        assertEquals(3, Regex("XposedBridge\\.hookMethod\\(").findAll(source).count())
        assertEquals(3, Regex("override fun afterHookedMethod").findAll(source).count())
        assertEquals(1, Regex("override fun beforeHookedMethod").findAll(source).count())
        // Completion hardening: interrupted playback (STATE_IDLE) must release
        // the narrator future, and the ENDED-without-signal branch must seed a
        // real Throwable before stock's exceptional completion.
        assertTrue(source.contains("getDeclaredMethod(\n                \"onPlaybackStateChanged\","))
        assertTrue(source.contains("getDeclaredField(\n                \"mCompletedSuccessfully\","))
        assertTrue(source.contains("getDeclaredField(\n                \"mThrow\","))
        assertTrue(source.contains("getDeclaredMethod(\n                \"signalCompletion\","))
        assertTrue(source.contains("if (state != STATE_ENDED) return"))
        assertTrue(source.contains("if (state != STATE_IDLE) return"))
        assertFalse(source.contains("hookAllMethods"))
        assertFalse(source.contains("textToSpeak"))
        assertFalse(source.contains("getSpeech"))
        assertFalse(source.contains("getAudio"))
        assertEquals(
            1,
            Regex("StreamingSpeechPlaybackHooks\\.install\\(cl\\)").findAll(ironman).count(),
        )
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
