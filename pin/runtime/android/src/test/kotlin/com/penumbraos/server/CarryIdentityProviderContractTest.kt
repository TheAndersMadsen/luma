package com.penumbraos.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CarryIdentityProviderContractTest {
    @Test
    fun physicalMaintenanceUidsAreExplicitlyBounded() {
        assertTrue(isTrustedCarryIdentityUid(CARRY_IDENTITY_ROOT_UID))
        assertTrue(isTrustedCarryIdentityUid(CARRY_IDENTITY_SYSTEM_UID))
        assertTrue(isTrustedCarryIdentityUid(CARRY_IDENTITY_SHELL_UID))
        assertFalse(isTrustedCarryIdentityUid(10000))
        assertFalse(isTrustedCarryIdentityUid(-1))
    }
}
