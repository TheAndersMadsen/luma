package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the Tickle home NavigateCard label -> target mapping.
 *
 * The launch itself runs inside an Xposed hook and needs the on-device runtime,
 * so it is not unit-testable; the label->target DECISION is pure and is the part
 * that has silently broken before (a card pointed at a package that does not
 * exist on the Pin). These tests guard that decision.
 */
class TickleLauncherHooksTest {
    @Test
    fun `message card opens the Humane messages experience, not AOSP mms`() {
        // Regression guard. The card used to target com.android.mms. That package
        // is present and launchable on the Pin (device-confirmed:
        // com.android.mms.ui.ConversationList), so the old tap opened the raw AOSP
        // MMS app — a touchscreen UI, wrong for the screenless laser projector and
        // inconsistent with every other card. It must open the Pin-native stock
        // messaging experience instead.
        assertEquals(
            TickleCardTarget.Experience("humane.experience.messages"),
            resolveTickleCardTarget("message"),
        )
    }

    @Test
    fun `listen and settings cards open their stock experiences`() {
        assertEquals(
            TickleCardTarget.Experience("humane.experience.music"),
            resolveTickleCardTarget("listen"),
        )
        assertEquals(
            TickleCardTarget.Experience("humane.experience.settings"),
            resolveTickleCardTarget("settings"),
        )
    }

    @Test
    fun `call and capture stay generic system-resolved actions`() {
        // These deliberately do NOT name a package: the Pin resolves the dialer
        // and camera itself. Encoding a fixed package is exactly what broke the
        // message card, so this asserts they remain SystemAction, not Experience.
        assertEquals(TickleCardTarget.SystemAction("dial"), resolveTickleCardTarget("call"))
        assertEquals(TickleCardTarget.SystemAction("camera"), resolveTickleCardTarget("capture"))
    }

    @Test
    fun `unowned labels keep stock behavior`() {
        // "r*ck" (the in-app music game) has its own working stock Runnable and
        // must be left alone; anything unrecognized is likewise not overridden.
        assertEquals(TickleCardTarget.Stock, resolveTickleCardTarget("r*ck"))
        assertEquals(TickleCardTarget.Stock, resolveTickleCardTarget(""))
        assertEquals(TickleCardTarget.Stock, resolveTickleCardTarget("something-else"))
    }
}
