package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Guards the installed music app's live interstitial behavior at Spotify's boundary. */
class MusicInterstitialsParityContractTest {
    @Test
    fun `obsolete provider fallbacks identify the active music provider`() {
        assertEquals(
            "featured playlist on spotify, up next.",
            rewriteSpotifyMusicInterstitialNarration(
                "featured playlist on tidal, up next.",
            ),
        )
        assertEquals(
            "your collection on spotify, up next.",
            rewriteSpotifyMusicInterstitialNarration(
                "your collection on tidal, up next.",
            ),
        )
    }

    @Test
    fun `all unrelated narration remains byte for byte unchanged`() {
        listOf(
            "oops! something went wrong connecting to tidal.",
            "unable to find requested music.",
            "discovery by daft punk, up next.",
            "Featured playlist on Tidal, up next.",
            "",
        ).forEach { narration ->
            assertEquals(narration, rewriteSpotifyMusicInterstitialNarration(narration))
        }
    }

    @Test
    fun `stock remains sole owner of the live feature flag decision`() {
        val musicHook = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/MusicHooks.kt",
        ).readText()

        assertTrue(musicHook.contains("installSpotifyInterstitialNarrationHook()"))
        assertTrue(musicHook.contains("rewriteSpotifyMusicInterstitialNarration(original)"))
        assertFalse(musicHook.contains("MUSIC_INTERSTITIALS_ENABLED"))
        assertFalse(musicHook.contains("music_interstitials_enabled"))
    }

    @Test
    fun `server cue RPCs stay default off bounded and stateless`() {
        val actionService = repoFile(
            "runtime/core/src/services/aibus/cue/interstitial.rs",
        ).readText()
        val loadingService = repoFile(
            "runtime/core/src/services/aibus/cue/loading_message.rs",
        ).readText()
        val config = repoFile("runtime/core/src/config.rs").readText()

        assertTrue(actionService.contains("pub struct ActionInterstitialHandler;"))
        assertTrue(actionService.contains("let armed = spoken_progress_cues_enabled();"))
        assertTrue(actionService.contains("interstitial_phrase(&names, armed)"))
        assertTrue(actionService.contains("interstitial: interstitial.to_string()"))
        assertTrue(actionService.contains("emitted = !interstitial.is_empty()"))
        assertTrue(actionService.contains("read_tool_spec(name)?"))
        assertTrue(config.contains("pub const DEFAULT_SPOKEN_PROGRESS_CUES: bool = false;"))
        assertTrue(loadingService.contains("pub struct LoadingMessageHandler;"))
        assertTrue(loadingService.contains("loading_message: String::new()"))
        assertTrue(loadingService.contains("verbal_message: String::new()"))
        assertTrue(loadingService.contains("emitted = false"))
        assertFalse(actionService.contains("MUSIC_INTERSTITIALS_ENABLED"))
        assertFalse(actionService.contains("music_interstitials_enabled"))
    }

    private fun repoFile(relativePath: String): File {
        val candidates = listOf(
            File(relativePath),
            File("..", relativePath),
            File("../..", relativePath),
        )
        return candidates.firstOrNull { it.exists() }
            ?: throw AssertionError("Missing repository contract path: $relativePath")
    }
}
