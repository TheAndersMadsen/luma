package dev.luma.gestures

import java.net.URI
import java.util.Locale

enum class ClipVisualStage { PUBLISHER, PENDING, TITLE, DETAILS, FAILURE }
enum class ClipPublisherMark { NEW_YORK_TIMES, INITIAL }
data class ClipPresentation(val stage: ClipVisualStage, val text: String?, val publisherMark: ClipPublisherMark, val publisherInitial: String)

/**
 * INFERRED presentation timing from the supplied demo. Recognition itself is
 * stock Button2/ControlView native press input, not a second pinch classifier.
 * A fresh tracked mesh gates that press; loss cancels visuals, never commits.
 */
class ClipMotion {
    private var began: Long? = null
    private var baseline = 0.0
    private var last: HandFrame? = null
    private var cancelled = false
    private var pulledAt: Long? = null
    private var details = false
    var held = true
    val started: Boolean get() = began != null
    val visible: Boolean get() = started && !cancelled

    fun press(frame: HandFrame?, projectable: Boolean, now: Long): Boolean {
        if (started || cancelled || !fresh(frame, projectable, now)) return false
        began = now; baseline = requireNotNull(frame).points[9].length(); last = frame
        return true
    }

    fun accept(frame: HandFrame?, projectable: Boolean, now: Long) {
        if (!visible) return
        val previous = last
        if (!fresh(frame, projectable, now) || previous == null || frame!!.rightHand != previous.rightHand ||
            frame.sourceTimestamp <= previous.sourceTimestamp || frame.observedAtMs <= previous.observedAtMs || frame.observedAtMs - previous.observedAtMs > 250) {
            cancel(); return
        }
        last = frame
        if (held && baseline - frame.points[9].length() >= 35) {
            val since = pulledAt ?: now.also { pulledAt = it }
            details = now - since >= 150
        } else if (!held || baseline - frame.points[9].length() < 20) { pulledAt = null; details = false }
    }

    fun cancel() { cancelled = true; details = false }

    fun presentation(snapshot: ClipSnapshot, now: Long): ClipPresentation? {
        if (!visible) return null
        val age = now - requireNotNull(began)
        if (age < 500) return null
        val host = runCatching { URI(snapshot.article.url).host?.lowercase(Locale.ROOT) }.getOrNull().orEmpty()
        val mark = if (host == "nytimes.com" || host.endsWith(".nytimes.com")) ClipPublisherMark.NEW_YORK_TIMES else ClipPublisherMark.INITIAL
        val publisher = snapshot.article.publisher.ifBlank { "Luma Clip" }
        val initial = publisher.substring(0, publisher.offsetByCodePoints(0, 1)).uppercase(Locale.ROOT)
        val (stage, text) = when {
            snapshot.phase == "failed" -> ClipVisualStage.FAILURE to "Couldn’t save"
            snapshot.phase == "unconfirmed" || (age >= 15_000 && snapshot.phase != "saved") -> ClipVisualStage.FAILURE to "Copy not confirmed"
            age < 2500 -> ClipVisualStage.PUBLISHER to null
            snapshot.phase != "saved" -> ClipVisualStage.PENDING to "Copying…"
            details -> ClipVisualStage.DETAILS to (snapshot.article.title + "\n\n" + snapshot.article.selection.take(160).ifBlank { snapshot.article.url })
            else -> ClipVisualStage.TITLE to snapshot.article.title
        }
        return ClipPresentation(stage, text, mark, initial)
    }

    private fun fresh(frame: HandFrame?, projectable: Boolean, now: Long): Boolean =
        projectable && frame != null && now >= frame.observedAtMs && now - frame.observedAtMs <= 250 &&
            frame.sourceTimestamp > 0 && frame.distances() != null
}
