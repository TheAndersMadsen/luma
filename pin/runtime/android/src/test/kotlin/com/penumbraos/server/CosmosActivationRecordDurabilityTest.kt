package com.penumbraos.server

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CosmosActivationRecordDurabilityTest {
    @Test
    fun everyRecordSaveAndClearCommitsTheSystemVault() {
        val directory = Files.createTempDirectory("cosmos-activation-record").toFile()
        try {
            var commits = 0
            val records = FileCosmosActivationRecordPort(
                directory.resolve(PersistentConfigVaultFormat.ACTIVATION_RECORD_FILE_NAME),
            ) {
                commits += 1
                true
            }

            assertTrue(records.save(activeRecord()))
            assertEquals(1, commits)
            assertTrue(records.clear())
            assertEquals(2, commits)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun recordMutationDoesNotReportSuccessWhenTheVaultCommitFails() {
        val directory = Files.createTempDirectory("cosmos-activation-record-failure").toFile()
        try {
            var commitSucceeds = false
            val records = FileCosmosActivationRecordPort(
                directory.resolve(PersistentConfigVaultFormat.ACTIVATION_RECORD_FILE_NAME),
            ) { commitSucceeds }

            assertFalse(records.save(activeRecord()))
            commitSucceeds = true
            assertTrue(records.save(activeRecord()))
            commitSucceeds = false
            assertFalse(records.clear())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun recordLoadRejectsAnOversizedLocalArtifact() {
        val directory = Files.createTempDirectory("cosmos-activation-record-oversized").toFile()
        try {
            val file = directory.resolve(PersistentConfigVaultFormat.ACTIVATION_RECORD_FILE_NAME)
            file.writeBytes(ByteArray(CosmosActivationRecordCodec.MAX_RECORD_BYTES + 1))
            val records = FileCosmosActivationRecordPort(file)

            assertThrows(IllegalStateException::class.java) { records.load() }
        } finally {
            directory.deleteRecursively()
        }
    }

    private fun activeRecord() = CosmosActivationRecord(
        phase = CosmosActivationPhase.ACTIVE,
        previousRemoteMode = "0",
        previousEdgeIpv4 = null,
        previousRootCertificateDerBase64 = null,
        previousDeviceStatusEndpoint = null,
        identityWasPresent = false,
        targetFingerprintSha256 = "ab".repeat(32),
        targetRootFingerprintSha256 = "cd".repeat(32),
        apiEndpoint = CosmosActivationContract.API_ENDPOINT,
        onboardingEndpoint = CosmosActivationContract.ONBOARDING_ENDPOINT,
        deviceStatusEndpoint = "https://pin.example.test/device-status/v1/report",
        targetEdgeIpv4 = "203.0.113.9",
    )
}
