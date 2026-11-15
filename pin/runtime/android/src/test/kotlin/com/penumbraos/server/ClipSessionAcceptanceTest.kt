package com.penumbraos.server

import dev.luma.gestures.ClipArticle
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Failure scope and the physical/software distinction: docs/gestures.md. */
class ClipSessionAcceptanceTest {
    private val id = "567c5b20-13ef-44d6-a481-11acb5568d05"
    private fun article(id: String = this.id) = JSONObject().put("id", id).put("title", "A small discovery")
        .put("publisher", "Example").put("url", "https://example.org/article").put("selection", "A selected passage.")

    @Test fun oneExplicitTargetSurvivesRetriesAndOnlyItsPinchRequestsCopy() {
        val sessions = ClipSessions()
        sessions.stage(article(), 1_000)
        assertEquals("ready", sessions.read(1_100)!!.getString("phase"))
        sessions.copy("another-id", 1_200)
        assertEquals("ready", sessions.read(1_300)!!.getString("phase"))
        sessions.copy(id, 1_400)
        sessions.copy(id, 1_500)
        assertEquals(1_400L, sessions.read(1_600)!!.getLong("requested_at_ms"))
        assertThrows(GestureRequestException::class.java) { sessions.stage(article("bba27cd9-cb35-4c15-a334-13cfbdb3cc74"), 1_700) }
        sessions.result(JSONObject().put("id", id).put("outcome", "saved"), 1_800)
        assertEquals("saved", sessions.read(1_900)!!.getString("phase"))
        sessions.result(JSONObject().put("id", id).put("outcome", "saved"), 2_000)
        assertEquals("saved", sessions.read(2_100)!!.getString("phase"))
    }

    @Test fun expiryCancellationAndLateAcknowledgementCannotCopyAnotherTarget() {
        val sessions = ClipSessions()
        sessions.stage(article(), 0)
        sessions.cancel(JSONObject().put("id", id), 1_000)
        sessions.copy(id, 1_100)
        assertNull(sessions.read(1_200))
        sessions.stage(article(), 2_000)
        sessions.copy(id, 62_001)
        assertNull(sessions.read(62_001))
        sessions.stage(article(), 70_000)
        sessions.copy(id, 71_000)
        assertEquals("unconfirmed", sessions.read(86_001)!!.getString("phase"))
        sessions.result(JSONObject().put("id", id).put("outcome", "saved"), 87_000)
        assertEquals("saved", sessions.read(87_100)!!.getString("phase"))
        val next = "bba27cd9-cb35-4c15-a334-13cfbdb3cc74"
        sessions.stage(article(next), 88_000)
        assertThrows(GestureRequestException::class.java) { sessions.result(JSONObject().put("id", id).put("outcome", "saved"), 88_100) }
        assertEquals("ready", sessions.read(88_200)!!.getString("phase"))
    }

    @Test fun articleBoundaryRejectsExecutableUrlsUnboundedTextAndUnknownFields() {
        for (url in listOf("javascript:alert(1)", "file:///article", "https://user:pass@example.org", "https://example.org\n")) {
            assertThrows(IllegalArgumentException::class.java) { ClipArticle.parse(article().put("url", url)) }
        }
        assertThrows(IllegalArgumentException::class.java) { ClipArticle.parse(article().put("selection", "x".repeat(12_001))) }
        assertThrows(IllegalArgumentException::class.java) { ClipArticle.parse(article().put("command", "anything")) }
        assertThrows(IllegalArgumentException::class.java) { ClipArticle.parse(article().put("title", "\u0000")) }
    }
}
