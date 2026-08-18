package com.penumbraos.server

import org.junit.Assert.assertFalse
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
}
