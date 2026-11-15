package com.penumbraos.hook

import dev.luma.gestures.HandFrame
import dev.luma.gestures.Point3
import java.lang.reflect.Field

/**
 * Stock HandTrackingSummary / HandState public fields, consumed by Tickle's
 * FlatHandCallback.onHandTrackingSummary. Copy only the bounded skeleton; never
 * retain a Binder object or assume the prototype's fixed projection mesh size.
 */
internal class StockHandFrameReader {
    private val fields = HashMap<Pair<Class<*>, String>, Field>()
    private fun field(value: Any, name: String): Any? = fields.getOrPut(value.javaClass to name) {
        value.javaClass.getField(name)
    }.get(value)

    data class Sample(val frame: HandFrame?, val projectable: Boolean)

    fun read(summary: Any, observedAtMs: Long, projectable: Boolean): HandFrame? =
        sample(summary, observedAtMs, projectable).let { if (it.projectable) it.frame else null }

    @Synchronized
    fun sample(summary: Any, observedAtMs: Long, projectionActive: Boolean): Sample = try {
        val hands = listOfNotNull(field(summary, "left"), field(summary, "right")).filter {
            field(it, "detected") == true && field(it, "isHand") == true
        }
        // INFERRED: ambiguity cancels; never silently switch between two hands.
        val hand = hands.singleOrNull()
        if (hand == null) Sample(null, false) else {
            // Stock ndkhandtracking stateToAidlHandStateV2 aliases hasFlatHand to tracked.
            // TickleGestureService.FlatHandCallback also checks projection3D.
            // Keep tracked landmarks for inspection when the native mesh rejects
            // a pose, but never feed that pose to an actionable recognizer.
            val mesh = field(hand, "projection3D") as? FloatArray
            val width = field(hand, "meshWidth") as? Int ?: 0
            val height = field(hand, "meshHeight") as? Int ?: 0
            val projectable = projectionActive && mesh != null && width in 2..128 && height in 2..128 &&
                mesh.size == width * height * 3 && mesh.all { it.isFinite() }
            val count = field(hand, "numHandKeypoints") as? Int
            val xyz = field(hand, "handKeypoints3D") as? FloatArray
            val timestamp = field(summary, "timestamp") as? Long
            val right = field(hand, "isRightHand") as? Boolean
            if (count == null || count !in 25..128 || xyz == null || xyz.size != count * 3 ||
                xyz.any { !it.isFinite() || kotlin.math.abs(it) > 10_000 } || timestamp == null || right == null
            ) Sample(null, false) else Sample(
                HandFrame(observedAtMs, timestamp, right, List(count) { index ->
                    Point3(xyz[index * 3].toDouble(), xyz[index * 3 + 1].toDouble(), xyz[index * 3 + 2].toDouble())
                }), projectable,
            )
        }
    } catch (_: Exception) { Sample(null, false) }
}
