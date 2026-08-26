package com.penumbraos.server

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PersistentConfigVaultFormatTest {

    @Test
    fun roundTripsRequiredAndOptionalArtifacts() {
        val files = validFiles().toMutableMap().apply {
            put(
                PersistentConfigVaultFormat.LOCAL_CONFIG_FILE_NAME,
                "[dev]\napk_install_enabled = false\n".toByteArray(),
            )
            put(
                PersistentConfigVaultFormat.SPOTIFY_AUTH_FILE_NAME,
                "{\"version\":1,\"device_id\":\"device\",\"credentials\":{}}\n".toByteArray(),
            )
        }

        val encoded = PersistentConfigVaultFormat.encode(7, files)
        val decoded = PersistentConfigVaultFormat.decode(encoded.bytes)

        assertEquals(7, decoded.generation)
        assertEquals(encoded.digestHex, decoded.digestHex)
        assertEquals(files.keys, decoded.files.keys)
        for ((name, bytes) in files) {
            assertArrayEquals(name, bytes, decoded.files[name])
        }
    }

    @Test
    fun rejectsTamperedBundleBeforePublishingArtifacts() {
        val encoded = PersistentConfigVaultFormat.encode(1, validFiles()).bytes
        encoded[encoded.lastIndex / 2] = (encoded[encoded.lastIndex / 2].toInt() xor 1).toByte()

        assertThrows(IllegalArgumentException::class.java) {
            PersistentConfigVaultFormat.decode(encoded)
        }
    }

    @Test
    fun rejectsMissingOrInvalidSecurityMarker() {
        val missing = validFiles().toMutableMap().apply {
            remove(PersistentConfigVaultFormat.SECURITY_SCHEMA_FILE_NAME)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PersistentConfigVaultFormat.encode(1, missing)
        }

        val invalid = validFiles().toMutableMap().apply {
            put(
                PersistentConfigVaultFormat.SECURITY_SCHEMA_FILE_NAME,
                "0\n".toByteArray(StandardCharsets.US_ASCII),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            PersistentConfigVaultFormat.encode(1, invalid)
        }
    }

    @Test
    fun rejectsMalformedSpotifyAuthenticationState() {
        val invalid = validFiles().toMutableMap().apply {
            put(PersistentConfigVaultFormat.SPOTIFY_AUTH_FILE_NAME, "not-json".toByteArray())
        }

        assertThrows(IllegalArgumentException::class.java) {
            PersistentConfigVaultFormat.encode(1, invalid)
        }
    }

    @Test
    fun dropsArtifactRetiredByAnEarlierRelease() {
        val expected = validFiles()
        val encoded = encodeWithExtraArtifact(
            generation = 9,
            files = expected,
            extraName = "codex-auth.json",
            extraBytes = "{\"tokens\":{}}\n".toByteArray(StandardCharsets.US_ASCII),
        )

        val decoded = PersistentConfigVaultFormat.decode(encoded)

        assertEquals(9, decoded.generation)
        assertEquals(expected.keys, decoded.files.keys)
        for ((name, bytes) in expected) {
            assertArrayEquals(name, bytes, decoded.files[name])
        }
    }

    /** Writes the on-disk bundle exactly as a release owning [extraName] did. */
    private fun encodeWithExtraArtifact(
        generation: Long,
        files: Map<String, ByteArray>,
        extraName: String,
        extraBytes: ByteArray,
    ): ByteArray {
        val payloadBuffer = ByteArrayOutputStream()
        DataOutputStream(payloadBuffer).use { output ->
            output.write("PENUMBRA_CONFIG_VAULT\u0000".toByteArray(StandardCharsets.US_ASCII))
            output.writeInt(1)
            output.writeLong(generation)
            val ordered = (files + (extraName to extraBytes)).toSortedMap()
            output.writeInt(ordered.size)
            for ((name, bytes) in ordered) {
                output.writeUTF(name)
                output.writeInt(bytes.size)
                output.write(bytes)
            }
        }
        val payload = payloadBuffer.toByteArray()
        return payload + MessageDigest.getInstance("SHA-256").digest(payload)
    }

    private fun validFiles(): Map<String, ByteArray> {
        val adminToken = "a".repeat(64)
        val bridgeToken = "b".repeat(64)
        return mapOf(
            PersistentConfigVaultFormat.CONFIG_FILE_NAME to
                ConfigSecurity.createSafeLegacyReplacement { adminToken }.toByteArray(),
            PersistentConfigVaultFormat.SECURITY_SCHEMA_FILE_NAME to
                "1\n".toByteArray(StandardCharsets.US_ASCII),
            PersistentConfigVaultFormat.ESIM_TOKEN_FILE_NAME to
                "$bridgeToken\n".toByteArray(StandardCharsets.US_ASCII),
        )
    }
}
