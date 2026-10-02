package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CellularSettingsCompatibilityHooksTest {
    @Test
    fun `missing line number describes validated LTE without spoofing a number`() {
        assertEquals(
            "LTE connected",
            CellularSettingsCompatibilityHooks.lineNumberStatus(
                carrierNumber = null,
                hasValidatedCellular = true,
            ),
        )
        assertEquals(
            "number unavailable",
            CellularSettingsCompatibilityHooks.lineNumberStatus(
                carrierNumber = " ",
                hasValidatedCellular = false,
            ),
        )
        assertEquals(
            null,
            CellularSettingsCompatibilityHooks.lineNumberStatus(
                carrierNumber = "+4512345678",
                hasValidatedCellular = true,
            ),
        )
    }

    @Test
    fun `blank network operator falls back to SIM operator`() {
        assertEquals(
            "Replacement Carrier",
            CellularSettingsCompatibilityHooks.carrierNameOrFallback(
                stockCarrierName = "",
                networkOperatorName = " ",
                simOperatorName = "Replacement Carrier",
            ),
        )
        assertEquals(
            "mobile network",
            CellularSettingsCompatibilityHooks.carrierNameOrFallback(null, null, null),
        )
    }

    @Test
    fun `settings module installs the focused cellular compatibility hook`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/SettingsHooks.kt",
        ).readText()
        assertTrue(source.contains("CellularSettingsCompatibilityHooks.install(cl)"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull(File::isFile)
            ?: throw AssertionError("Missing settings hook source: $relativePath")
    }
}
