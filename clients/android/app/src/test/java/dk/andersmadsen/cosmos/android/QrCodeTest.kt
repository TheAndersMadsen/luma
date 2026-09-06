package dk.andersmadsen.cosmos.android

import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import dk.andersmadsen.cosmos.android.ui.QrCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QrCodeTest {
    private val descriptor = Descriptor("11111111-1111-4111-8111-111111111111",
        "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU", "android_tv", NativeEvent.APPROVAL)

    @Test
    fun encodesTheApprovalLinkAsAScannableCode() {
        val url = descriptor.approvalUrl("https://center.example")
        val matrix = QrCode.encode(url)!!
        // A version-n symbol is 17 + 4n modules square, and the caller adds the quiet zone.
        assertTrue(matrix.size >= 21)
        assertEquals(0, (matrix.size - 21) % 4)
        for (x in 0 until 7) { assertTrue(matrix[x, 0]); assertTrue(matrix[x, 6]); assertTrue(matrix[0, x]); assertTrue(matrix[6, x]) }
        for (x in 1 until 6) { assertFalse(matrix[x, 1]); assertFalse(matrix[x, 5]) }
        assertTrue(matrix[3, 3])
        assertEquals(url, decode(matrix))
    }

    @Test
    fun refusesEmptyText() {
        assertNull(QrCode.encode(""))
    }

    private fun decode(matrix: dk.andersmadsen.cosmos.android.ui.QrMatrix): String {
        val scale = 4
        val quiet = 4 * scale
        val size = matrix.size * scale + 2 * quiet
        val pixels = IntArray(size * size) { 0xFFFFFFFF.toInt() }
        for (y in 0 until matrix.size) for (x in 0 until matrix.size) if (matrix[x, y]) {
            for (dy in 0 until scale) for (dx in 0 until scale) pixels[(quiet + y * scale + dy) * size + quiet + x * scale + dx] = 0xFF000000.toInt()
        }
        return QRCodeReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(size, size, pixels)))).text
    }
}
