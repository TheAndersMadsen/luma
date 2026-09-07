package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.Attestation
import dk.andersmadsen.cosmos.android.action.Ceremony
import dk.andersmadsen.cosmos.android.action.CeremonyEvent
import dk.andersmadsen.cosmos.android.action.CeremonyState
import dk.andersmadsen.cosmos.android.action.Confirmation
import dk.andersmadsen.cosmos.android.action.Description
import dk.andersmadsen.cosmos.android.action.Risk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class CeremonyTest {
    private val confirmation = Confirmation(
        grantId = UUID.fromString("11111111-1111-4111-8111-111111111111"),
        actionId = UUID.fromString("22222222-2222-4222-8222-222222222222"),
        turnId = UUID.fromString("33333333-3333-4333-8333-333333333333"),
        generation = 7,
        description = Description("open", "PR 412", "android", "It opens a link in your browser.", "shared_room"),
        descriptionDigest = "9".repeat(64),
        risk = Risk.MODERATE,
        attestation = Attestation.FOREGROUND_TAP,
        privacy = "shared_room",
        expiresAtMs = 30_000,
    )

    @Test
    fun onlyADeliberateTapAnswersIt() {
        val asking = Ceremony.open(confirmation, 0)
        assertEquals(CeremonyState.ASKING, asking.state)
        assertTrue(asking.showing)
        val granted = asking.on(CeremonyEvent.Confirm)
        assertEquals(CeremonyState.ANSWERED, granted.state)
        assertEquals(true, granted.answer?.granted)
        // A tap is the only evidence this device can obtain, and it says so.
        assertEquals(Attestation.FOREGROUND_TAP, granted.answer?.attestation)
        val declined = asking.on(CeremonyEvent.Decline)
        assertEquals(CeremonyState.ANSWERED, declined.state)
        assertEquals(false, declined.answer?.granted)
        assertNull(declined.answer?.attestation)
    }

    @Test
    fun backDismissesThePanelWithoutAnsweringIt() {
        val dismissed = Ceremony.open(confirmation, 0).on(CeremonyEvent.Back)
        assertEquals(CeremonyState.DISMISSED, dismissed.state)
        assertNull(dismissed.answer)
        assertFalse(dismissed.showing)
        // And a later tap cannot answer a question that is no longer on screen.
        assertEquals(dismissed, dismissed.on(CeremonyEvent.Confirm))
        assertNull(dismissed.on(CeremonyEvent.Confirm).answer)
    }

    @Test
    fun oneCeremonyTakesOneAnswer() {
        val granted = Ceremony.open(confirmation, 0).on(CeremonyEvent.Confirm)
        assertEquals(granted, granted.on(CeremonyEvent.Decline))
        assertEquals(granted, granted.on(CeremonyEvent.Back))
        assertEquals(granted, granted.on(CeremonyEvent.Elapsed(40_000)))
    }

    @Test
    fun theCountdownRunsOutIntoADenialAndIsVisibleWhileItRuns() {
        val asking = Ceremony.open(confirmation, 0)
        assertEquals(30, asking.secondsLeft(0))
        assertEquals(15, asking.secondsLeft(15_000))
        assertEquals(1, asking.secondsLeft(29_600))
        assertEquals(0, asking.secondsLeft(30_000))
        assertEquals(0, asking.secondsLeft(45_000))
        assertEquals(asking, asking.on(CeremonyEvent.Elapsed(29_999)))
        val expired = asking.on(CeremonyEvent.Elapsed(30_000))
        assertEquals(CeremonyState.EXPIRED, expired.state)
        assertNull(expired.answer)
        // A ceremony that arrives already expired is never shown.
        assertEquals(CeremonyState.EXPIRED, Ceremony.open(confirmation, 30_001).state)
    }

    @Test
    fun aCeremonyThisDeviceCannotProveIsNeverShownAndNeverAnswered() {
        val owner = confirmation.copy(attestation = Attestation.DEVICE_OWNER_AUTH, risk = Risk.HIGH)
        val unavailable = Ceremony.open(owner, 0)
        assertEquals(CeremonyState.UNAVAILABLE, unavailable.state)
        assertFalse(unavailable.showing)
        assertNull(unavailable.on(CeremonyEvent.Confirm).answer)
        assertEquals(CeremonyState.UNAVAILABLE, unavailable.on(CeremonyEvent.Confirm).state)
    }
}
