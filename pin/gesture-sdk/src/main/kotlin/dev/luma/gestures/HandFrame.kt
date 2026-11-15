package dev.luma.gestures

import kotlin.math.sqrt

/** Stock humane.experience.tickle.gesture.Hand.<init>: four joints per digit, wrist=0. */
enum class Finger(val rootIndex: Int, val tipIndex: Int) {
    THUMB(1, 4), INDEX(5, 8), MIDDLE(9, 12), RING(13, 16), PINKY(17, 20),
}

data class Point3(val x: Double, val y: Double, val z: Double) {
    operator fun minus(other: Point3) = Point3(x - other.x, y - other.y, z - other.z)
    operator fun plus(other: Point3) = Point3(x + other.x, y + other.y, z + other.z)
    operator fun times(scale: Double) = Point3(x * scale, y * scale, z * scale)
    fun dot(other: Point3) = x * other.x + y * other.y + z * other.z
    fun cross(other: Point3) = Point3(y * other.z - z * other.y, z * other.x - x * other.z, x * other.y - y * other.x)
    fun length() = sqrt(dot(this))
    fun isFinite() = x.isFinite() && y.isFinite() && z.isFinite()
    internal fun normalized(): Point3? = length().takeIf { it.isFinite() && it > 0.0001 }?.let { this * (1.0 / it) }
}

/**
 * Snapshot of ONE tracked hand. The adapter gates projection separately.
 * Coordinate units follow stock FingerTracker's
 * millimetres. Native timestamp is opaque and used only for ordering; observedAtMs
 * is the adapter's monotonic clock. Loss/ambiguity is represented by a null frame.
 * No per-joint confidence is fabricated: stock HandState carries none.
 */
data class HandFrame(
    val observedAtMs: Long,
    val sourceTimestamp: Long,
    val rightHand: Boolean,
    val points: List<Point3>,
) {
    internal fun distances(): DoubleArray? {
        if (points.size !in 25..128 || points.any { !it.isFinite() }) return null
        val middle = points[9]
        val ring = points[13]
        val center = (points[22] + points[23]) * 0.5
        // Stock FingerMath.palmPlane + Hand.fingerTouchPlane/thumbTouchPlane.
        val palm = ((center - middle).cross(center - ring) * if (rightHand) 1.0 else -1.0)
            .normalized() ?: return null
        val fingerNormal = palm.cross(ring - middle).normalized() ?: return null
        val thumbNormal = palm.cross(points[5] - points[0]).normalized() ?: return null
        return DoubleArray(5) { index ->
            val finger = Finger.entries[index]
            if (finger == Finger.THUMB) (points[finger.tipIndex] - points[0]).dot(thumbNormal)
            else (points[finger.tipIndex] - middle).dot(fingerNormal)
        }
    }
}
