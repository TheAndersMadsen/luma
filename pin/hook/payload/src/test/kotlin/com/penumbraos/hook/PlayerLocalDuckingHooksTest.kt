package com.penumbraos.hook

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerLocalDuckingHooksTest {
    private class FakePlayer(
        @Volatile var volume: Float,
    ) {
        @Volatile var writes: Int = 0

        fun write(value: Float) {
            volume = value
            writes++
        }
    }

    @Test
    fun `first duck saves local gain and repeated callbacks stay idempotent`() {
        val state = PlayerLocalDuckingState()
        val player = FakePlayer(0.8f)

        assertTrue(state.duck(player, { player.volume }, player::write))
        assertEquals(0.16f, player.volume, 0.0001f)
        assertEquals(1, player.writes)

        assertTrue(state.duck(player, { player.volume }, player::write))
        assertEquals(0.16f, player.volume, 0.0001f)
        assertEquals(1, player.writes)

        assertTrue(state.unduck(player, { player.volume }, player::write))
        assertEquals(0.8f, player.volume, 0.0001f)
        assertEquals(2, player.writes)

        assertFalse(state.unduck(player, { player.volume }, player::write))
        assertEquals(0.8f, player.volume, 0.0001f)
        assertEquals(2, player.writes)
    }

    @Test
    fun `unmatched unduck is a strict no-op`() {
        val state = PlayerLocalDuckingState()
        val player = FakePlayer(0.7f)

        assertFalse(state.unduck(player, { player.volume }, player::write))
        assertEquals(0.7f, player.volume, 0.0f)
        assertEquals(0, player.writes)
    }

    @Test
    fun `abort clears state without writing or later restoring`() {
        val state = PlayerLocalDuckingState()
        val player = FakePlayer(1.0f)

        assertTrue(state.duck(player, { player.volume }, player::write))
        assertEquals(0.2f, player.volume, 0.0f)
        assertTrue(state.clear(player))
        assertEquals(1, player.writes)

        assertFalse(state.unduck(player, { player.volume }, player::write))
        assertEquals(0.2f, player.volume, 0.0f)
        assertEquals(1, player.writes)
    }

    @Test
    fun `explicit local volume change while ducked is never overwritten`() {
        val state = PlayerLocalDuckingState()
        val player = FakePlayer(0.9f)

        assertTrue(state.duck(player, { player.volume }, player::write))
        player.write(0.55f)
        assertTrue(state.unduck(player, { player.volume }, player::write))

        assertEquals(0.55f, player.volume, 0.0f)
        assertEquals(2, player.writes)
        assertFalse(state.unduck(player, { player.volume }, player::write))
    }

    @Test
    fun `even a nearby explicit local gain remains authoritative`() {
        val state = PlayerLocalDuckingState()
        val player = FakePlayer(0.75f)

        assertTrue(state.duck(player, { player.volume }, player::write))
        player.write(0.15005f)
        assertTrue(state.unduck(player, { player.volume }, player::write))

        assertEquals(0.15005f, player.volume, 0.0f)
        assertEquals(2, player.writes)
        assertFalse(state.unduck(player, { player.volume }, player::write))
    }

    @Test
    fun `invalid volume and failed first write never create restorable state`() {
        val state = PlayerLocalDuckingState()
        val invalid = FakePlayer(Float.NaN)
        assertFalse(state.duck(invalid, { invalid.volume }, invalid::write))
        assertEquals(0, invalid.writes)

        val failed = FakePlayer(0.6f)
        val failedDuck = runCatching {
            state.duck(failed, { failed.volume }) {
                throw IllegalStateException("player rejected gain")
            }
        }
        assertTrue(failedDuck.isFailure)
        assertFalse(state.unduck(failed, { failed.volume }, failed::write))
        assertEquals(0.6f, failed.volume, 0.0f)
        assertEquals(0, failed.writes)
    }

    @Test
    fun `failed restore write retains state for a later focus gain retry`() {
        val state = PlayerLocalDuckingState()
        val player = FakePlayer(0.75f)

        assertTrue(state.duck(player, { player.volume }, player::write))
        assertEquals(0.15f, player.volume, 0.0001f)

        val failedRestore = runCatching {
            state.unduck(player, { player.volume }) {
                throw IllegalStateException("transient player write failure")
            }
        }
        assertTrue(failedRestore.isFailure)
        assertEquals(0.15f, player.volume, 0.0001f)
        assertEquals(1, player.writes)

        assertTrue(state.unduck(player, { player.volume }, player::write))
        assertEquals(0.75f, player.volume, 0.0001f)
        assertEquals(2, player.writes)
        assertFalse(state.unduck(player, { player.volume }, player::write))
    }

    @Test
    fun `concurrent players retain independent state`() {
        val state = PlayerLocalDuckingState()
        val players = (1..64).map { index -> FakePlayer(index / 64.0f) }
        val executor = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)

        try {
            val futures = players.map { player ->
                executor.submit {
                    start.await(2, TimeUnit.SECONDS)
                    check(state.duck(player, { player.volume }, player::write))
                    check(state.duck(player, { player.volume }, player::write))
                    check(state.unduck(player, { player.volume }, player::write))
                }
            }
            start.countDown()
            futures.forEach { it.get(5, TimeUnit.SECONDS) }
        } finally {
            executor.shutdownNow()
        }

        players.forEachIndexed { index, player ->
            assertEquals((index + 1) / 64.0f, player.volume, 0.0001f)
            assertEquals(2, player.writes)
            assertFalse(state.unduck(player, { player.volume }, player::write))
        }
    }

    @Test
    fun `concurrent duplicate callbacks write one duck and one restore`() {
        val state = PlayerLocalDuckingState()
        val player = FakePlayer(0.8f)
        val executor = Executors.newFixedThreadPool(8)

        try {
            val duckStart = CountDownLatch(1)
            val ducks = (1..64).map {
                executor.submit<Boolean> {
                    duckStart.await(2, TimeUnit.SECONDS)
                    state.duck(player, { player.volume }, player::write)
                }
            }
            duckStart.countDown()
            assertEquals(64, ducks.count { it.get(5, TimeUnit.SECONDS) })
            assertEquals(0.16f, player.volume, 0.0001f)
            assertEquals(1, player.writes)

            val unduckStart = CountDownLatch(1)
            val unducks = (1..64).map {
                executor.submit<Boolean> {
                    unduckStart.await(2, TimeUnit.SECONDS)
                    state.unduck(player, { player.volume }, player::write)
                }
            }
            unduckStart.countDown()
            assertEquals(1, unducks.count { it.get(5, TimeUnit.SECONDS) })
            assertEquals(0.8f, player.volume, 0.0001f)
            assertEquals(2, player.writes)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun `source is narrow fail closed and never intercepts system gain`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/PlayerLocalDuckingHooks.kt",
        ).readText()
        val music = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/MusicHooks.kt",
        ).readText()

        assertTrue(source.contains("humane.experience.music.playback.MediaPlayer"))
        assertTrue(source.contains("humane.experience.music.playback.MediaPlayerForwarding"))
        assertTrue(source.contains("duckOnAudioFocusChange"))
        assertTrue(source.contains("unduckOnAudioFocusChange"))
        assertTrue(source.contains("getDeclaredMethod(name)"))
        assertTrue(source.contains("getDeclaredField(\"mForwardingPlayer\")"))
        assertTrue(source.contains("getMethod(\"getVolume\")"))
        assertTrue(source.contains("getMethod(\"setVolume\""))
        assertTrue(source.contains("stop = exactInstanceVoid(forwardingClass, \"stop\")"))
        assertTrue(source.contains("duckingState.unduck("))
        assertFalse(source.contains("duckingState.clear(param.thisObject)"))
        assertTrue(source.contains("unhooks.asReversed()"))
        assertTrue(source.contains("unhook.unhook()"))
        assertTrue(
            source.indexOf("val shape = resolveMusicShape(classLoader)") <
                source.indexOf("XposedBridge.hookMethod(shape.duck"),
        )
        assertTrue(source.contains("param.result = null"))
        assertEquals(3, Regex("XposedBridge\\.hookMethod\\(").findAll(source).count())
        assertFalse(source.contains("hookAllMethods"))
        assertFalse(source.contains("AudioManager"))
        assertFalse(source.contains("STREAM_MUSIC"))
        assertFalse(source.contains("setStreamVolume"))
        assertFalse(source.contains("adjustStreamVolume"))
        assertFalse(source.contains("decreaseDeviceVolume"))
        assertFalse(source.contains("increaseDeviceVolume"))
        assertFalse(source.contains("CHANNEL_OUT_MONO"))
        assertFalse(source.contains("setChannelMixingMatrix"))
        assertEquals(
            1,
            Regex("PlayerLocalDuckingHooks\\.installMusic\\(cl\\)").findAll(music).count(),
        )
        assertTrue(
            music.indexOf("PlayerLocalDuckingHooks.installMusic(cl)") <
                music.indexOf("resolveTargetTypes()"),
        )
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
