package com.penumbraos.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceActionDispatcherTest {
    @Test
    fun stockActionAllowlistMatchesTheInstalledHumaneExperiences() {
        assertEquals(
            DeviceActionDispatcher.StockAction.COMPOSE_MESSAGE,
            DeviceActionDispatcher.StockAction.fromWireName("compose_message"),
        )
        assertEquals(
            DeviceActionDispatcher.StockAction.CONFIRM_MESSAGE,
            DeviceActionDispatcher.StockAction.fromWireName("confirm_message"),
        )
        assertEquals(
            DeviceActionDispatcher.StockAction.CAPTURE_PHOTO,
            DeviceActionDispatcher.StockAction.fromWireName("capture_photo"),
        )
        assertEquals(
            DeviceActionDispatcher.StockAction.CALL_PERSON,
            DeviceActionDispatcher.StockAction.fromWireName("call_person"),
        )
        assertEquals(
            DeviceActionDispatcher.StockAction.PLAY_MUSIC,
            DeviceActionDispatcher.StockAction.fromWireName("play_music"),
        )
        assertEquals(
            DeviceActionDispatcher.DIALER_PACKAGE,
            DeviceActionDispatcher.StockAction.CALL_PERSON.targetPackage,
        )
        assertEquals(
            "humane.experience.dialer.DialerActivity",
            DeviceActionDispatcher.StockAction.CALL_PERSON.targetActivity,
        )
        assertEquals(
            DeviceActionDispatcher.StockAction.END_CALL,
            DeviceActionDispatcher.StockAction.fromWireName("end_call"),
        )
        assertEquals(
            "humane.experience.dialer.DialerActivity",
            DeviceActionDispatcher.StockAction.END_CALL.targetActivity,
        )
        assertEquals(
            DeviceActionDispatcher.EXPERIENCE_ACTIVITY,
            DeviceActionDispatcher.StockAction.COMPOSE_MESSAGE.targetActivity,
        )
        assertEquals(
            DeviceActionDispatcher.PHOTOGRAPHY_ACTIVITY,
            DeviceActionDispatcher.StockAction.CAPTURE_PHOTO.targetActivity,
        )
        assertEquals(
            DeviceActionDispatcher.MUSIC_PACKAGE,
            DeviceActionDispatcher.StockAction.PLAY_MUSIC.targetPackage,
        )
        assertEquals(
            DeviceActionDispatcher.EXPERIENCE_ACTIVITY,
            DeviceActionDispatcher.StockAction.PLAY_MUSIC.targetActivity,
        )
        assertEquals(
            DeviceActionDispatcher.StockAction.TICKLE,
            DeviceActionDispatcher.StockAction.fromWireName("tickle"),
        )
        assertEquals(
            DeviceActionDispatcher.TICKLE_PACKAGE,
            DeviceActionDispatcher.StockAction.TICKLE.targetPackage,
        )
        assertEquals(
            DeviceActionDispatcher.EXPERIENCE_ACTIVITY,
            DeviceActionDispatcher.StockAction.TICKLE.targetActivity,
        )
        assertEquals(
            "humaneinternal.system.intent.actions.tickle.TickleAction",
            DeviceActionDispatcher.StockAction.TICKLE.actionClass,
        )
        assertNull(DeviceActionDispatcher.StockAction.fromWireName("send_raw_sms"))
        assertNull(DeviceActionDispatcher.StockAction.fromWireName("place_call"))
        assertNull(
            DeviceActionDispatcher.StockAction.fromWireName(
                DeviceActionDispatcher.EMERGENCY_CLASSIFICATION_ACTION,
            ),
        )
    }

    @Test
    fun musicDiagnosticAcceptsOnlyBoundedCatalogText() {
        DeviceActionDispatcher.requireValidMusicText("Laugh Now Cry Later", "track")
        DeviceActionDispatcher.requireValidMusicText("Drake", "artist")

        assertFails { DeviceActionDispatcher.requireValidMusicText("   ", "track") }
        assertFails {
            DeviceActionDispatcher.requireValidMusicText(
                "x".repeat(DeviceActionDispatcher.MAX_MUSIC_TEXT_CHARS + 1),
                "track",
            )
        }
        assertFails {
            DeviceActionDispatcher.requireValidMusicText("song\u0000title", "track")
        }
    }

    @Test
    fun smsTestInputsAreStrictlyBounded() {
        DeviceActionDispatcher.requireValidRecipient("+4542493591")
        DeviceActionDispatcher.requireValidMessage("PenumbraOS stock SMS test")

        assertFails { DeviceActionDispatcher.requireValidRecipient("42493591") }
        assertFails { DeviceActionDispatcher.requireValidRecipient("+45; reboot") }
        assertFails { DeviceActionDispatcher.requireValidMessage("   ") }
        assertFails {
            DeviceActionDispatcher.requireValidMessage(
                "x".repeat(DeviceActionDispatcher.MAX_MESSAGE_CHARS + 1),
            )
        }
    }

    @Test
    fun stockDatabaseStateUsesSentCallbackSemantics() {
        assertEquals("pending", DeviceActionDispatcher.messageStateName(1))
        assertEquals("delivered_to_carrier", DeviceActionDispatcher.messageStateName(2))
        assertEquals("error", DeviceActionDispatcher.messageStateName(5))
        assertTrue(DeviceActionDispatcher.ACTION_INTENT.startsWith("humane.intent.action."))
        assertEquals("a", DeviceActionDispatcher.ACTION_EXTRA)
    }

    @Test
    fun messageStatusBoundaryMustBeRecentAndNotInTheFuture() {
        val now = 1_800_000_000_000L
        DeviceActionDispatcher.requireValidMessageStatusWindow(now, now)
        DeviceActionDispatcher.requireValidMessageStatusWindow(
            now - DeviceActionDispatcher.MAX_MESSAGE_STATUS_LOOKBACK_MS,
            now,
        )
        DeviceActionDispatcher.requireValidMessageStatusWindow(
            now + DeviceActionDispatcher.MAX_MESSAGE_STATUS_FUTURE_SKEW_MS,
            now,
        )
        assertFails { DeviceActionDispatcher.requireValidMessageStatusWindow(0L, now) }
        assertFails {
            DeviceActionDispatcher.requireValidMessageStatusWindow(
                now - DeviceActionDispatcher.MAX_MESSAGE_STATUS_LOOKBACK_MS - 1L,
                now,
            )
        }
        assertFails {
            DeviceActionDispatcher.requireValidMessageStatusWindow(
                now + DeviceActionDispatcher.MAX_MESSAGE_STATUS_FUTURE_SKEW_MS + 1L,
                now,
            )
        }
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected validation failure")
        } catch (_: IllegalArgumentException) {
        }
    }
}
