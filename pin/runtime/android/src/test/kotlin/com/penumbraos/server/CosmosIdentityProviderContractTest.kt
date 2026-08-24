package com.penumbraos.server

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
    }

    @Test
    fun serverRejectsMissingOrMalformedProvisionedRoot() {
        assertNull(parseProvisionedCosmosRoot(null))
        assertNull(parseProvisionedCosmosRoot("not-base64"))
        assertNull(parseProvisionedCosmosRoot("bm90LWEtY2VydGlmaWNhdGU="))
    }
}
