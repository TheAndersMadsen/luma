package com.penumbraos.hook

import dev.luma.gestures.*
import org.junit.Assert.*
import org.junit.Test

class ClipMotionReplayTest {
    private val article = ClipArticle("567c5b20-13ef-44d6-a481-11acb5568d05", "An article title", "Publisher", "https://example.org/article", "Selected text")
    private fun frame(time: Long, distance: Double = 300.0) = HandFrame(time, time * 1000, true,
        MutableList(25) { Point3(0.0, 0.0, distance) }.apply {
            this[0] = Point3(0.0, -35.0, distance)
            this[5] = Point3(15.0, -10.0, distance)
            this[9] = Point3(10.0, 0.0, distance)
            this[13] = Point3(-10.0, 0.0, distance)
            this[22] = Point3(10.0, -20.0, distance)
            this[23] = Point3(-10.0, -20.0, distance)
        })
    @Test fun nativePressRequestsOnceAndPresentationWaitsForConfirmedStorage() {
        val motion = ClipMotion()
        assertFalse(motion.press(frame(1000).copy(points = List(25) { Point3(0.0, 0.0, 0.0) }), true, 1000))
        assertFalse(motion.press(frame(0), true, 1000))
        assertTrue(motion.press(frame(1000), true, 1000))
        assertFalse(motion.press(frame(1100), true, 1100))
        val requested = ClipSnapshot(article, "requested", 60_000, 1000)
        assertNull(motion.presentation(requested, 1200))
        assertEquals(ClipVisualStage.PUBLISHER, motion.presentation(requested, 1600)!!.stage)
        assertNull(motion.presentation(requested, 1600)!!.text)
        assertEquals("P", motion.presentation(requested, 1600)!!.publisherInitial)
        assertEquals("Copying…", motion.presentation(requested, 3600)!!.text)
        assertEquals("An article title", motion.presentation(requested.copy(phase = "saved"), 3600)!!.text)
        assertEquals("Copy not confirmed", motion.presentation(requested.copy(phase = "unconfirmed"), 3600)!!.text)
        motion.cancel()
        assertNull(motion.presentation(requested.copy(phase = "saved"), 4000))
        assertFalse(motion.press(frame(4000), true, 4000))
    }
    @Test fun pullRequiresContinuousTrackingAndLossCannotBecomeASecondCopy() {
        val motion = ClipMotion()
        assertTrue(motion.press(frame(1000), true, 1000))
        for (time in 1050L..3650L step 50) motion.accept(frame(time, if (time >= 3450) 250.0 else 300.0), true, time)
        val details = motion.presentation(ClipSnapshot(article, "saved", 60_000, 1000), 3650)!!
        assertEquals(ClipVisualStage.DETAILS, details.stage)
        assertEquals("An article title\n\nSelected text", details.text)
        motion.accept(null, false, 3700)
        assertFalse(motion.visible)
        assertFalse(motion.press(frame(3800), true, 3800))
    }

    @Test fun thePublisherMarkPersistsBesideTheTitleAndCannotBeSelectedBySpoofedPublisherText() {
        val motion = ClipMotion()
        assertTrue(motion.press(frame(1000), true, 1000))
        val source = article.copy(url = "https://www.nytimes.com/2020/11/09/health/covid-vaccine-pfizer.html")
        val snapshot = ClipSnapshot(source, "saved", 60_000, 1000)
        val publisher = motion.presentation(snapshot, 1600)!!
        val title = motion.presentation(snapshot, 3600)!!
        assertEquals(ClipPublisherMark.NEW_YORK_TIMES, publisher.publisherMark)
        assertEquals(publisher.publisherMark, title.publisherMark)
        assertEquals(ClipVisualStage.TITLE, title.stage)
        for (url in listOf("https://nytimes.com.example.org/article", "https://notnytimes.com/article")) {
            val fake = snapshot.copy(article = article.copy(publisher = "The New York Times", url = url))
            assertEquals(ClipPublisherMark.INITIAL, motion.presentation(fake, 1600)!!.publisherMark)
        }
    }
}
