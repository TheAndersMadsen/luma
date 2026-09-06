package dk.andersmadsen.cosmos.android.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** A square module grid without a quiet zone; true is a dark module. */
class QrMatrix(val size: Int, private val dark: BooleanArray) {
    operator fun get(x: Int, y: Int): Boolean = dark[y * size + x]
}

/** Encodes text for scanning by the owner's other device. Pure Java; no camera, no decoding. */
object QrCode {
    fun encode(text: String): QrMatrix? = runCatching {
        val hints = mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.CHARACTER_SET to "UTF-8")
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
        QrMatrix(matrix.width, BooleanArray(matrix.width * matrix.height) { matrix.get(it % matrix.width, it / matrix.width) })
    }.getOrNull()
}

/** The link as crisp modules on a white quiet zone; nothing renders when the text does not fit a code. */
@Composable
fun QrCodeImage(text: String, contentDescription: String, modifier: Modifier = Modifier) {
    val matrix = remember(text) { QrCode.encode(text) } ?: return
    val bitmap = remember(matrix) {
        val pixels = IntArray(matrix.size * matrix.size) { if (matrix[it % matrix.size, it / matrix.size]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
        Bitmap.createBitmap(pixels, matrix.size, matrix.size, Bitmap.Config.ARGB_8888).asImageBitmap()
    }
    Image(
        bitmap = bitmap, contentDescription = contentDescription, contentScale = ContentScale.Fit, filterQuality = FilterQuality.None,
        modifier = modifier.aspectRatio(1f).background(Color.White, RoundedCornerShape(12.dp)).padding(12.dp),
    )
}
