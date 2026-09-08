package dk.andersmadsen.cosmos.android.action

import java.text.Normalizer

/**
 * What this device is allowed to say about what it did.
 *
 * `unknown` is an honest and common outcome here and it is never rounded up.
 * Android tells an app that an activity started; it does not tell it that a
 * page loaded, that navigation began, or that a player is playing. So a launch
 * this device cannot observe further is `unknown` with the launch recorded,
 * and only an observation — the launched app taking the foreground, or a media
 * session actually playing the bound item — can carry a completion.
 */
object ActionOutcome {
    /** What a media session told the notification listener, if anything. */
    data class Playback(val title: String, val state: PlaybackState, val positionMs: Long)

    /**
     * Opening a link. `opened` means the handler took the screen: the intent
     * resolved to an application and this app observed its own foreground go
     * away to it. Anything less is a launch, not an opening.
     */
    fun open(resolvedApp: String?, launched: Boolean, tookForeground: Boolean): Report = when {
        !launched -> refused(DeclineReason.NO_HANDLER)
        tookForeground -> Report(ReportOutcome.COMPLETED, Evidence.Open(resolvedApp, opened = true))
        else -> Report(ReportOutcome.UNKNOWN, Evidence.Open(resolvedApp, opened = false))
    }

    /**
     * Starting navigation. Launching Maps is not navigating, and this phone
     * cannot see another application's screen, so `navigating` is true only
     * where the platform itself gave that evidence.
     */
    fun route(resolvedApp: String?, launched: Boolean, navigating: Boolean): Report = when {
        !launched -> refused(DeclineReason.NO_HANDLER)
        navigating -> Report(ReportOutcome.COMPLETED, Evidence.Route(resolvedApp, launched = true, navigating = true))
        else -> Report(ReportOutcome.UNKNOWN, Evidence.Route(resolvedApp, launched = true, navigating = false))
    }

    /**
     * Playback on the television. Without the notification-listener grant this
     * device cannot observe a media session at all, so the honest report is
     * always `unknown` — a player launch is not playback. A title match in the
     * exact provider's session is diagnostic only: this search-based command
     * carries no media identity that could prove the selected item or trailer.
     */
    fun playback(
        provider: String,
        itemDigest: String,
        boundTitle: String,
        launched: Boolean,
        listenerGranted: Boolean,
        observed: Playback?,
    ): Report {
        if (!launched) return refused(DeclineReason.NO_HANDLER)
        val unknown = { state: PlaybackState, position: Long ->
            Report(ReportOutcome.UNKNOWN, Evidence.Playback(provider, state, position.coerceIn(0, MAX_POSITION_MS), itemDigest))
        }
        if (!listenerGranted || observed == null) return unknown(PlaybackState.LAUNCHED, 0)
        if (!titleMatches(observed.title, boundTitle)) return unknown(PlaybackState.LAUNCHED, 0)
        return unknown(observed.state, observed.positionMs)
    }

    /** Another app's session, or two from this app, cannot answer this command. */
    fun <T> uniqueSession(sessions: List<T>, expectedPackage: String?, packageName: (T) -> String): T? =
        if (expectedPackage.isNullOrEmpty()) null
        else sessions.filter { packageName(it) == expectedPackage }.singleOrNull()

    /**
     * A revoke supersedes remaining work; it does not un-open an application.
     * So cancelling is a promise about evidence: `cancelled` only where this
     * device can prove nothing started, and `unknown` once something has.
     */
    fun cancelled(operation: Operation, started: Boolean): Report =
        report(if (started) ReportOutcome.UNKNOWN else ReportOutcome.CANCELLED, operation, started)

    /** Attempted and could not be carried out; the evidence still fits the channel. */
    fun failed(operation: Operation): Report = report(ReportOutcome.FAILED, operation, started = false)

    private fun report(outcome: ReportOutcome, operation: Operation, started: Boolean): Report {
        val evidence = when (operation) {
            is Operation.Open -> Evidence.Open(null, opened = false)
            is Operation.Route -> Evidence.Route(null, launched = started, navigating = false)
            is Operation.Play -> Evidence.Playback(
                operation.providers.firstOrNull() ?: "unknown", PlaybackState.LAUNCHED, 0, operation.itemDigest,
            )
            // Nothing here can carry that out at all, which is a refusal.
            is Operation.Unsupported -> return refused(DeclineReason.NO_HANDLER)
        }
        return Report(outcome, evidence)
    }

    fun refused(reason: DeclineReason): Report = Report(ReportOutcome.REFUSED, Evidence.Declined(reason))

    /**
     * Real player metadata reads "The Zone of Interest | Official Trailer
     * (2025)", so this is a normalised containment and never a digest
     * comparison: case, accents, punctuation and runs of whitespace are
     * flattened on both sides. This can also match sequels, commentary and
     * advertisements, so it is never evidence of the requested media identity.
     */
    fun titleMatches(observed: String, bound: String): Boolean {
        val wanted = normalise(bound)
        return wanted.isNotEmpty() && normalise(observed).contains(wanted)
    }

    fun normalise(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFKD)
        .filterNot { it.code in 0x0300..0x036F }
        .lowercase()
        .map { if (it.isLetterOrDigit()) it else ' ' }
        .joinToString("")
        .trim()
        .replace(WHITESPACE, " ")

    private val WHITESPACE = Regex("\\s+")
    private const val MAX_POSITION_MS = 86_400_000L
}
