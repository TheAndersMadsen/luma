package com.penumbraos.hook

import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptionSaveFlagHooksTest {
    @Test
    fun `same live gate follows false true false and preserves enabled bytes by identity`() {
        val enabled = AtomicBoolean(false)
        val reads = AtomicInteger(0)
        val audio = byteArrayOf(1, 2, 3, 4)
        val builder = Any()
        var delegatedAudio: ByteArray? = null

        fun invoke(): Any {
            val skip = TranscriptionSaveFlagHooks.shouldSkipAudioAttachment(audio) {
                reads.incrementAndGet()
                enabled.get()
            }
            if (skip) return builder
            delegatedAudio = audio
            return builder
        }

        assertSame(builder, invoke())
        assertNull(delegatedAudio)

        enabled.set(true)
        assertSame(builder, invoke())
        assertSame(audio, delegatedAudio)

        delegatedAudio = null
        enabled.set(false)
        assertSame(builder, invoke())
        assertNull(delegatedAudio)
        assertEquals(3, reads.get())
        assertEquals(byteArrayOf(1, 2, 3, 4).toList(), audio.toList())
    }

    @Test
    fun `in flight enabled snapshot is revoked by live false and read failures fail closed`() {
        val startSnapshotEnabled = true
        val audio = ByteArray(320_000) { 0x2a }

        assertTrue(startSnapshotEnabled)
        assertTrue(
            TranscriptionSaveFlagHooks.shouldSkipAudioAttachment(audio) { false },
        )
        assertTrue(
            TranscriptionSaveFlagHooks.shouldSkipAudioAttachment(audio) {
                throw IllegalStateException("feature service unavailable")
            },
        )
        assertEquals(0x2a, audio.first().toInt())
        assertEquals(0x2a, audio.last().toInt())
    }

    @Test
    fun `true delegates all nonnull sizes while null clear delegates without a flag read`() {
        for (audio in listOf(ByteArray(0), ByteArray(1), ByteArray(320_000))) {
            assertFalse(
                TranscriptionSaveFlagHooks.shouldSkipAudioAttachment(audio) { true },
            )
        }

        var reads = 0
        assertFalse(
            TranscriptionSaveFlagHooks.shouldSkipAudioAttachment(null) {
                reads++
                false
            },
        )
        assertEquals(0, reads)
    }

    @Test
    fun `source hooks only exact setter returns receiver and has bounded metadata-only logs`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/TranscriptionSaveFlagHooks.kt",
        ).readText()
        val ironman = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()

        assertTrue(
            source.contains(
                "humane.system.transcription.TranscriptionResponse\\\$Builder",
            ),
        )
        assertTrue(source.contains("\"setAudioData\","))
        assertTrue(source.contains("ByteArray::class.java"))
        assertTrue(source.contains("setAudioData.returnType == builderClass"))
        assertTrue(source.contains("SERVER_TRANSCRIPTION_SAVE_ENABLED"))
        assertTrue(source.contains("getDeclaredMethod(\n                    \"getBoolValue\","))
        assertTrue(source.contains("param.result = param.thisObject"))
        assertFalse(source.contains("param.args[0] = null"))
        assertFalse(source.contains("audio.fill"))
        assertEquals(1, Regex("XposedBridge\\.hookMethod\\(").findAll(source).count())
        assertEquals(
            1,
            Regex("TranscriptionSaveFlagHooks\\.install\\(cl\\)")
                .findAll(ironman)
                .count(),
        )

        // Logging is install-time metadata only: no utterance-sized values or
        // byte contents are emitted from the attachment hook.
        assertEquals(3, Regex("Log\\.[ew]\\(").findAll(source).count())
        assertFalse(source.contains("audio.size"))
        assertFalse(source.contains("contentToString"))
        assertFalse(source.contains("FileOutputStream"))
        assertFalse(source.contains("java.io.File"))
        assertFalse(source.contains("android.provider.Settings"))
        assertFalse(source.contains("sendBroadcast"))
        assertFalse(source.contains("hookAllMethods"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
