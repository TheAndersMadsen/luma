package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.ActionWire
import dk.andersmadsen.cosmos.android.action.Confirmation
import dk.andersmadsen.cosmos.android.action.DeviceTask
import dk.andersmadsen.cosmos.android.action.Revoked
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Presentation-safe state decoded from one native snapshot. No credentials or journal bytes. */
data class Descriptor(val enrollmentId: String, val publicKey: String, val platform: String, val approval: String) {
    fun json(): String = JSONObject().put("enrollmentId", enrollmentId).put("publicKey", publicKey)
        .put("platform", platform).put("approval", approval).toString()

    /** Center's approval page with this public descriptor as a link fragment; it never leaves the browser. */
    fun approvalUrl(serverOrigin: String): String {
        val encoded = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(json().toByteArray())
        return serverOrigin.trimEnd('/') + "/settings/account/surfaces#descriptor=" + encoded
    }
}

data class Admission(val turnId: UUID, val generation: Long, val duplicate: Boolean)

data class PendingOperation(val kind: String, val instanceId: UUID, val sequence: Long, val canRetry: Boolean)

sealed interface CreditPart {
    data class Text(val text: String) : CreditPart
    data class Link(val text: String, val href: String) : CreditPart
}

data class PlaceItem(val placeId: String, val name: String, val address: String, val sourceUrl: String?)

/** One option Cosmos offers; [id] is the stable label a follow-up such as "number two" resolves against. */
data class Choice(val id: String, val title: String, val detail: String)

sealed interface DisplayContent {
    data class Text(val text: String) : DisplayContent
    data class Places(val query: String, val items: List<PlaceItem>, val credits: List<List<CreditPart>>) : DisplayContent
    /** Two to eight options under one title; selecting one sends its title back as a request. */
    data class Choices(val title: String, val items: List<Choice>) : DisplayContent
}

data class DisplayCard(
    val actionId: UUID, val turnId: UUID, val generation: Long,
    val contentDigest: String, val expiresAtMs: Long, val content: DisplayContent,
    /** The class Cosmos routed this card at; anything above shared_room is private to this screen. */
    val privacy: String = "shared_room",
) {
    val private: Boolean get() = privacy == "near_user" || privacy == "private"
}

/**
 * A private card or a command is waiting for this installation. It names the
 * kind of surface that asked, the class and the expiry, never any content; it
 * arrives once this app reports its unlocked foreground. A card waits because
 * it is private; a command waits because no phone starts one in the background.
 */
data class Invitation(val id: UUID, val kind: String, val origin: String, val privacy: String, val expiresAtMs: Long) {
    val forTask: Boolean get() = kind == "task"
}

/**
 * Where the current turn stands: working, waiting for a device, shown or spoken
 * somewhere, nowhere to show it, or unknown. [surfacePlatform] names the device
 * class Cosmos chose when it knows one; [privacy] is the class it routed at.
 */
data class TurnStatus(val turnId: UUID, val generation: Long, val state: String, val surfacePlatform: String?, val privacy: String)

/** One complete spoken reply. The bytes are fetched separately; this names and bounds them. */
data class SpeechReply(
    val actionId: UUID, val turnId: UUID, val generation: Long,
    val contentDigest: String, val expiresAtMs: Long, val text: String, val format: String, val byteLength: Int,
)

data class NativeEvent(
    val operation: String, val error: String?, val connected: Boolean,
    val pendingOpen: Boolean, val needsReconnect: Boolean,
    val descriptor: Descriptor?, val pending: PendingOperation?, val lastUnknown: PendingOperation?,
    val admission: Admission?, val visible: Boolean, val display: DisplayCard?, val speech: SpeechReply?,
    val invitation: Invitation?, val status: TurnStatus?, val eventsSkipped: Long,
    /** The command this device was asked to carry out, if one stands. */
    val task: DeviceTask? = null,
    /** The ceremony this device is the venue for, if one stands. */
    val confirmation: Confirmation? = null,
    /** The command Cosmos retired, and why. */
    val revoked: Revoked? = null,
) {
    val ok: Boolean get() = error == null

    companion object {
        const val APPROVAL = "native-device-action-v4"
        private val OPERATIONS = setOf("prepare", "connect", "send_text", "send_text_to", "send_text_with_context",
            "retry_pending", "cancel", "set_visible", "acknowledge", "acknowledge_speech", "acknowledge_task",
            "report", "progress", "grant", "display", "speech", "invitation", "status", "task", "confirmation",
            "disconnect", "heartbeat")
        private val DISPLAY_CLASSES = setOf("public", "shared_room", "near_user", "private")
        private val STATUS_STATES = setOf("working", "waiting", "confirming", "acting", "shown", "spoken",
            "done", "refused", "nowhere", "unknown")
        private val SURFACE_PLATFORMS = setOf("pin", "browser", "macos", "linux", "android", "android_tv")
        private val PRIVATE_CLASSES = setOf("near_user", "private")
        private val PENDING_KINDS = setOf("text", "heartbeat", "cancel", "state", "acknowledge", "report", "grant")
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
                "choices" -> {
                    val title = content.getString("title")
                    val items = list(content.getJSONArray("items")) { item -> Choice(item.getString("id"), item.getString("title"), item.getString("detail")) }
                    require(title.isNotBlank() && title.toByteArray().size <= NativeSurface.MAX_TEXT_BYTES && credits.length() == 0
                        && items.size in 2..8 && items.distinctBy { it.id }.size == items.size
                        && items.all { it.id.isNotBlank() && it.title.isNotBlank() && (it.title + it.detail).toByteArray().size <= NativeSurface.MAX_TEXT_BYTES }) { "invalid choices card" }
                    DisplayContent.Choices(title, items)
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
            val privacy = value.optString("privacy", "shared_room")
            require(generation in 1..MAX_SAFE && HEX64.matches(digest) && value.getLong("expiresAtMs") > 0
                && privacy in DISPLAY_CLASSES) { "invalid card identity" }
            return DisplayCard(uuid(value.getString("actionId")), uuid(value.getString("turnId")), generation,
                digest, value.getLong("expiresAtMs"), body, privacy)
        }

        private fun invitation(value: JSONObject?): Invitation? {
            value ?: return null
            val origin = value.getString("origin")
            val privacy = value.getString("privacy")
            val kind = value.getString("kind")
            // A card waits because it is private; a command waits at any class
            // because no phone may start one from the background.
            val classes = if (kind == "task") DISPLAY_CLASSES else PRIVATE_CLASSES
            require(origin.isNotEmpty() && origin.length <= 32 && origin.all { it in 'a'..'z' || it == '_' }
                && kind in setOf("card", "task") && privacy in classes && value.getLong("expiresAtMs") > 0) { "invalid invitation" }
            return Invitation(uuid(value.getString("id")), kind, origin, privacy, value.getLong("expiresAtMs"))
        }

        private fun status(value: JSONObject?): TurnStatus? {
            value ?: return null
            val state = value.getString("state")
            val platform = if (value.isNull("surfacePlatform")) null else value.getString("surfacePlatform")
            val privacy = value.getString("privacy")
            val generation = value.getLong("generation")
            require(state in STATUS_STATES && (platform == null || platform in SURFACE_PLATFORMS) && privacy in DISPLAY_CLASSES
                && generation in 1..MAX_SAFE) { "invalid status" }
            return TurnStatus(uuid(value.getString("turnId")), generation, state, platform, privacy)
        }

        private fun speech(value: JSONObject?): SpeechReply? {
            value ?: return null
            val text = value.getString("text")
            val generation = value.getLong("generation")
            val digest = value.getString("contentDigest")
            val length = value.getInt("byteLength")
            require(text.isNotBlank() && text.toByteArray().size <= NativeSurface.MAX_TEXT_BYTES
                && value.getString("format") == "audio/mpeg" && length in 1..NativeSurface.MAX_SPEECH_BYTES
                && generation in 1..MAX_SAFE && HEX64.matches(digest) && value.getLong("expiresAtMs") > 0) { "invalid speech reply" }
            return SpeechReply(uuid(value.getString("actionId")), uuid(value.getString("turnId")), generation,
                digest, value.getLong("expiresAtMs"), text, "audio/mpeg", length)
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
            if (descriptor != null) require(descriptor.platform in setOf("android", "android_tv") && descriptor.approval == APPROVAL) { "foreign descriptor" }
            val connected = value.getBoolean("connected")
            return NativeEvent(
                operation = operation, error = error, connected = connected,
                pendingOpen = value.getBoolean("pendingOpen"), needsReconnect = value.getBoolean("needsReconnect"),
                descriptor = descriptor, pending = pending(value.optJSONObject("pending")),
                lastUnknown = pending(value.optJSONObject("lastUnknown")), admission = admission(value.optJSONObject("admission")),
                visible = value.getBoolean("visible"), display = if (connected) display(value.optJSONObject("display")) else null,
                speech = if (connected) speech(value.optJSONObject("speech")) else null,
                invitation = if (connected) invitation(value.optJSONObject("invitation")) else null,
                status = if (connected) status(value.optJSONObject("status")) else null,
                eventsSkipped = value.getLong("eventsSkipped"),
                // A command, its ceremony and its retirement belong to a live
                // connection exactly as a card does: a dropped room holds none.
                task = if (connected) ActionWire.task(value.optJSONObject("task")) else null,
                confirmation = if (connected) ActionWire.confirmation(value.optJSONObject("confirmation")) else null,
                revoked = if (connected) ActionWire.revoked(value.optJSONObject("revoked")) else null,
            )
        }
    }
}
