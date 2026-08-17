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
            "penumbra_carry_device_attestation_v1",
            CarryRemoteTransport.ATTESTATION_KEY_ALIAS,
        )
    }

    @Test
    fun cloneAttestationSubjectMatchesTheStockDacPattern() {
        assertTrue(
            CarryRemoteTransport.isCompatibleAttestationSubject(
                "2c2a0001104000ff",
                "V:01:D:2C2A0001104000FF:P:00000001",
            ),
        )
        assertFalse(
            CarryRemoteTransport.isCompatibleAttestationSubject(
                "2c2a0001104000ff",
                "V:01:D:2c2a0001104000ff:P:pin",
            ),
        )
        assertFalse(
            CarryRemoteTransport.isCompatibleAttestationSubject(
                "2c2a0001104000ff",
                "V:01:D:2c2a0001104000fe:P:00000001",
            ),
        )
    }

    @Test
    fun onboardingAutomationAcceptsOnlyTheStockFourDigitShape() {
        assertTrue(CarryOnboardingAutomation.isCompatiblePincode("1234"))
        assertTrue(CarryOnboardingAutomation.isCompatiblePincode("0000"))
        assertFalse(CarryOnboardingAutomation.isCompatiblePincode(null))
        assertFalse(CarryOnboardingAutomation.isCompatiblePincode("123"))
        assertFalse(CarryOnboardingAutomation.isCompatiblePincode("12345"))
        assertFalse(CarryOnboardingAutomation.isCompatiblePincode("12a4"))
        assertFalse(CarryOnboardingAutomation.isCompatiblePincode("１２３４"))
    }

    @Test
    fun onboardingPreservesOnlyTheFirstPreDucWifiDisable() {
        assertTrue(
            CarryOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = true,
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
        assertFalse(
            CarryOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = true,
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = true,
            ),
        )
        assertFalse(
            CarryOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = false,
                ducProvisioned = false,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
        assertFalse(
            CarryOnboardingAutomation.shouldPreserveInitialWifi(
                cloneEnabled = true,
                ducProvisioned = true,
                requestedEnabled = false,
                alreadyHandled = false,
            ),
        )
    }

    @Test
    fun provisioningIdentityBootstrapAcceptsOnlyHexDeviceIds() {
        assertTrue(CarryRemoteTransport.isCompatibleAttestationDeviceId("2c2a0001104000ff"))
        assertTrue(CarryRemoteTransport.isCompatibleAttestationDeviceId("A0"))
        assertFalse(CarryRemoteTransport.isCompatibleAttestationDeviceId(null))
        assertFalse(CarryRemoteTransport.isCompatibleAttestationDeviceId(""))
        assertFalse(CarryRemoteTransport.isCompatibleAttestationDeviceId("2c2a:001"))
        assertFalse(CarryRemoteTransport.isCompatibleAttestationDeviceId("2c2a 001"))
    }

    @Test
    fun connectivityChecksUseOnlyExactCloneHosts() {
        for (host in listOf(
            "connectivity-check.carry.humane.cloud",
            "n.carry.humane.cloud",
        )) {
            assertTrue(CarryRemoteTransport.isAllowedNetworkHost(host))
            assertTrue(CarryRemoteTransport.isAllowedNetworkHost("  ${host.uppercase()}  "))
        }

        for (host in listOf(
            "connectivity-check.prod.humane.cloud",
            "n.prod.humane.cloud",
            "connectivity-check.carry.humane.cloud.evil.example",
            "n.carry.humane.cloud.evil.example",
            "evil-connectivity-check.carry.humane.cloud",
            "evil.example",
            "",
        )) {
            assertFalse(CarryRemoteTransport.isAllowedNetworkHost(host))
        }
        assertFalse(CarryRemoteTransport.isAllowedNetworkHost(null))
    }

    @Test
    fun exactConnectivityHostsResolveToTheConfiguredOperatorAddress() {
        val configured = byteArrayOf(203.toByte(), 0, 113, 42)
        for (host in listOf(
            "connectivity-check.carry.humane.cloud",
            "n.carry.humane.cloud",
        )) {
            val resolved = CarryRemoteTransport.resolvedNetworkAddress(host, configured)
            assertEquals("203.0.113.42", resolved?.hostAddress)
            assertEquals(host, resolved?.hostName)
        }

        assertNull(
            CarryRemoteTransport.resolvedNetworkAddress(
                "n.carry.humane.cloud.evil.example",
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
    fun remoteCarryGatewaysAreExactAndTlsOnly() {
        assertTrue(CarryRemoteTransport.isAllowedGateway("api.carry.humane.cloud:443"))
        assertTrue(CarryRemoteTransport.isAllowedGateway("onboarding.carry.humane.cloud"))
        assertFalse(CarryRemoteTransport.isAllowedGateway("api.prod.humane.cloud:443"))
        assertFalse(CarryRemoteTransport.isAllowedGateway("location.carry.humane.cloud:443"))
        assertFalse(CarryRemoteTransport.isAllowedGateway("api.carry.humane.cloud:80"))
        assertFalse(CarryRemoteTransport.isAllowedGateway("api.carry.humane.cloud.evil:443"))
        assertFalse(CarryRemoteTransport.isAllowedGateway("https://api.carry.humane.cloud/path"))
    }

    @Test
    fun remoteCarryMapsOnlyTheStockApiAndOnboardingAuthorities() {
        assertEquals(
            "api.carry.humane.cloud:443",
            CarryRemoteTransport.redirectedGateway("api.prod.humane.cloud"),
        )
        assertEquals(
            "onboarding.carry.humane.cloud:443",
            CarryRemoteTransport.redirectedGateway("onboarding.prod.humane.cloud:443"),
        )
        assertNull(CarryRemoteTransport.redirectedGateway("location.prod.humane.cloud"))
        assertNull(CarryRemoteTransport.redirectedGateway("api.prod.humane.cloud.evil"))
        assertNull(CarryRemoteTransport.redirectedGateway("api.prod.humane.cloud:80"))
    }

    @Test
    fun provisioningProcessUsesTheAttestationOnlyOnboardingPlane() {
        assertEquals(
            "onboarding.carry.humane.cloud:443",
            CarryRemoteTransport.redirectedGatewayForProcess(
                "api.prod.humane.cloud",
                CarryRemoteTransport.PROVISIONING_PROCESS,
            ),
        )
        assertEquals(
            "api.carry.humane.cloud:443",
            CarryRemoteTransport.redirectedGatewayForProcess(
                "api.prod.humane.cloud",
                "hu.ma.ne.ironman",
            ),
        )
        assertNull(
            CarryRemoteTransport.redirectedGatewayForProcess(
                "untrusted.example",
                CarryRemoteTransport.PROVISIONING_PROCESS,
            ),
        )
    }

    @Test
    fun directAttestationBridgeIsExactToProvisioningCloneMode() {
        val directManager =
            "humaneinternal.system.credentials.DeviceAttestationCredentialKeyManager"

        assertTrue(
            CarryRemoteTransport.shouldBridgeDirectAttestation(
                directManager,
                CarryRemoteTransport.PROVISIONING_PROCESS,
                cloneEnabled = true,
            ),
        )
        assertFalse(
            CarryRemoteTransport.shouldBridgeDirectAttestation(
                directManager,
                "hu.ma.ne.ironman",
                cloneEnabled = true,
            ),
        )
        assertFalse(
            CarryRemoteTransport.shouldBridgeDirectAttestation(
                directManager,
                CarryRemoteTransport.PROVISIONING_PROCESS,
                cloneEnabled = false,
            ),
        )
        assertFalse(
            CarryRemoteTransport.shouldBridgeDirectAttestation(
                "humaneinternal.system.credentials.DeviceUserCredentialKeyManager",
                CarryRemoteTransport.PROVISIONING_PROCESS,
                cloneEnabled = true,
            ),
        )
    }

    @Test
    fun remoteEdgeAddressRequiresOneCanonicalIpv4() {
        assertArrayEquals(
            byteArrayOf(198.toByte(), 51, 100, 42),
            CarryRemoteTransport.parseIpv4("198.51.100.42"),
        )
        assertNull(CarryRemoteTransport.parseIpv4("198.51.100"))
        assertNull(CarryRemoteTransport.parseIpv4("198.51.100.256"))
        assertNull(CarryRemoteTransport.parseIpv4("198.51.100.42.example"))
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
            CarryRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = true,
                cloneTrustInstalled = false,
            ),
        )
        assertFalse(
            "clone mode with clone trust installed is the working path",
            CarryRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = true,
                cloneTrustInstalled = true,
            ),
        )
        assertFalse(
            "clone mode off: this gate must not fire (local/plaintext path owns it)",
            CarryRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = false,
                cloneTrustInstalled = false,
            ),
        )
        assertFalse(
            "clone mode off with trust present is still not this gate's concern",
            CarryRemoteTransport.cloneRedirectRefusedForMissingTrust(
                cloneEnabled = false,
                cloneTrustInstalled = true,
            ),
        )
    }

    /**
     * Pins the WIRING, not just the decision: the redirect must consult
     * [CarryRemoteTransport.cloneRedirectRefusedForMissingTrust] with the value
     * [CarryRemoteTransport.installCloneTrust] returned for the SAME factory.
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
            bypass.contains("CarryRemoteTransport.installCloneTrust(clazz)") &&
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
