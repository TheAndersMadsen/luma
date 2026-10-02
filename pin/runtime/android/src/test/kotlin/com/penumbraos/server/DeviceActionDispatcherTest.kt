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

}
