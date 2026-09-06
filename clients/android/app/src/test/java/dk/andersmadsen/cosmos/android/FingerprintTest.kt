package dk.andersmadsen.cosmos.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

class FingerprintTest {
    // SEC 2's P-256 generator as the uncompressed SEC1 point, the same vector Center's tests use.
    private val generatorHex = "04" +
        "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
        "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
    private val generator = "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"
    // `printf HEX | xxd -r -p | shasum -a 256`, computed outside this implementation.
    private val expected = "698bea63dc44a344663ff1429aea10842df27b6b991ef25866b2c6c02cdcc5be"

    @Test
    fun digestsTheRawPointBytesLikeCenterAndTheMac() {
        assertEquals(generator, Base64.getUrlEncoder().withoutPadding().encodeToString(generatorHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()))
        assertEquals(expected, Fingerprint.of(generator))
    }

    @Test
    fun groupsTheDigestInFourLinesOfFourGroups() {
        val lines = Fingerprint.lines(expected)
        assertEquals(listOf("698b ea63 dc44 a344", "663f f142 9aea 1084", "2df2 7b6b 991e f258", "66b2 c6c0 2cdc c5be"), lines)
        assertEquals(expected, lines.joinToString("").replace(" ", ""))
    }

    @Test
    fun rejectsPaddedShortOffCurveAndNonCanonicalKeys() {
        assertNull(Fingerprint.of("$generator="))
        assertNull(Fingerprint.of(generator.dropLast(1)))
        assertNull(Fingerprint.of(generator.dropLast(1) + "V"))
        for (fill in listOf(0, 255)) {
            val offCurve = ByteArray(65) { fill.toByte() }.also { it[0] = 4 }
            assertNull(Fingerprint.of(Base64.getUrlEncoder().withoutPadding().encodeToString(offCurve)))
        }
        val compressed = ByteArray(65) { 0 }.also { it[0] = 2 }
        assertNull(Fingerprint.of(Base64.getUrlEncoder().withoutPadding().encodeToString(compressed)))
    }
}
