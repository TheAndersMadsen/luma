package com.penumbraos.server

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DatabaseKeyManagerTest {

    @Test
    fun wrappedKeyFormatRoundTripsAndRejectsTrailingData() {
        val iv = ByteArray(12) { it.toByte() }
        val ciphertext = ByteArray(48) { (it + 32).toByte() }
        val encoded = DatabaseKeyManager.WrappedKeyFormat.encode(iv, ciphertext)
        val decoded = DatabaseKeyManager.WrappedKeyFormat.decode(encoded)
        assertArrayEquals(iv, decoded.iv)
        assertArrayEquals(ciphertext, decoded.ciphertext)

        val failure = runCatching {
            DatabaseKeyManager.WrappedKeyFormat.decode(encoded + byteArrayOf(1))
        }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
    }

    @Test
    fun databaseKeyHexEncodingIsCanonical() {
        val encoded = DatabaseKeyManager.toLowerHexAscii(
            byteArrayOf(0x00, 0x0f, 0x10, 0x7f, 0x80.toByte(), 0xff.toByte()),
        )
        assertEquals("000f107f80ff", encoded.toString(Charsets.US_ASCII))
    }
}
