package com.penumbraos.server

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.Locale

/** Strict one-request HTTP/1.x parser for the localabstract USB bridge. */
internal object UsbHttpRequestSecurity {
    private const val MAX_HEADER_BYTES = 32 * 1024
    private const val MAX_HEADER_COUNT = 100
    private const val MAX_LINE_BYTES = 8 * 1024
    private const val MAX_HEADER_NAME_BYTES = 256
    private const val MAX_CONTENT_LENGTH_BYTES = 256L * 1024L * 1024L

    data class PreparedRequest(
        val headers: ByteArray,
        val contentLength: Long,
    )

    class RejectedRequest internal constructor() : IOException()

    fun readAndPrepare(input: InputStream, adminToken: String): PreparedRequest =
        prepare(readHeaderBlock(input), adminToken)

    internal fun prepare(headerBlock: ByteArray, adminToken: String): PreparedRequest {
        try {
            ConfigSecurity.requireValidAdminToken(adminToken)
        } catch (_: Throwable) {
            throw RejectedRequest()
        }
        rejectUnless(headerBlock.size <= MAX_HEADER_BYTES)
        val text = headerBlock.toString(StandardCharsets.ISO_8859_1)
        rejectUnless(text.endsWith("\r\n\r\n"))
        val lines = text.dropLast(4).split("\r\n")
        rejectUnless(lines.isNotEmpty())

        val requestLine = lines.first()
        rejectUnless(requestLine.toByteArray(StandardCharsets.ISO_8859_1).size <= MAX_LINE_BYTES)
        rejectUnless(requestLine.count { it == ' ' } == 2)
        val firstSpace = requestLine.indexOf(' ')
        val lastSpace = requestLine.lastIndexOf(' ')
        rejectUnless(firstSpace > 0 && lastSpace > firstSpace + 1 && lastSpace < requestLine.lastIndex)
        val method = requestLine.substring(0, firstSpace)
        val target = requestLine.substring(firstSpace + 1, lastSpace)
        val version = requestLine.substring(lastSpace + 1)
        rejectUnless(method.all(::isHttpTokenCharacter))
        rejectUnless(target.startsWith('/') && !target.contains('#'))
        rejectUnless(target.all { it.code in 0x21..0x7e })
        rejectUnless(version == "HTTP/1.1" || version == "HTTP/1.0")

        val forwarded = mutableListOf(requestLine)
        var contentLength: Long? = null
        var headerCount = 0
        for (line in lines.drop(1)) {
            headerCount += 1
            rejectUnless(headerCount <= MAX_HEADER_COUNT)
            rejectUnless(line.isNotEmpty() && line.first() != ' ' && line.first() != '\t')
            rejectUnless(line.toByteArray(StandardCharsets.ISO_8859_1).size <= MAX_LINE_BYTES)
            val colon = line.indexOf(':')
            rejectUnless(colon in 1..MAX_HEADER_NAME_BYTES)
            val name = line.substring(0, colon)
            val value = line.substring(colon + 1)
            rejectUnless(name.all(::isHttpTokenCharacter))
            rejectUnless(value.all { it == '\t' || it.code in 0x20..0x7e })

            when (name.lowercase(Locale.ROOT)) {
                "authorization", "proxy-authorization", "connection" -> Unit
                "transfer-encoding", "trailer", "expect" -> throw RejectedRequest()
                "content-length" -> {
                    rejectUnless(contentLength == null)
                    val normalized = value.trim()
                    rejectUnless(normalized.isNotEmpty() && normalized.all(Char::isDigit))
                    contentLength = normalized.toLongOrNull() ?: throw RejectedRequest()
                    forwarded += "Content-Length: $contentLength"
                }
                else -> forwarded += line
            }
        }

        // Center's transport always supplies Content-Length, including zero.
        // Requiring it removes close-delimited and pipelining ambiguity.
        val exactContentLength = contentLength ?: throw RejectedRequest()
        rejectUnless(exactContentLength <= MAX_CONTENT_LENGTH_BYTES)
        forwarded += "Authorization: Bearer $adminToken"
        forwarded += "Connection: close"
        val rewritten = (forwarded.joinToString("\r\n") + "\r\n\r\n")
            .toByteArray(StandardCharsets.ISO_8859_1)
        rejectUnless(rewritten.size <= MAX_HEADER_BYTES)
        return PreparedRequest(rewritten, exactContentLength)
    }

    private fun readHeaderBlock(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val terminator = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        var matched = 0
        while (output.size() < MAX_HEADER_BYTES) {
            val next = input.read()
            if (next == -1) throw RejectedRequest()
            output.write(next)
            val byte = next.toByte()
            matched = if (byte == terminator[matched]) {
                matched + 1
            } else if (byte == terminator[0]) {
                1
            } else {
                0
            }
            if (matched == terminator.size) return output.toByteArray()
        }
        throw RejectedRequest()
    }

    private fun isHttpTokenCharacter(char: Char): Boolean =
        char.code < 0x80 && (char.isLetterOrDigit() || char in "!#$%&'*+-.^_`|~")

    private fun rejectUnless(condition: Boolean) {
        if (!condition) throw RejectedRequest()
    }
}
