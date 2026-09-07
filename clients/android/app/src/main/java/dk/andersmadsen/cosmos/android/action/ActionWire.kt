package dk.andersmadsen.cosmos.android.action

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The device-action half of a native snapshot, decoded exactly as strictly as
 * the rest of it. Nothing here decides anything: a command is a description of
 * what Cosmos asked for, and this phone's own copy of the owner's policy is
 * what decides whether it happens ([DevicePolicy]).
 */

/** Where an [Operation.Open] points. Only `https` can be carried out here. */
sealed interface Locator {
    data class Https(val url: String) : Locator
    data class App(val id: String) : Locator
    data class File(val rootId: String, val relative: String) : Locator
    /** A scheme this build does not know; it is refused, never guessed at. */
    data class Other(val scheme: String) : Locator
}

/** Where in a document an open should land. Android opens documents whole. */
sealed interface Position {
    data class Line(val line: Int) : Position
    data class Page(val page: Int) : Position
    data class Fragment(val value: String) : Position
}

/**
 * One bound command. Every field was minted by the runtime from state it
 * committed itself; this client builds nothing from strings and interpolates
 * nothing into a command.
 */
sealed interface Operation {
    data class Open(val locator: Locator, val version: String?, val position: Position?, val label: String) : Operation
    data class Route(val placeId: String, val name: String, val address: String, val lat: String, val lng: String) : Operation
    data class Play(val title: String, val query: String, val providers: List<String>, val itemDigest: String) : Operation
    /** A command shape this build cannot carry out. It is refused, never attempted. */
    data class Unsupported(val kind: String) : Operation
}

/**
 * One command this installation was asked to carry out. Acknowledging it says
 * "I bound this exact command and it is legal here" and nothing more; only a
 * report may say what happened, and only what this phone observed.
 */
data class DeviceTask(
    val actionId: UUID,
    val turnId: UUID,
    val generation: Long,
    val channel: String,
    val contentDigest: String,
    /** A repeat of this key re-sends the same report and never runs anything twice. */
    val idempotencyKey: String,
    val operation: Operation,
    val expiresAtMs: Long,
    val reportByMs: Long,
    val privacy: String,
) {
    /** Above the shared class; a television never renders one. */
    val private: Boolean get() = privacy == "near_user" || privacy == "private"
}

/** What a person is asked to confirm, in the runtime's own composed words. */
data class Description(
    val verb: String,
    val subject: String,
    val deviceKind: String,
    val effect: String,
    val privacy: String,
)

/** What this device proved about the person who answered. */
enum class Attestation(val wire: String) { FOREGROUND_TAP("foreground_tap"), DEVICE_OWNER_AUTH("device_owner_auth") }

enum class Risk { LOW, MODERATE, HIGH }

/**
 * One ceremony this installation is the venue for. The person standing here is
 * the person who answers; declining weighs exactly as much as accepting, and
 * dismissing the sheet answers nothing at all.
 */
data class Confirmation(
    val grantId: UUID,
    val actionId: UUID,
    val turnId: UUID,
    val generation: Long,
    val description: Description,
    val descriptionDigest: String,
    val risk: Risk,
    /** The weakest actor evidence Cosmos will accept for this command. */
    val attestation: Attestation,
    val privacy: String,
    val expiresAtMs: Long,
)

enum class RevokeReason { CANCELLED, PREEMPTED, SUPERSEDED, EXPIRED, REVALIDATION_FAILED }

/** One retired command and why, so this device can say what happened plainly. */
data class Revoked(val actionId: UUID, val reason: RevokeReason)

enum class ReportOutcome(val wire: String) {
    COMPLETED("completed"), REFUSED("refused"), FAILED("failed"), CANCELLED("cancelled"), UNKNOWN("unknown"),
}

enum class PlaybackState(val wire: String) { PLAYING("playing"), BUFFERING("buffering"), LAUNCHED("launched") }

/** The fixed reasons a device may decline; no free text ever crosses this leg. */
enum class DeclineReason(val wire: String) {
    NO_HANDLER("no_handler"), LOCKED("locked"), NOT_PERMITTED("not_permitted"), UNRESOLVABLE("unresolvable"),
    VERSION_CHANGED("version_changed"), ENTRY_CHANGED("entry_changed"), NO_ATTESTATION("no_attestation"),
}

/** This device's own bounded account of what it observed. */
sealed interface Evidence {
    data class Open(val resolvedApp: String?, val opened: Boolean) : Evidence
    data class Route(val resolvedApp: String?, val launched: Boolean, val navigating: Boolean) : Evidence
    data class Playback(val provider: String, val state: PlaybackState, val positionMs: Long, val itemDigest: String) : Evidence
    data class Declined(val reason: DeclineReason) : Evidence
}

/**
 * What this device says happened. Reporting `completed` for an effect it did
 * not observe would be a false outcome claim, so the shapes that can prove a
 * completion are the only ones [ActionOutcome] pairs with one.
 */
data class Report(val outcome: ReportOutcome, val evidence: Evidence) {
    /**
     * The bounded UTF-8 JSON the native library parses. It is written by hand
     * so the bytes are the same every time and a test can read them as a
     * person would; nothing here is a map with its own idea of order.
     */
    fun json(): String {
        val fields = when (evidence) {
            is Evidence.Open -> listOf("kind" to quote("open"), "opened" to evidence.opened.toString()) +
                resolved(evidence.resolvedApp)
            is Evidence.Route -> listOf(
                "kind" to quote("route"), "launched" to evidence.launched.toString(),
                "navigating" to evidence.navigating.toString(),
            ) + resolved(evidence.resolvedApp)
            is Evidence.Playback -> listOf(
                "kind" to quote("playback"), "provider" to quote(evidence.provider),
                "state" to quote(evidence.state.wire), "positionMs" to evidence.positionMs.toString(),
                "itemDigest" to quote(evidence.itemDigest),
            )
            is Evidence.Declined -> listOf("kind" to quote("declined"), "reason" to quote(evidence.reason.wire))
        }
        val body = fields.joinToString(",") { (key, value) -> "${quote(key)}:$value" }
        return """{"outcome":${quote(outcome.wire)},"evidence":{$body}}"""
    }

    private fun resolved(app: String?): List<Pair<String, String>> =
        app?.let { listOf("resolvedApp" to quote(it)) } ?: emptyList()

    private fun quote(value: String): String = buildString {
        append('"')
        for (character in value) when {
            character == '"' -> append("\\\"")
            character == '\\' -> append("\\\\")
            character.code < 0x20 -> append("\\u%04x".format(character.code))
            else -> append(character)
        }
        append('"')
    }
}

/** Strict decoding of the action fields of a snapshot; anything else is refused here. */
object ActionWire {
    const val MAX_SAFE = 9_007_199_254_740_991L
    val PRIVACY_CLASSES = setOf("public", "shared_room", "near_user", "private")
    val CHANNELS = setOf("action.open", "action.route", "action.play", "action.run")
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val NIL = UUID(0, 0)

    private fun uuid(value: String): UUID {
        val parsed = UUID.fromString(value)
        require(parsed != NIL) { "nil identifier" }
        return parsed
    }

    private fun optional(value: JSONObject, key: String): String? =
        if (value.isNull(key)) null else value.getString(key)

    private fun locator(value: JSONObject): Locator = when (val scheme = value.getString("scheme")) {
        "https" -> Locator.Https(value.getString("url"))
        "app" -> Locator.App(value.getString("id"))
        "file" -> Locator.File(value.getString("rootId"), value.getString("relative"))
        else -> Locator.Other(scheme)
    }

    private fun position(value: JSONObject?): Position? = when (value?.getString("kind")) {
        null -> null
        "line" -> Position.Line(value.getInt("line"))
        "page" -> Position.Page(value.getInt("page"))
        "fragment" -> Position.Fragment(value.getString("value"))
        else -> throw IllegalArgumentException("unsupported position")
    }

    private fun providers(value: JSONArray): List<String> = List(value.length()) { value.getString(it) }

    fun operation(value: JSONObject): Operation = when (val kind = value.getString("kind")) {
        "open" -> Operation.Open(
            locator(value.getJSONObject("locator")),
            optional(value, "version"),
            position(value.optJSONObject("position")),
            value.getString("label"),
        )
        "route" -> Operation.Route(
            value.getString("placeId"), value.getString("name"), value.getString("address"),
            value.getString("lat"), value.getString("lng"),
        )
        "play" -> Operation.Play(
            value.getString("title"), value.getString("query"),
            providers(value.getJSONArray("providers")), value.getString("itemDigest"),
        )
        else -> Operation.Unsupported(kind)
    }

    fun task(value: JSONObject?): DeviceTask? {
        value ?: return null
        val generation = value.getLong("generation")
        val channel = value.getString("channel")
        val digest = value.getString("contentDigest")
        val key = value.getString("idempotencyKey")
        val privacy = value.getString("privacy")
        require(generation in 1..MAX_SAFE && channel in CHANNELS && HEX64.matches(digest) && HEX64.matches(key)
            && privacy in PRIVACY_CLASSES && value.getLong("expiresAtMs") > 0 && value.getLong("reportByMs") > 0) { "invalid task" }
        return DeviceTask(
            uuid(value.getString("actionId")), uuid(value.getString("turnId")), generation, channel, digest, key,
            operation(value.getJSONObject("operation")), value.getLong("expiresAtMs"), value.getLong("reportByMs"), privacy,
        )
    }

    fun confirmation(value: JSONObject?): Confirmation? {
        value ?: return null
        val description = value.getJSONObject("description")
        require(description.getString("kind") == "device_action") { "unsupported description" }
        val generation = value.getLong("generation")
        val digest = value.getString("descriptionDigest")
        val privacy = value.getString("privacy")
        val risk = value.getString("risk")
        val attestation = value.getString("attestation")
        require(generation in 1..MAX_SAFE && HEX64.matches(digest) && privacy in PRIVACY_CLASSES
            && risk in setOf("low", "moderate", "high") && attestation in setOf("foreground_tap", "device_owner_auth")
            && value.getLong("expiresAtMs") > 0) { "invalid confirmation" }
        return Confirmation(
            uuid(value.getString("grantId")), uuid(value.getString("actionId")), uuid(value.getString("turnId")),
            generation,
            Description(
                description.getString("verb"), description.getString("subject"),
                description.getString("deviceKind"), description.getString("effect"),
                description.getString("class"),
            ),
            digest, Risk.valueOf(risk.uppercase()),
            if (attestation == "device_owner_auth") Attestation.DEVICE_OWNER_AUTH else Attestation.FOREGROUND_TAP,
            privacy, value.getLong("expiresAtMs"),
        )
    }

    fun revoked(value: JSONObject?): Revoked? {
        value ?: return null
        val reason = value.getString("reason")
        require(reason in setOf("cancelled", "preempted", "superseded", "expired", "revalidation_failed")) { "invalid revoke" }
        return Revoked(uuid(value.getString("actionId")), RevokeReason.valueOf(reason.uppercase()))
    }
}
