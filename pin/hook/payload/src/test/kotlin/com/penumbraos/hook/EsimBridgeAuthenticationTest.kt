package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EsimBridgeAuthenticationTest {
    @Test
    fun authenticationVectorsMatchServerAndRust() {
        val token = "0123456789abcdef".repeat(4)
        val serverNonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        val clientNonce = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"

        assertEquals(
            "bwhw1XBfg-tEt-sF6N_3w5SCjFQy4IMoT1IDXFSWTG8",
            EsimBridgeAuthentication.clientProofForTest(token, serverNonce, clientNonce),
        )
        assertEquals(
            "fk5F0PWBeCaaLXVKkkZr-OxyMV3JrYtEkFUaMbGVeKs",
            EsimBridgeAuthentication.serverProofForTest(token, serverNonce, clientNonce),
        )
    }

    @Test
    fun actionStartedEventNeverContainsActivationCredential() {
        val secret = "LPA:1${'$'}activation-code-must-not-escape"
        val extras = EsimBridgeAuthentication.actionStartedExtras(
            iccid = "8901000000000000000",
            nickname = "Travel",
            source = "rust",
            activationCodeProvided = secret.isNotEmpty(),
        )

        assertFalse(extras.containsKey("activationCode"))
        assertFalse(extras.values.any { it == secret })
        assertEquals(true, extras["activationCodeProvided"])
        assertTrue(extras.containsKey("iccid"))
    }

    @Test
    fun deliveredBridgeTokenMustBeCanonicalLowercaseHex() {
        val token = "0123456789abcdef".repeat(4)

        assertEquals(token, EsimBridgeAuthentication.canonicalDeliveredTokenOrNull(token))
        assertNull(EsimBridgeAuthentication.canonicalDeliveredTokenOrNull(null))
        assertNull(EsimBridgeAuthentication.canonicalDeliveredTokenOrNull("short"))
        assertNull(EsimBridgeAuthentication.canonicalDeliveredTokenOrNull(token.uppercase()))
        assertNull(
            EsimBridgeAuthentication.canonicalDeliveredTokenOrNull(
                token.dropLast(1) + "g",
            ),
        )
    }

    @Test
    fun operationBridgeAuthenticationRunsOffCallerThread() {
        val caller = Thread.currentThread()
        var worker: Thread? = null

        assertTrue(
            EsimEventEmitter.runBoundedOperationAuthentication {
                worker = Thread.currentThread()
                true
            },
        )
        assertNotSame(caller, worker)
    }

    @Test
    fun operationContextClearDropsDeliveredBridgeToken() {
        EsimOperationContext.begin(
            action = "humane.connectivity.esimlpa.getProfiles",
            requestId = "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            operationToken = "op_11111111111111111111111111111111",
            iccid = null,
            nickname = null,
            source = "rust",
            bridgeAuthToken = "0123456789abcdef".repeat(4),
            activationCodeProvided = false,
        )

        EsimOperationContext.clear()

        assertNull(EsimOperationContext.snapshot())
    }
}
