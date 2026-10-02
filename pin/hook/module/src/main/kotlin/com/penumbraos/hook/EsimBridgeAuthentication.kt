package com.penumbraos.hook

import android.content.Context
import java.io.BufferedReader
import java.io.File
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/** Client side of the authenticated loopback protocol used for eSIM events. */
internal object EsimBridgeAuthentication {
    private const val SERVER_PACKAGE = "com.penumbraos.server"
    private const val TOKEN_FILE_NAME = "esim-bridge-auth.token"
    private const val TOKEN_CHARS = 64
    private const val NONCE_BYTES = 32
    private const val NONCE_CHARS = 43
    private const val PROOF_BYTES = 32
    private const val PROOF_CHARS = 43
    private const val MAX_AUTH_LINE_CHARS = 512
    private const val HMAC_ALGORITHM = "HmacSHA256"
    private const val CHALLENGE_TYPE = "esim.auth_challenge"
    private const val RESPONSE_TYPE = "esim.auth_response"
    private const val ACK_TYPE = "esim.authenticated"
    private const val CHANNEL = "events"
    private val CLIENT_DOMAIN =
        "penumbra/esim-bridge/$CHANNEL/client/v1\u0000".toByteArray(StandardCharsets.UTF_8)
    private val SERVER_DOMAIN =
        "penumbra/esim-bridge/$CHANNEL/server/v1\u0000".toByteArray(StandardCharsets.UTF_8)
    private val random = SecureRandom()

    fun loadToken(context: Context): String {
        val serverContext = context.createPackageContext(SERVER_PACKAGE, 0)
        val tokenFile = File(serverContext.filesDir, TOKEN_FILE_NAME)
        check(tokenFile.isFile && !Files.isSymbolicLink(tokenFile.toPath())) {
            "eSIM bridge authentication is unavailable"
        }
        return requireValidToken(tokenFile.readText().trim())
    }

    /**
     * Validate the token delivered with a server-originated LPA request.
     *
     * The Humane connectivity SELinux domain cannot traverse the server app's
     * data directory, even though both packages use UID 1000. The explicit
     * service intent is therefore the request-scoped handoff. Only a
     * canonical candidate reaches socket authentication. The server still
     * proves possession of the same secret before accepting an event.
     */
    fun canonicalDeliveredTokenOrNull(token: String?): String? =
        token?.takeIf(::isValidToken)

    /**
     * Authenticate the server before the caller sends an event. The token is
     * used only as an HMAC key and is never written to the socket.
     */
    fun authenticateServer(
        reader: BufferedReader,
        writer: OutputStreamWriter,
        token: String,
        nonceGenerator: () -> ByteArray = ::freshNonce,
    ): Boolean {
        requireValidToken(token)
        val challengeLine = readBoundedLine(reader, MAX_AUTH_LINE_CHARS) ?: return false
        val challenge = try {
            JSONObject(challengeLine)
        } catch (_: Throwable) {
            return false
        }
        if (challenge.keys().asSequence().toSet() != setOf("type", "channel", "nonce") ||
            challenge.optString("type") != CHALLENGE_TYPE ||
            challenge.optString("channel") != CHANNEL
        ) {
            return false
        }

        val serverNonce = decodeNonce(challenge.optString("nonce")) ?: return false
        val clientNonce = nonceGenerator().also(::requireNonce)
        writeJsonLine(
            writer,
            JSONObject()
                .put("type", RESPONSE_TYPE)
                .put("channel", CHANNEL)
                .put("nonce", encode(clientNonce))
                .put("proof", encode(proof(CLIENT_DOMAIN, token, serverNonce, clientNonce))),
        )

        val ackLine = readBoundedLine(reader, MAX_AUTH_LINE_CHARS) ?: return false
        val ack = try {
            JSONObject(ackLine)
        } catch (_: Throwable) {
            return false
        }
        if (ack.keys().asSequence().toSet() != setOf("type", "channel", "proof") ||
            ack.optString("type") != ACK_TYPE ||
            ack.optString("channel") != CHANNEL
        ) {
            return false
        }

        val presentedProof = decodeProof(ack.optString("proof")) ?: return false
        val expectedProof = proof(SERVER_DOMAIN, token, serverNonce, clientNonce)
        return MessageDigest.isEqual(expectedProof, presentedProof)
    }

    internal fun actionStartedExtras(
        iccid: String?,
        nickname: String?,
        source: String?,
        activationCodeProvided: Boolean,
    ): Map<String, Any?> = mapOf(
        "iccid" to iccid,
        "nickname" to nickname,
        "penumbra_source" to source,
        // Presence is useful for diagnostics. The provisioning credential is
        // intentionally never copied into an event.
        "activationCodeProvided" to activationCodeProvided,
    )

    internal fun clientProofForTest(token: String, serverNonce: String, clientNonce: String): String =
        proofForTest(CLIENT_DOMAIN, token, serverNonce, clientNonce)

    internal fun serverProofForTest(token: String, serverNonce: String, clientNonce: String): String =
        proofForTest(SERVER_DOMAIN, token, serverNonce, clientNonce)

    private fun proofForTest(
        domain: ByteArray,
        token: String,
        serverNonce: String,
        clientNonce: String,
    ): String {
        val server = checkNotNull(decodeNonce(serverNonce))
        val client = checkNotNull(decodeNonce(clientNonce))
        return encode(proof(domain, requireValidToken(token), server, client))
    }

    private fun requireValidToken(token: String): String {
        check(isValidToken(token)) {
            "eSIM bridge authentication is unavailable"
        }
        return token
    }

    private fun isValidToken(token: String): Boolean =
        token.length == TOKEN_CHARS && token.all { it in '0'..'9' || it in 'a'..'f' }

    private fun proof(
        domain: ByteArray,
        token: String,
        serverNonce: ByteArray,
        clientNonce: ByteArray,
    ): ByteArray {
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(SecretKeySpec(token.toByteArray(StandardCharsets.US_ASCII), HMAC_ALGORITHM))
        mac.update(domain)
        mac.update(serverNonce)
        mac.update(clientNonce)
        return mac.doFinal()
    }

    private fun freshNonce(): ByteArray = ByteArray(NONCE_BYTES).also(random::nextBytes)

    private fun requireNonce(nonce: ByteArray) {
        require(nonce.size == NONCE_BYTES) { "eSIM authentication nonce must be 32 bytes" }
    }

    private fun readBoundedLine(reader: BufferedReader, maxChars: Int): String? {
        val line = StringBuilder(minOf(maxChars, 256))
        while (true) {
            val next = reader.read()
            if (next == -1) return line.takeIf { it.isNotEmpty() }?.toString()
            if (next == '\n'.code) return line.toString().removeSuffix("\r")
            if (line.length >= maxChars) return null
            line.append(next.toChar())
        }
    }

    private fun writeJsonLine(writer: OutputStreamWriter, message: JSONObject) {
        writer.write(message.toString())
        writer.write('\n'.code)
        writer.flush()
    }

    private fun encode(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)

    private fun decodeNonce(value: String): ByteArray? = decodeCanonical(value, NONCE_CHARS, NONCE_BYTES)

    private fun decodeProof(value: String): ByteArray? = decodeCanonical(value, PROOF_CHARS, PROOF_BYTES)

    private fun decodeCanonical(value: String, expectedChars: Int, expectedBytes: Int): ByteArray? {
        if (value.length != expectedChars || value.any { !it.isLetterOrDigit() && it != '-' && it != '_' }) {
            return null
        }
        val decoded = try {
            Base64.getUrlDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return decoded.takeIf { it.size == expectedBytes && encode(it) == value }
    }
}
