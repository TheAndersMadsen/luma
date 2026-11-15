package dev.luma.gestures

import org.json.JSONObject
import org.json.JSONTokener
import org.json.JSONArray
import java.security.MessageDigest

/** INFERRED: Luma's local, declarative configuration. No downloaded executable code. */
enum class GestureMode { OFF, OBSERVE, ACTIVE }

data class GestureFeature(val id: String, val title: String, val available: Boolean, val note: String, val trigger: String = "fingers")

object GestureFeatures {
    val catalog: List<GestureFeature> = listOf(
        GestureFeature("open_music", "Open Music", true, "Experimental launcher shortcut; physical validation required."),
        GestureFeature("open_messages", "Open Messages", true, "Opens the experience; never sends a message."),
        GestureFeature("open_settings", "Open Settings", true, "Opens the experience; never changes a setting."),
        GestureFeature("pinch_to_copy", "Pinch to copy", true, "Hand off an article from your browser, then pinch on Home to save it to Notes. Physical projection validation required.", "pinch_session"),
    )
}

data class GestureBinding(val fingers: Set<Finger>, val holdMs: Long, val feature: String) {
    init {
        // INFERRED: reserve thumb/index and the stock pinch/fist controls. A chord
        // must be exact: any additional finger cancels it until neutral again.
        require(fingers.isNotEmpty() && fingers.all { it in setOf(Finger.MIDDLE, Finger.RING, Finger.PINKY) })
        require(holdMs in 250..1_500)
        require(GestureFeatures.catalog.any { it.id == feature && it.available && it.trigger == "fingers" })
    }
}

data class GestureConfig(val mode: GestureMode, val bindings: List<GestureBinding>) {
    init {
        require(bindings.size <= 4)
        require(bindings.map { it.fingers }.distinct().size == bindings.size)
        require(bindings.indices.none { a ->
            bindings.indices.any { b -> a != b && bindings[a].fingers.containsAll(bindings[b].fingers) }
        })
        require(mode == GestureMode.OFF || bindings.isNotEmpty())
    }

    fun toJson(): JSONObject = JSONObject()
        .put("schema_version", 1)
        .put("mode", mode.name.lowercase())
        .put("bindings", JSONArray(bindings.map { binding ->
            JSONObject().put("fingers", JSONArray(binding.fingers.sortedBy { it.ordinal }.map { it.name.lowercase() }))
                .put("hold_ms", binding.holdMs).put("feature", binding.feature)
        }))

    companion object {
        const val SETTING = "luma_launcher_gestures_v1"
        const val MAX_BYTES = 4_096
        val OFF = GestureConfig(GestureMode.OFF, emptyList())

        fun revision(raw: String?): String = MessageDigest.getInstance("SHA-256")
            .digest((raw ?: "").toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }

        /** Missing settings disable the SDK. Malformed settings throw; callers fail closed. */
        fun parse(raw: String?): GestureConfig {
            if (raw == null) return OFF
            try {
                require(raw.toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
                val tokens = JSONTokener(raw)
                val json = tokens.nextValue() as? JSONObject
                    ?: throw IllegalArgumentException("Expected a gesture configuration object")
                require(tokens.nextClean() == '\u0000')
                requireKeys(json, setOf("schema_version", "mode", "bindings"))
                require(json.get("schema_version") is Int && json.getInt("schema_version") == 1)
                val mode = when (json.get("mode")) {
                    "off" -> GestureMode.OFF
                    "observe" -> GestureMode.OBSERVE
                    "active" -> GestureMode.ACTIVE
                    else -> throw IllegalArgumentException("Unknown gesture mode")
                }
                val array = json.getJSONArray("bindings")
                require(array.length() <= 4)
                val bindings = (0 until array.length()).map { index ->
                    val item = array.getJSONObject(index)
                    requireKeys(item, setOf("fingers", "hold_ms", "feature"))
                    require(item.get("hold_ms") is Int)
                    val names = item.getJSONArray("fingers")
                    require(names.length() in 1..3)
                    val fingers = (0 until names.length()).map { fingerIndex ->
                        val name = names.get(fingerIndex)
                        require(name is String)
                        Finger.entries.singleOrNull { it.name.lowercase() == name }
                            ?: throw IllegalArgumentException("Unknown finger")
                    }
                    require(fingers.distinct().size == fingers.size)
                    require(item.get("feature") is String)
                    GestureBinding(fingers.toSet(), item.getLong("hold_ms"), item.getString("feature"))
                }
                return GestureConfig(mode, bindings)
            } catch (error: Exception) {
                throw IllegalArgumentException("Invalid launcher gesture configuration", error)
            }
        }

        private fun requireKeys(json: JSONObject, expected: Set<String>) {
            require(json.keys().asSequence().toSet() == expected)
        }
    }
}
