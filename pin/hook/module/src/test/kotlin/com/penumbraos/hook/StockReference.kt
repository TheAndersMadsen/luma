package com.penumbraos.hook

import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue

/**
 * The local stock reference `./luma stock decompile` writes to
 * `$LUMA_DATA_DIR/stock-reference`, outside the checkout (README "Stock
 * reference"): the pulled stock apps in `apks/` and their jadx output in
 * `decompiled/`. The `./luma` checks pass `LUMA_DATA_DIR` to every test.
 *
 * Evidence-bound tests pin the exact stock bytes they were reviewed against.
 * They run when the reference holds those stock apps. Without a reference
 * (fresh clone, CI), or with one pulled from another firmware build, they skip
 * and say why: evidence reviewed on one build proves nothing about another.
 */
internal object StockReference {
    private val root: File? =
        System.getenv("LUMA_DATA_DIR")?.takeIf { it.isNotBlank() }?.let { File(it, "stock-reference") }

    /** Skips unless the reference holds [apk] with exactly the [reviewedSha256]. */
    fun requireReviewedApk(apk: String, reviewedSha256: String): File {
        val file = root?.let { File(it, "apks/$apk") }
        assumeTrue(
            "Stock reference absent: run ./luma stock decompile --from-device SERIAL (needs apks/$apk)",
            file?.isFile == true,
        )
        val actual = sha256(file!!)
        assumeTrue(
            "The stock reference holds $apk $actual, not the reviewed $reviewedSha256; " +
                "re-review this evidence against it before re-pinning",
            actual == reviewedSha256,
        )
        return file
    }

    /**
     * jadx output below `decompiled/` for a reviewed app. Call
     * [requireReviewedApk] first. With [expectedSha256] the file must still be
     * the exact reviewed decompile.
     */
    fun decompiled(relativePath: String, expectedSha256: String? = null): File {
        val file = File(root!!, "decompiled/$relativePath")
        assertTrue("The stock reference is missing decompiled/$relativePath", file.exists())
        if (expectedSha256 != null) {
            assertEquals(
                "Pinned reverse-engineering evidence changed; re-review: decompiled/$relativePath",
                expectedSha256,
                sha256(file),
            )
        }
        return file
    }

    fun sha256(file: File): String = file.inputStream().buffered().use { sha256(it) }

    fun sha256(input: InputStream): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
        return digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}
