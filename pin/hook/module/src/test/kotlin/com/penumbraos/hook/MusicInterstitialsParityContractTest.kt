package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Guards the installed music app's live interstitial behavior at the provider boundary. */
class MusicInterstitialsParityContractTest {
    @Test
    fun `genuine stock tracks suppress notable events at the exact two argument signature`() {
        // Failure modes: a no-arg hook misses the real method, the enum is
        // resolved in the wrong loader, or unrelated stock tracks are suppressed.
        // Stock Track.emitNotableEvent(TrackNotableEventType, String) is called
        // by MediaManager.emitNotableEvent during playback/pause/skip.
        val musicHook = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/MusicHooks.kt",
        ).readText()
        val eventHook = musicHook.substringAfter("\"emitNotableEvent\",")
            .substringBefore("}.also")
        assertTrue(eventHook.contains("arrayOf("))
        assertTrue(eventHook.contains("cl.loadClass(\"humane.ui.notableevents.TrackNotableEvent\\\$TrackNotableEventType\")"))
        assertTrue(eventHook.contains("String::class.java"))
        assertTrue(eventHook.contains("if (spotifyItems.containsKey(param.thisObject)) param.result = null"))
    }

    @Test
    fun `obsolete provider fallbacks become provider neutral`() {
        assertEquals(
            "featured playlist, up next.",
            rewriteMusicInterstitialNarration(
                "featured playlist on tidal, up next.",
            ),
        )
        assertEquals(
            "your collection, up next.",
            rewriteMusicInterstitialNarration(
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
            assertEquals(narration, rewriteMusicInterstitialNarration(narration))
        }
    }

    @Test
    fun `stock remains sole owner of the live feature flag decision`() {
        val musicHook = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/MusicHooks.kt",
        ).readText()

        assertTrue(musicHook.contains("installMusicInterstitialNarrationHook()"))
        assertTrue(musicHook.contains("rewriteMusicInterstitialNarration(original)"))
        assertFalse(musicHook.contains("MUSIC_INTERSTITIALS_ENABLED"))
        assertFalse(musicHook.contains("music_interstitials_enabled"))
    }

    @Test
    fun `the spoken-progress arming flag stays default-off in the runtime config`() {
        val config = repoFile("runtime/core/src/config.rs").readText()

        assertTrue(config.contains("pub const DEFAULT_SPOKEN_PROGRESS_CUES: bool = false;"))
        assertFalse(config.contains("MUSIC_INTERSTITIALS_ENABLED"))
        assertFalse(config.contains("music_interstitials_enabled"))
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
