package dk.andersmadsen.cosmos.android

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/**
 * The public-key fingerprint the owner compares with Center: SHA-256 over the
 * exact 65 uncompressed SEC1 P-256 bytes, lowercase hex. Mirrors the Mac's
 * PublicDescriptor.fingerprint, including its rejection of non-canonical keys.
 */
object Fingerprint {
    private val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    private val SHAPE = Regex("^[A-Za-z0-9_-]{87}$")

    /** Sixty-four hex characters, or null when [publicKey] is not a canonical base64url P-256 point. */
    fun of(publicKey: String): String? {
        if (!SHAPE.matches(publicKey)) return null
        val bytes = runCatching { Base64.getUrlDecoder().decode(publicKey) }.getOrNull() ?: return null
        if (bytes.size != 65 || bytes[0] != 4.toByte()) return null
        if (Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) != publicKey) return null
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val y = BigInteger(1, bytes.copyOfRange(33, 65))
        if (x >= P || y >= P) return null
        // The SEC1 shape alone does not prove a point on P-256: y² = x³ − 3x + b (mod p).
        val onCurve = y.multiply(y).mod(P) == x.pow(3).subtract(x.multiply(BigInteger.valueOf(3))).add(B).mod(P)
        if (!onCurve) return null
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    /** Four lines of four 4-character groups, the way the owner compares it by eye. */
    fun lines(hex: String): List<String> = hex.chunked(16).map { line -> line.chunked(4).joinToString(" ") }
}
