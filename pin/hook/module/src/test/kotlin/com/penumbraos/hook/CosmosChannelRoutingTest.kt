package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CosmosChannelRoutingTest {
    @Test
    fun cloneAttestationAliasMatchesTheHostImportContract() {
        assertEquals(
            "penumbra_cosmos_device_attestation_v1",
            CosmosRemoteTransport.ATTESTATION_KEY_ALIAS,
        )
        assertEquals("penumbra_cosmos_remote_mode", CosmosRemoteTransport.ENABLED_SETTING)
        assertEquals("penumbra_cosmos_edge_ipv4", CosmosRemoteTransport.EDGE_IPV4_SETTING)
        assertEquals(
            "penumbra_cosmos_root_certificate_der_b64",
            CosmosRemoteTransport.ROOT_CERTIFICATE_SETTING,
        )
        assertEquals(
            "penumbra_cosmos_attestation_bundle_b64",
            CosmosRemoteTransport.ATTESTATION_BUNDLE_SETTING,
        )
        assertEquals(
            "penumbra_cosmos_onboarding_pincode",
            CosmosOnboardingAutomation.PINCODE_SETTING,
        )
    }

    @Test
    fun missingOrMalformedProvisionedRootFailsClosed() {
        assertNull(CosmosRemoteTransport.parseProvisionedRootCertificate(null))
        assertNull(CosmosRemoteTransport.parseProvisionedRootCertificate("not-base64"))
        assertNull(CosmosRemoteTransport.parseProvisionedRootCertificate("bm90LWEtY2VydGlmaWNhdGU="))
    }

    @Test
    fun cloneAttestationSubjectMatchesTheStockDacPattern() {
        assertTrue(
            CosmosRemoteTransport.isCompatibleAttestationSubject(
                "2c2a0001104000ff",
                "V:01:D:2C2A0001104000FF:P:00000001",
            ),
        )
        assertFalse(
            CosmosRemoteTransport.isCompatibleAttestationSubject(
                "2c2a0001104000ff",
                "V:01:D:2c2a0001104000ff:P:pin",
            ),
        )
        assertFalse(
            CosmosRemoteTransport.isCompatibleAttestationSubject(
                "2c2a0001104000ff",
                "V:01:D:2c2a0001104000fe:P:00000001",
            ),
        )
    }

    @Test
    fun onboardingAutomationAcceptsOnlyTheStockFourDigitShape() {
        assertTrue(CosmosOnboardingAutomation.isCompatiblePincode("1234"))
        assertTrue(CosmosOnboardingAutomation.isCompatiblePincode("0000"))
        assertFalse(CosmosOnboardingAutomation.isCompatiblePincode(null))
        assertFalse(CosmosOnboardingAutomation.isCompatiblePincode("123"))
        assertFalse(CosmosOnboardingAutomation.isCompatiblePincode("12345"))
        assertFalse(CosmosOnboardingAutomation.isCompatiblePincode("12a4"))
        assertFalse(CosmosOnboardingAutomation.isCompatiblePincode("１２３４"))
    }

    @Test
    fun onboardingPreservesOnlyTheFirstPreDucWifiDisableEvenBeforeActivation() {
        assertFalse(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = true,
            ),
        )
        assertTrue(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
        assertFalse(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                ducProvisioned = true,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
        assertFalse(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                ducProvisioned = false,
                requestedEnabled = true,
                alreadyHandled = false,
            ),
        )
        val source = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/CosmosOnboardingAutomation.kt",
        ).readText()
        val guard = source
            .substringAfter("private fun installInitialWifiGuard()")
            .substringBefore("private fun ensurePendingPincodeObserver()")
        assertFalse(guard.contains("CosmosRemoteTransport.isEnabled()"))
    }

    @Test
    fun onboardingPincodeHandoffHandlesLifecycleAndLateStaging() {
        val source = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/CosmosOnboardingAutomation.kt",
        ).readText()

        assertTrue(source.contains("PincodePromptNode"))
        assertTrue(source.contains("hookMethodAfter(promptNode, \"willBecomeActive\""))
        assertTrue(source.contains("getMethod(\"next\")"))
        assertTrue(source.contains("PincodeNode"))
        assertTrue(source.contains("hookMethodBefore(pincodeNode, \"didBecomeActive\""))
        assertTrue(source.contains("getDeclaredMethod(\"attemptUnlock\")"))
        assertTrue(source.contains("registerContentObserver("))
        assertTrue(source.contains("Settings.Global.getUriFor(PINCODE_SETTING)"))
        assertTrue(source.contains("resolver.delete(Settings.Global.getUriFor(PINCODE_SETTING)"))
        assertFalse(source.contains("Settings.Global.putString(resolver, PINCODE_SETTING, null)"))
    }

    @Test
    fun provisioningIdentityBootstrapAcceptsOnlyHexDeviceIds() {
        assertTrue(CosmosRemoteTransport.isCompatibleAttestationDeviceId("2c2a0001104000ff"))
        assertTrue(CosmosRemoteTransport.isCompatibleAttestationDeviceId("A0"))
        assertFalse(CosmosRemoteTransport.isCompatibleAttestationDeviceId(null))
        assertFalse(CosmosRemoteTransport.isCompatibleAttestationDeviceId(""))
        assertFalse(CosmosRemoteTransport.isCompatibleAttestationDeviceId("2c2a:001"))
        assertFalse(CosmosRemoteTransport.isCompatibleAttestationDeviceId("2c2a 001"))
    }

    @Test
    fun connectivityChecksUseOnlyExactCloneHosts() {
        for (host in listOf(
            "connectivity-check.cosmos.humane.cloud",
            "n.cosmos.humane.cloud",
        )) {
            assertTrue(CosmosRemoteTransport.isAllowedNetworkHost(host))
            assertTrue(CosmosRemoteTransport.isAllowedNetworkHost("  ${host.uppercase()}  "))
        }

        for (host in listOf(
            "connectivity-check.prod.humane.cloud",
            "n.prod.humane.cloud",
            "connectivity-check.cosmos.humane.cloud.evil.example",
            "n.cosmos.humane.cloud.evil.example",
            "evil-connectivity-check.cosmos.humane.cloud",
            "evil.example",
            "",
        )) {
            assertFalse(CosmosRemoteTransport.isAllowedNetworkHost(host))
        }
        assertFalse(CosmosRemoteTransport.isAllowedNetworkHost(null))
    }

    @Test
    fun exactConnectivityHostsResolveToTheConfiguredOperatorAddress() {
        val configured = byteArrayOf(203.toByte(), 0, 113, 42)
        for (host in listOf(
            "connectivity-check.cosmos.humane.cloud",
            "n.cosmos.humane.cloud",
        )) {
            val resolved = CosmosRemoteTransport.resolvedNetworkAddress(host, configured)
            assertEquals("203.0.113.42", resolved?.hostAddress)
            assertEquals(host, resolved?.hostName)
        }

        assertNull(
            CosmosRemoteTransport.resolvedNetworkAddress(
                "n.cosmos.humane.cloud.evil.example",
                configured,
            ),
        )
    }

    @Test
    fun legacyWireGatewaysAreExactAndTlsOnly() {
        assertTrue(CosmosRemoteTransport.isAllowedGateway("api.cosmos.humane.cloud:443"))
        assertTrue(CosmosRemoteTransport.isAllowedGateway("onboarding.cosmos.humane.cloud"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("api.prod.humane.cloud:443"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("location.cosmos.humane.cloud:443"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("api.cosmos.humane.cloud:80"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("api.cosmos.humane.cloud.evil:443"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("https://api.cosmos.humane.cloud/path"))
    }

    @Test
    fun logicalCosmosTransportMapsOnlyToStableLegacyWireAuthorities() {
        assertEquals(
            "api.cosmos.humane.cloud:443",
            CosmosRemoteTransport.redirectedGateway("api.prod.humane.cloud"),
        )
        assertEquals(
            "onboarding.cosmos.humane.cloud:443",
            CosmosRemoteTransport.redirectedGateway("onboarding.prod.humane.cloud:443"),
        )
        assertNull(CosmosRemoteTransport.redirectedGateway("location.prod.humane.cloud"))
        assertNull(CosmosRemoteTransport.redirectedGateway("api.prod.humane.cloud.evil"))
        assertNull(CosmosRemoteTransport.redirectedGateway("api.prod.humane.cloud:80"))
    }

    @Test
    fun provisioningProcessUsesTheAttestationOnlyOnboardingPlane() {
        assertEquals(
            "onboarding.cosmos.humane.cloud:443",
            CosmosRemoteTransport.redirectedGatewayForProcess(
                "api.prod.humane.cloud",
                CosmosRemoteTransport.PROVISIONING_PROCESS,
            ),
        )
        assertEquals(
            "api.cosmos.humane.cloud:443",
            CosmosRemoteTransport.redirectedGatewayForProcess(
                "api.prod.humane.cloud",
                "hu.ma.ne.ironman",
            ),
        )
        assertNull(
            CosmosRemoteTransport.redirectedGatewayForProcess(
                "untrusted.example",
                CosmosRemoteTransport.PROVISIONING_PROCESS,
            ),
        )
    }

    @Test
    fun directAttestationBridgeIsExactToProvisioningCloneMode() {
        val directManager =
            "humaneinternal.system.credentials.DeviceAttestationCredentialKeyManager"

        assertTrue(
            CosmosRemoteTransport.shouldBridgeDirectAttestation(
                directManager,
                CosmosRemoteTransport.PROVISIONING_PROCESS,
                cloneEnabled = true,
            ),
        )
        assertFalse(
            CosmosRemoteTransport.shouldBridgeDirectAttestation(
                directManager,
                "hu.ma.ne.ironman",
                cloneEnabled = true,
            ),
        )
        assertFalse(
            CosmosRemoteTransport.shouldBridgeDirectAttestation(
                directManager,
                CosmosRemoteTransport.PROVISIONING_PROCESS,
                cloneEnabled = false,
            ),
        )
        assertFalse(
            CosmosRemoteTransport.shouldBridgeDirectAttestation(
                "humaneinternal.system.credentials.DeviceUserCredentialKeyManager",
                CosmosRemoteTransport.PROVISIONING_PROCESS,
                cloneEnabled = true,
            ),
        )

        val source = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/CosmosRemoteTransport.kt",
        ).readText()
        val pendingImport = source
            .substringAfter("private fun importPendingAttestation(store: KeyStore)")
            .substringBefore("private fun validateAttestation(")
        val keyImport = pendingImport.indexOf("store.setEntry(")
        val privateKeyReadback = pendingImport.indexOf(
            "check(store.getKey(ATTESTATION_KEY_ALIAS, null) is PrivateKey)",
        )
        val certificateReadback = pendingImport.indexOf(
            "check(store.getCertificateChain(ATTESTATION_KEY_ALIAS)?.isNotEmpty() == true)",
        )
        val exactIdentityReadback = pendingImport.indexOf("validateStoredAttestation(")
        val handoffDelete = pendingImport.indexOf(
            "resolver.delete(Settings.Global.getUriFor(ATTESTATION_BUNDLE_SETTING), null, null)",
        )
        assertTrue(keyImport >= 0)
        assertTrue(privateKeyReadback > keyImport)
        assertTrue(certificateReadback > privateKeyReadback)
        assertTrue(exactIdentityReadback > certificateReadback)
        assertTrue(handoffDelete > exactIdentityReadback)
        assertTrue(
            source.contains(
                "resolver.delete(Settings.Global.getUriFor(ATTESTATION_BUNDLE_SETTING), null, null)",
            ),
        )
        assertFalse(
            source.contains(
                "Settings.Global.putString(resolver, ATTESTATION_BUNDLE_SETTING, null)",
            ),
        )
    }

    @Test
    fun remoteEdgeAddressRequiresOneCanonicalIpv4() {
        assertArrayEquals(
            byteArrayOf(198.toByte(), 51, 100, 42),
            CosmosRemoteTransport.parseIpv4("198.51.100.42"),
        )
        assertNull(CosmosRemoteTransport.parseIpv4("198.51.100"))
        assertNull(CosmosRemoteTransport.parseIpv4("198.51.100.256"))
        assertNull(CosmosRemoteTransport.parseIpv4("198.51.100.42.example"))
    }

    @Test
    fun channelRoutingIsRemoteOnlyAndFailsClosed() {
        val routingSource = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/CosmosChannelRouting.kt",
        ).readText()

        assertTrue(routingSource.contains("val cloneTrustInstalled = CosmosRemoteTransport.installCloneTrust(factory)"))
        assertTrue(routingSource.contains("if (!CosmosRemoteTransport.isEnabled())"))
        assertTrue(routingSource.contains("if (!cloneTrustInstalled)"))
        assertTrue(routingSource.contains("CosmosRemoteTransport.redirectedGatewayForCurrentProcess("))
        assertFalse(routingSource.contains("127.0.0.1"))
        assertFalse(routingSource.contains("ContentResolver"))
    }

    private fun repoFile(relativePath: String): File {
        val candidates = listOf(
            File(relativePath),
            File("..", relativePath),
            File("../..", relativePath),
        )
        return candidates.firstOrNull { it.exists() }
            ?: throw AssertionError("Missing repository contract path: $relativePath")
    }

    private inline fun <reified T : Throwable> assertFails(block: () -> Unit) {
        try {
            block()
            fail("Expected ${T::class.java.simpleName}")
        } catch (error: Throwable) {
            assertTrue(
                "Expected ${T::class.java.simpleName}, got ${error::class.java.simpleName}",
                error is T,
            )
        }
    }
}
