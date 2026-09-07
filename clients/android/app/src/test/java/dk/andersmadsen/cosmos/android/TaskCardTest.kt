package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.ActionOutcome
import dk.andersmadsen.cosmos.android.action.DeclineReason
import dk.andersmadsen.cosmos.android.action.Description
import dk.andersmadsen.cosmos.android.action.Locator
import dk.andersmadsen.cosmos.android.action.Operation
import dk.andersmadsen.cosmos.android.action.PlaybackState
import dk.andersmadsen.cosmos.android.action.TaskCards
import dk.andersmadsen.cosmos.android.action.TaskStage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskCardTest {
    private val link = Operation.Open(Locator.Https("https://github.com/owner/repo/pull/412"), null, null, "PR 412")
    private val route = Operation.Route("place", "Restaurant Barr", "Strandgade 93", "55.673611", "12.596944")
    private val play = Operation.Play("The Zone of Interest", "The Zone of Interest trailer", listOf("youtube"), "c".repeat(64))

    @Test
    fun aRunningCommandIsOneStateWordOneSentenceAnElapsedTimeAndCancelTask() {
        val card = TaskCards.card(TaskStage.Working(route, 14_000), "this phone")!!
        assertEquals("Working", card.state)
        assertEquals("Starting directions to Restaurant Barr", card.sentence)
        assertEquals("0:14", card.elapsed)
        assertTrue(card.canCancel)
        assertNull(card.next)
        assertEquals("Opening PR 412", TaskCards.card(TaskStage.Working(link, 0), "this phone")?.sentence)
        assertEquals("Starting The Zone of Interest", TaskCards.card(TaskStage.Working(play, 0), "this TV")?.sentence)
    }

    @Test
    fun aCeremonyOnScreenIsWaitingForYou() {
        val description = Description("run", "Project tests", "macos", "It changes files in that project.", "private")
        val card = TaskCards.card(TaskStage.Confirming(description), "this phone")!!
        assertEquals("Waiting for you", card.state)
        assertEquals("Confirm to run Project tests.", card.sentence)
        assertFalse(card.canCancel)
    }

    @Test
    fun onlyAnObservedEffectReadsAsCompleted() {
        val opened = TaskStage.Reported(link, ActionOutcome.open("com.android.chrome", launched = true, tookForeground = true))
        assertEquals(TaskCards.card(opened, "this phone"), dk.andersmadsen.cosmos.android.action.TaskCard("Completed", "It's open on this phone."))
        val playing = TaskStage.Reported(play, ActionOutcome.playback(
            "youtube", "c".repeat(64), "The Zone of Interest", launched = true, listenerGranted = true,
            observed = ActionOutcome.Playback("The Zone of Interest | Trailer", PlaybackState.PLAYING, 4200),
        ))
        assertEquals("Playing on this TV.", TaskCards.card(playing, "this TV", explain = false)?.sentence)
    }

    @Test
    fun anUnobservedEffectSaysSoInPlainWords() {
        val unknown = TaskStage.Reported(route, ActionOutcome.route("com.google.android.apps.maps", launched = true, navigating = false))
        val card = TaskCards.card(unknown, "this phone")!!
        assertEquals("Cannot confirm", card.state)
        assertEquals("I opened it on this phone — I can't confirm navigation started.", card.sentence)
        assertFalse(card.canCancel)
        val playback = TaskStage.Reported(play, ActionOutcome.playback(
            "youtube", "c".repeat(64), "The Zone of Interest", launched = true, listenerGranted = false, observed = null,
        ))
        assertEquals("I started it on this TV — I can't confirm it's playing.", TaskCards.card(playback, "this TV")?.sentence)
    }

    @Test
    fun aRefusalIsNotDoneWithOneSentenceOnEachThing() {
        val refused = TaskStage.Reported(link, ActionOutcome.refused(DeclineReason.NOT_PERMITTED))
        val card = TaskCards.card(refused, "this phone")!!
        assertEquals("Not done", card.state)
        assertEquals("This phone has not been allowed to do that.", card.sentence)
        assertEquals("Allow it in Center → Devices, then ask again.", card.next)
        val nothing = TaskStage.Reported(link, ActionOutcome.refused(DeclineReason.NO_HANDLER))
        assertEquals("Nothing on this phone can open that.", TaskCards.card(nothing, "this phone")?.sentence)
        assertEquals("Install an app that opens it, then ask again.", TaskCards.card(nothing, "this phone")?.next)
        val stopped = TaskStage.Reported(route, ActionOutcome.cancelled(route, started = false))
        assertEquals("Not done", TaskCards.card(stopped, "this phone")?.state)
        assertEquals("Stopped when you asked for something else.", TaskCards.card(stopped, "this phone")?.sentence)
    }

    @Test
    fun aTelevisionNeverExplainsARefusal() {
        for (reason in DeclineReason.entries) {
            val refused = TaskStage.Reported(play, ActionOutcome.refused(reason))
            assertNull(TaskCards.card(refused, "this TV", explain = false))
        }
        val cancelled = TaskStage.Reported(play, ActionOutcome.cancelled(play, started = false))
        assertNull(TaskCards.card(cancelled, "this TV", explain = false))
        // It still says what it is doing, and still admits what it cannot confirm.
        assertEquals("Working", TaskCards.card(TaskStage.Working(play, 0), "this TV", explain = false)?.state)
        val unknown = TaskStage.Reported(play, ActionOutcome.playback(
            "youtube", "c".repeat(64), "The Zone of Interest", launched = true, listenerGranted = false, observed = null,
        ))
        val card = TaskCards.card(unknown, "this TV", explain = false)!!
        assertEquals("Cannot confirm", card.state)
        assertNull(card.sentence)
    }

    @Test
    fun elapsedTimeReadsAsAClock() {
        assertEquals("0:00", TaskCards.elapsed(0))
        assertEquals("0:00", TaskCards.elapsed(-5_000))
        assertEquals("0:09", TaskCards.elapsed(9_400))
        assertEquals("1:05", TaskCards.elapsed(65_000))
        assertEquals("99:59", TaskCards.elapsed(1_000_000_000))
    }
}
