package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ChannelFactoryBypassTest {
    @Test
    fun cloneAttestationAliasMatchesTheHostImportContract() {
        assertEquals(
            "penumbra_cosmos_device_attestation_v1",
            CosmosRemoteTransport.ATTESTATION_KEY_ALIAS,
        )
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
    fun onboardingPreservesOnlyTheFirstPreDucWifiDisable() {
        assertTrue(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = true,
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
        assertFalse(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = true,
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = true,
            ),
        )
        assertFalse(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = false,
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
        assertFalse(
            CosmosOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = true,
                ducProvisioned = true,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
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
    fun authorizationIsAttachedOnlyToTheExactLocalTarget() {
        assertTrue(ChannelFactoryBypass.shouldAttachAuthorization("127.0.0.1:9090"))
        assertFalse(ChannelFactoryBypass.shouldAttachAuthorization("127.0.0.1:16789"))
        assertFalse(ChannelFactoryBypass.shouldAttachAuthorization("api.example.test:443"))
        assertFalse(ChannelFactoryBypass.shouldAttachAuthorization(null))
    }

    @Test
    fun tokenValidationMatchesTheServerContract() {
        val token = "a".repeat(32)
        assertEquals(token, ChannelFactoryBypass.requireValidToken(token))
        assertFails<IllegalArgumentException> {
            ChannelFactoryBypass.requireValidToken("short")
        }
        assertFails<IllegalArgumentException> {
            ChannelFactoryBypass.requireValidToken("a".repeat(31) + " ")
        }
        assertFails<IllegalArgumentException> {
            ChannelFactoryBypass.requireValidToken("a".repeat(513))
        }
    }

    @Test
    fun providerContractMatchesTheServerAuthority() {
        assertEquals("content://com.penumbraos.server.grpcauth", ChannelFactoryBypass.AUTH_PROVIDER_URI)
        assertEquals("GET_TOKEN", ChannelFactoryBypass.AUTH_PROVIDER_METHOD)
        assertEquals("token", ChannelFactoryBypass.AUTH_PROVIDER_RESULT)
    }

    @Test
    fun remoteCosmosGatewaysAreExactAndTlsOnly() {
        assertTrue(CosmosRemoteTransport.isAllowedGateway("api.cosmos.humane.cloud:443"))
        assertTrue(CosmosRemoteTransport.isAllowedGateway("onboarding.cosmos.humane.cloud"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("api.prod.humane.cloud:443"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("location.cosmos.humane.cloud:443"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("api.cosmos.humane.cloud:80"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("api.cosmos.humane.cloud.evil:443"))
        assertFalse(CosmosRemoteTransport.isAllowedGateway("https://api.cosmos.humane.cloud/path"))
    }

    @Test
    fun remoteCosmosMapsOnlyTheStockApiAndOnboardingAuthorities() {
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

    /**
     * The device must never redirect to the clone :443 without clone trust
     * installed on that factory — that is exactly the handshake failure against
     * the operator's private CA the transport exists to avoid (the push relay's
     * persistent `Subscribe` stream is the loudest victim: an endless
     * reconnect-with-backoff storm). Only the clone-on / trust-missing corner is
     * unsafe; the other three must proceed so working and local paths do not
     * regress.
     */
    @Test
    fun cloneRedirectIsRefusedOnlyWhenCloneModeIsOnAndTrustIsMissing() {
        assertTrue(
            "clone mode with no clone trust must be refused, not dialed",
            CosmosRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = true,
                cloneTrustInstalled = false,
            ),
        )
        assertFalse(
            "clone mode with clone trust installed is the working path",
            CosmosRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = true,
                cloneTrustInstalled = true,
            ),
        )
        assertFalse(
            "clone mode off: this gate must not fire (local/plaintext path owns it)",
            CosmosRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = false,
                cloneTrustInstalled = false,
            ),
        )
        assertFalse(
            "clone mode off with trust present is still not this gate's concern",
            CosmosRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = false,
                cloneTrustInstalled = true,
            ),
        )
    }

    /**
     * Pins the WIRING, not just the decision: the redirect must consult
     * [CosmosRemoteTransport.cloneRedirectRefusedForMissingTrust] with the value
     * [CosmosRemoteTransport.installCloneTrust] returned for the SAME factory.
     * Deleting the gate (so the redirect proceeds regardless of trust) leaves the
     * pure-function test above green, so a source-level check is what catches it.
     */
    @Test
    fun theRedirectIsGatedOnCloneTrustBeingInstalled() {
        val bypass = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/ChannelFactoryBypass.kt",
        ).readText()

        // installCloneTrust's result is captured (not discarded) and fed to the gate.
        assertTrue(
            "the redirect must capture installCloneTrust's result",
            bypass.contains("CosmosRemoteTransport.installCloneTrust(clazz)") &&
                bypass.contains("val cloneTrustInstalled ="),
        )
        assertTrue(
            "the redirect must refuse the clone gateway when clone trust is missing",
            bypass.contains("cloneRedirectRefusedForMissingTrust(") &&
                bypass.contains("cloneTrustInstalled"),
        )
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
