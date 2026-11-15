package com.penumbraos.hook

import dev.luma.gestures.Finger
import dev.luma.gestures.GestureConfig
import dev.luma.gestures.GestureEngine
import dev.luma.gestures.GestureMatch
import dev.luma.gestures.HandFrame
import dev.luma.gestures.Point3
import org.junit.Assert.*
import org.junit.Test

/** Synthetic summary -> SDK -> action-ID replay. Failure scope: docs/gestures.md. */
class LauncherGestureReplayTest {
    class State {
        @JvmField var detected = true
        @JvmField var isHand = true
        @JvmField var hasFlatHand = true
        @JvmField var isRightHand = true
        @JvmField var numHandKeypoints = 25
        @JvmField var handKeypoints3D = FloatArray(75)
        @JvmField var meshWidth = 2
        @JvmField var meshHeight = 2
        @JvmField var projection3D = FloatArray(12)
    }
    class Summary {
        @JvmField var timestamp = 1L
        @JvmField var left: State? = null
        @JvmField var right: State? = null
    }

    private fun config(mode: String = "observe", fingers: String = "\"middle\"") =
        GestureConfig.parse("""{"schema_version":1,"mode":"$mode","bindings":[{"fingers":[$fingers],"hold_ms":300,"feature":"open_music"}]}""")

    private fun points(curled: Set<Finger> = emptySet(), right: Boolean = true): List<Point3> {
        val points = MutableList(25) { Point3(0.0, 0.0, 0.0) }
        points[0] = Point3(0.0, -25.0, 0.0)
        for (finger in Finger.entries) {
            val x = (finger.ordinal - 2) * 20.0
            for (joint in 0..3) {
                val shorten = if (finger in curled) joint * 6.0 else 0.0
                points[finger.rootIndex + joint] = Point3(x, 30.0 + joint * 20.0 - shorten, 0.0)
            }
        }
        points[22] = Point3(-5.0, 0.0, 0.0)
        points[23] = Point3(5.0, 0.0, 0.0)
        return if (right) points else points.map { Point3(-it.x, it.y, it.z) }
    }

    private inner class Replay(mode: String = "observe", val right: Boolean = true) {
        val engine = GestureEngine(config(mode))
        val reader = StockHandFrameReader()
        val matches = mutableListOf<GestureMatch>()
        var time = 1_000L
        var source = 1L
        var transform: (Point3) -> Point3 = { it }

        fun frame(curled: Set<Finger> = emptySet()): HandFrame {
            val state = State().also {
                it.isRightHand = right
                it.handKeypoints3D = points(curled, right).map(transform)
                    .flatMap { p -> listOf(p.x.toFloat(), p.y.toFloat(), p.z.toFloat()) }.toFloatArray()
            }
            val summary = Summary().also {
                it.timestamp = source++
                if (right) it.right = state else it.left = state
            }
            return checkNotNull(reader.read(summary, time, true))
        }

        fun sample(curled: Set<Finger> = emptySet()) {
            engine.accept(frame(curled))?.let(matches::add)
            time += 50
        }
        fun hold(curled: Set<Finger> = emptySet(), samples: Int = 10) = repeat(samples) { sample(curled) }
        fun gesture() { hold(setOf(Finger.MIDDLE)); hold() }
    }

    @Test fun deliberateHoldAndReleaseProducesOneConfiguredActionForEitherHand() {
        for (right in listOf(true, false)) {
            val replay = Replay(right = right)
            replay.hold()
            replay.hold(setOf(Finger.MIDDLE), 30)
            assertTrue(replay.matches.isEmpty())
            replay.hold()
            replay.hold()
            assertEquals(listOf("open_music"), replay.matches.map { it.feature })
            assertTrue(replay.matches.single().observeOnly)
            replay.gesture()
            assertEquals(2, replay.matches.size)
        }
    }

    @Test fun activeModeUsesSameRecognizerAndDefaultOffNeverEmits() {
        val active = Replay("active")
        active.hold(); active.gesture()
        assertFalse(active.matches.single().observeOnly)
        val disabled = GestureEngine(GestureConfig.parse(null))
        repeat(30) { assertNull(disabled.accept(active.frame())) }
    }

    @Test fun wholeHandTranslationAndRotationDoNotBecomeFingerActions() {
        val replay = Replay()
        replay.hold()
        replay.transform = { p -> Point3(p.z + 45.0, p.y - 50.0, -p.x + 200.0) }
        replay.hold()
        assertTrue(replay.matches.isEmpty())
        replay.gesture()
        assertEquals(1, replay.matches.size)
    }

    @Test fun shortCurlJitterAndConflictingFingersNeverCommit() {
        val replay = Replay()
        replay.hold()
        replay.hold(setOf(Finger.MIDDLE), 3); replay.hold()
        repeat(12) { replay.sample(setOf(Finger.MIDDLE)); replay.sample() }
        replay.hold()
        assertTrue(replay.matches.isEmpty())
        replay.hold(setOf(Finger.MIDDLE))
        replay.hold(setOf(Finger.MIDDLE, Finger.INDEX))
        replay.hold(setOf(Finger.MIDDLE)); replay.hold()
        assertTrue(replay.matches.isEmpty())
        replay.hold(Finger.entries.toSet()); replay.hold()
        assertTrue(replay.matches.isEmpty())
        replay.gesture()
        assertEquals(1, replay.matches.size)
    }

    @Test fun lossCancelGapDuplicateAndHandSwitchCannotCompleteAPendingAction() {
        for (failure in listOf("loss", "cancel", "gap", "duplicate", "switch", "backwards")) {
            val replay = Replay()
            replay.hold(); replay.hold(setOf(Finger.MIDDLE))
            when (failure) {
                "loss" -> assertNull(replay.engine.accept(null))
                "cancel" -> replay.engine.cancel()
                "gap" -> replay.time += 1_000
                "duplicate" -> replay.source--
                "switch" -> replay.engine.accept(replay.frame().copy(rightHand = false))
                "backwards" -> replay.time -= 500
            }
            replay.hold()
            assertTrue("Failure: $failure", replay.matches.isEmpty())
        }
    }

    @Test fun readerRejectsInvalidGeometryAndAmbiguousOrNonProjectableHandsAndCopiesArrays() {
        val replay = Replay()
        val state = State().also {
            it.handKeypoints3D = points().flatMap { p -> listOf(p.x.toFloat(), p.y.toFloat(), p.z.toFloat()) }.toFloatArray()
        }
        val summary = Summary().also { it.right = state }
        assertNull(replay.reader.read(summary, 1_000, false))
        val frame = checkNotNull(replay.reader.read(summary, 1_000, true))
        state.projection3D = FloatArray(0)
        assertNull(replay.reader.read(summary, 1_000, true))
        val trackedWithoutMesh = replay.reader.sample(summary, 1_000, false)
        assertNotNull(trackedWithoutMesh.frame)
        assertFalse(trackedWithoutMesh.projectable)
        state.projection3D = FloatArray(12)
        val original = frame.points.toList()
        state.handKeypoints3D.fill(Float.NaN)
        assertEquals(original, frame.points)
        assertNull(replay.reader.read(summary, 1_000, true))
        state.handKeypoints3D = FloatArray(9)
        assertNull(replay.reader.read(summary, 1_000, true))
        state.handKeypoints3D = FloatArray(75)
        assertNull(replay.engine.accept(replay.reader.read(summary, 1_000, true)))
        summary.left = State().also { it.isRightHand = false }
        assertNull(replay.reader.read(summary, 1_000, true))
        summary.left = null; state.detected = false
        assertNull(replay.reader.read(summary, 1_000, true))
    }

    @Test fun invalidConfigurationFailsClosedInsteadOfInvokingUnknownFeatures() {
        val good = """{"schema_version":1,"mode":"active","bindings":[{"fingers":["middle"],"hold_ms":300,"feature":"open_music"}]}"""
        val invalid = listOf(
            "{}", "null", "[]", " ".repeat(4097),
            good.replace("\"schema_version\":1", "\"schema_version\":2"),
            good.replace("\"schema_version\":1", "\"schema_version\":\"1\""),
            good.replace("\"middle\"", "\"index\""),
            good.replace("\"middle\"", "\"thumb\""),
            good.replace("\"middle\"", "\"middle\",\"middle\""),
            good.replace("300", "1"), good.replace("300", "300.5"),
            good.replace("open_music", "pinch_to_copy"),
            good.replace("open_music", "shell"),
            good.replace("\"mode\":\"active\"", "\"mode\":\"automatic\""),
            good.replace("\"mode\":\"active\"", "\"mode\":\"active\",\"command\":\"anything\""),
            good.replace("}]}", "},{\"fingers\":[\"middle\"],\"hold_ms\":500,\"feature\":\"open_settings\"}]}"),
        )
        for (json in invalid) {
            assertThrows(IllegalArgumentException::class.java) { GestureConfig.parse(json) }
        }
    }
}
