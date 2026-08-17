package com.penumbraos.server

import com.penumbraos.stockaibus.contract.TierASymbols
import org.json.JSONObject

/**
 * Canonical, request-scoped contract for the privileged stock LPA service.
 *
 * The stock service exposes process-global asynchronous listeners. Therefore
 * every LPA request, including reads, is serialized here. A mutation cannot be
 * overlapped by a status read that would replace the hook's request identity.
 */
internal data class CanonicalEsimRequest(
    val requestId: String,
    val action: String,
    val operationToken: String,
    val iccid: String? = null,
    val activationCode: String? = null,
    val nickname: String? = null,
) {
    val binding: EsimOperationBinding
        get() = EsimOperationBinding(
            requestId = requestId,
            action = action,
            operationToken = operationToken,
            iccid = iccid,
            nickname = nickname,
            activationCodeProvided = activationCode != null,
        )
}

internal data class EsimOperationBinding(
    val requestId: String,
    val action: String,
    val operationToken: String,
    val iccid: String?,
    val nickname: String?,
    val activationCodeProvided: Boolean,
)

internal data class EsimCancellation(
    val requestId: String,
    val action: String,
    val operationToken: String,
)

internal sealed class EsimAdmission {
    data class Accepted(val request: CanonicalEsimRequest) : EsimAdmission()
    data class Rejected(val reason: String) : EsimAdmission()
}

internal object EsimRequestProtocol {
    private const val ACTION_PREFIX = TierASymbols.Packages.ESIM_LPA + "."
    internal const val ACTION_GET_PROFILES = ACTION_PREFIX + "getProfiles"
    internal const val ACTION_GET_ACTIVE_PROFILE = ACTION_PREFIX + "getActiveProfile"
    internal const val ACTION_GET_ACTIVE_PROFILE_ICCID = ACTION_PREFIX + "getActiveprofileICCID"
    internal const val ACTION_GET_EID = ACTION_PREFIX + "getEID"
    internal const val ACTION_ENABLE_PROFILE = ACTION_PREFIX + "enableProfile"
    internal const val ACTION_DISABLE_PROFILE = ACTION_PREFIX + "disableProfile"
    internal const val ACTION_DELETE_PROFILE = ACTION_PREFIX + "deleteProfile"
    internal const val ACTION_SET_NICKNAME = ACTION_PREFIX + "setNickname"
    internal const val ACTION_DOWNLOAD_VERIFY_AND_ENABLE_PROFILE =
        ACTION_PREFIX + "downloadVerifyAndEnableProfile"
    internal const val ACTION_DOWNLOAD_AND_ENABLE_PROFILE =
        ACTION_PREFIX + "downloadAndEnableProfile"

    private val requestIdPattern = Regex("^req_[0-9a-f]{32}$")
    private val operationTokenPattern = Regex("^op_[0-9a-f]{32}$")
    private val iccidPattern = Regex("^[0-9]{10,22}$")

    private enum class Schema {
        EMPTY,
        ICCID,
        ICCID_AND_NICKNAME,
        ACTIVATION_CODE,
    }

    private val actionSchemas = mapOf(
        ACTION_GET_PROFILES to Schema.EMPTY,
        ACTION_GET_ACTIVE_PROFILE to Schema.EMPTY,
        ACTION_GET_ACTIVE_PROFILE_ICCID to Schema.EMPTY,
        ACTION_GET_EID to Schema.EMPTY,
        ACTION_ENABLE_PROFILE to Schema.ICCID,
        ACTION_DISABLE_PROFILE to Schema.ICCID,
        ACTION_DELETE_PROFILE to Schema.ICCID,
        ACTION_SET_NICKNAME to Schema.ICCID_AND_NICKNAME,
        ACTION_DOWNLOAD_VERIFY_AND_ENABLE_PROFILE to Schema.ACTIVATION_CODE,
    )

    fun parse(message: JSONObject): Result<CanonicalEsimRequest> = runCatching {
        requireExactKeys(
            message,
            setOf("type", "request_id", "action", "operation_token", "payload"),
            "request envelope",
        )
        require(message.optString("type") == "esim.request") { "unsupported request type" }

        val requestId = requiredString(message, "request_id")
        require(requestIdPattern.matches(requestId)) { "invalid request_id" }
        val operationToken = requiredString(message, "operation_token")
        require(operationTokenPattern.matches(operationToken)) { "invalid operation_token" }
        val action = requiredString(message, "action")
        val schema = actionSchemas[action] ?: error("unsupported eSIM action")
        val payload = message.optJSONObject("payload") ?: error("payload must be an object")

        when (schema) {
            Schema.EMPTY -> {
                requireExactKeys(payload, emptySet(), "payload")
                CanonicalEsimRequest(requestId, action, operationToken)
            }
            Schema.ICCID -> {
                requireExactKeys(payload, setOf("iccid"), "payload")
                CanonicalEsimRequest(
                    requestId,
                    action,
                    operationToken,
                    iccid = normalizeIccid(requiredString(payload, "iccid")),
                )
            }
            Schema.ICCID_AND_NICKNAME -> {
                requireExactKeys(payload, setOf("iccid", "nickname"), "payload")
                CanonicalEsimRequest(
                    requestId,
                    action,
                    operationToken,
                    iccid = normalizeIccid(requiredString(payload, "iccid")),
                    nickname = normalizeNickname(requiredString(payload, "nickname")),
                )
            }
            Schema.ACTIVATION_CODE -> {
                requireExactKeys(payload, setOf("activationCode"), "payload")
                CanonicalEsimRequest(
                    requestId,
                    action,
                    operationToken,
                    activationCode = normalizeActivationCode(requiredString(payload, "activationCode")),
                )
            }
        }
    }

    fun parseCancellation(message: JSONObject): Result<EsimCancellation> = runCatching {
        requireExactKeys(
            message,
            setOf("type", "request_id", "action", "operation_token"),
            "cancellation envelope",
        )
        require(message.optString("type") == "esim.cancel_request") { "unsupported request type" }
        val requestId = requiredString(message, "request_id")
        require(requestIdPattern.matches(requestId)) { "invalid request_id" }
        val action = requiredString(message, "action")
        require(actionSchemas.containsKey(action)) { "unsupported eSIM action" }
        val operationToken = requiredString(message, "operation_token")
        require(operationTokenPattern.matches(operationToken)) { "invalid operation_token" }
        EsimCancellation(requestId, action, operationToken)
    }

    fun expectedTerminalType(action: String): String? = when (action) {
        ACTION_GET_PROFILES -> "esim.profiles_result"
        ACTION_GET_ACTIVE_PROFILE -> "esim.active_profile_result"
        ACTION_GET_ACTIVE_PROFILE_ICCID -> "esim.active_iccid_result"
        ACTION_GET_EID -> "esim.device_identifiers_result"
        ACTION_ENABLE_PROFILE,
        ACTION_DISABLE_PROFILE,
        ACTION_DELETE_PROFILE,
        ACTION_SET_NICKNAME -> "esim.profile_mutation_result"
        else -> null
    }

    fun expectedMutationOperation(action: String): String? = when (action) {
        ACTION_ENABLE_PROFILE,
        ACTION_DOWNLOAD_VERIFY_AND_ENABLE_PROFILE -> "enable"
        ACTION_DISABLE_PROFILE -> "disable"
        ACTION_DELETE_PROFILE -> "delete"
        ACTION_SET_NICKNAME -> "set_nickname"
        else -> null
    }

    fun isDownloadAction(action: String): Boolean =
        action == ACTION_DOWNLOAD_VERIFY_AND_ENABLE_PROFILE

    private fun requiredString(objectValue: JSONObject, key: String): String {
        require(objectValue.has(key) && !objectValue.isNull(key)) { "$key is required" }
        return (objectValue.opt(key) as? String)?.takeIf { it.isNotEmpty() }
            ?: error("$key must be a non-empty string")
    }

    private fun requireExactKeys(value: JSONObject, expected: Set<String>, label: String) {
        val actual = mutableSetOf<String>()
        val keys = value.keys()
        while (keys.hasNext()) actual += keys.next()
        require(actual == expected) { "$label schema mismatch" }
    }

    private fun normalizeIccid(raw: String): String {
        val normalized = raw.trim().filterNot { it == ' ' || it == '-' }
        require(iccidPattern.matches(normalized)) { "invalid iccid" }
        return normalized
    }

    private fun normalizeNickname(raw: String): String {
        val normalized = raw.trim()
        require(normalized.isNotEmpty() && normalized.length <= 64) { "invalid nickname" }
        require(normalized.none(Char::isISOControl)) { "invalid nickname" }
        return normalized
    }

    private fun normalizeActivationCode(raw: String): String {
        val normalized = raw.trim()
        require(normalized.isNotEmpty() && normalized.length <= 2_048) { "invalid activation code" }
        require(normalized.none(Char::isISOControl)) { "invalid activation code" }
        return normalized
    }
}

internal class EsimOperationGate {
    private val seenRequestIds = linkedSetOf<String>()
    private var active: EsimOperationBinding? = null

    @Synchronized
    fun admit(request: CanonicalEsimRequest): EsimAdmission {
        if (!seenRequestIds.add(request.requestId)) {
            return EsimAdmission.Rejected("duplicate or replayed request_id")
        }
        if (active != null) {
            return EsimAdmission.Rejected("another eSIM operation is already in flight")
        }
        active = request.binding
        return EsimAdmission.Accepted(request)
    }

    @Synchronized
    fun releaseAfterDispatchFailure(binding: EsimOperationBinding) {
        if (active == binding) active = null
    }

    @Synchronized
    fun cancel(cancellation: EsimCancellation): Boolean {
        val binding = active ?: return false
        if (binding.requestId != cancellation.requestId ||
            binding.action != cancellation.action ||
            binding.operationToken != cancellation.operationToken
        ) {
            return false
        }
        active = null
        return true
    }

    @Synchronized
    fun acceptsEvent(event: JSONObject): Boolean {
        val binding = active ?: return false
        if (event.optString("request_id") != binding.requestId ||
            event.optString("action") != binding.action ||
            event.optString("operation_token") != binding.operationToken
        ) {
            return false
        }

        val payload = event.optJSONObject("payload")
        return when (event.optString("type")) {
            "esim.action_started" -> actionStartedMatches(payload, binding)
            "esim.sysprop_update" -> EsimRequestProtocol.expectedMutationOperation(binding.action) == null
            "esim.profiles_result",
            "esim.active_profile_result",
            "esim.active_iccid_result",
            "esim.device_identifiers_result" ->
                event.optString("type") == EsimRequestProtocol.expectedTerminalType(binding.action) &&
                    payload?.optString("result")?.isNotEmpty() == true
            "esim.profile_mutation_result" -> mutationResultMatches(payload, binding)
            "esim.download_progress" ->
                EsimRequestProtocol.isDownloadAction(binding.action) &&
                    payload?.optString("phase")?.isNotEmpty() == true
            "esim.download_result" ->
                EsimRequestProtocol.isDownloadAction(binding.action) &&
                    payload?.optString("result")?.isNotEmpty() == true
            else -> false
        }
    }

    @Synchronized
    fun markDelivered(event: JSONObject) {
        val binding = active ?: return
        if (!acceptsEvent(event) || !isTerminal(event, binding)) return
        active = null
    }

    @Synchronized
    fun activeBindingForTest(): EsimOperationBinding? = active

    private fun actionStartedMatches(payload: JSONObject?, binding: EsimOperationBinding): Boolean {
        val extras = payload?.optJSONObject("extras") ?: return false
        return nullableString(extras, "iccid") == binding.iccid &&
            nullableString(extras, "nickname") == binding.nickname &&
            (extras.opt("activationCodeProvided") as? Boolean) == binding.activationCodeProvided
    }

    private fun mutationResultMatches(payload: JSONObject?, binding: EsimOperationBinding): Boolean {
        payload ?: return false
        if (payload.optString("operation") != EsimRequestProtocol.expectedMutationOperation(binding.action)) {
            return false
        }
        if (!EsimRequestProtocol.isDownloadAction(binding.action) &&
            nullableString(payload, "target_iccid") != binding.iccid
        ) {
            return false
        }
        if (binding.nickname != null && nullableString(payload, "nickname") != binding.nickname) {
            return false
        }
        return payload.optString("result").isNotEmpty()
    }

    private fun isTerminal(event: JSONObject, binding: EsimOperationBinding): Boolean {
        val type = event.optString("type")
        if (type == EsimRequestProtocol.expectedTerminalType(binding.action)) return true
        if (!EsimRequestProtocol.isDownloadAction(binding.action)) return false
        if (type == "esim.profile_mutation_result") return true
        if (type != "esim.download_result") return false
        return event.optJSONObject("payload")?.optString("result")
            ?.takeIf { it.isNotEmpty() } != "success"
    }

    private fun nullableString(value: JSONObject, key: String): String? =
        if (!value.has(key) || value.isNull(key)) null else value.optString(key).takeIf { it.isNotEmpty() }
}
