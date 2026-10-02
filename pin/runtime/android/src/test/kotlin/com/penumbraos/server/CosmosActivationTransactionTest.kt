package com.penumbraos.server

import java.security.MessageDigest
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CosmosActivationTransactionTest {
    private val candidate = CosmosIdentityDescriptor(
        fingerprintSha256 = "ab".repeat(32),
        subject = "CN=V:01:D:1a2b3c4d:P:00000001",
    )
    private val root = rootDescriptor("operator-root")
    private val statusEndpoint = "https://pin.example.test/device-status/v1/report"
    private val attestationHandoff = Base64.getEncoder().encodeToString(
        "validated-attestation-handoff".toByteArray(Charsets.UTF_8),
    )

    @Test
    fun firstActivationCommitsIdentityEdgeThenRemoteGate() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.EDGE_IPV4_SETTING to "198.51.100.7",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ACTIVATED, result.code)
        assertEquals("1", settings[CosmosActivationContract.REMOTE_MODE_SETTING])
        assertEquals("203.0.113.9", settings[CosmosActivationContract.EDGE_IPV4_SETTING])
        assertEquals(root.certificateDerBase64, settings[CosmosActivationContract.ROOT_CERTIFICATE_SETTING])
        assertEquals(statusEndpoint, settings[CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING])
        assertEquals(attestationHandoff, settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertEquals(candidate, identity.current())
        assertEquals(1, identity.installCalls)
        assertEquals(
            listOf(
                CosmosActivationContract.ROOT_CERTIFICATE_SETTING,
                CosmosActivationContract.EDGE_IPV4_SETTING,
                CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
                CosmosActivationContract.ATTESTATION_BUNDLE_SETTING,
                CosmosActivationContract.REMOTE_MODE_SETTING,
            ),
            settings.successfulWrites.takeLast(5),
        )
        assertEquals(CosmosActivationPhase.ACTIVE, records.value?.phase)
    }

    @Test
    fun validatedAttestationIsPublishedAfterIdentityAndEdgeButBeforeRemoteMode() {
        val settings = FakeSettings(CosmosActivationContract.REMOTE_MODE_SETTING to "0")
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activate(
            apiEndpoint = CosmosActivationContract.API_ENDPOINT,
            onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
            deviceStatusEndpoint = statusEndpoint,
            edgeIpv4 = "203.0.113.9",
            root = root,
            identity = identity,
            attestationHandoff = attestationHandoff,
        )

        assertTrue(result.ok)
        assertEquals(attestationHandoff, settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertTrue(
            settings.successfulWrites.indexOf(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING) >
                settings.successfulWrites.indexOf(CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING),
        )
        assertEquals(CosmosActivationContract.REMOTE_MODE_SETTING, settings.successfulWrites.last())
    }

    @Test
    fun firstActivationAfterStockOnboardingNeverPublishesThePrivateHandoff() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.DUC_PROVISIONED_SETTING to "1",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ACTIVATED, result.code)
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertFalse(
            settings.successfulWrites.contains(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING),
        )
        assertEquals(CosmosActivationContract.REMOTE_MODE_SETTING, settings.successfulWrites.last())
    }

    @Test
    fun matchingActivationIsAVerifiedNoOp() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)
        val transaction = transaction(settings, records)
        assertTrue(transaction.activateValid(identity).ok)
        val writesAfterFirstActivation = settings.successfulWrites.size

        val result = transaction.activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_ACTIVE, result.code)
        assertFalse(result.changed)
        assertTrue(result.managed)
        assertEquals(1, identity.installCalls)
        assertEquals(writesAfterFirstActivation, settings.successfulWrites.size)
    }

    @Test
    fun failedCommitRestoresEveryPriorValueAndRemovesOnlyNewIdentity() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "custom-disabled",
            CosmosActivationContract.EDGE_IPV4_SETTING to "198.51.100.22",
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING to "previous-root",
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING to
                "https://old.example.test/device-status/v1/report",
        ).apply {
            failNextWrite(CosmosActivationContract.REMOTE_MODE_SETTING)
        }
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertFalse(result.ok)
        assertEquals(CosmosActivationCode.TRANSACTION_FAILED, result.code)
        assertTrue(result.rollbackComplete)
        assertEquals(
            "custom-disabled",
            settings[CosmosActivationContract.REMOTE_MODE_SETTING],
        )
        assertEquals("198.51.100.22", settings[CosmosActivationContract.EDGE_IPV4_SETTING])
        assertEquals("previous-root", settings[CosmosActivationContract.ROOT_CERTIFICATE_SETTING])
        assertEquals(
            "https://old.example.test/device-status/v1/report",
            settings[CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING],
        )
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertNull(identity.current())
        assertNull(records.value)
    }

    @Test
    fun readBackMismatchAlsoRollsBack() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.EDGE_IPV4_SETTING to "198.51.100.23",
        ).apply {
            ignoreNextWrite(CosmosActivationContract.ROOT_CERTIFICATE_SETTING)
        }
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertFalse(result.ok)
        assertEquals("0", settings[CosmosActivationContract.REMOTE_MODE_SETTING])
        assertEquals("198.51.100.23", settings[CosmosActivationContract.EDGE_IPV4_SETTING])
        assertNull(settings[CosmosActivationContract.ROOT_CERTIFICATE_SETTING])
        assertNull(identity.current())
        assertNull(records.value)
    }

    @Test
    fun rollbackFailureRemainsVisibleInTheJournal() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
        ).apply {
            failNextWrite(CosmosActivationContract.REMOTE_MODE_SETTING)
        }
        val records = FakeRecords()
        val identity = FakeIdentity(candidate).apply {
            installFailure = IllegalStateException("fixture import failure")
        }

        val result = transaction(settings, records).activateValid(identity)

        assertEquals(CosmosActivationCode.ROLLBACK_FAILED, result.code)
        assertFalse(result.rollbackComplete)
        assertEquals(CosmosActivationPhase.PREPARING, records.value?.phase)
        assertTrue(records.value?.rollbackFailed == true)
    }

    @Test
    fun interruptedPreparationClearsThePincodeAndRestoresThePreviousRootBeforeRetrying() {
        val previousRoot = rootDescriptor("previous-root")
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.EDGE_IPV4_SETTING to "203.0.113.9",
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING to root.certificateDerBase64,
            CosmosActivationContract.ONBOARDING_PINCODE_SETTING to "4821",
        )
        val records = FakeRecords().apply {
            value = CosmosActivationRecord(
                phase = CosmosActivationPhase.PREPARING,
                previousRemoteMode = "0",
                previousEdgeIpv4 = "198.51.100.44",
                previousRootCertificateDerBase64 = previousRoot.certificateDerBase64,
                previousDeviceStatusEndpoint = null,
                identityWasPresent = false,
                targetFingerprintSha256 = candidate.fingerprintSha256,
                targetRootFingerprintSha256 = root.fingerprintSha256,
                apiEndpoint = CosmosActivationContract.API_ENDPOINT,
                onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
                deviceStatusEndpoint = statusEndpoint,
                targetEdgeIpv4 = "203.0.113.9",
            )
        }
        val identity = FakeIdentity(candidate, installed = candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ACTIVATED, result.code)
        assertEquals(1, identity.removalCalls)
        assertEquals(1, identity.installCalls)
        assertEquals(root.certificateDerBase64, settings[CosmosActivationContract.ROOT_CERTIFICATE_SETTING])
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertEquals(CosmosActivationPhase.ACTIVE, records.value?.phase)
    }

    @Test
    fun activationStatusSurfacesInterruptedAndRollbackFailedTransactions() {
        val preparing = activeRecord(CosmosActivationPhase.PREPARING)
        val observed = observedState(remoteMode = "0")
        assertEquals(
            CosmosActivationStatusState.PREPARING,
            reconcileCosmosActivationStatus(preparing, observed).state,
        )
        assertEquals(
            CosmosActivationStatusState.DEACTIVATING,
            reconcileCosmosActivationStatus(
                preparing.copy(phase = CosmosActivationPhase.DEACTIVATING),
                observed,
            ).state,
        )
        val rollbackFailed = reconcileCosmosActivationStatus(
            preparing.copy(rollbackFailed = true),
            observed,
        )
        assertEquals(CosmosActivationStatusState.ROLLBACK_FAILED, rollbackFailed.state)
        assertTrue(rollbackFailed.managed)
        assertFalse(rollbackFailed.consistent)
        assertFalse(rollbackFailed.rollbackComplete)
    }

    @Test
    fun activationStatusRequiresTheLiveRootIdentityEdgeAndGateToMatchTheJournal() {
        val record = activeRecord(CosmosActivationPhase.ACTIVE)
        val active = reconcileCosmosActivationStatus(record, observedState())
        assertEquals(CosmosActivationStatusState.ACTIVE, active.state)
        assertTrue(active.consistent)
        assertTrue(active.targetMatches)
        assertTrue(active.remoteGateEnabled)

        val digestMismatch = reconcileCosmosActivationStatus(
            record,
            observedState(rootFingerprintSha256 = "ef".repeat(32)),
        )
        assertEquals(CosmosActivationStatusState.INCONSISTENT, digestMismatch.state)
        assertFalse(digestMismatch.consistent)
        assertFalse(digestMismatch.targetMatches)
    }

    @Test
    fun activationStatusDoesNotFlattenUnjournaledArtifactsToInactive() {
        val inactive = reconcileCosmosActivationStatus(
            record = null,
            observed = observedState(
                remoteMode = "0",
                edgeIpv4 = null,
                deviceStatusEndpoint = null,
                rootPresent = false,
                rootFingerprintSha256 = null,
                identityPresent = false,
            ),
        )
        assertEquals(CosmosActivationStatusState.INACTIVE, inactive.state)
        assertTrue(inactive.consistent)

        val orphanedRoot = reconcileCosmosActivationStatus(
            record = null,
            observed = observedState(
                remoteMode = "0",
                edgeIpv4 = null,
                identityPresent = false,
            ),
        )
        assertEquals(CosmosActivationStatusState.INCONSISTENT, orphanedRoot.state)
        assertFalse(orphanedRoot.consistent)
    }

    @Test
    fun deactivationRestoresExactSettingsAndIdentityOwnership() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "custom-disabled",
            CosmosActivationContract.EDGE_IPV4_SETTING to "198.51.100.24",
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING to "previous-root",
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING to
                "https://old.example.test/device-status/v1/report",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)
        val transaction = transaction(settings, records)
        assertTrue(transaction.activateValid(identity).ok)

        val result = transaction.deactivate(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.DEACTIVATED, result.code)
        assertEquals(
            "custom-disabled",
            settings[CosmosActivationContract.REMOTE_MODE_SETTING],
        )
        assertEquals("198.51.100.24", settings[CosmosActivationContract.EDGE_IPV4_SETTING])
        assertEquals("previous-root", settings[CosmosActivationContract.ROOT_CERTIFICATE_SETTING])
        assertEquals(
            "https://old.example.test/device-status/v1/report",
            settings[CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING],
        )
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertNull(identity.current())
        assertNull(records.value)
    }

    @Test
    fun stagedPincodeCannotSurviveDeactivationAndReactivate() {
        val settings = FakeSettings(CosmosActivationContract.REMOTE_MODE_SETTING to "0")
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)
        val transaction = transaction(settings, records)
        assertTrue(transaction.activateValid(identity).ok)
        assertTrue(settings.write(CosmosActivationContract.ONBOARDING_PINCODE_SETTING, "4821"))

        assertTrue(transaction.deactivate(identity).ok)
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertTrue(transaction.activateValid(identity).ok)
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
    }

    @Test
    fun alreadyInactiveDeactivationClearsOrphanedOneShotValues() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.ONBOARDING_PINCODE_SETTING to "4821",
            CosmosActivationContract.ATTESTATION_BUNDLE_SETTING to "orphaned-attestation",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).deactivate(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_INACTIVE, result.code)
        assertTrue(result.changed)
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
    }

    @Test
    fun inactiveActivationClearsAnOrphanedPincodeBeforeEnablingRemoteMode() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.ONBOARDING_PINCODE_SETTING to "4821",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertTrue(
            settings.successfulWrites.indexOf(CosmosActivationContract.ONBOARDING_PINCODE_SETTING) <
                settings.successfulWrites.indexOf(CosmosActivationContract.REMOTE_MODE_SETTING),
        )
    }

    @Test
    fun interruptedDeactivationClearsTheStagedPincode() {
        val settings = FakeSettings(CosmosActivationContract.REMOTE_MODE_SETTING to "0")
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)
        val transaction = transaction(settings, records)
        assertTrue(transaction.activateValid(identity).ok)
        assertTrue(settings.write(CosmosActivationContract.ONBOARDING_PINCODE_SETTING, "4821"))
        records.value = checkNotNull(records.value).copy(
            phase = CosmosActivationPhase.DEACTIVATING,
        )

        val result = transaction.deactivate(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_INACTIVE, result.code)
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertNull(records.value)
    }

    @Test
    fun activationRollbackClearsAnOrphanedPincode() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.ONBOARDING_PINCODE_SETTING to "4821",
        ).apply {
            failNextWrite(CosmosActivationContract.REMOTE_MODE_SETTING)
        }
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertEquals(CosmosActivationCode.TRANSACTION_FAILED, result.code)
        assertTrue(result.rollbackComplete)
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertNull(records.value)
    }

    @Test
    fun failedDeactivationRestoresTheActiveAttestationHandoffButNotThePincode() {
        val settings = FakeSettings(CosmosActivationContract.REMOTE_MODE_SETTING to "0")
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)
        val transaction = transaction(settings, records)
        assertTrue(transaction.activateValid(identity).ok)
        assertTrue(settings.write(CosmosActivationContract.ONBOARDING_PINCODE_SETTING, "4821"))
        identity.removalSucceeds = false

        val result = transaction.deactivate(identity)

        assertEquals(CosmosActivationCode.TRANSACTION_FAILED, result.code)
        assertTrue(result.rollbackComplete)
        assertEquals("1", settings[CosmosActivationContract.REMOTE_MODE_SETTING])
        assertEquals(
            attestationHandoff,
            settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING],
        )
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertEquals(CosmosActivationPhase.ACTIVE, records.value?.phase)
    }

    @Test
    fun deactivationRetainsAnIdentityThatPredatedActivation() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate, installed = candidate)
        val transaction = transaction(settings, records)
        assertTrue(transaction.activateValid(identity).ok)

        val result = transaction.deactivate(identity)

        assertTrue(result.ok)
        assertEquals(candidate, identity.current())
        assertEquals(0, identity.removalCalls)
    }

    @Test
    fun resultAndJournalNeverContainCandidateSecretMaterial() {
        val secret = "sensitive-attestation-material-SENTINEL-SECRET"
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate).apply {
            installFailure = IllegalStateException(secret)
        }

        val result = transaction(settings, records).activateValid(identity)
        val observable = buildString {
            append(result)
            append(result.message)
            records.history.forEach(::append)
        }

        assertFalse(result.ok)
        assertFalse(observable.contains("SENTINEL-SECRET"))
        assertFalse(observable.contains("sensitive-attestation-material"))
    }

    @Test
    fun pendingAttestationIsNeverOverwritten() {
        val sentinel = "base64-private-staging-value"
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "0",
            CosmosActivationContract.ATTESTATION_BUNDLE_SETTING to sentinel,
        )
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertEquals(CosmosActivationCode.PENDING_ATTESTATION_CONFLICT, result.code)
        assertEquals(sentinel, settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertEquals(0, identity.installCalls)
        assertNull(records.value)
    }

    @Test
    fun endpointsAndAttestationSubjectAreExactContracts() {
        val plan = CosmosActivationContract.plan(
            "HTTPS://api.cosmos.humane.cloud:443/",
            "https://onboarding.cosmos.humane.cloud/",
            "https://PIN.EXAMPLE.TEST:443/device-status/v1/report",
            "203.0.113.9",
        )
        assertEquals(CosmosActivationContract.API_ENDPOINT, plan.apiEndpoint)
        assertEquals(CosmosActivationContract.ONBOARDING_ENDPOINT, plan.onboardingEndpoint)
        assertEquals(statusEndpoint, plan.deviceStatusEndpoint)
        assertEquals("203.0.113.9", plan.edgeIpv4)
        assertEquals(
            "V:01:D:1a2b3c4d:P:00000001",
            CosmosActivationContract.expectedAttestationSubject("1A2B3C4D"),
        )
        assertTrue(
            runCatching {
                CosmosActivationContract.plan(
                    "https://cosmos.andersmadsen.dk",
                    CosmosActivationContract.ONBOARDING_ENDPOINT,
                    statusEndpoint,
                    "203.0.113.9",
                )
            }.isFailure,
        )
        assertTrue(
            runCatching {
                CosmosActivationContract.plan(
                    CosmosActivationContract.API_ENDPOINT,
                    CosmosActivationContract.ONBOARDING_ENDPOINT,
                    statusEndpoint,
                    "203.000.113.9",
                )
            }.isFailure,
        )
    }

    @Test
    fun activeReplacementRestoresMissingHandoffBeforeStockOnboardingCompletes() {
        assertEquals("penumbra_cosmos_remote_mode", CosmosActivationContract.REMOTE_MODE_SETTING)
        assertEquals("penumbra_cosmos_edge_ipv4", CosmosActivationContract.EDGE_IPV4_SETTING)
        assertEquals(
            "penumbra_cosmos_attestation_bundle_b64",
            CosmosActivationContract.ATTESTATION_BUNDLE_SETTING,
        )
        assertEquals(
            "penumbra_cosmos_root_certificate_der_b64",
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING,
        )
        assertEquals(
            "penumbra_cosmos_device_status_endpoint",
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
        )
        assertEquals(
            "humane.settings.global.DUC_PROVISIONED",
            CosmosActivationContract.DUC_PROVISIONED_SETTING,
        )
        assertEquals(
            "penumbra_cosmos_device_attestation_v1",
            CosmosActivationContract.ATTESTATION_KEY_ALIAS,
        )

        // This map is the existing Settings.Global state. A keep-data APK
        // replacement must observe it directly.
        val settings = FakeSettings(
            "penumbra_cosmos_remote_mode" to "1",
            "penumbra_cosmos_edge_ipv4" to "203.0.113.9",
            "penumbra_cosmos_root_certificate_der_b64" to root.certificateDerBase64,
            "penumbra_cosmos_device_status_endpoint" to statusEndpoint,
        )
        val records = FakeRecords().apply {
            value = CosmosActivationRecord(
                phase = CosmosActivationPhase.ACTIVE,
                previousRemoteMode = "0",
                previousEdgeIpv4 = null,
                previousRootCertificateDerBase64 = null,
                previousDeviceStatusEndpoint = null,
                identityWasPresent = false,
                targetFingerprintSha256 = candidate.fingerprintSha256,
                targetRootFingerprintSha256 = root.fingerprintSha256,
                apiEndpoint = CosmosActivationContract.API_ENDPOINT,
                onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
                deviceStatusEndpoint = statusEndpoint,
                targetEdgeIpv4 = "203.0.113.9",
            )
        }
        val identity = FakeIdentity(candidate, installed = candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_ACTIVE, result.code)
        assertTrue(result.changed)
        assertEquals(0, identity.installCalls)
        assertEquals(0, identity.removalCalls)
        assertEquals(
            listOf(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING),
            settings.successfulWrites,
        )
        assertEquals(attestationHandoff, settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertEquals("1", settings["penumbra_cosmos_remote_mode"])
        assertEquals("203.0.113.9", settings["penumbra_cosmos_edge_ipv4"])
        assertEquals(root.certificateDerBase64, settings["penumbra_cosmos_root_certificate_der_b64"])
    }

    @Test
    fun completedStockOnboardingDoesNotRepublishThePrivateHandoff() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "1",
            CosmosActivationContract.EDGE_IPV4_SETTING to "203.0.113.9",
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING to root.certificateDerBase64,
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING to statusEndpoint,
            CosmosActivationContract.DUC_PROVISIONED_SETTING to "1",
        )
        val records = FakeRecords().apply {
            value = activeRecord(CosmosActivationPhase.ACTIVE)
        }
        val identity = FakeIdentity(candidate, installed = candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_ACTIVE, result.code)
        assertFalse(result.changed)
        assertTrue(settings.successfulWrites.isEmpty())
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertEquals(0, identity.installCalls)
        assertEquals(0, identity.removalCalls)
    }

    @Test
    fun completedStockOnboardingClearsOrphanedOneShotValuesAndReportsTheMutation() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "1",
            CosmosActivationContract.EDGE_IPV4_SETTING to "203.0.113.9",
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING to root.certificateDerBase64,
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING to statusEndpoint,
            CosmosActivationContract.DUC_PROVISIONED_SETTING to "1",
            CosmosActivationContract.ATTESTATION_BUNDLE_SETTING to attestationHandoff,
            CosmosActivationContract.ONBOARDING_PINCODE_SETTING to "4821",
        )
        val records = FakeRecords().apply {
            value = activeRecord(CosmosActivationPhase.ACTIVE)
        }
        val identity = FakeIdentity(candidate, installed = candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_ACTIVE, result.code)
        assertTrue(result.changed)
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
        assertEquals(
            listOf(
                CosmosActivationContract.ATTESTATION_BUNDLE_SETTING,
                CosmosActivationContract.ONBOARDING_PINCODE_SETTING,
            ),
            settings.successfulWrites,
        )
    }

    @Test
    fun consumedHandoffRestoreIsAcceptedWhenStockOnboardingCompletesDuringTheWrite() {
        lateinit var settings: FakeSettings
        settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "1",
            CosmosActivationContract.EDGE_IPV4_SETTING to "203.0.113.9",
            CosmosActivationContract.ROOT_CERTIFICATE_SETTING to root.certificateDerBase64,
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING to statusEndpoint,
            CosmosActivationContract.DUC_PROVISIONED_SETTING to "0",
            CosmosActivationContract.ONBOARDING_PINCODE_SETTING to "4821",
        ).apply {
            afterSuccessfulWrite = { key, value ->
                if (key == CosmosActivationContract.ATTESTATION_BUNDLE_SETTING && value != null) {
                    settings.write(CosmosActivationContract.DUC_PROVISIONED_SETTING, "1")
                    settings.write(CosmosActivationContract.ATTESTATION_BUNDLE_SETTING, null)
                }
            }
        }
        val records = FakeRecords().apply {
            value = activeRecord(CosmosActivationPhase.ACTIVE)
        }
        val identity = FakeIdentity(candidate, installed = candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_ACTIVE, result.code)
        assertTrue(result.changed)
        assertEquals("1", settings[CosmosActivationContract.DUC_PROVISIONED_SETTING])
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertNull(settings[CosmosActivationContract.ONBOARDING_PINCODE_SETTING])
    }

    private fun transaction(
        settings: FakeSettings,
        records: FakeRecords,
    ) = CosmosActivationTransaction(settings, records)

    private fun CosmosActivationTransaction.activateValid(identity: FakeIdentity) = activate(
        apiEndpoint = CosmosActivationContract.API_ENDPOINT,
        onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
        deviceStatusEndpoint = statusEndpoint,
        edgeIpv4 = "203.0.113.9",
        root = root,
        identity = identity,
        attestationHandoff = attestationHandoff,
    )

    private fun rootDescriptor(value: String): CosmosRootDescriptor {
        val bytes = value.toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
        return CosmosRootDescriptor(Base64.getEncoder().encodeToString(bytes), digest)
    }

    private fun activeRecord(phase: CosmosActivationPhase) = CosmosActivationRecord(
        phase = phase,
        previousRemoteMode = "0",
        previousEdgeIpv4 = null,
        previousRootCertificateDerBase64 = null,
        previousDeviceStatusEndpoint = null,
        identityWasPresent = false,
        targetFingerprintSha256 = candidate.fingerprintSha256,
        targetRootFingerprintSha256 = root.fingerprintSha256,
        apiEndpoint = CosmosActivationContract.API_ENDPOINT,
        onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
        deviceStatusEndpoint = statusEndpoint,
        targetEdgeIpv4 = "203.0.113.9",
    )

    private fun observedState(
        remoteMode: String? = "1",
        edgeIpv4: String? = "203.0.113.9",
        deviceStatusEndpoint: String? = statusEndpoint,
        rootPresent: Boolean = true,
        rootFingerprintSha256: String? = root.fingerprintSha256,
        identityPresent: Boolean = true,
    ) = CosmosActivationObservedState(
        remoteMode = remoteMode,
        edgeIpv4 = edgeIpv4,
        deviceStatusEndpoint = deviceStatusEndpoint,
        rootCertificatePresent = rootPresent,
        rootCertificateFingerprintSha256 = rootFingerprintSha256,
        identityPresent = identityPresent,
        identityUsable = identityPresent,
        identityFingerprintSha256 = candidate.fingerprintSha256.takeIf { identityPresent },
    )

    private class FakeSettings(vararg initial: Pair<String, String?>) : CosmosSettingsPort {
        private val values = mutableMapOf<String, String>()
        private val failWrites = mutableMapOf<String, Int>()
        private val ignoredWrites = mutableMapOf<String, Int>()
        val successfulWrites = mutableListOf<String>()
        var afterSuccessfulWrite: ((String, String?) -> Unit)? = null

        init {
            initial.forEach { (key, value) -> if (value != null) values[key] = value }
        }

        operator fun get(key: String): String? = values[key]

        fun failNextWrite(key: String) {
            failWrites[key] = (failWrites[key] ?: 0) + 1
        }

        fun ignoreNextWrite(key: String) {
            ignoredWrites[key] = (ignoredWrites[key] ?: 0) + 1
        }

        override fun read(key: String): String? = values[key]

        override fun write(key: String, value: String?): Boolean {
            val failures = failWrites[key] ?: 0
            if (failures > 0) {
                failWrites[key] = failures - 1
                return false
            }
            val ignores = ignoredWrites[key] ?: 0
            if (ignores > 0) {
                ignoredWrites[key] = ignores - 1
                return true
            }
            if (value == null) values.remove(key) else values[key] = value
            successfulWrites += key
            afterSuccessfulWrite?.invoke(key, value)
            return true
        }
    }

    private class FakeRecords : CosmosActivationRecordPort {
        var value: CosmosActivationRecord? = null
        val history = mutableListOf<CosmosActivationRecord>()

        override fun load(): CosmosActivationRecord? = value

        override fun save(record: CosmosActivationRecord): Boolean {
            value = record
            history += record
            return true
        }

        override fun clear(): Boolean {
            value = null
            return true
        }
    }

    private class FakeIdentity(
        private val target: CosmosIdentityDescriptor,
        installed: CosmosIdentityDescriptor? = null,
    ) : CosmosIdentityPort {
        private var current = installed
        var installCalls = 0
        var removalCalls = 0
        var installFailure: Throwable? = null
        var removalSucceeds = true

        override fun candidate(): CosmosIdentityDescriptor = target

        override fun current(): CosmosIdentityDescriptor? = current

        override fun installCandidate(): CosmosIdentityDescriptor {
            installCalls += 1
            installFailure?.let { throw it }
            current = target
            return target
        }

        override fun removeIfMatches(fingerprintSha256: String): Boolean {
            removalCalls += 1
            if (!removalSucceeds) return false
            val installed = current ?: return true
            if (installed.fingerprintSha256 != fingerprintSha256) return false
            current = null
            return true
        }
    }
}
