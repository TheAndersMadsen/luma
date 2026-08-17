package com.penumbraos.server

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/** Keeps the SQLCipher key wrapped by a non-exportable hardware-backed key. */
internal object DatabaseKeyManager {

    private const val TAG = "PenumbraServer"
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val WRAPPING_KEY_ALIAS = "penumbraos.database.sqlcipher.wrapping.v1"
    private const val WRAPPED_KEY_FILE_NAME = "database-key.v1"
    private const val DATABASE_KEY_BYTES = 32
    private const val GCM_TAG_BITS = 128
    private val AAD = "com.penumbraos.server:database-key:v1".toByteArray(Charsets.US_ASCII)

    fun loadOrCreate(databaseFile: File): ByteArray {
        val directory = checkNotNull(databaseFile.parentFile)
        check(directory.exists() || directory.mkdirs()) { "Failed to create database directory" }
        check(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) {
            "Invalid database directory"
        }

        val wrappedKeyFile = File(directory, WRAPPED_KEY_FILE_NAME)
        check(!Files.isSymbolicLink(wrappedKeyFile.toPath())) {
            "Refusing symbolic-link wrapped database key"
        }
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val wrappingKey = keyStore.getKey(WRAPPING_KEY_ALIAS, null) as? SecretKey

        if (wrappedKeyFile.isFile) {
            checkNotNull(wrappingKey) { "Database wrapping key is unavailable" }
            requireHardwareBacked(wrappingKey)
            return decryptWrappedKey(wrappingKey, wrappedKeyFile.readBytes())
        }

        check(databaseIsAbsentOrPlaintext(databaseFile)) {
            "Refusing to replace a missing key for an encrypted database"
        }
        val durableWrappingKey = wrappingKey ?: generateWrappingKey()
        requireHardwareBacked(durableWrappingKey)
        val databaseKey = ByteArray(DATABASE_KEY_BYTES).also(SecureRandom()::nextBytes)
        val encoded = encryptDatabaseKey(durableWrappingKey, databaseKey)
        writeAtomic(wrappedKeyFile, encoded)
        return databaseKey
    }

    fun toLowerHexAscii(bytes: ByteArray): ByteArray {
        val digits = "0123456789abcdef".toByteArray(Charsets.US_ASCII)
        return ByteArray(bytes.size * 2).also { encoded ->
            bytes.forEachIndexed { index, byte ->
                val value = byte.toInt() and 0xff
                encoded[index * 2] = digits[value ushr 4]
                encoded[index * 2 + 1] = digits[value and 0x0f]
            }
        }
    }

    private fun generateWrappingKey(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                WRAPPING_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun requireHardwareBacked(key: SecretKey) {
        val factory = SecretKeyFactory.getInstance(key.algorithm, KEYSTORE_PROVIDER)
        val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
        val hardware = when (info.securityLevel) {
            KeyProperties.SECURITY_LEVEL_STRONGBOX -> "StrongBox"
            KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "trusted-environment"
            else -> null
        }
        checkNotNull(hardware) { "Database wrapping key is not hardware-backed" }
        Log.w(TAG, "Database wrapping key verified in $hardware")
    }

    private fun encryptDatabaseKey(wrappingKey: SecretKey, databaseKey: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
        cipher.updateAAD(AAD)
        return WrappedKeyFormat.encode(cipher.iv, cipher.doFinal(databaseKey))
    }

    private fun decryptWrappedKey(wrappingKey: SecretKey, encoded: ByteArray): ByteArray {
        val wrapped = WrappedKeyFormat.decode(encoded)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, wrapped.iv))
        cipher.updateAAD(AAD)
        return cipher.doFinal(wrapped.ciphertext).also { key ->
            check(key.size == DATABASE_KEY_BYTES) { "Invalid unwrapped database key length" }
        }
    }

    private fun databaseIsAbsentOrPlaintext(databaseFile: File): Boolean {
        if (!databaseFile.exists()) return true
        check(databaseFile.isFile && !Files.isSymbolicLink(databaseFile.toPath())) {
            "Invalid database file"
        }
        val header = ByteArray(WrappedKeyFormat.SQLITE_HEADER.size)
        val read = databaseFile.inputStream().use { it.read(header) }
        return read == header.size && header.contentEquals(WrappedKeyFormat.SQLITE_HEADER)
    }

    private fun writeAtomic(destination: File, bytes: ByteArray) {
        val temporary = File(checkNotNull(destination.parentFile), ".${destination.name}.tmp")
        check(!Files.isSymbolicLink(temporary.toPath())) { "Refusing wrapped-key temp symlink" }
        try {
            FileOutputStream(temporary, false).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    internal object WrappedKeyFormat {
        internal val SQLITE_HEADER = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)
        private val MAGIC = "PENUMBRA_DB_KEY\u0000".toByteArray(Charsets.US_ASCII)
        private const val VERSION = 1
        private const val MIN_IV_BYTES = 12
        private const val MAX_IV_BYTES = 32
        private const val MAX_CIPHERTEXT_BYTES = 128
        private const val MAX_ENCODED_BYTES = 256

        data class WrappedKey(val iv: ByteArray, val ciphertext: ByteArray)

        fun encode(iv: ByteArray, ciphertext: ByteArray): ByteArray {
            require(iv.size in MIN_IV_BYTES..MAX_IV_BYTES) { "Invalid wrapped-key IV length" }
            require(ciphertext.size in 1..MAX_CIPHERTEXT_BYTES) {
                "Invalid wrapped-key ciphertext length"
            }
            val output = ByteArrayOutputStream()
            DataOutputStream(output).use { data ->
                data.write(MAGIC)
                data.writeInt(VERSION)
                data.writeInt(iv.size)
                data.write(iv)
                data.writeInt(ciphertext.size)
                data.write(ciphertext)
            }
            return output.toByteArray().also {
                require(it.size <= MAX_ENCODED_BYTES) { "Wrapped database key is too large" }
            }
        }

        fun decode(encoded: ByteArray): WrappedKey {
            require(encoded.size in (MAGIC.size + 12)..MAX_ENCODED_BYTES) {
                "Invalid wrapped database key size"
            }
            DataInputStream(ByteArrayInputStream(encoded)).use { data ->
                val magic = ByteArray(MAGIC.size).also(data::readFully)
                require(magic.contentEquals(MAGIC)) { "Invalid wrapped database key magic" }
                require(data.readInt() == VERSION) { "Unsupported wrapped database key version" }
                val iv = ByteArray(data.readInt().also {
                    require(it in MIN_IV_BYTES..MAX_IV_BYTES) { "Invalid wrapped-key IV length" }
                }).also(data::readFully)
                val ciphertext = ByteArray(data.readInt().also {
                    require(it in 1..MAX_CIPHERTEXT_BYTES) {
                        "Invalid wrapped-key ciphertext length"
                    }
                }).also(data::readFully)
                require(data.available() == 0) { "Trailing wrapped database key data" }
                return WrappedKey(iv, ciphertext)
            }
        }
    }
}
