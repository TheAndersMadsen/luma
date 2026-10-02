package com.penumbraos.hook

import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class StandaloneDockKaslrTest {
    private val bootId = "a7f9be5d-5f1f-4555-8c0d-48f76f6ff12e"
    private val serial = "TEST-SERIAL"
    private val fingerprint =
        "qti/atoll/atoll:12/SKQ1.230401.001/101.000470.45.20:user/release-keys"
    private val symbols = """
        ffffff8008080000 T _text
        ffffff80082700b0 T free_pgtables
        ffffff800827cc20 T exit_mmap
    """.trimIndent()

    /*
     * These cases pin every fail-closed boundary before the parser exists:
     * one root report member, current SYSTEM LOG only, exact device/boot
     * binding, raw register values present in the WARN stack frame, two
     * independent symbols, and one aligned slide shared by every anchor.
     */
    @Test
    fun `two current boot warn anchors derive one aligned runtime base`() {
        val report = reportZip()
        try {
            val result = StandaloneDockKaslr.derive(
                report,
                symbols,
                expectedBootId = bootId,
                expectedSerial = serial,
                expectedFingerprint = fingerprint,
            )

            assertEquals(0x1f7d800000UL, result.slide)
            assertEquals(0xffffff9f85880000UL, result.runtimeTextBase)
            assertEquals(setOf("free_pgtables", "exit_mmap"), result.anchors.map { it.symbol }.toSet())
        } finally {
            report.delete()
        }
    }

    @Test
    fun `disagreeing warn anchors fail closed`() {
        val report = reportZip(lrHeader = "ffffff9f85c7cc70")
        try {
            assertThrows(StandaloneDockKaslrException::class.java) {
                StandaloneDockKaslr.derive(
                    report,
                    symbols,
                    expectedBootId = bootId,
                    expectedSerial = serial,
                    expectedFingerprint = fingerprint,
                )
            }
        } finally {
            report.delete()
        }
    }

    @Test
    fun `a report from another boot fails closed`() {
        val report = reportZip(embeddedBootId = "00000000-0000-0000-0000-000000000000")
        try {
            assertThrows(StandaloneDockKaslrException::class.java) {
                StandaloneDockKaslr.derive(
                    report,
                    symbols,
                    expectedBootId = bootId,
                    expectedSerial = serial,
                    expectedFingerprint = fingerprint,
                )
            }
        } finally {
            report.delete()
        }
    }

    private fun reportZip(
        lrHeader: String = "ffffff9f85a7cc70",
        embeddedBootId: String = bootId,
    ): File {
        val report = """
            ========================================================
            Build fingerprint: '$fingerprint'
            Command line: androidboot.serialno=$serial androidboot.slot_suffix=_b
            linuxBootId=$embeddedBootId
            ------ SYSTEM LOG (logcat -v threadtime -d *:v) ------
            --------- beginning of kernel
            01-01 W WARNING: CPU: 1 PID: 474 at mm.h free_pgtables+0x150/0x158
            01-01 W pc      : free_pgtables+0x150/0x158
            01-01 W lr      : exit_mmap+0x90/0x1c0
            01-01 W PC      : 0xffffff9f85a701c0:
            01-01 W LR      : 0x$lrHeader:
            01-01 W SP      : 0xffffff801490baf0:
            01-01 W : baf0  85a70200 ffffff9f 20000005 00000000 00000000 00000000 00000000 00000000
            01-01 W : bb30  00000000 00000000 85a7ccb0 ffffff9f 00000000 00000000 00000000 00000000
            01-01 W Call trace:
            01-01 W ---[ end trace abc ]---
            --------- beginning of main
        """.trimIndent()
        val path = Files.createTempFile("luma-dock-report", ".zip").toFile()
        ZipOutputStream(path.outputStream()).use { archive ->
            archive.putNextEntry(ZipEntry("bugreport-atoll.txt"))
            archive.write(report.toByteArray())
            archive.closeEntry()
            archive.putNextEntry(ZipEntry("FS/data/misc/logd/logcat.01"))
            archive.write("stale archived warning".toByteArray())
            archive.closeEntry()
        }
        return path
    }
}
