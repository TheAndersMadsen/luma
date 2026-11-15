package dev.luma.gestures

import org.json.JSONArray
import org.json.JSONObject

/** INFERRED: bounded in-memory diagnostics, never a native confidence claim. */
class GestureObservation private constructor(private val value: JSONObject) {
    fun toJson(): JSONObject = JSONObject(value.toString())

    companion object {
        const val MAX_BYTES = 16_384
        const val DESCRIPTOR = "dev.luma.gestures.LauncherObservation"
        const val TRANSACTION_REPORT = 1
        const val SERVICE_CLASS = "com.penumbraos.server.GestureBridgeService"
        val statuses = setOf("off", "calibrating", "ready", "holding", "release", "cancelled", "suspended", "unavailable")
        val reasons = setOf("home_required", "hand_lost", "projection_unavailable", "stale_frame", "queue_overflow", "service_lost", "callback_failed", "subscription_failed", "subscription_unavailable", "invalid_config")

        fun idle(elapsedMs: Long, status: String, reason: String? = null): GestureObservation = snapshot(
            elapsedMs, status, reason, false, false, emptySet(), null, 0.0, null, "", null,
        )

        fun snapshot(
            elapsedMs: Long, status: String, reason: String?, eligible: Boolean, projectable: Boolean,
            fingers: Set<Finger>, feature: String?, holdProgress: Double, frame: HandFrame?,
            revision: String, match: JSONObject?,
        ): GestureObservation = parse(JSONObject()
            .put("schema_version", 1).put("elapsed_ms", elapsedMs).put("status", status)
            .put("reason", reason ?: JSONObject.NULL).put("eligible", eligible).put("projectable", projectable)
            .put("fingers", JSONArray(fingers.sortedBy { it.ordinal }.map { it.name.lowercase() }))
            .put("feature", feature ?: JSONObject.NULL).put("hold_progress", holdProgress)
            .put("hand", frame?.let { if (it.rightHand) "right" else "left" } ?: JSONObject.NULL)
            .put("points", JSONArray(frame?.points?.take(25)?.map { JSONArray(listOf(it.x, it.y, it.z)) } ?: emptyList<Any>()))
            .put("revision", revision).put("match", match ?: JSONObject.NULL))

        fun parse(value: JSONObject): GestureObservation {
            require(value.toString().toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
            require(value.keys().asSequence().toSet() == setOf("schema_version", "elapsed_ms", "status", "reason", "eligible", "projectable", "fingers", "feature", "hold_progress", "hand", "points", "revision", "match"))
            require(value.get("schema_version") == 1)
            require(value.get("elapsed_ms") is Number && value.getDouble("elapsed_ms") == value.getLong("elapsed_ms").toDouble() && value.getLong("elapsed_ms") >= 0)
            require(value.get("status") in statuses)
            require(value.isNull("reason") || value.get("reason") in reasons)
            require(value.get("eligible") is Boolean && value.get("projectable") is Boolean)
            val digits = value.getJSONArray("fingers")
            val names = (0 until digits.length()).map { digits.get(it) }
            require(names.size <= 5 && names.distinct().size == names.size && names.all { name -> Finger.entries.any { it.name.lowercase() == name } })
            require(value.isNull("feature") || GestureFeatures.catalog.any { it.id == value.get("feature") && it.available })
            require(value.get("hold_progress") is Number && value.getDouble("hold_progress") in 0.0..1.0)
            require(value.isNull("hand") || value.get("hand") in setOf("left", "right"))
            val points = value.getJSONArray("points")
            require(points.length() == 0 || points.length() == 25)
            require((points.length() == 0) == value.isNull("hand"))
            repeat(points.length()) { index ->
                val xyz = points.getJSONArray(index)
                require(xyz.length() == 3)
                repeat(3) { require(xyz.get(it) is Number && xyz.getDouble(it).isFinite() && kotlin.math.abs(xyz.getDouble(it)) <= 10_000) }
            }
            val revision = value.get("revision") as? String ?: throw IllegalArgumentException()
            require(revision.isEmpty() || revision.matches(Regex("[0-9a-f]{64}")))
            if (!value.isNull("match")) {
                val match = value.getJSONObject("match")
                require(match.keys().asSequence().toSet() == setOf("id", "feature", "outcome"))
                require((match.get("id") as? String)?.matches(Regex("[0-9a-f-]{36}:[0-9]{1,12}")) == true)
                require(GestureFeatures.catalog.any { it.id == match.get("feature") && it.available })
                require(match.get("outcome") in setOf("observed", "launched", "failed"))
            }
            return GestureObservation(JSONObject(value.toString()))
        }
    }
}
