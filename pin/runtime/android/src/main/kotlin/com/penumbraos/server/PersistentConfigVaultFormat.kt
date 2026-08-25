package com.penumbraos.server

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Bounded, authenticated-on-read format for the system-owned configuration
 * snapshot. The SHA-256 digest detects torn/corrupt writes; access control is
 * provided by the credential-encrypted vault directory and its provider.
 */
internal object PersistentConfigVaultFormat {

    const val CONFIG_FILE_NAME = "config.toml"
    const val LOCAL_CONFIG_FILE_NAME = "config.local.toml"
    const val SECURITY_SCHEMA_FILE_NAME = ".config-security-schema"
    const val ESIM_TOKEN_FILE_NAME = "esim-bridge-auth.token"
    const val SPOTIFY_AUTH_FILE_NAME = "spotify-auth.json"

    const val MAX_ARTIFACT_BYTES = 256 * 1024
    const val MAX_BUNDLE_BYTES = 1024 * 1024

    private const val FORMAT_VERSION = 1
    private const val DIGEST_BYTES = 32
    private val MAGIC = "PENUMBRA_CONFIG_VAULT\u0000".toByteArray(StandardCharsets.US_ASCII)
    private val REQUIRED_FILES = setOf(
        CONFIG_FILE_NAME,
        SECURITY_SCHEMA_FILE_NAME,
        ESIM_TOKEN_FILE_NAME,
    )
    val allowedFiles = setOf(
        CONFIG_FILE_NAME,
        LOCAL_CONFIG_FILE_NAME,
        SECURITY_SCHEMA_FILE_NAME,
        ESIM_TOKEN_FILE_NAME,
        SPOTIFY_AUTH_FILE_NAME,
    )

    data class Snapshot(
        val generation: Long,
        val files: Map<String, ByteArray>,
        val digestHex: String,
    )

    data class EncodedSnapshot(
        val bytes: ByteArray,
        val digestHex: String,
    )

    fun encode(generation: Long, files: Map<String, ByteArray>): EncodedSnapshot {
        require(generation > 0) { "Vault generation must be positive" }
        validateFiles(files)

        val payloadBuffer = ByteArrayOutputStream()
        DataOutputStream(payloadBuffer).use { output ->
            output.write(MAGIC)
            output.writeInt(FORMAT_VERSION)
            output.writeLong(generation)
            val ordered = files.toSortedMap()
            output.writeInt(ordered.size)
            for ((name, bytes) in ordered) {
                output.writeUTF(name)
                output.writeInt(bytes.size)
                output.write(bytes)
            }
        }
        val payload = payloadBuffer.toByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(payload)
        val encoded = ByteBuffer.allocate(payload.size + digest.size)
            .put(payload)
            .put(digest)
            .array()
        require(encoded.size <= MAX_BUNDLE_BYTES) { "Vault bundle exceeds size limit" }
        return EncodedSnapshot(encoded, digest.toHex())
    }

    fun decode(encoded: ByteArray): Snapshot {
        require(encoded.size in (MAGIC.size + 4 + 8 + 4 + DIGEST_BYTES)..MAX_BUNDLE_BYTES) {
            "Invalid vault bundle size"
        }
        val payloadSize = encoded.size - DIGEST_BYTES
        val payload = encoded.copyOfRange(0, payloadSize)
        val presentedDigest = encoded.copyOfRange(payloadSize, encoded.size)
        val expectedDigest = MessageDigest.getInstance("SHA-256").digest(payload)
        require(MessageDigest.isEqual(expectedDigest, presentedDigest)) {
            "Vault bundle digest mismatch"
        }

        val files = linkedMapOf<String, ByteArray>()
        val generation: Long
        DataInputStream(ByteArrayInputStream(payload)).use { input ->
            val magic = ByteArray(MAGIC.size)
            input.readFully(magic)
            require(magic.contentEquals(MAGIC)) { "Invalid vault bundle magic" }
            require(input.readInt() == FORMAT_VERSION) { "Unsupported vault bundle version" }
            generation = input.readLong()
            require(generation > 0) { "Invalid vault generation" }
            val fileCount = input.readInt()
            require(fileCount in REQUIRED_FILES.size..allowedFiles.size) {
                "Invalid vault artifact count"
            }
            repeat(fileCount) {
                val name = input.readUTF()
                require(name in allowedFiles && name !in files) { "Invalid vault artifact name" }
                val size = input.readInt()
                require(size in 0..MAX_ARTIFACT_BYTES) { "Invalid vault artifact size" }
                files[name] = ByteArray(size).also(input::readFully)
            }
            require(input.available() == 0) { "Trailing vault payload data" }
        }
        validateFiles(files)
        return Snapshot(generation, files, presentedDigest.toHex())
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

    private fun validateFiles(files: Map<String, ByteArray>) {
        require(files.keys.all { it in allowedFiles } && files.keys.containsAll(REQUIRED_FILES)) {
            "Invalid vault artifact set"
        }
        require(files.values.all { it.size <= MAX_ARTIFACT_BYTES }) {
            "Vault artifact exceeds size limit"
        }

        val config = strictUtf8(checkNotNull(files[CONFIG_FILE_NAME]))
        require(config.isNotEmpty()) { "Canonical config is empty" }
        ConfigSecurity.readAdminToken(config)

        require(
            checkNotNull(files[SECURITY_SCHEMA_FILE_NAME])
                .contentEquals("1\n".toByteArray(StandardCharsets.US_ASCII)),
        ) { "Invalid config security schema" }

        val tokenText = strictUtf8(checkNotNull(files[ESIM_TOKEN_FILE_NAME])).trim()
        EsimBridgeAuthentication.requireValidToken(tokenText)

        files[LOCAL_CONFIG_FILE_NAME]?.let(::strictUtf8)
        files[SPOTIFY_AUTH_FILE_NAME]?.let { auth ->
            val text = strictUtf8(auth).trim()
            require(
                text.length in 2..MAX_ARTIFACT_BYTES &&
                    text.first() == '{' &&
                    text.last() == '}' &&
                    text.none { it == '\u0000' },
            ) { "Invalid Spotify authentication state" }
        }
    }

    private fun strictUtf8(bytes: ByteArray): String = StandardCharsets.UTF_8
        .newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()

    private fun ByteArray.toHex(): String =
        joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
