package com.penumbraos.server

import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale

/**
 * Wire names consumed by the injected Pin transport.
 *
 * Implemented: these values intentionally remain the existing `penumbra_cosmos_*`
 * keys because changing them would break already-built Hook APKs. "Cosmos" is
 * the product name; the stored keys are a compatibility contract.
 */
internal object CosmosActivationContract {
    const val REMOTE_MODE_SETTING = "penumbra_cosmos_remote_mode"
    const val EDGE_IPV4_SETTING = "penumbra_cosmos_edge_ipv4"
    const val ROOT_CERTIFICATE_SETTING = "penumbra_cosmos_root_certificate_der_b64"
    const val DEVICE_STATUS_ENDPOINT_SETTING = "penumbra_cosmos_device_status_endpoint"
    const val ATTESTATION_BUNDLE_SETTING = "penumbra_cosmos_attestation_bundle_b64"
    const val ATTESTATION_KEY_ALIAS = "penumbra_cosmos_device_attestation_v1"
    const val ATTESTATION_PRODUCT_ID = "00000001"

    const val API_HOST = "api.cosmos.humane.cloud"
    const val ONBOARDING_HOST = "onboarding.cosmos.humane.cloud"
    const val API_ENDPOINT = "https://$API_HOST"
    const val ONBOARDING_ENDPOINT = "https://$ONBOARDING_HOST"

    fun plan(
        apiEndpoint: String,
        onboardingEndpoint: String,
        deviceStatusEndpoint: String,
        edgeIpv4: String,
    ): CosmosEndpointPlan = CosmosEndpointPlan(
        apiEndpoint = canonicalHttpsEndpoint(apiEndpoint, API_HOST),
        onboardingEndpoint = canonicalHttpsEndpoint(onboardingEndpoint, ONBOARDING_HOST),
        deviceStatusEndpoint = canonicalDeviceStatusEndpoint(deviceStatusEndpoint),
        edgeIpv4 = canonicalIpv4(edgeIpv4),
    )

    fun expectedAttestationSubject(deviceId: String): String {
        require(deviceId.isNotEmpty() && deviceId.all(Char::isAsciiHexDigit)) {
            "Device id must be hexadecimal"
        }
        return "V:01:D:${deviceId.lowercase(Locale.US)}:P:$ATTESTATION_PRODUCT_ID"
    }

    private fun canonicalHttpsEndpoint(value: String, expectedHost: String): String {
        val parsed = runCatching { URI(value.trim()) }
            .getOrElse { throw IllegalArgumentException("Cosmos endpoint is invalid") }
        require(parsed.scheme.equals("https", ignoreCase = true)) {
            "Cosmos endpoint must use HTTPS"
        }
        require(parsed.host?.lowercase(Locale.US) == expectedHost) {
            "Cosmos endpoint host is not allowlisted"
        }
        require(parsed.userInfo == null && parsed.query == null && parsed.fragment == null) {
            "Cosmos endpoint cannot contain credentials, a query, or a fragment"
        }
        require(parsed.port == -1 || parsed.port == 443) {
            "Cosmos endpoint must use port 443"
        }
        require(parsed.path.isNullOrEmpty() || parsed.path == "/") {
            "Cosmos endpoint cannot contain a path"
        }
        return "https://$expectedHost"
    }

    fun canonicalDeviceStatusEndpoint(value: String): String {
        val parsed = runCatching { URI(value.trim()) }
            .getOrElse { throw IllegalArgumentException("Device status endpoint is invalid") }
        require(parsed.scheme.equals("https", ignoreCase = true) && !parsed.host.isNullOrBlank()) {
            "Device status endpoint must use HTTPS"
        }
        require(parsed.userInfo == null && parsed.query == null && parsed.fragment == null) {
            "Device status endpoint cannot contain credentials, a query, or a fragment"
        }
        require(parsed.port == -1 || parsed.port == 443) {
            "Device status endpoint must use port 443"
        }
        require(parsed.path == "/device-status/v1/report") {
            "Device status endpoint path is invalid"
        }
        return "https://${parsed.host.lowercase(Locale.US)}/device-status/v1/report"
    }

    private fun canonicalIpv4(value: String): String {
        val parts = value.trim().split('.')
        require(parts.size == 4) { "Cosmos edge address must be IPv4" }
        return parts.joinToString(".") { part ->
            require(part.isNotEmpty() && part.length <= 3 && part.all(Char::isDigit)) {
                "Cosmos edge address must be IPv4"
            }
            val octet = part.toIntOrNull()
            require(octet != null && octet in 0..255 && octet.toString() == part) {
                "Cosmos edge address must be canonical IPv4"
            }
            octet.toString()
        }
    }
}

private fun Char.isAsciiHexDigit(): Boolean =
    this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

internal data class CosmosEndpointPlan(
    val apiEndpoint: String,
    val onboardingEndpoint: String,
    val deviceStatusEndpoint: String,
    val edgeIpv4: String,
)

internal data class CosmosIdentityDescriptor(
    val fingerprintSha256: String,
    val subject: String,
    val usableForTls: Boolean = true,
)

internal data class CosmosRootDescriptor(
    val certificateDerBase64: String,
    val fingerprintSha256: String,
)

internal interface CosmosSettingsPort {
    fun read(key: String): String?

    /** A null value means an exact row deletion, not a textual/null sentinel. */
    fun write(key: String, value: String?): Boolean
}

/** Candidate material is bound to an implementation instance and never enters the journal. */
internal interface CosmosIdentityPort {
    fun candidate(): CosmosIdentityDescriptor

    fun current(): CosmosIdentityDescriptor?

    fun installCandidate(): CosmosIdentityDescriptor

    /** Returns false rather than deleting when the current leaf does not match. */
    fun removeIfMatches(fingerprintSha256: String): Boolean
}

internal enum class CosmosActivationPhase {
    PREPARING,
    ACTIVE,
    DEACTIVATING,
}

/**
 * Durable non-secret rollback state. Attestation key bytes and the staging value
 * are deliberately excluded. Activation refuses to overwrite a pending staging
 * value, so the exact previous value is always absent.
 */
internal data class CosmosActivationRecord(
    val phase: CosmosActivationPhase,
    val previousRemoteMode: String?,
    val previousEdgeIpv4: String?,
    val previousRootCertificateDerBase64: String?,
    val previousDeviceStatusEndpoint: String?,
    val identityWasPresent: Boolean,
    val targetFingerprintSha256: String,
    val targetRootFingerprintSha256: String,
    val apiEndpoint: String,
    val onboardingEndpoint: String,
    val deviceStatusEndpoint: String,
    val targetEdgeIpv4: String,
    val rollbackFailed: Boolean = false,
)

internal enum class CosmosActivationStatusState(val wireValue: String) {
    ACTIVE("active"),
    INACTIVE("inactive"),
    PREPARING("preparing"),
    DEACTIVATING("deactivating"),
    ROLLBACK_FAILED("rollback_failed"),
    INCONSISTENT("inconsistent"),
}

internal data class CosmosActivationObservedState(
    val remoteMode: String?,
    val edgeIpv4: String?,
    val deviceStatusEndpoint: String?,
    val rootCertificatePresent: Boolean,
    val rootCertificateFingerprintSha256: String?,
    val identityPresent: Boolean,
    val identityUsable: Boolean,
    val identityFingerprintSha256: String?,
)

internal data class CosmosActivationStatus(
    val state: CosmosActivationStatusState,
    val consistent: Boolean,
    val managed: Boolean,
    val phase: CosmosActivationPhase?,
    val rollbackFailed: Boolean,
    val rollbackComplete: Boolean,
    val remoteGateEnabled: Boolean,
    val targetMatches: Boolean,
)

/** Reconcile the durable transaction journal with the live activation inputs. */
internal fun reconcileCosmosActivationStatus(
    record: CosmosActivationRecord?,
    observed: CosmosActivationObservedState,
): CosmosActivationStatus {
    val remoteGateEnabled = observed.remoteMode == "1"
    val targetMatches = record != null &&
        observed.edgeIpv4 == record.targetEdgeIpv4 &&
        observed.deviceStatusEndpoint == record.deviceStatusEndpoint &&
        observed.rootCertificateFingerprintSha256 == record.targetRootFingerprintSha256 &&
        observed.identityPresent &&
        observed.identityUsable &&
        observed.identityFingerprintSha256 == record.targetFingerprintSha256

    val state = when {
        record?.rollbackFailed == true -> CosmosActivationStatusState.ROLLBACK_FAILED
        record?.phase == CosmosActivationPhase.PREPARING -> CosmosActivationStatusState.PREPARING
        record?.phase == CosmosActivationPhase.DEACTIVATING -> CosmosActivationStatusState.DEACTIVATING
        record?.phase == CosmosActivationPhase.ACTIVE && remoteGateEnabled && targetMatches ->
            CosmosActivationStatusState.ACTIVE
        record != null -> CosmosActivationStatusState.INCONSISTENT
        remoteGateEnabled || observed.edgeIpv4 != null || observed.deviceStatusEndpoint != null ||
            observed.rootCertificatePresent || observed.identityPresent ->
            CosmosActivationStatusState.INCONSISTENT
        else -> CosmosActivationStatusState.INACTIVE
    }
    val consistent = state == CosmosActivationStatusState.ACTIVE ||
        state == CosmosActivationStatusState.INACTIVE
    return CosmosActivationStatus(
        state = state,
        consistent = consistent,
        managed = record != null,
        phase = record?.phase,
        rollbackFailed = record?.rollbackFailed == true,
        rollbackComplete = consistent,
        remoteGateEnabled = remoteGateEnabled,
        targetMatches = targetMatches,
    )
}

internal interface CosmosActivationRecordPort {
    fun load(): CosmosActivationRecord?

    fun save(record: CosmosActivationRecord): Boolean

    fun clear(): Boolean
}

internal enum class CosmosActivationCode(val wireValue: String, val safeMessage: String) {
    ACTIVATED("activated", "Cosmos activation completed."),
    ALREADY_ACTIVE("already_active", "Cosmos is already active with this identity and endpoint."),
    DEACTIVATED("deactivated", "Cosmos activation was removed and the previous Pin state was restored."),
    ALREADY_INACTIVE("already_inactive", "Cosmos is already inactive."),
    INVALID_REQUEST("invalid_request", "The Cosmos activation request was rejected."),
    IDENTITY_CONFLICT("identity_conflict", "A different Cosmos identity is already installed."),
    IDENTITY_UNUSABLE("identity_unusable", "The installed Cosmos identity is not usable for TLS."),
    ACTIVE_CONFIGURATION_CONFLICT(
        "active_configuration_conflict",
        "A different remote Cosmos configuration is already active.",
    ),
    PENDING_ATTESTATION_CONFLICT(
        "pending_attestation_conflict",
        "A separate attestation import is already pending.",
    ),
    UNMANAGED_ACTIVE_CONFIGURATION(
        "unmanaged_active_configuration",
        "The active Cosmos configuration has no rollback record and was left unchanged.",
    ),
    TRANSACTION_FAILED("transaction_failed", "Cosmos activation did not complete."),
    ROLLBACK_FAILED(
        "rollback_failed",
        "Cosmos activation failed and automatic rollback was incomplete.",
    ),
}

internal data class CosmosActivationResult(
    val ok: Boolean,
    val code: CosmosActivationCode,
    val changed: Boolean,
    val managed: Boolean,
    val rollbackComplete: Boolean,
    val apiEndpoint: String? = null,
    val onboardingEndpoint: String? = null,
    val deviceStatusEndpoint: String? = null,
    val edgeIpv4: String? = null,
    val identityFingerprintSha256: String? = null,
    val rootCertificateFingerprintSha256: String? = null,
) {
    val message: String get() = code.safeMessage
}

/**
 * Pure commit coordinator for Pin -> Cosmos activation.
 *
 * Implemented ordering: validate everything, journal, persist and read back the
 * root, import identity, write the edge, clear staging, and enable remote mode
 * last. Every Settings.Global write is read back exactly.
 */
internal class CosmosActivationTransaction(
    private val settings: CosmosSettingsPort,
    private val records: CosmosActivationRecordPort,
) {
    fun activate(
        apiEndpoint: String,
        onboardingEndpoint: String,
        deviceStatusEndpoint: String,
        edgeIpv4: String,
        root: CosmosRootDescriptor,
        identity: CosmosIdentityPort,
        clearStaging: (() -> Boolean)? = null,
    ): CosmosActivationResult {
        val plan = try {
            CosmosActivationContract.plan(
                apiEndpoint,
                onboardingEndpoint,
                deviceStatusEndpoint,
                edgeIpv4,
            )
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.INVALID_REQUEST)
        }

        val candidate = try {
            identity.candidate().also(::requireSafeDescriptor)
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.INVALID_REQUEST)
        }
        try {
            requireSafeRoot(root)
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.INVALID_REQUEST)
        }

        val existingRecord = try {
            records.load()
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.TRANSACTION_FAILED)
        }

        if (existingRecord?.phase != null && existingRecord.phase != CosmosActivationPhase.ACTIVE) {
            if (!completeInterruptedTransition(existingRecord, identity)) {
                markRollbackFailed(existingRecord)
                return failure(CosmosActivationCode.ROLLBACK_FAILED, rollbackComplete = false)
            }
        }

        val activeRecord = try {
            records.load()
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.TRANSACTION_FAILED)
        }
        val currentRemote = safeRead(CosmosActivationContract.REMOTE_MODE_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val currentEdge = safeRead(CosmosActivationContract.EDGE_IPV4_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val currentRoot = safeRead(CosmosActivationContract.ROOT_CERTIFICATE_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val currentDeviceStatus = safeRead(CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val pendingAttestation = safeRead(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val currentIdentity = try {
            identity.current()?.also(::requireSafeDescriptor)
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.TRANSACTION_FAILED)
        }

        if (pendingAttestation.value != null) {
            return failure(CosmosActivationCode.PENDING_ATTESTATION_CONFLICT)
        }

        if (currentRemote.value == "1") {
            val matches = currentEdge.value == plan.edgeIpv4 &&
                currentDeviceStatus.value == plan.deviceStatusEndpoint &&
                currentRoot.value == root.certificateDerBase64 &&
                currentIdentity?.fingerprintSha256 == candidate.fingerprintSha256 &&
                currentIdentity.usableForTls
            if (!matches) {
                return failure(CosmosActivationCode.ACTIVE_CONFIGURATION_CONFLICT)
            }
            val managed = activeRecord?.phase == CosmosActivationPhase.ACTIVE &&
                recordTargets(activeRecord, plan, candidate, root)
            return success(
                code = CosmosActivationCode.ALREADY_ACTIVE,
                changed = false,
                managed = managed,
                plan = plan,
                candidate = candidate,
                root = root,
            )
        }

        if (activeRecord != null) {
            // An ACTIVE journal with a disabled/tampered gate must be reconciled
            // explicitly; silently writing over it would destroy rollback truth.
            return failure(CosmosActivationCode.ACTIVE_CONFIGURATION_CONFLICT)
        }

        if (currentIdentity != null &&
            currentIdentity.fingerprintSha256 != candidate.fingerprintSha256
        ) {
            return failure(CosmosActivationCode.IDENTITY_CONFLICT)
        }
        if (currentIdentity != null && !currentIdentity.usableForTls) {
            return failure(CosmosActivationCode.IDENTITY_UNUSABLE)
        }

        val preparing = CosmosActivationRecord(
            phase = CosmosActivationPhase.PREPARING,
            previousRemoteMode = currentRemote.value,
            previousEdgeIpv4 = currentEdge.value,
            previousRootCertificateDerBase64 = currentRoot.value,
            previousDeviceStatusEndpoint = currentDeviceStatus.value,
            identityWasPresent = currentIdentity != null,
            targetFingerprintSha256 = candidate.fingerprintSha256,
            targetRootFingerprintSha256 = root.fingerprintSha256,
            apiEndpoint = plan.apiEndpoint,
            onboardingEndpoint = plan.onboardingEndpoint,
            deviceStatusEndpoint = plan.deviceStatusEndpoint,
            targetEdgeIpv4 = plan.edgeIpv4,
        )
        if (!safeSave(preparing)) {
            return failure(CosmosActivationCode.TRANSACTION_FAILED)
        }

        return try {
            check(writeExact(
                CosmosActivationContract.ROOT_CERTIFICATE_SETTING,
                root.certificateDerBase64,
            ))
            val installed = identity.installCandidate().also(::requireSafeDescriptor)
            check(installed.fingerprintSha256 == candidate.fingerprintSha256)
            check(installed.usableForTls)
            check(writeExact(CosmosActivationContract.EDGE_IPV4_SETTING, plan.edgeIpv4))
            check(writeExact(
                CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
                plan.deviceStatusEndpoint,
            ))
            check(
                clearStaging?.invoke()
                    ?: writeExact(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING, null),
            )
            // Commit gate is always last. Until this exact read-back succeeds,
            // stock traffic cannot be redirected to a partially configured edge.
            check(writeExact(CosmosActivationContract.REMOTE_MODE_SETTING, "1"))

            val active = preparing.copy(phase = CosmosActivationPhase.ACTIVE)
            check(safeSave(active))
            success(
                code = CosmosActivationCode.ACTIVATED,
                changed = true,
                managed = true,
                plan = plan,
                candidate = candidate,
                root = root,
            )
        } catch (_: Throwable) {
            val rolledBack = rollbackActivation(preparing, identity)
            if (rolledBack) {
                runCatching { records.clear() }
                failure(CosmosActivationCode.TRANSACTION_FAILED)
            } else {
                markRollbackFailed(preparing)
                failure(CosmosActivationCode.ROLLBACK_FAILED, rollbackComplete = false)
            }
        }
    }

    fun deactivate(identity: CosmosIdentityPort): CosmosActivationResult {
        val record = try {
            records.load()
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.TRANSACTION_FAILED)
        }
        if (record == null) {
            val remote = safeRead(CosmosActivationContract.REMOTE_MODE_SETTING)
                ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
            return if (remote.value == "1") {
                failure(CosmosActivationCode.UNMANAGED_ACTIVE_CONFIGURATION)
            } else {
                success(CosmosActivationCode.ALREADY_INACTIVE, changed = false, managed = false)
            }
        }
        if (record.phase != CosmosActivationPhase.ACTIVE) {
            return if (completeInterruptedTransition(record, identity)) {
                success(CosmosActivationCode.ALREADY_INACTIVE, changed = false, managed = false)
            } else {
                markRollbackFailed(record)
                failure(CosmosActivationCode.ROLLBACK_FAILED, rollbackComplete = false)
            }
        }

        val currentIdentity = try {
            identity.current()?.also(::requireSafeDescriptor)
        } catch (_: Throwable) {
            return failure(CosmosActivationCode.TRANSACTION_FAILED)
        }
        if (!record.identityWasPresent &&
            currentIdentity != null &&
            currentIdentity.fingerprintSha256 != record.targetFingerprintSha256
        ) {
            return failure(CosmosActivationCode.IDENTITY_CONFLICT)
        }
        val pending = safeRead(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        if (pending.value != null) {
            return failure(CosmosActivationCode.PENDING_ATTESTATION_CONFLICT)
        }

        val activeRemote = safeRead(CosmosActivationContract.REMOTE_MODE_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val activeEdge = safeRead(CosmosActivationContract.EDGE_IPV4_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val activeRoot = safeRead(CosmosActivationContract.ROOT_CERTIFICATE_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val activeDeviceStatus = safeRead(CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING)
            ?: return failure(CosmosActivationCode.TRANSACTION_FAILED)
        val deactivating = record.copy(phase = CosmosActivationPhase.DEACTIVATING)
        if (!safeSave(deactivating)) {
            return failure(CosmosActivationCode.TRANSACTION_FAILED)
        }

        var identityRemoved = false
        return try {
            check(writeExact(CosmosActivationContract.REMOTE_MODE_SETTING, record.previousRemoteMode))
            check(writeExact(CosmosActivationContract.EDGE_IPV4_SETTING, record.previousEdgeIpv4))
            check(writeExact(
                CosmosActivationContract.ROOT_CERTIFICATE_SETTING,
                record.previousRootCertificateDerBase64,
            ))
            check(writeExact(
                CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
                record.previousDeviceStatusEndpoint,
            ))
            check(writeExact(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING, null))
            if (!record.identityWasPresent) {
                check(identity.removeIfMatches(record.targetFingerprintSha256))
                identityRemoved = true
            }
            check(previousStateMatches(record, identity))
            // If clearing the already-restored non-secret record fails, the next
            // call recognizes DEACTIVATING and finishes cleanup idempotently.
            runCatching { records.clear() }
            success(
                code = CosmosActivationCode.DEACTIVATED,
                changed = true,
                managed = false,
                plan = CosmosEndpointPlan(
                    record.apiEndpoint,
                    record.onboardingEndpoint,
                    record.deviceStatusEndpoint,
                    record.targetEdgeIpv4,
                ),
                candidate = CosmosIdentityDescriptor(
                    record.targetFingerprintSha256,
                    subject = "",
                ),
                root = CosmosRootDescriptor(
                    certificateDerBase64 = activeRoot.value.orEmpty(),
                    fingerprintSha256 = record.targetRootFingerprintSha256,
                ),
            )
        } catch (_: Throwable) {
            val identityWasUsable = currentIdentity?.fingerprintSha256 ==
                record.targetFingerprintSha256 && currentIdentity.usableForTls
            val restoredActive = !identityRemoved && identityWasUsable &&
                writeExact(CosmosActivationContract.EDGE_IPV4_SETTING, activeEdge.value) &&
                writeExact(CosmosActivationContract.ROOT_CERTIFICATE_SETTING, activeRoot.value) &&
                writeExact(
                    CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
                    activeDeviceStatus.value,
                ) &&
                writeExact(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING, null) &&
                writeExact(CosmosActivationContract.REMOTE_MODE_SETTING, activeRemote.value) &&
                safeSave(record)
            if (restoredActive) {
                failure(CosmosActivationCode.TRANSACTION_FAILED)
            } else {
                markRollbackFailed(deactivating)
                failure(CosmosActivationCode.ROLLBACK_FAILED, rollbackComplete = false)
            }
        }
    }

    private fun completeInterruptedTransition(
        record: CosmosActivationRecord,
        identity: CosmosIdentityPort,
    ): Boolean {
        val completed = when (record.phase) {
            CosmosActivationPhase.PREPARING -> rollbackActivation(record, identity)
            CosmosActivationPhase.DEACTIVATING -> completeDeactivation(record, identity)
            CosmosActivationPhase.ACTIVE -> true
        }
        return completed && runCatching { records.clear() }.getOrDefault(false)
    }

    private fun completeDeactivation(
        record: CosmosActivationRecord,
        identity: CosmosIdentityPort,
    ): Boolean = runCatching {
        check(writeExact(CosmosActivationContract.REMOTE_MODE_SETTING, record.previousRemoteMode))
        check(writeExact(CosmosActivationContract.EDGE_IPV4_SETTING, record.previousEdgeIpv4))
        check(writeExact(
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING,
            record.previousRootCertificateDerBase64,
        ))
        check(writeExact(
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
            record.previousDeviceStatusEndpoint,
        ))
        check(writeExact(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING, null))
        if (!record.identityWasPresent) {
            check(identity.removeIfMatches(record.targetFingerprintSha256))
        }
        previousStateMatches(record, identity)
    }.getOrDefault(false)

    private fun rollbackActivation(
        record: CosmosActivationRecord,
        identity: CosmosIdentityPort,
    ): Boolean = runCatching {
        // Fail closed: restore the disabled/non-1 gate before changing endpoint
        // or identity state.
        check(record.previousRemoteMode != "1")
        check(writeExact(CosmosActivationContract.REMOTE_MODE_SETTING, record.previousRemoteMode))
        check(writeExact(CosmosActivationContract.EDGE_IPV4_SETTING, record.previousEdgeIpv4))
        check(writeExact(
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING,
            record.previousRootCertificateDerBase64,
        ))
        check(writeExact(
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
            record.previousDeviceStatusEndpoint,
        ))
        check(writeExact(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING, null))
        if (!record.identityWasPresent) {
            check(identity.removeIfMatches(record.targetFingerprintSha256))
        }
        previousStateMatches(record, identity)
    }.getOrDefault(false)

    private fun previousStateMatches(
        record: CosmosActivationRecord,
        identity: CosmosIdentityPort,
    ): Boolean {
        if (settings.read(CosmosActivationContract.REMOTE_MODE_SETTING) != record.previousRemoteMode) {
            return false
        }
        if (settings.read(CosmosActivationContract.EDGE_IPV4_SETTING) != record.previousEdgeIpv4) {
            return false
        }
        if (settings.read(CosmosActivationContract.ROOT_CERTIFICATE_SETTING) !=
            record.previousRootCertificateDerBase64
        ) {
            return false
        }
        if (settings.read(CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING) !=
            record.previousDeviceStatusEndpoint
        ) {
            return false
        }
        if (settings.read(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING) != null) {
            return false
        }
        val currentIdentity = identity.current()
        return if (record.identityWasPresent) {
            currentIdentity?.fingerprintSha256 == record.targetFingerprintSha256
        } else {
            currentIdentity == null
        }
    }

    private fun writeExact(key: String, value: String?): Boolean = runCatching {
        settings.write(key, value) && settings.read(key) == value
    }.getOrDefault(false)

    private fun safeSave(record: CosmosActivationRecord): Boolean = runCatching {
        records.save(record) && records.load() == record
    }.getOrDefault(false)

    private fun markRollbackFailed(record: CosmosActivationRecord) {
        safeSave(record.copy(rollbackFailed = true))
    }

    private data class ReadValue(val value: String?)

    private fun safeRead(key: String): ReadValue? = runCatching {
        ReadValue(settings.read(key))
    }.getOrNull()

    private fun recordTargets(
        record: CosmosActivationRecord,
        plan: CosmosEndpointPlan,
        candidate: CosmosIdentityDescriptor,
        root: CosmosRootDescriptor,
    ): Boolean = record.apiEndpoint == plan.apiEndpoint &&
        record.onboardingEndpoint == plan.onboardingEndpoint &&
        record.deviceStatusEndpoint == plan.deviceStatusEndpoint &&
        record.targetEdgeIpv4 == plan.edgeIpv4 &&
        record.targetFingerprintSha256 == candidate.fingerprintSha256 &&
        record.targetRootFingerprintSha256 == root.fingerprintSha256

    private fun requireSafeDescriptor(descriptor: CosmosIdentityDescriptor) {
        require(descriptor.fingerprintSha256.length == 64)
        require(descriptor.fingerprintSha256.all(Char::isAsciiHexDigit))
        require(!descriptor.subject.contains("PRIVATE KEY", ignoreCase = true))
    }

    private fun requireSafeRoot(root: CosmosRootDescriptor) {
        require(root.fingerprintSha256.length == 64)
        require(root.fingerprintSha256.all(Char::isAsciiHexDigit))
        require(root.certificateDerBase64.length in 1..16_384)
        val der = Base64.getDecoder().decode(root.certificateDerBase64)
        require(der.size in 1..8192)
        require(Base64.getEncoder().encodeToString(der) == root.certificateDerBase64)
        val digest = MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
        require(digest.equals(root.fingerprintSha256, ignoreCase = true))
    }

    private fun success(
        code: CosmosActivationCode,
        changed: Boolean,
        managed: Boolean,
        plan: CosmosEndpointPlan? = null,
        candidate: CosmosIdentityDescriptor? = null,
        root: CosmosRootDescriptor? = null,
    ): CosmosActivationResult = CosmosActivationResult(
        ok = true,
        code = code,
        changed = changed,
        managed = managed,
        rollbackComplete = true,
        apiEndpoint = plan?.apiEndpoint,
        onboardingEndpoint = plan?.onboardingEndpoint,
        deviceStatusEndpoint = plan?.deviceStatusEndpoint,
        edgeIpv4 = plan?.edgeIpv4,
        identityFingerprintSha256 = candidate?.fingerprintSha256,
        rootCertificateFingerprintSha256 = root?.fingerprintSha256,
    )

    private fun failure(
        code: CosmosActivationCode,
        rollbackComplete: Boolean = true,
    ): CosmosActivationResult = CosmosActivationResult(
        ok = false,
        code = code,
        changed = false,
        managed = false,
        rollbackComplete = rollbackComplete,
    )
}
