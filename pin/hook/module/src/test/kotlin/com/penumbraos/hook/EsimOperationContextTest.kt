package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class EsimOperationContextTest {
    private val token = "0123456789abcdef".repeat(4)

    @Test
    fun immutableSnapshotsKeepLateCallbacksBoundToTheirOriginalRequest() {
        val first = requireNotNull(
            EsimOperationContext.begin(
                action = "humane.connectivity.esimlpa.enableProfile",
                requestId = "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                operationToken = "op_11111111111111111111111111111111",
                iccid = "1234567890",
                nickname = null,
                source = "rust",
                bridgeAuthToken = token,
                activationCodeProvided = false,
            ),
        )
        first.downloadIccid = "download-a"

        val second = requireNotNull(
            EsimOperationContext.begin(
                action = "humane.connectivity.esimlpa.disableProfile",
                requestId = "req_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                operationToken = "op_22222222222222222222222222222222",
                iccid = "2222222222",
                nickname = null,
                source = "rust",
                bridgeAuthToken = token,
                activationCodeProvided = false,
            ),
        )

        assertEquals("req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", first.requestId)
        assertEquals("op_11111111111111111111111111111111", first.operationToken)
        assertEquals("1234567890", first.iccid)
        assertEquals("download-a", first.downloadIccid)
        assertEquals(second, EsimOperationContext.snapshot())
        assertNull(second.downloadIccid)
    }

    @Test
    fun incompletePrivilegedIdentityFailsClosed() {
        assertNull(
            EsimOperationContext.begin(
                action = "humane.connectivity.esimlpa.deleteProfile",
                requestId = "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                operationToken = null,
                iccid = "1234567890",
                nickname = null,
                source = "rust",
                bridgeAuthToken = token,
                activationCodeProvided = false,
            ),
        )
        assertNull(EsimOperationContext.snapshot())
    }

    @Test
    fun listenerProxyPreservesStockReturnAndCarriesTheRegistrationSnapshot() {
        val first = operation(
            "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "op_11111111111111111111111111111111",
        )
        var callbackOperation: EsimOperationSnapshot? = null
        val delegate = object : EsimListenerForTest {
            override fun complete(message: String): String = "stock:$message"
            override fun fail(): Unit = error("stock failure")
        }
        val proxy = EsimLpaHooks.wrapListener(EsimListenerForTest::class.java, delegate) { method, _ ->
            if (method == "complete") callbackOperation = first
        } as EsimListenerForTest

        operation(
            "req_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "op_22222222222222222222222222222222",
        )

        assertEquals("stock:done", proxy.complete("done"))
        assertSame(first, callbackOperation)
        assertThrows(IllegalStateException::class.java) { proxy.fail() }
    }

    private fun operation(requestId: String, operationToken: String): EsimOperationSnapshot =
        requireNotNull(
            EsimOperationContext.begin(
                action = "humane.connectivity.esimlpa.enableProfile",
                requestId = requestId,
                operationToken = operationToken,
                iccid = "1234567890",
                nickname = null,
                source = "rust",
                bridgeAuthToken = token,
                activationCodeProvided = false,
            ),
        )
}

private interface EsimListenerForTest {
    fun complete(message: String): String
    fun fail()
}
