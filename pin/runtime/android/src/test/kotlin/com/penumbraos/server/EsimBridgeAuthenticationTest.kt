package com.penumbraos.server

import java.io.BufferedReader
import java.io.StringReader
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EsimBridgeAuthenticationTest {
    @Test
    fun perInstallTokenIsGeneratedOnceAndNeverPlacedInConfig() {
        val directory = Files.createTempDirectory("penumbra-esim-auth").toFile()
        try {
            val first = EsimBridgeAuthentication.ensureToken(directory)
            val second = EsimBridgeAuthentication.ensureToken(directory)
            val tokenFile = directory.resolve(EsimBridgeAuthentication.TOKEN_FILE_NAME)

            assertEquals(first, second)
            assertEquals(64, first.length)
            assertTrue(first.all { it in '0'..'9' || it in 'a'..'f' })
            assertEquals(first, tokenFile.readText().trim())
            assertFalse(directory.resolve("config.toml").exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun authenticationVectorsAreBoundToHookAndRustChannels() {
        val token = "0123456789abcdef".repeat(4)
        val serverNonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        val clientNonce = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"

        assertEquals(
            "bwhw1XBfg-tEt-sF6N_3w5SCjFQy4IMoT1IDXFSWTG8",
            EsimBridgeAuthentication.clientProofForTest(
                EsimBridgeAuthentication.Channel.EVENTS,
                token,
                serverNonce,
                clientNonce,
            ),
        )
        assertEquals(
            "fk5F0PWBeCaaLXVKkkZr-OxyMV3JrYtEkFUaMbGVeKs",
            EsimBridgeAuthentication.serverProofForTest(
                EsimBridgeAuthentication.Channel.EVENTS,
                token,
                serverNonce,
                clientNonce,
            ),
        )
        assertEquals(
            "BVF9ipNYSuVUYpdEV2NI_fHSqAX6GJsN_9XBpxaizGs",
            EsimBridgeAuthentication.clientProofForTest(
                EsimBridgeAuthentication.Channel.CONTROL,
                token,
                serverNonce,
                clientNonce,
            ),
        )
        assertEquals(
            "LFFZ6rg56xIRlbbvCeHG2OSvnUC3KaFYwGG7MKBG5Qg",
            EsimBridgeAuthentication.serverProofForTest(
                EsimBridgeAuthentication.Channel.CONTROL,
                token,
                serverNonce,
                clientNonce,
            ),
        )
    }

    @Test
    fun socketLinesAreBoundedBeforeJsonParsing() {
        val reader = BufferedReader(StringReader("first\r\nsecond\n"))
        assertEquals("first", EsimBridgeAuthentication.readBoundedLine(reader, 16))
        assertEquals("second", EsimBridgeAuthentication.readBoundedLine(reader, 16))

        val oversized = BufferedReader(StringReader("x".repeat(17)))
        assertFails { EsimBridgeAuthentication.readBoundedLine(oversized, 16) }
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected failure")
        } catch (_: IllegalArgumentException) {
        }
    }
}
