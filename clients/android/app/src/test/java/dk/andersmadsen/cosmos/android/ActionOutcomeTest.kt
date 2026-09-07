package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.ActionOutcome
import dk.andersmadsen.cosmos.android.action.DeclineReason
import dk.andersmadsen.cosmos.android.action.Evidence
import dk.andersmadsen.cosmos.android.action.Operation
import dk.andersmadsen.cosmos.android.action.PlaybackState
import dk.andersmadsen.cosmos.android.action.ReportOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionOutcomeTest {
    private val digest = "c".repeat(64)

    @Test
    fun aLaunchThisDeviceCannotObserveIsUnknownAndNeverCompleted() {
        val observed = ActionOutcome.open("com.android.chrome", launched = true, tookForeground = true)
        assertEquals(ReportOutcome.COMPLETED, observed.outcome)
        assertEquals(Evidence.Open("com.android.chrome", opened = true), observed.evidence)
        // startActivity returning proves a launch, not that anything opened.
        val unseen = ActionOutcome.open("com.android.chrome", launched = true, tookForeground = false)
        assertEquals(ReportOutcome.UNKNOWN, unseen.outcome)
        assertEquals(Evidence.Open("com.android.chrome", opened = false), unseen.evidence)
        // Nothing took it at all: that is a refusal with the declined evidence.
        val nothing = ActionOutcome.open(null, launched = false, tookForeground = false)
        assertEquals(ReportOutcome.REFUSED, nothing.outcome)
        assertEquals(Evidence.Declined(DeclineReason.NO_HANDLER), nothing.evidence)
    }

    @Test
    fun openingMapsIsNotNavigating() {
        val launched = ActionOutcome.route("com.google.android.apps.maps", launched = true, navigating = false)
        assertEquals(ReportOutcome.UNKNOWN, launched.outcome)
        assertEquals(Evidence.Route("com.google.android.apps.maps", launched = true, navigating = false), launched.evidence)
        val navigating = ActionOutcome.route("com.google.android.apps.maps", launched = true, navigating = true)
        assertEquals(ReportOutcome.COMPLETED, navigating.outcome)
        assertEquals(ReportOutcome.REFUSED, ActionOutcome.route(null, launched = false, navigating = false).outcome)
    }

    private fun playback(
        listener: Boolean = true,
        observed: ActionOutcome.Playback? = null,
        launched: Boolean = true,
    ) = ActionOutcome.playback("youtube", digest, "The Zone of Interest", launched, listener, observed)

    @Test
    fun withoutTheListenerGrantPlaybackIsAlwaysUnknown() {
        val report = playback(listener = false)
        assertEquals(ReportOutcome.UNKNOWN, report.outcome)
        assertEquals(Evidence.Playback("youtube", PlaybackState.LAUNCHED, 0, digest), report.evidence)
        // Even with a session in front of it, an ungranted listener sees nothing.
        val ignored = playback(
            listener = false,
            observed = ActionOutcome.Playback("The Zone of Interest", PlaybackState.PLAYING, 4200),
        )
        assertEquals(ReportOutcome.UNKNOWN, ignored.outcome)
    }

    @Test
    fun onlyAPlayingSessionOfTheBoundItemIsACompletion() {
        val playing = playback(observed = ActionOutcome.Playback("The Zone of Interest | Official Trailer (2025)", PlaybackState.PLAYING, 4200))
        assertEquals(ReportOutcome.COMPLETED, playing.outcome)
        assertEquals(Evidence.Playback("youtube", PlaybackState.PLAYING, 4200, digest), playing.evidence)
        // Buffering is not playing.
        val buffering = playback(observed = ActionOutcome.Playback("The Zone of Interest", PlaybackState.BUFFERING, 0))
        assertEquals(ReportOutcome.UNKNOWN, buffering.outcome)
        assertEquals(Evidence.Playback("youtube", PlaybackState.BUFFERING, 0, digest), buffering.evidence)
        // Something else is playing: that says nothing about the bound item.
        val other = playback(observed = ActionOutcome.Playback("Dune: Part Two", PlaybackState.PLAYING, 900))
        assertEquals(ReportOutcome.UNKNOWN, other.outcome)
        assertEquals(Evidence.Playback("youtube", PlaybackState.LAUNCHED, 0, digest), other.evidence)
        assertEquals(ReportOutcome.REFUSED, playback(launched = false).outcome)
    }

    @Test
    fun titlesAreComparedAfterNormalisationAndNeverByDigest() {
        assertTrue(ActionOutcome.titleMatches("The Zone of Interest | Official Trailer (2025)", "The Zone of Interest"))
        assertTrue(ActionOutcome.titleMatches("the  zone   of interest", "The Zone of Interest"))
        assertTrue(ActionOutcome.titleMatches("Amélie — bande-annonce", "Amelie"))
        assertFalse(ActionOutcome.titleMatches("Dune: Part Two", "The Zone of Interest"))
        assertFalse(ActionOutcome.titleMatches("The Zone of Interest", ""))
        assertEquals("the zone of interest official trailer 2025",
            ActionOutcome.normalise("The Zone of Interest | Official Trailer (2025)"))
    }

    @Test
    fun cancellingIsAPromiseAboutEvidence() {
        val operation = Operation.Route("place", "Restaurant Barr", "Strandgade 93", "55.673611", "12.596944")
        // Nothing started, so this device can prove it stopped nothing.
        val nothing = ActionOutcome.cancelled(operation, started = false)
        assertEquals(ReportOutcome.CANCELLED, nothing.outcome)
        assertEquals(Evidence.Route(null, launched = false, navigating = false), nothing.evidence)
        // A revoke does not un-open an application, so this can only be unknown.
        assertEquals(ReportOutcome.UNKNOWN, ActionOutcome.cancelled(operation, started = true).outcome)
    }

    @Test
    fun aFailureStillCarriesEvidenceThatBelongsToItsChannel() {
        val play = Operation.Play("The Zone of Interest", "trailer", listOf("youtube"), digest)
        val failed = ActionOutcome.failed(play)
        assertEquals(ReportOutcome.FAILED, failed.outcome)
        assertEquals(Evidence.Playback("youtube", PlaybackState.LAUNCHED, 0, digest), failed.evidence)
        val open = Operation.Open(dk.andersmadsen.cosmos.android.action.Locator.Https("https://github.com/x"), null, null, "PR")
        assertEquals(Evidence.Open(null, opened = false), ActionOutcome.failed(open).evidence)
        // A shape this build cannot carry out is a refusal, not a failure.
        assertEquals(ReportOutcome.REFUSED, ActionOutcome.failed(Operation.Unsupported("run")).outcome)
    }

    @Test
    fun writesTheExactWireShapeTheNativeLibraryParses() {
        assertEquals(
            """{"outcome":"refused","evidence":{"kind":"declined","reason":"not_permitted"}}""",
            ActionOutcome.refused(DeclineReason.NOT_PERMITTED).json(),
        )
        assertEquals(
            """{"outcome":"unknown","evidence":{"kind":"route","launched":true,"navigating":false,"resolvedApp":"com.google.android.apps.maps"}}""",
            ActionOutcome.route("com.google.android.apps.maps", launched = true, navigating = false).json(),
        )
        assertEquals(
            """{"outcome":"completed","evidence":{"kind":"playback","provider":"youtube","state":"playing","positionMs":4200,"itemDigest":"$digest"}}""",
            playback(observed = ActionOutcome.Playback("The Zone of Interest", PlaybackState.PLAYING, 4200)).json(),
        )
    }
}
