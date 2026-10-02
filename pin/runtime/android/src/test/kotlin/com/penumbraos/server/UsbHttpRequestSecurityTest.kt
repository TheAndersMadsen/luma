package com.penumbraos.server

import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class UsbHttpRequestSecurityTest {
    private val token = "t".repeat(64)

    @Test
    fun callerAuthorizationIsStrippedAndTrustedBearerIsInjected() {
        val input = request(
            "Authorization: Bearer caller-controlled",
            "aUtHoRiZaTiOn: Basic also-controlled",
            "Proxy-Authorization: Basic proxy-controlled",
            "Connection: keep-alive",
            "Content-Length: 0",
        )

        val prepared = UsbHttpRequestSecurity.prepare(input, token)
        val rewritten = prepared.headers.toString(StandardCharsets.ISO_8859_1)
        assertEquals(0, prepared.contentLength)
        assertEquals(1, Regex("(?im)^authorization:").findAll(rewritten).count())
        assertTrue(rewritten.contains("Authorization: Bearer $token\r\n"))
        assertTrue(rewritten.contains("Connection: close\r\n"))
        assertFalse(rewritten.contains("caller-controlled"))
        assertFalse(rewritten.contains("proxy-controlled"))
    }

    @Test
    fun headerReaderStopsBeforeTheDeclaredBody() {
        val body = "hello".toByteArray(StandardCharsets.US_ASCII)
        val request = request("Content-Length: ${body.size}") + body
        val input = ByteArrayInputStream(request)

        val prepared = UsbHttpRequestSecurity.readAndPrepare(input, token)
        assertEquals(body.size.toLong(), prepared.contentLength)
        assertEquals(body.size, input.available())
    }

    @Test
    fun ambiguousFramingAndMissingLengthFailClosed() {
        assertRejected { UsbHttpRequestSecurity.prepare(request("Host: localhost"), token) }
        assertRejected {
            UsbHttpRequestSecurity.prepare(
                request("Content-Length: 0", "Content-Length: 0"),
                token,
            )
        }
        assertRejected {
            UsbHttpRequestSecurity.prepare(
                request("Transfer-Encoding: chunked", "Content-Length: 0"),
                token,
            )
        }
    }

    @Test
    fun oversizedHeadersFailClosed() {
        val oversized = "X-Large: ${"x".repeat(33 * 1024)}"
        assertRejected {
            UsbHttpRequestSecurity.prepare(request(oversized, "Content-Length: 0"), token)
        }
    }

    @Test
    fun requestBodiesLargerThanTheServerUploadLimitFailClosed() {
        assertRejected {
            UsbHttpRequestSecurity.prepare(
                request("Content-Length: ${256L * 1024L * 1024L + 1L}"),
                token,
            )
        }
    }

    private fun request(vararg headers: String): ByteArray =
        ("GET /api/settings HTTP/1.1\r\n" + headers.joinToString("\r\n") + "\r\n\r\n")
            .toByteArray(StandardCharsets.ISO_8859_1)

    private fun assertRejected(block: () -> Unit) {
        try {
            block()
            fail("expected request rejection")
        } catch (_: UsbHttpRequestSecurity.RejectedRequest) {
        }
    }
}
