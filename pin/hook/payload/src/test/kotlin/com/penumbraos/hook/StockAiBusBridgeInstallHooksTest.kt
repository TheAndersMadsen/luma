package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StockAiBusBridgeInstallHooksTest {
    @Test
    fun onlyUnderstandAndNearbyMayUseTheReadyLocalBinder() {
        val understand = StockAiBusBridgeInstallHooks.TRANSACTION_SYNAPSE_UNDERSTANDING
        val nearby = StockAiBusBridgeInstallHooks.TRANSACTION_ENCRYPTED_NEARBY_SEARCH
        assertTrue(StockAiBusBridgeInstallHooks.shouldUseLocalTransaction(understand, true))
        assertTrue(StockAiBusBridgeInstallHooks.shouldUseLocalTransaction(nearby, true))
        assertFalse(StockAiBusBridgeInstallHooks.shouldUseLocalTransaction(understand, false))
        assertFalse(StockAiBusBridgeInstallHooks.shouldUseLocalTransaction(nearby, false))
        for (code in 1..18) {
            if (code != understand && code != nearby) {
                assertFalse(StockAiBusBridgeInstallHooks.shouldUseLocalTransaction(code, true))
            }
        }
    }

    @Test
    fun providerContractMatchesTheServerAuthority() {
        assertEquals("content://com.penumbraos.server.grpcauth", StockAiBusBridgeInstallHooks.PROVIDER_URI)
        assertEquals("GET_AIBUS_BRIDGE", StockAiBusBridgeInstallHooks.PROVIDER_METHOD)
        assertEquals("binder", StockAiBusBridgeInstallHooks.PROVIDER_RESULT)
    }
}
