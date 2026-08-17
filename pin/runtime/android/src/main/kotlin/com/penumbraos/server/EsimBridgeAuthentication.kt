package com.penumbraos.server

import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/**
 * Authentication shared by the two loopback-only eSIM sockets.
 *
 * Loopback is not an Android application boundary: another app with the
 * INTERNET permission can connect to it. The protocol therefore proves
 * possession of an app-private, per-install token in both directions before a
 * request or event is sent. The token itself never crosses the socket.
 */
internal object EsimBridgeAuthentication {
    const val TOKEN_FILE_NAME = "esim-bridge-auth.token"
    const val TOKEN_ENVIRONMENT_VARIABLE = "PENUMBRA_ESIM_BRIDGE_TOKEN"

    private const val TOKEN_BYTES = 32
    private const val TOKEN_CHARS = TOKEN_BYTES * 2
    private const val NONCE_BYTES = 32
    private const val NONCE_CHARS = 43
    private const val PROOF_BYTES = 32
    private const val PROOF_CHARS = 43
    private const val HMAC_ALGORITHM = "HmacSHA256"
    private const val CHALLENGE_TYPE = "esim.auth_challenge"
    private const val RESPONSE_TYPE = "esim.auth_response"
    private const val ACK_TYPE = "esim.authenticated"
    private val random = SecureRandom()

    enum class Channel(val wireName: String) {
        EVENTS("events"),
        CONTROL("control"),
    }

    fun ensureToken(filesDir: File): String {
        val tokenFile = File(filesDir, TOKEN_FILE_NAME)
        check(!Files.isSymbolicLink(tokenFile.toPath())) {
            "Refusing to use a symbolic-link eSIM bridge token"
        }

        if (tokenFile.exists()) {
            return requireValidToken(tokenFile.readText().trim())
        }

        val bytes = ByteArray(TOKEN_BYTES).also(random::nextBytes)
        val token = bytes.joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
        writeOwnerOnly(tokenFile, "$token\n")
        return token
    }

    fun requireValidToken(token: String): String {
        check(token.length == TOKEN_CHARS && token.all { it in '0'..'9' || it in 'a'..'f' }) {
            "eSIM bridge token must be 32 random bytes encoded as lowercase hexadecimal"
        }
        return token
    }

    /** Server half of the mutual challenge-response protocol. */
    fun authenticateClient(
        reader: BufferedReader,
        writer: OutputStreamWriter,
        token: String,
        channel: Channel,
        nonceGenerator: () -> ByteArray = ::freshNonce,
    ): Boolean {
        requireValidToken(token)
        val serverNonce = nonceGenerator().also(::requireNonce)
        writeJsonLine(
            writer,
            JSONObject()
                .put("type", CHALLENGE_TYPE)
                .put("channel", channel.wireName)
                .put("nonce", encode(serverNonce)),
        )

        val responseLine = readBoundedLine(reader, MAX_AUTH_LINE_CHARS) ?: return false
        val response = try {
            JSONObject(responseLine)
        } catch (_: Throwable) {
            return false
        }
        if (response.keys().asSequence().toSet() != setOf("type", "channel", "nonce", "proof") ||
            response.optString("type") != RESPONSE_TYPE ||
            response.optString("channel") != channel.wireName
        ) {
            return false
        }

        val clientNonce = decodeNonce(response.optString("nonce")) ?: return false
        val presentedProof = decodeProof(response.optString("proof")) ?: return false
        val expectedProof = proof(channel, Role.CLIENT, token, serverNonce, clientNonce)
        if (!MessageDigest.isEqual(expectedProof, presentedProof)) return false

        writeJsonLine(
            writer,
            JSONObject()
                .put("type", ACK_TYPE)
                .put("channel", channel.wireName)
                .put("proof", encode(proof(channel, Role.SERVER, token, serverNonce, clientNonce))),
        )
        return true
    }

    fun readBoundedLine(reader: BufferedReader, maxChars: Int): String? {
        require(maxChars > 0)
        val line = StringBuilder(minOf(maxChars, 256))
        while (true) {
            val next = reader.read()
            if (next == -1) return line.takeIf { it.isNotEmpty() }?.toString()
            if (next == '\n'.code) return line.toString().removeSuffix("\r")
            if (line.length >= maxChars) throw IllegalArgumentException("eSIM bridge line exceeds limit")
            line.append(next.toChar())
        }
    }

    fun writeJsonLine(writer: OutputStreamWriter, message: JSONObject) {
        writer.write(message.toString())
        writer.write('\n'.code)
        writer.flush()
    }

    internal fun clientProofForTest(
        channel: Channel,
        token: String,
        serverNonce: String,
        clientNonce: String,
    ): String = proofForTest(channel, Role.CLIENT, token, serverNonce, clientNonce)

    internal fun serverProofForTest(
        channel: Channel,
        token: String,
        serverNonce: String,
        clientNonce: String,
    ): String = proofForTest(channel, Role.SERVER, token, serverNonce, clientNonce)

    private fun proofForTest(
        channel: Channel,
        role: Role,
        token: String,
        serverNonce: String,
        clientNonce: String,
    ): String {
        val server = checkNotNull(decodeNonce(serverNonce))
        val client = checkNotNull(decodeNonce(clientNonce))
        return encode(proof(channel, role, requireValidToken(token), server, client))
    }

    private fun proof(
        channel: Channel,
        role: Role,
        token: String,
        serverNonce: ByteArray,
        clientNonce: ByteArray,
    ): ByteArray {
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(SecretKeySpec(token.toByteArray(StandardCharsets.US_ASCII), HMAC_ALGORITHM))
        mac.update(domain(channel, role))
        mac.update(serverNonce)
        mac.update(clientNonce)
        return mac.doFinal()
    }

    private fun domain(channel: Channel, role: Role): ByteArray =
        "penumbra/esim-bridge/${channel.wireName}/${role.wireName}/v1\u0000"
            .toByteArray(StandardCharsets.UTF_8)

    private enum class Role(val wireName: String) {
        CLIENT("client"),
        SERVER("server"),
    }

    private fun freshNonce(): ByteArray = ByteArray(NONCE_BYTES).also(random::nextBytes)

    private fun requireNonce(nonce: ByteArray) {
        require(nonce.size == NONCE_BYTES) { "eSIM authentication nonce must be 32 bytes" }
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

    private fun writeOwnerOnly(file: File, text: String) {
        val parent = checkNotNull(file.parentFile)
        check(parent.exists() || parent.mkdirs()) { "Failed to create eSIM token directory" }
        val temporary = File(parent, ".${file.name}.tmp")
        check(!Files.isSymbolicLink(temporary.toPath())) {
            "Refusing to use a symbolic-link eSIM token temp file"
        }
        try {
            FileOutputStream(temporary, false).use { output ->
                output.write(text.toByteArray(StandardCharsets.US_ASCII))
                output.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    file.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(
                    temporary.toPath(),
                    file.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
            file.setReadable(false, false)
            file.setWritable(false, false)
            check(file.setReadable(true, true) && file.setWritable(true, true)) {
                "Failed to restrict eSIM bridge token permissions"
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private const val MAX_AUTH_LINE_CHARS = 512
}
