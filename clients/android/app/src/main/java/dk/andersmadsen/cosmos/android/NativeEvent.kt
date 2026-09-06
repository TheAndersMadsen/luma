package dk.andersmadsen.cosmos.android

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Presentation-safe state decoded from one native snapshot. No credentials or journal bytes. */
data class Descriptor(val enrollmentId: String, val publicKey: String, val platform: String, val approval: String) {
    fun json(): String = JSONObject().put("enrollmentId", enrollmentId).put("publicKey", publicKey)
        .put("platform", platform).put("approval", approval).toString()
}

data class Admission(val turnId: UUID, val generation: Long, val duplicate: Boolean)

data class PendingOperation(val kind: String, val instanceId: UUID, val sequence: Long, val canRetry: Boolean)

sealed interface CreditPart {
    data class Text(val text: String) : CreditPart
    data class Link(val text: String, val href: String) : CreditPart
}

data class PlaceItem(val placeId: String, val name: String, val address: String, val sourceUrl: String?)

sealed interface DisplayContent {
    data class Text(val text: String) : DisplayContent
    data class Places(val query: String, val items: List<PlaceItem>, val credits: List<List<CreditPart>>) : DisplayContent
}

data class DisplayCard(
    val actionId: UUID, val turnId: UUID, val generation: Long,
    val contentDigest: String, val expiresAtMs: Long, val content: DisplayContent,
)

data class NativeEvent(
    val operation: String, val error: String?, val connected: Boolean,
    val pendingOpen: Boolean, val needsReconnect: Boolean,
    val descriptor: Descriptor?, val pending: PendingOperation?, val lastUnknown: PendingOperation?,
    val admission: Admission?, val visible: Boolean, val display: DisplayCard?, val eventsSkipped: Long,
) {
    val ok: Boolean get() = error == null

    companion object {
        private val OPERATIONS = setOf("prepare", "connect", "send_text", "retry_pending", "cancel",
            "set_visible", "acknowledge", "display", "disconnect", "heartbeat")
        private val PENDING_KINDS = setOf("text", "heartbeat", "cancel", "state", "acknowledge")
        private val NIL = UUID(0, 0)
        private val HEX64 = Regex("^[0-9a-f]{64}$")
        private const val MAX_SAFE = 9_007_199_254_740_991L

        private fun uuid(value: String): UUID {
            val parsed = UUID.fromString(value)
            require(parsed != NIL) { "nil identifier" }
            return parsed
        }

        private fun pending(value: JSONObject?): PendingOperation? {
            value ?: return null
            val kind = value.getString("kind")
            require(kind in PENDING_KINDS) { "unsupported pending kind" }
            val sequence = value.getLong("sequence")
            require(sequence in 1..MAX_SAFE) { "invalid sequence" }
            return PendingOperation(kind, uuid(value.getString("instanceId")), sequence, value.getBoolean("canRetry"))
        }

        private fun admission(value: JSONObject?): Admission? {
            value ?: return null
            val generation = value.getLong("generation")
            require(generation in 1..MAX_SAFE) { "invalid generation" }
            return Admission(uuid(value.getString("turnId")), generation, value.getBoolean("duplicate"))
        }

        private fun credit(value: JSONObject): CreditPart = when (value.getString("kind")) {
            "text" -> { require(!value.has("href")) { "text credit with href" }; CreditPart.Text(value.getString("text")) }
            "link" -> {
                val href = value.getString("href")
                require(href.startsWith("https://") && value.getString("text").isNotBlank()) { "invalid credit link" }
                CreditPart.Link(value.getString("text"), href)
            }
            else -> throw IllegalArgumentException("unsupported credit kind")
        }

        private fun <T> list(array: JSONArray, map: (JSONObject) -> T): List<T> = List(array.length()) { map(array.getJSONObject(it)) }

        private fun display(value: JSONObject?): DisplayCard? {
            value ?: return null
            val content = value.getJSONObject("content")
            val credits = value.getJSONArray("credits")
            val body = when (content.getString("kind")) {
                "text" -> {
                    val text = content.getString("text")
                    require(text.isNotBlank() && text.toByteArray().size <= NativeSurface.MAX_TEXT_BYTES && credits.length() == 0) { "invalid text card" }
                    DisplayContent.Text(text)
                }
                "places" -> {
                    val items = list(content.getJSONArray("items")) { item ->
                        val source = if (item.isNull("sourceUrl")) null else item.getString("sourceUrl")
                        require(source == null || source.startsWith("https://")) { "invalid place source" }
                        PlaceItem(item.getString("placeId"), item.getString("name"), item.getString("address"), source)
                    }
                    val attributions = content.getJSONArray("attributions")
                    require(items.size <= 4 && attributions.length() == credits.length() && credits.length() <= 16) { "invalid place card" }
                    val parts = List(credits.length()) { index -> list(credits.getJSONArray(index), ::credit) }
                    DisplayContent.Places(content.getString("query"), items, parts)
                }
                else -> throw IllegalArgumentException("unsupported card")
            }
            val generation = value.getLong("generation")
            val digest = value.getString("contentDigest")
            require(generation in 1..MAX_SAFE && HEX64.matches(digest) && value.getLong("expiresAtMs") > 0) { "invalid card identity" }
            return DisplayCard(uuid(value.getString("actionId")), uuid(value.getString("turnId")), generation,
                digest, value.getLong("expiresAtMs"), body)
        }

        /** Strict decode; any unsupported shape is a client-side invalid response. */
        fun decode(bytes: ByteArray): NativeEvent {
            val value = JSONObject(String(bytes, Charsets.UTF_8))
            require(value.getInt("version") == 1 && value.getString("kind") == "state") { "unsupported snapshot" }
            val operation = value.getString("operation")
            require(operation in OPERATIONS) { "unsupported operation" }
            val outcome = value.getString("outcome")
            val error = if (value.isNull("error")) null else value.getString("error")
            require((outcome == "ok") == (error == null) && (error?.length ?: 0) <= 64) { "inconsistent outcome" }
            val descriptor = value.optJSONObject("descriptor")?.let {
                Descriptor(it.getString("enrollmentId"), it.getString("publicKey"), it.getString("platform"), it.getString("approval"))
            }
            if (descriptor != null) require(descriptor.platform in setOf("android", "android_tv") && descriptor.approval == "native-shared-display-v2") { "foreign descriptor" }
            val connected = value.getBoolean("connected")
            return NativeEvent(
                operation = operation, error = error, connected = connected,
                pendingOpen = value.getBoolean("pendingOpen"), needsReconnect = value.getBoolean("needsReconnect"),
                descriptor = descriptor, pending = pending(value.optJSONObject("pending")),
                lastUnknown = pending(value.optJSONObject("lastUnknown")), admission = admission(value.optJSONObject("admission")),
                visible = value.getBoolean("visible"), display = if (connected) display(value.optJSONObject("display")) else null,
                eventsSkipped = value.getLong("eventsSkipped"),
            )
        }
    }
}
