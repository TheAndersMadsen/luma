package dk.andersmadsen.cosmos.android.action

import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.util.UUID

/**
 * This installation's own copy of the owner's device-action policy, and the
 * verification every command passes before anything happens on this device.
 *
 * Nothing here trusts what Cosmos said. A host, an application or a media
 * provider that is not written in *this* copy is refused whatever arrived on
 * the wire — that is the whole point of a second copy: a compromised or
 * confused orchestrator cannot widen what this phone will open or what this TV
 * will play.
 *
 * The copy is the same object the owner wrote in Center → Devices. Cosmos
 * delivers it over the connection this installation already holds, bound to
 * the surface and the approval revision that connection was opened at:
 *
 * ```json
 * {"version":1,"surfaceId":"…","approvalRevision":4,
 *  "actions":{"revision":2,"maximumClass":"shared_room",
 *             "open":{"hosts":["github.com"],
 *                     "apps":[{"id":"com.google.android.youtube","label":"YouTube"}]},
 *             "route":{"app":"google_maps"},
 *             "play":{"providers":["youtube"]}}}
 * ```
 *
 * Delivery is not authority. The document is a cache of one approval revision:
 * it is held only while the connection is, it is never written to disk, and an
 * installation holding none does nothing at all rather than anything.
 *
 * Cosmos holds no package names, so the application id is this platform's own
 * package and the provider id is mapped to packages here ([MediaProviders]).
 */
data class DevicePolicy(
    val hosts: Set<String> = emptySet(),
    val apps: List<DeviceApp> = emptyList(),
    /** The owner allowed navigation on this device. Only Google Maps exists as a route app. */
    val route: Boolean = false,
    val providers: Set<String> = emptySet(),
) {
    val isEmpty: Boolean get() = hosts.isEmpty() && apps.isEmpty() && !route && providers.isEmpty()

    /**
     * Exactly the caps Cosmos applies when the owner saves the policy. This
     * device holds a copy, so it holds the copy to the same shape; a copy that
     * is out of shape is refused whole, because half an allowlist is worse
     * than none.
     */
    val wellFormed: Boolean
        get() = hosts.size <= MAX_HOSTS && hosts.all(::declaredHost) &&
            apps.size <= MAX_APPS && apps.all { packageId(it.id) && text(it.label, MAX_LABEL_BYTES) } &&
            apps.distinctBy { it.id }.size == apps.size &&
            providers.size <= MAX_PROVIDERS && providers.all(::providerId)

    /**
     * The whole local check in one place. An operation this device cannot
     * carry out, a host or application the owner never listed, a provider it
     * never allowed, or a command whose own shape does not hold, is each a
     * refusal with its own reason. Only a command that passes all of it is
     * ever acknowledged.
     */
    fun plan(operation: Operation, platform: String): PlannedAction? = when (operation) {
        is Operation.Open -> if (platform != PHONE) null else planOpen(operation)
        is Operation.Route -> when {
            platform != PHONE -> null
            !route -> null
            !coordinate(operation.lat, 90) || !coordinate(operation.lng, 180) -> null
            !text(operation.name, MAX_LABEL_BYTES) -> null
            else -> PlannedAction.Navigate(operation.lat, operation.lng, operation.name)
        }
        is Operation.Play -> when {
            platform != TV -> null
            !text(operation.query, MAX_QUERY_BYTES) || !text(operation.title, MAX_LABEL_BYTES) -> null
            else -> operation.providers.firstOrNull { it in providers }
                ?.let { PlannedAction.Play(it, operation.query, operation.title, operation.itemDigest) }
        }
        is Operation.Unsupported -> null
    }

    /** Why a command was refused, when [plan] returns nothing. */
    fun refusal(operation: Operation, platform: String): DeclineReason = when (operation) {
        is Operation.Unsupported -> DeclineReason.NO_HANDLER
        is Operation.Open -> when {
            platform != PHONE -> DeclineReason.NO_HANDLER
            operation.locator is Locator.File -> DeclineReason.UNRESOLVABLE
            operation.locator is Locator.Other -> DeclineReason.UNRESOLVABLE
            operation.locator is Locator.Https && !httpsUrl(operation.locator.url) -> DeclineReason.UNRESOLVABLE
            operation.locator is Locator.Https && operation.version != null -> DeclineReason.VERSION_CHANGED
            else -> DeclineReason.NOT_PERMITTED
        }
        is Operation.Route -> when {
            platform != PHONE -> DeclineReason.NO_HANDLER
            !route -> DeclineReason.NOT_PERMITTED
            else -> DeclineReason.UNRESOLVABLE
        }
        is Operation.Play -> when {
            platform != TV -> DeclineReason.NO_HANDLER
            operation.providers.none { it in providers } -> DeclineReason.NOT_PERMITTED
            else -> DeclineReason.UNRESOLVABLE
        }
    }

    private fun planOpen(operation: Operation.Open): PlannedAction? = when (val locator = operation.locator) {
        is Locator.Https -> when {
            // A document version binds an open to bytes this device would have
            // to read; a phone opens a link, so it can prove no such thing.
            operation.version != null -> null
            !httpsUrl(locator.url) -> null
            host(locator.url)?.takeIf { it in hosts } == null -> null
            else -> PlannedAction.OpenLink(locator.url)
        }
        is Locator.App -> apps.firstOrNull { it.id == locator.id }?.let { PlannedAction.OpenApp(it.id, it.label) }
        is Locator.File, is Locator.Other -> null
    }

    companion object {
        const val PHONE = "android"
        const val TV = "android_tv"
        /** The whole document, exactly as the runtime bounds it before it commits one. */
        const val MAX_POLICY_BYTES = 8192
        const val MAX_HOSTS = 16
        const val MAX_APPS = 8
        const val MAX_PROVIDERS = 4
        const val MAX_LABEL_BYTES = 120
        const val MAX_QUERY_BYTES = 200
        const val MAX_URL_BYTES = 2048

        /**
         * The delivered copy, read against what the snapshot said it is.
         *
         * The document has to be the exact bytes the snapshot named — its
         * length and its SHA-256 — and it has to be the owner's statement
         * about *this* connection: another surface or another approval
         * revision is somebody else's permission and is never held here. Half
         * an allowlist is worse than none, so anything out of shape anywhere
         * refuses the whole document and this device then holds nothing.
         */
        fun decode(bytes: ByteArray, held: HeldPolicy): DevicePolicy? {
            if (bytes.size != held.byteLength || bytes.isEmpty() || bytes.size > MAX_POLICY_BYTES) return null
            if (digest(bytes) != held.digest) return null
            val policy = runCatching {
                val value = JSONObject(String(bytes, Charsets.UTF_8))
                require(value.getInt("version") == 1) { "unsupported policy" }
                // The owner's statement is about one surface at one approval.
                require(UUID.fromString(value.getString("surfaceId")) == held.surfaceId) { "another surface" }
                require(value.getLong("approvalRevision") == held.approvalRevision) { "another approval" }
                // A section is present exactly where the snapshot named its revision.
                require(value.has("actions") == (held.actionsRevision != null)) { "actions disagree" }
                require(value.has("commands") == (held.commandsRevision != null)) { "commands disagree" }
                if (held.commandsRevision != null) {
                    val commands = value.getJSONObject("commands")
                    require(commands.getLong("revision") == held.commandsRevision) { "another commands revision" }
                    require(commands.getString("maximumClass") in ActionWire.PRIVACY_CLASSES) { "unknown class" }
                    commands.getBoolean("offerOutputToCognition")
                }
                // The owner granted this installation no device actions at all;
                // it still holds the copy, and the copy allows it nothing.
                if (held.actionsRevision == null) return@runCatching DevicePolicy()
                val actions = value.getJSONObject("actions")
                require(actions.getLong("revision") == held.actionsRevision) { "another actions revision" }
                require(actions.getString("maximumClass") in ActionWire.PRIVACY_CLASSES) { "unknown class" }
                val open = actions.optJSONObject("open")
                val hostArray = open?.optJSONArray("hosts")
                val appArray = open?.optJSONArray("apps")
                val playArray = actions.optJSONObject("play")?.optJSONArray("providers")
                DevicePolicy(
                    hosts = buildSet { for (index in 0 until (hostArray?.length() ?: 0)) add(hostArray!!.getString(index).lowercase()) },
                    // Cosmos holds no package names: the id is this platform's own.
                    apps = List(appArray?.length() ?: 0) { index ->
                        val app = appArray!!.getJSONObject(index)
                        DeviceApp(app.getString("id"), app.getString("label"))
                    },
                    // Only one route application exists; an unknown one is not a route.
                    route = actions.optJSONObject("route")?.optString("app") == "google_maps",
                    providers = buildSet { for (index in 0 until (playArray?.length() ?: 0)) add(playArray!!.getString(index)) },
                )
            }.getOrNull() ?: return null
            return if (policy.wellFormed) policy else null
        }

        /** The one binding both implementations recompute over the delivered bytes. */
        fun digest(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        /** Text a person reads: non-blank, bounded, and without control characters. */
        fun text(value: String, maximum: Int): Boolean =
            value.isNotBlank() && value.toByteArray().size <= maximum && value.none { it.isISOControl() }

        /** A bare registrable host: lowercase, dotted, no scheme, port, userinfo or path. */
        fun declaredHost(value: String): Boolean =
            value.isNotEmpty() && value.length <= 253 && value == value.lowercase() && value.contains('.') &&
                !value.startsWith('.') && !value.endsWith('.') && !value.contains("..") &&
                value.all { it in 'a'..'z' || it in '0'..'9' || it == '.' || it == '-' }

        fun packageId(value: String): Boolean =
            value.isNotEmpty() && value.toByteArray().size <= 128 && !value.startsWith('.') && !value.endsWith('.') &&
                value.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '-' || it == '_' }

        fun providerId(value: String): Boolean =
            value.isNotEmpty() && value.length <= 32 &&
                value.all { it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }

        /** An `https` locator this device can open without ambiguity. */
        fun httpsUrl(value: String): Boolean {
            if (value.isEmpty() || value.toByteArray().size > MAX_URL_BYTES ||
                value.contains('\\') || value.any { it.isWhitespace() || it.isISOControl() }
            ) return false
            val url = runCatching { URI(value) }.getOrNull() ?: return false
            return url.scheme == "https" && !url.host.isNullOrEmpty() && url.userInfo == null && url.port == -1
        }

        fun host(value: String): String? = runCatching { URI(value).host?.lowercase() }.getOrNull()

        /**
         * Coordinates are ASCII decimal strings with exactly six fraction
         * digits, because float formatting is the one conversion that drifts
         * between languages and this contract hashes it.
         */
        fun coordinate(value: String, maximum: Int): Boolean {
            val body = value.removePrefix("-")
            val whole = body.substringBefore('.', "")
            val fraction = body.substringAfter('.', "")
            if (whole.isEmpty() || whole.length > 3 || fraction.length != 6) return false
            if (!whole.all { it.isDigit() } || !fraction.all { it.isDigit() }) return false
            if (whole.length > 1 && whole.startsWith('0')) return false
            val degrees = whole.toInt()
            return degrees < maximum || (degrees == maximum && fraction.all { it == '0' })
        }
    }
}

/** One application the owner declared this device may open. */
data class DeviceApp(val id: String, val label: String)

/** What this device will actually do, once the command has passed every check. */
sealed interface PlannedAction {
    data class OpenLink(val url: String) : PlannedAction
    data class OpenApp(val id: String, val label: String) : PlannedAction
    data class Navigate(val lat: String, val lng: String, val name: String) : PlannedAction
    data class Play(val provider: String, val query: String, val title: String, val itemDigest: String) : PlannedAction
}
