package com.penumbraos.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
    fun logicalRenameKeepsTheDeployedContentProviderAuthority() {
        assertEquals(
            "com.penumbraos.server.cosmosidentity",
            CosmosIdentityProvider.AUTHORITY,
        )
        assertEquals(
            "penumbra_cosmos_device_attestation_v1",
            CosmosIdentityProvider.KEY_ALIAS,
        )
    }
}
