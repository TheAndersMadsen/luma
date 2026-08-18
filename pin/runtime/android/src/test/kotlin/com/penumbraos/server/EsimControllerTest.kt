package com.penumbraos.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class EsimControllerTest {
    @Test
    fun requestExtrasIncludeValidatedBridgeTokenAndOmitAbsentOptions() {
        val token = "0123456789abcdef".repeat(4)

        val extras = EsimController.requestExtras(
            requestId = "request-1",
            operationToken = "op-1",
            iccid = null,
            activationCode = null,
            nickname = null,
            source = "rust",
            bridgeAuthToken = token,
        )

        assertEquals(token, extras[EsimController.BRIDGE_AUTH_TOKEN_EXTRA])
        assertEquals("request-1", extras["penumbra_request_id"])
        assertEquals("op-1", extras[EsimController.OPERATION_TOKEN_EXTRA])
        assertEquals("rust", extras["penumbra_source"])
        assertFalse(extras.containsKey("iccid"))
        assertFalse(extras.containsKey("activationCode"))
        assertFalse(extras.containsKey("Nickname"))
    }

    @Test(expected = IllegalStateException::class)
    fun requestExtrasRejectMalformedBridgeToken() {
        EsimController.requestExtras(
            requestId = "request-1",
            operationToken = "op-1",
            iccid = null,
            activationCode = null,
            nickname = null,
            source = "rust",
            bridgeAuthToken = "not-a-token",
        )
    }
}
