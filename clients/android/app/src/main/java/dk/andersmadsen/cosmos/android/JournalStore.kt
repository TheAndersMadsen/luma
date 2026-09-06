package dk.andersmadsen.cosmos.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The client journal holds session secrets and pending user text. It is
 * stored encrypted under a Keystore AES key in app-private storage and replaced
 * atomically (temporary file, fsync, rename), so a crash leaves the old bytes.
 */
class JournalStore private constructor(private val directory: File) {
    private val file = File(directory, "cosmos-journal.bin")
    private val temporary = File(directory, "cosmos-journal.tmp")
    private val lock = Any()

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun read(): ByteArray? = synchronized(lock) {
        if (!file.isFile) return null
        val bytes = file.readBytes()
        require(bytes.size > 12 + 16) { "journal file is truncated" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        cipher.doFinal(bytes, 12, bytes.size - 12)
    }

    fun writeAtomically(plain: ByteArray) = synchronized(lock) {
        require(plain.isNotEmpty()) { "journal is never empty" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.iv + cipher.doFinal(plain)
        require(cipher.iv.size == 12) { "unexpected GCM nonce length" }
        FileOutputStream(temporary).use { stream ->
            stream.write(encrypted)
            stream.fd.sync()
        }
        check(temporary.renameTo(file)) { "journal rename failed" }
    }

    companion object {
        private const val KEY_ALIAS = "dk.andersmadsen.cosmos.android.journal"

        fun open(context: Context): JournalStore =
            JournalStore(File(context.applicationContext.noBackupFilesDir, "cosmos").apply { mkdirs() })
    }
}
