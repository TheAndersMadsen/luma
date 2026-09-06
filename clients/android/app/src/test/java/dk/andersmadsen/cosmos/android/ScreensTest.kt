package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.ui.AssistantState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class ScreensTest {
    private val descriptor = Descriptor("11111111-1111-4111-8111-111111111111", "k", "android", NativeEvent.APPROVAL)
    private val turn = UUID.fromString("44444444-4444-4444-8444-444444444444")
    private val card = DisplayCard(UUID.fromString("33333333-3333-4333-8333-333333333333"), turn, 2, "a".repeat(64), 1000, DisplayContent.Text("An answer."))

    @Test
    fun choosesSetupApproveOrSessionFromTheInstallationState() {
        assertEquals(Screen.SETUP, SurfaceState().screen())
        assertEquals(Screen.SETUP, SurfaceState(phase = Phase.PREPARING).screen())
        assertEquals(Screen.APPROVE, SurfaceState(phase = Phase.PREPARED, descriptor = descriptor).screen())
        assertEquals(Screen.SESSION, SurfaceState(phase = Phase.PREPARED, descriptor = descriptor, approved = true).screen())
        assertEquals(Screen.SESSION, SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor).screen())
        assertEquals(Screen.APPROVE, SurfaceState(phase = Phase.BLOCKED, descriptor = descriptor).screen())
    }

    @Test
    fun reportsConnectedReconnectingOrDisconnected() {
        assertEquals(SessionStatus.CONNECTED, SurfaceState(phase = Phase.CONNECTED, connectionWanted = true).sessionStatus())
        assertEquals(SessionStatus.RECONNECTING, SurfaceState(phase = Phase.PREPARED, needsReconnect = true, connectionWanted = true).sessionStatus())
        assertEquals(SessionStatus.DISCONNECTED, SurfaceState(phase = Phase.PREPARED, descriptor = descriptor).sessionStatus())
        assertEquals("Reconnecting…", SessionStatus.RECONNECTING.label)
    }

    @Test
    fun mirrorsPlaybackAndCommandsOnTheWaveform() {
        assertEquals(AssistantState.SPEAKING, SurfaceState(speaking = true, busy = true).assistantState())
        assertEquals(AssistantState.THINKING, SurfaceState(busy = true, alert = true).assistantState())
        assertEquals(AssistantState.ERROR, SurfaceState(alert = true).assistantState())
        assertEquals(AssistantState.ERROR, SurfaceState(phase = Phase.BLOCKED).assistantState())
        assertEquals(AssistantState.IDLE, SurfaceState(phase = Phase.CONNECTED).assistantState())
    }

    @Test
    fun noticesFailuresPendingWorkAndFreshFeedbackButNotSteadyState() {
        val connected = SurfaceState(phase = Phase.CONNECTED, operation = "connect", message = "Cosmos confirmed the connection.")
        assertNull(connected.notice())
        assertNull(connected.copy(operation = "heartbeat").notice())
        assertNull(connected.copy(operation = "prepare", pendingOpen = true, hasPending = true).notice())
        assertEquals("Cosmos confirmed the connection.", connected.copy(alert = true).notice())
        assertEquals("Cosmos confirmed the connection.", connected.copy(phase = Phase.BLOCKED).notice())
        assertEquals("Cosmos confirmed the connection.", connected.copy(hasPending = true).notice())
        // An abandoned operation gets its own standing line rather than echoing the current message.
        assertNull(connected.copy(hasUnknownOutcome = true).notice())
        assertTrue(UNKNOWN_OUTCOME_NOTICE.startsWith("A previous request has an unknown outcome."))
        assertEquals("Admitted.", connected.copy(operation = "send_text", message = "Admitted.").notice())
        assertEquals("Gone.", connected.copy(operation = "disconnect", message = "Gone.").notice())
    }

    @Test
    fun offersCancelOnlyWhileTheAdmissionIsTheFreshestSnapshot() {
        val admitted = SurfaceState(phase = Phase.CONNECTED, operation = "send_text", admission = Admission(turn, 1, false))
        assertTrue(admitted.offersCancel())
        assertFalse(admitted.copy(operation = "heartbeat").offersCancel())
        assertFalse(admitted.copy(busy = true).offersCancel())
        assertFalse(admitted.copy(admission = null).offersCancel())
    }

    @Test
    fun stagesTheTvFromItsOwnRequestThenTheReplyForThatTurn() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        assertEquals(TvStage.Idle, connected.tvStage(null))
        // Sending: Working until Cosmos admits the request as a new turn, whatever admission the connection already carried.
        val earlier = Admission(UUID.fromString("22222222-2222-4222-8222-222222222222"), 1, false)
        val request = TvRequest("how many goals has he scored this season?", turnBefore = earlier.turnId)
        assertEquals(TvStage.Working, connected.copy(admission = earlier).tvStage(request))
        assertEquals(TvStage.Working, connected.copy(admission = earlier, busy = true).tvStage(request.copy(sending = true)))
        // Admitted: the transcript stays until the card or spoken reply for that turn arrives; an older card does not count.
        val admitted = connected.copy(admission = Admission(turn, 2, false), operation = "send_text")
        assertEquals(TvStage.Transcript(request.text), admitted.tvStage(request.copy(sending = true)))
        val older = card.copy(actionId = UUID.fromString("77777777-7777-4777-8777-777777777777"), turnId = earlier.turnId)
        assertEquals(TvStage.Transcript(request.text), admitted.copy(display = older).tvStage(request))
        assertEquals(TvStage.Answer(card.actionId, "An answer.", "An answer.", card), admitted.copy(display = card).tvStage(request))
        val speech = SpeechReply(UUID.fromString("55555555-5555-4555-8555-555555555555"), turn, 3, "b".repeat(64), 1000, "Five goals.", "audio/mpeg", 10)
        assertEquals(TvStage.Answer(speech.actionId, "Five goals.", "Five goals."), admitted.copy(speech = speech).tvStage(request))
        // A send that settled without a new admission is dropped.
        assertEquals(TvStage.Idle, connected.copy(admission = earlier, alert = true, operation = "send_text").tvStage(request.copy(sending = true)))
    }

    @Test
    fun captionsCurrentRepliesButNeverPrivateCardsOrDismissedOnes() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor, admission = Admission(turn, 2, false))
        assertEquals(TvStage.Answer(card.actionId, "An answer.", "An answer.", card), connected.copy(display = card).tvStage(null))
        assertEquals(TvStage.Idle, connected.copy(display = card).tvStage(null, dismissed = card.actionId))
        assertEquals(TvStage.Idle, connected.copy(display = card.copy(privacy = "private")).tvStage(null))
        assertEquals(TvStage.Transcript("q"), connected.copy(display = card.copy(privacy = "near_user")).tvStage(TvRequest("q", null)))
        // Place cards caption their query; the list and credits wait in the paged view.
        val places = card.copy(content = DisplayContent.Places("Café", listOf(PlaceItem("one", "Café", "1 Main Street", null)), emptyList()))
        val stage = connected.copy(display = places).tvStage(null) as TvStage.Answer
        assertEquals("Café", stage.caption)
        assertEquals("Café\n\n1. Café\n1 Main Street", stage.full)
        // Housekeeping commands do not stage anything: a busy connection with no request stays idle.
        assertEquals(TvStage.Idle, connected.copy(busy = true).tvStage(null))
    }

    @Test
    fun labelsTheServerByHost() {
        assertEquals("center.andersmadsen.dk", serverLabel("https://center.andersmadsen.dk/"))
        assertEquals("center.example:8443", serverLabel(" https://center.example:8443 "))
    }

    @Test
    fun pagesWholeLinesWithoutShrinking() {
        assertEquals(listOf(0..2, 3..5, 6..6), pageRanges(7, 3))
        assertEquals(listOf(0..3), pageRanges(4, 4))
        assertEquals(listOf(0..0, 1..1), pageRanges(2, 0))
        assertEquals(listOf(0..0), pageRanges(0, 3))
    }

    @Test
    fun flattensCardsToPlainLinesWithCreditTextOnly() {
        assertEquals("An answer.", card.content.plainText())
        val places = DisplayContent.Places("Café", listOf(PlaceItem("one", "Café", "1 Main Street", "https://maps.example/one")),
            listOf(listOf(CreditPart.Text("Credit: "), CreditPart.Link("Map", "https://credits.example"))))
        assertEquals("Café\n\n1. Café\n1 Main Street\n\nGoogle Maps · Credit: Map", places.plainText())
        assertEquals("Café\n\nNo matching places found.", DisplayContent.Places("Café", emptyList(), emptyList()).plainText())
    }
}
