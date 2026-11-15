package com.penumbraos.server

import dev.luma.gestures.GestureConfig
import dev.luma.gestures.GestureFeatures
import dev.luma.gestures.GestureObservation
import org.json.JSONArray
import org.json.JSONObject

internal interface GestureSettingsStore {
    fun read(): String?
    fun write(value: String): Boolean
}

internal class GestureRequestException(val code: String) : Exception(code)

/** INFERRED: Pin-owned preferences. The same SDK validates both writer and consumer. */
internal class GestureSettings(private val store: GestureSettingsStore) {
    @Synchronized fun read(): JSONObject {
        val raw = store.read()
        val parsed = runCatching { GestureConfig.parse(raw) }
        return JSONObject().put("schema_version", 1).put("revision", GestureConfig.revision(raw))
            .put("valid", parsed.isSuccess).put("config", parsed.getOrDefault(GestureConfig.OFF).toJson())
            .put("catalog", JSONArray(GestureFeatures.catalog.map {
                JSONObject().put("id", it.id).put("title", it.title).put("available", it.available).put("note", it.note).put("trigger", it.trigger)
            }))
    }

    @Synchronized fun update(request: JSONObject): JSONObject {
        val config = try {
            require(request.keys().asSequence().toSet() == setOf("revision", "config"))
            require((request.get("revision") as? String)?.matches(Regex("[0-9a-f]{64}")) == true)
            GestureConfig.parse(request.getJSONObject("config").toString())
        } catch (_: Exception) { throw GestureRequestException("invalid_request") }
        if (request.getString("revision") != GestureConfig.revision(store.read())) throw GestureRequestException("conflict")
        val raw = config.toJson().toString()
        if (!store.write(raw) || store.read() != raw) throw GestureRequestException("operation_failed")
        return read()
    }
}

/** A stopped or dead launcher must not leave a live hand on the inspector. */
internal class GestureObservations {
    private var latest: JSONObject? = null
    @Synchronized fun record(raw: String, now: Long) {
        require(raw.toByteArray(Charsets.UTF_8).size <= GestureObservation.MAX_BYTES)
        val observation = GestureObservation.parse(JSONObject(raw)).toJson()
        val time = observation.getLong("elapsed_ms")
        require(time <= now && now - time <= 1_000)
        val oldTime = latest?.getLong("elapsed_ms")
        if (oldTime == null || time >= oldTime) latest = observation
    }
    @Synchronized fun read(now: Long): JSONObject? = latest?.takeIf {
        now >= it.getLong("elapsed_ms") && now - it.getLong("elapsed_ms") <= 1_000
    }?.let { JSONObject(it.toString()) }
}
