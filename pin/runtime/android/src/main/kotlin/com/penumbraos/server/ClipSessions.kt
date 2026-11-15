package com.penumbraos.server

import dev.luma.gestures.ClipArticle
import dev.luma.gestures.ClipSnapshot
import org.json.JSONObject

/** One explicit, ephemeral browser target. Durable content lives only in Cosmos. */
internal class ClipSessions {
    private var current: ClipSnapshot? = null

    private fun live(now: Long): ClipSnapshot? {
        val value = current ?: return null
        if (now >= value.expiresAtMs) { current = null; return null }
        if (value.phase == "requested" && now - requireNotNull(value.requestedAtMs) >= 15_000) {
            current = value.copy(phase = "unconfirmed")
        }
        return current
    }

    @Synchronized fun read(now: Long): JSONObject? = live(now)?.toJson()

    @Synchronized fun stage(input: JSONObject, now: Long): JSONObject {
        val article = try { ClipArticle.parse(input) } catch (_: Exception) { throw GestureRequestException("invalid_request") }
        val old = live(now)
        if (old?.article?.id == article.id) {
            if (old.article != article) throw GestureRequestException("conflict")
            return old.toJson()
        }
        if (old?.phase in setOf("ready", "requested", "unconfirmed")) throw GestureRequestException("conflict")
        return ClipSnapshot(article, "ready", now + 60_000, null).also { current = it }.toJson()
    }

    /** Only the admitted launcher calls this, on a native press in its Clip view. */
    @Synchronized fun copy(id: String, now: Long) {
        val value = live(now) ?: return
        if (value.article.id == id && value.phase == "ready") {
            current = value.copy(phase = "requested", requestedAtMs = now, expiresAtMs = now + 60_000)
        }
    }

    @Synchronized fun result(input: JSONObject, now: Long): JSONObject {
        if (input.keys().asSequence().toSet() != setOf("id", "outcome") || input.get("outcome") !in setOf("saved", "failed")) {
            throw GestureRequestException("invalid_request")
        }
        val value = live(now)?.takeIf { it.article.id == input.get("id") && it.phase != "ready" }
            ?: throw GestureRequestException("conflict")
        val outcome = input.getString("outcome")
        if (value.phase in setOf("saved", "failed") && value.phase != outcome) throw GestureRequestException("conflict")
        return value.copy(phase = outcome).also { current = it }.toJson()
    }

    @Synchronized fun cancel(input: JSONObject, now: Long) {
        if (input.keys().asSequence().toSet() != setOf("id")) throw GestureRequestException("invalid_request")
        val value = live(now) ?: return
        if (value.article.id != input.get("id") || value.phase != "ready") throw GestureRequestException("conflict")
        current = null
    }
}
