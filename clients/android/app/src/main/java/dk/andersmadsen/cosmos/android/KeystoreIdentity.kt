package dk.andersmadsen.cosmos.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/**
 * The installation identity: one non-exportable P-256 key in the Android
 * Keystore plus a locally generated enrollment locator. The private key never
 * leaves the Keystore; Cosmos only ever sees the SEC1 public point.
 */
class KeystoreIdentity private constructor(private val context: Context) {
    val enrollmentId: UUID
        get() {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            preferences.getString(ENROLLMENT, null)?.let { return UUID.fromString(it) }
            val fresh = UUID.randomUUID()
            check(preferences.edit().putString(ENROLLMENT, fresh.toString()).commit()) { "enrollment locator not saved" }
            return fresh
        }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun ensureKey() {
        val store = keyStore()
        if (store.containsAlias(KEY_ALIAS)) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
    }

    /** Uncompressed SEC1 point: 0x04 || X || Y, each coordinate 32 bytes. */
    fun publicKeySec1(): ByteArray {
        ensureKey()
        val key = keyStore().getCertificate(KEY_ALIAS).publicKey as ECPublicKey
        return byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY)
    }

    /** DER ECDSA over SHA-256 of the complete message; the Keystore hashes once. */
    fun signSha256(message: ByteArray): ByteArray {
        ensureKey()
        val entry = keyStore().getEntry(KEY_ALIAS, null) as KeyStore.PrivateKeyEntry
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(entry.privateKey)
            update(message)
            sign()
        }
    }

    private fun coordinate(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        val trimmed = if (raw.size > 32 && raw[0] == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
        require(trimmed.size <= 32) { "coordinate exceeds field width" }
        return ByteArray(32 - trimmed.size) + trimmed
    }

    companion object {
        private const val PREFERENCES = "cosmos-installation"
        private const val ENROLLMENT = "enrollmentId"
        private const val KEY_ALIAS = "dk.andersmadsen.cosmos.android.installation"

        fun open(context: Context): KeystoreIdentity = KeystoreIdentity(context.applicationContext)
    }
}
