package dev.luma.gestures

import java.net.URI
import java.util.UUID
import org.json.JSONObject

/** INFERRED browser handoff. Content is data, never a command or assistant prompt. */
data class ClipArticle(val id: String, val title: String, val publisher: String, val url: String, val selection: String) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("title", title).put("publisher", publisher)
        .put("url", url).put("selection", selection)
    companion object {
        const val MAX_BYTES = 60 * 1024
        fun parse(json: JSONObject): ClipArticle {
            require(json.toString().toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
            require(json.keys().asSequence().toSet() == setOf("id", "title", "publisher", "url", "selection"))
            fun text(name: String, limit: Int): String {
                val value = json.get(name) as? String ?: throw IllegalArgumentException()
                require(value.codePointCount(0, value.length) <= limit && '\u0000' !in value)
                return value
            }
            val id = text("id", 36)
            val uuid = UUID.fromString(id)
            require(uuid.version() == 4 && uuid.variant() == 2 && uuid.toString() == id)
            val title = text("title", 256).also { require(it.isNotBlank()) }
            val publisher = text("publisher", 100)
            val url = text("url", 2048)
            require(url.toByteArray(Charsets.UTF_8).size <= 2048)
            val uri = try { URI(url) } catch (error: Exception) { throw IllegalArgumentException("Invalid article URL", error) }
            require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && url.none { it.isWhitespace() })
            return ClipArticle(id, title, publisher, url, text("selection", 12_000))
        }
    }
}

data class ClipSnapshot(val article: ClipArticle, val phase: String, val expiresAtMs: Long, val requestedAtMs: Long?) {
    fun toJson(): JSONObject = JSONObject().put("article", article.toJson()).put("phase", phase)
        .put("expires_at_ms", expiresAtMs).put("requested_at_ms", requestedAtMs ?: JSONObject.NULL)
    companion object {
        fun parse(json: JSONObject): ClipSnapshot {
            require(json.keys().asSequence().toSet() == setOf("article", "phase", "expires_at_ms", "requested_at_ms"))
            val phase = json.getString("phase")
            require(phase in setOf("ready", "requested", "saved", "failed", "unconfirmed"))
            val expires = json.getLong("expires_at_ms").also { require(it >= 0) }
            val requested = if (json.isNull("requested_at_ms")) null else json.getLong("requested_at_ms").also { require(it in 0..expires) }
            require((phase == "ready") == (requested == null))
            return ClipSnapshot(ClipArticle.parse(json.getJSONObject("article")), phase, expires, requested)
        }
    }
}
