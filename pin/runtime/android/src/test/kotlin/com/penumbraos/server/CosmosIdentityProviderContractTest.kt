package com.penumbraos.server

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class CosmosIdentityProviderContractTest {
    @Test
    fun physicalMaintenanceUidsAreExplicitlyBounded() {
        assertTrue(isTrustedCosmosIdentityUid(COSMOS_IDENTITY_ROOT_UID))
        assertTrue(isTrustedCosmosIdentityUid(COSMOS_IDENTITY_SYSTEM_UID))
        assertTrue(isTrustedCosmosIdentityUid(COSMOS_IDENTITY_SHELL_UID))
        assertFalse(isTrustedCosmosIdentityUid(10000))
        assertFalse(isTrustedCosmosIdentityUid(-1))
    }

    @Test
    fun persistedIdentityUsesTheDeployedContentProviderAuthority() {
        assertEquals(
            "com.penumbraos.server.cosmosidentity",
            CosmosIdentityProvider.AUTHORITY,
        )
        assertEquals(
            "penumbra_cosmos_device_attestation_v1",
            CosmosIdentityProvider.KEY_ALIAS,
        )
        assertEquals("onboarding-pincode", CosmosIdentityProvider.ONBOARDING_PINCODE_PATH)
        assertEquals(
            "penumbra_cosmos_onboarding_pincode",
            CosmosActivationContract.ONBOARDING_PINCODE_SETTING,
        )
    }

    @Test
    fun serverRejectsMissingOrMalformedProvisionedRoot() {
        assertNull(parseProvisionedCosmosRoot(null))
        assertNull(parseProvisionedCosmosRoot("not-base64"))
        assertNull(parseProvisionedCosmosRoot("bm90LWEtY2VydGlmaWNhdGU="))
    }

    @Test
    fun activationPublishesTheValidatedIdentityForTheProvisioningProcess() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/server/CosmosIdentityProvider.kt",
        ).readText()
        val activation = source
            .substringAfter("private fun activateCosmos()")
            .substringBefore("private fun deactivateCosmos()")

        assertTrue(activation.contains("Base64.getEncoder().encodeToString(bytes)"))
        assertTrue(activation.contains("attestationHandoff = attestationHandoff"))
        assertFalse(activation.contains("clearStaging"))
    }

    @Test
    fun onboardingPincodeAcceptsExactlyFourAsciiDigits() {
        assertEquals("4821", compatibleOnboardingPincode(byteArrayOf(0x34, 0x38, 0x32, 0x31)))
        assertNull(compatibleOnboardingPincode(byteArrayOf(0x31, 0x32, 0x33)))
        assertNull(compatibleOnboardingPincode(byteArrayOf(0x31, 0x32, 0x33, 0x34, 0x35)))
        assertNull(compatibleOnboardingPincode(byteArrayOf(0x31, 0x32, 0x61, 0x34)))
        assertNull(compatibleOnboardingPincode(byteArrayOf(0x31, 0x32, 0x33, 0x0a)))
        assertNull(compatibleOnboardingPincode("１２３４".toByteArray(Charsets.UTF_8)))
    }

    @Test
    fun onboardingPincodeWriteIsGatedAndHasNoReadSurface() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/server/CosmosIdentityProvider.kt",
        ).readText()
        val writer = source
            .substringAfter("private fun openOnboardingPincodePipe()")
            .substringBefore("override fun call(")

        assertTrue(writer.contains("CosmosActivationContract.REMOTE_MODE_SETTING"))
        assertTrue(writer.contains("CosmosActivationContract.DUC_PROVISIONED_SETTING"))
        assertTrue(writer.contains("CosmosActivationContract.ONBOARDING_PINCODE_SETTING"))
        assertTrue(writer.contains("compatibleOnboardingPincode(bytes)"))
        assertFalse(writer.contains("putString(\""))
        assertTrue(source.contains("override fun query("))
        assertTrue(source.contains("): Cursor? = null"))
    }

    @Test
    fun nullSettingsWritesDeleteTheExactGlobalUriAndReadItBack() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/server/CosmosIdentityProvider.kt",
        ).readText()
        val writer = source.substringAfter("private class AndroidCosmosSettingsPort(")

        assertTrue(writer.contains("resolver.delete(Settings.Global.getUriFor(key), null, null)"))
        assertTrue(writer.contains("return read(key) == null"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("runtime/android", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
