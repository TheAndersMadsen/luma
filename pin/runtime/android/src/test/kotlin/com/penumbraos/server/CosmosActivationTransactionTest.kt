package com.penumbraos.server

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
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertEquals(candidate, identity.current())
        assertEquals(1, identity.installCalls)
        assertEquals(
            listOf(
                CosmosActivationContract.EDGE_IPV4_SETTING,
                CosmosActivationContract.ATTESTATION_BUNDLE_SETTING,
                CosmosActivationContract.REMOTE_MODE_SETTING,
            ),
            settings.successfulWrites.takeLast(3),
        )
        assertEquals(CosmosActivationPhase.ACTIVE, records.value?.phase)
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
            ignoreNextWrite(CosmosActivationContract.EDGE_IPV4_SETTING)
        }
        val records = FakeRecords()
        val identity = FakeIdentity(candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertFalse(result.ok)
        assertEquals("0", settings[CosmosActivationContract.REMOTE_MODE_SETTING])
        assertEquals("198.51.100.23", settings[CosmosActivationContract.EDGE_IPV4_SETTING])
        assertNull(identity.current())
        assertNull(records.value)
    }

    @Test
    fun deactivationRestoresExactSettingsAndIdentityOwnership() {
        val settings = FakeSettings(
            CosmosActivationContract.REMOTE_MODE_SETTING to "custom-disabled",
            CosmosActivationContract.EDGE_IPV4_SETTING to "198.51.100.24",
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
        assertNull(settings[CosmosActivationContract.ATTESTATION_BUNDLE_SETTING])
        assertNull(identity.current())
        assertNull(records.value)
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
            "203.0.113.9",
        )
        assertEquals(CosmosActivationContract.API_ENDPOINT, plan.apiEndpoint)
        assertEquals(CosmosActivationContract.ONBOARDING_ENDPOINT, plan.onboardingEndpoint)
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
                    "203.0.113.9",
                )
            }.isFailure,
        )
        assertTrue(
            runCatching {
                CosmosActivationContract.plan(
                    CosmosActivationContract.API_ENDPOINT,
                    CosmosActivationContract.ONBOARDING_ENDPOINT,
                    "203.000.113.9",
                )
            }.isFailure,
        )
    }

    @Test
    fun keepDataReplacementReadsPreRenameStateAndDoesNotReimportIdentity() {
        assertEquals("penumbra_cosmos_remote_mode", CosmosActivationContract.REMOTE_MODE_SETTING)
        assertEquals("penumbra_cosmos_edge_ipv4", CosmosActivationContract.EDGE_IPV4_SETTING)
        assertEquals(
            "penumbra_cosmos_attestation_bundle_b64",
            CosmosActivationContract.ATTESTATION_BUNDLE_SETTING,
        )
        assertEquals(
            "penumbra_cosmos_device_attestation_v1",
            CosmosActivationContract.ATTESTATION_KEY_ALIAS,
        )

        // This map is the Settings.Global state already present before the
        // logical rename. A keep-data APK replacement must observe it directly.
        val settings = FakeSettings(
            "penumbra_cosmos_remote_mode" to "1",
            "penumbra_cosmos_edge_ipv4" to "203.0.113.9",
        )
        val records = FakeRecords().apply {
            value = CosmosActivationRecord(
                phase = CosmosActivationPhase.ACTIVE,
                previousRemoteMode = "0",
                previousEdgeIpv4 = null,
                identityWasPresent = false,
                targetFingerprintSha256 = candidate.fingerprintSha256,
                apiEndpoint = CosmosActivationContract.API_ENDPOINT,
                onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
                targetEdgeIpv4 = "203.0.113.9",
            )
        }
        val identity = FakeIdentity(candidate, installed = candidate)

        val result = transaction(settings, records).activateValid(identity)

        assertTrue(result.ok)
        assertEquals(CosmosActivationCode.ALREADY_ACTIVE, result.code)
        assertEquals(0, identity.installCalls)
        assertEquals(0, identity.removalCalls)
        assertTrue(settings.successfulWrites.isEmpty())
        assertNull(settings["penumbra_cosmos_remote_mode"])
        assertNull(settings["penumbra_cosmos_edge_ipv4"])
    }

    private fun transaction(
        settings: FakeSettings,
        records: FakeRecords,
    ) = CosmosActivationTransaction(settings, records)

    private fun CosmosActivationTransaction.activateValid(identity: FakeIdentity) = activate(
        apiEndpoint = CosmosActivationContract.API_ENDPOINT,
        onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
        edgeIpv4 = "203.0.113.9",
        identity = identity,
    )

    private class FakeSettings(vararg initial: Pair<String, String?>) : CosmosSettingsPort {
        private val values = mutableMapOf<String, String>()
        private val failWrites = mutableMapOf<String, Int>()
        private val ignoredWrites = mutableMapOf<String, Int>()
        val successfulWrites = mutableListOf<String>()

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
            val installed = current ?: return true
            if (installed.fingerprintSha256 != fingerprintSha256) return false
            current = null
            return true
        }
    }
}
