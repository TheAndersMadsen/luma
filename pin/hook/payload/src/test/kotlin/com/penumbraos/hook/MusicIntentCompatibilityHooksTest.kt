package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MusicIntentCompatibilityHooksTest {
    @Test
    fun `natural track by artist emits native play music slots`() {
        val action = MusicIntentCompatibilityHooks.parse(
            "Play Feel Good Inc by Gorillaz",
        )

        assertEquals("PlayMusic", action?.name)
        assertEquals("Feel Good Inc", action?.inputs?.get("Track"))
        assertEquals("Gorillaz", action?.inputs?.get("Artist"))
    }

    @Test
    fun `formal labels and polite aliases retain clean slots`() {
        val action = MusicIntentCompatibilityHooks.parse(
            "Could you please put on the song Teardrop by the artist Massive Attack?",
        )

        assertEquals("PlayMusic", action?.name)
        assertEquals("Teardrop", action?.inputs?.get("Track"))
        assertEquals("Massive Attack", action?.inputs?.get("Artist"))
    }

    @Test
    fun `track split uses the final by delimiter`() {
        val action = MusicIntentCompatibilityHooks.parse(
            "play Stand by Me by Ben E King",
        )

        assertEquals("Stand by Me", action?.inputs?.get("Track"))
        assertEquals("Ben E King", action?.inputs?.get("Artist"))
    }

    @Test
    fun `album artist grammar remains owned by stock regex`() {
        assertNull(
            MusicIntentCompatibilityHooks.parse(
                "play the album Demon Days by Gorillaz",
            ),
        )
    }

    @Test
    fun `contextual artist requests fall through to grounded server context`() {
        listOf(
            "Play the most popular song by this artist",
            "play the biggest track by that artist",
        ).forEach { utterance ->
            assertNull(MusicIntentCompatibilityHooks.parse(utterance))
        }
    }

    @Test
    fun `conversational transport aliases map to stock actions`() {
        val cases = mapOf(
            "pause the music" to "PauseMusic",
            "continue playback" to "ResumeMusic",
            "skip this song" to "NextTrack",
            "go back to the previous song" to "PreviousTrack",
            "restart this song" to "RestartTrack",
        )

        cases.forEach { (utterance, expected) ->
            assertEquals(expected, MusicIntentCompatibilityHooks.parse(utterance)?.name)
        }
    }

    @Test
    fun `transport controls are selected locally without a Cosmos route`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/MusicIntentCompatibilityHooks.kt",
        ).readText()
        val ironman = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()

        assertTrue(source.contains("InterpreterOrchestrator"))
        assertTrue(source.contains("override fun beforeHookedMethod"))
        assertTrue(source.contains("param.result = events"))
        assertFalse(source.contains("CosmosRemoteTransport"))
        assertFalse(source.contains("ChannelFactory"))
        assertTrue(ironman.contains("MusicIntentCompatibilityHooks.install(cl)"))
    }

    @Test
    fun `unrelated prompts are untouched`() {
        listOf(
            "take a picture",
            "play some upbeat music",
            "play my workout playlist",
            "what is the weather",
        ).forEach { utterance ->
            assertNull(MusicIntentCompatibilityHooks.parse(utterance))
        }
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull(File::isFile)
            ?: error("Could not find $relativePath")
    }
}
