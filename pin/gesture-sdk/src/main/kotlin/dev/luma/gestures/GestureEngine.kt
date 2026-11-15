package dev.luma.gestures

import kotlin.math.abs
import kotlin.math.sign

data class GestureMatch(val feature: String, val fingers: Set<Finger>, val observeOnly: Boolean)

/**
 * INFERRED: a bounded release-confirmed recognizer, not a bit-for-bit Tickle port.
 * Stock FingerTracker.update supplies the five-sample baseline and 12 mm trigger.
 * Luma freezes that baseline for this projection session, uses an 8 mm release
 * threshold, and requires a held exact chord followed by 150 ms of neutral hand.
 * Loss is cancellation, never release. Call only from one serialized input lane.
 */
class GestureEngine(private val config: GestureConfig) {
    enum class Status { OFF, CALIBRATING, READY, HOLDING, CANCELLED }
    var status: Status = if (config.mode == GestureMode.OFF) Status.OFF else Status.CALIBRATING
        private set
    var curledFingers: Set<Finger> = emptySet()
        private set
    val candidateFeature: String? get() = candidate?.feature
    var holdProgress: Double = 0.0
        private set
    val releaseReady: Boolean get() = held && !requireNeutral

    private var previous: HandFrame? = null
    private val calibration = ArrayList<DoubleArray>(5)
    private var baseline: DoubleArray? = null
    private var candidate: GestureBinding? = null
    private var beganAt = 0L
    private var held = false
    private var neutralSince: Long? = null
    private var requireNeutral = false

    fun cancel() {
        previous = null
        calibration.clear()
        baseline = null
        curledFingers = emptySet()
        candidate = null
        held = false
        holdProgress = 0.0
        neutralSince = null
        requireNeutral = false
        status = if (config.mode == GestureMode.OFF) Status.OFF else Status.CANCELLED
    }

    fun accept(frame: HandFrame?): GestureMatch? {
        if (config.mode == GestureMode.OFF) return null
        val values = frame?.distances()
        if (frame == null || values == null || frame.sourceTimestamp <= 0 || frame.observedAtMs < 0) {
            cancel()
            return null
        }
        val last = previous
        if (last != null && (
                last.rightHand != frame.rightHand || frame.sourceTimestamp <= last.sourceTimestamp ||
                    frame.observedAtMs <= last.observedAtMs || frame.observedAtMs - last.observedAtMs > 250
                )) {
            cancel()
            return null
        }
        previous = frame
        val rest = baseline
        if (rest == null) {
            status = Status.CALIBRATING
            // INFERRED: a moving calibration cannot silently become a neutral pose.
            if (calibration.any { sample -> values.indices.any { abs(sample[it] - values[it]) > 3.0 } }) {
                calibration.clear()
            }
            calibration.add(values)
            if (calibration.size == 5) {
                baseline = DoubleArray(5) { digit -> calibration.map { it[digit] }.average() }
                status = Status.READY
            }
            return null
        }
        // INFERRED: orient each distance to its calibrated side of the plane so
        // mirrored hands share one closure convention. Never adapt away a slow curl.
        curledFingers = Finger.entries.filter { finger ->
            val displacement = (rest[finger.ordinal] - values[finger.ordinal]) * sign(rest[finger.ordinal])
            displacement >= if (finger in curledFingers) 8.0 else 12.0
        }.toSet()

        if (curledFingers.isEmpty()) {
            if (candidate != null && !held) {
                candidate = null
                requireNeutral = true
                status = Status.CANCELLED
            }
            val neutral = neutralSince ?: frame.observedAtMs.also { neutralSince = it }
            if (frame.observedAtMs - neutral < 150) return null
            val completed = candidate?.takeIf { held && !requireNeutral }
            candidate = null
            held = false
            holdProgress = 0.0
            requireNeutral = false
            status = Status.READY
            return completed?.let { GestureMatch(it.feature, it.fingers, config.mode == GestureMode.OBSERVE) }
        }
        neutralSince = null
        if (requireNeutral) return null
        val pending = candidate
        if (held && pending != null && pending.fingers.containsAll(curledFingers)) {
            // A chord's fingers need not open in the same sensor frame. An
            // extra finger still cancels below, and only fully neutral commits.
            status = Status.HOLDING
            return null
        }
        val binding = config.bindings.singleOrNull { it.fingers == curledFingers }
        if (binding == null && pending == null && config.bindings.any { it.fingers.containsAll(curledFingers) }) {
            // Entering a configured chord one finger at a time is not an action.
            status = Status.READY
            return null
        }
        if (binding == null || (candidate != null && candidate != binding)) {
            candidate = null
            held = false
            holdProgress = 0.0
            requireNeutral = true
            status = Status.CANCELLED
            return null
        }
        if (candidate == null) {
            candidate = binding
            beganAt = frame.observedAtMs
        }
        held = held || frame.observedAtMs - beganAt >= binding.holdMs
        holdProgress = ((frame.observedAtMs - beganAt).toDouble() / binding.holdMs).coerceIn(0.0, 1.0)
        status = Status.HOLDING
        return null
    }
}
