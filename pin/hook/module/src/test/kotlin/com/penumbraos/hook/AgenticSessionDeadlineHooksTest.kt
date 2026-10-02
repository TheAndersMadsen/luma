package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgenticSessionDeadlineHooksTest {
    private class ExactStockShape {
        companion object {
            @JvmField
            var AIMIC_TIMEOUT_MS: Long = AgenticSessionDeadlineHooks.EXPECTED_STOCK_TIMEOUT_MS
        }
    }

    private class WrongTypeShape {
        companion object {
            @JvmField
            var AIMIC_TIMEOUT_MS: Int = 25_000
        }
    }

    @Test
    fun `exact stock field is extended and applying again is idempotent`() {
        ExactStockShape.AIMIC_TIMEOUT_MS = AgenticSessionDeadlineHooks.EXPECTED_STOCK_TIMEOUT_MS

        assertEquals(
            AgenticSessionDeadlineHooks.ApplyResult.APPLIED,
            AgenticSessionDeadlineHooks.applyExactStockField(ExactStockShape::class.java),
        )
        assertEquals(
            AgenticSessionDeadlineHooks.AGENTIC_SESSION_TIMEOUT_MS,
            ExactStockShape.AIMIC_TIMEOUT_MS,
        )
        assertEquals(
            AgenticSessionDeadlineHooks.ApplyResult.ALREADY_APPLIED,
            AgenticSessionDeadlineHooks.applyExactStockField(ExactStockShape::class.java),
        )
    }

    @Test
    fun `unknown firmware value and incompatible shape are never changed`() {
        ExactStockShape.AIMIC_TIMEOUT_MS = 31_000L
        assertEquals(
            AgenticSessionDeadlineHooks.ApplyResult.UNEXPECTED_FIRMWARE,
            AgenticSessionDeadlineHooks.applyExactStockField(ExactStockShape::class.java),
        )
        assertEquals(31_000L, ExactStockShape.AIMIC_TIMEOUT_MS)

        WrongTypeShape.AIMIC_TIMEOUT_MS = 25_000
        assertEquals(
            AgenticSessionDeadlineHooks.ApplyResult.INVALID_FIELD,
            AgenticSessionDeadlineHooks.applyExactStockField(WrongTypeShape::class.java),
        )
        assertEquals(25_000, WrongTypeShape.AIMIC_TIMEOUT_MS)
    }

    @Test
    fun `deadline hook is installed before other Ironman modules can initialize interpreters`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        val deadline = source.indexOf("AgenticSessionDeadlineHooks.install(cl)")
        val credentials = source.indexOf("hookCredentialManager(cl)")
        val history = source.indexOf("ContextHistorySafetyHooks.install(cl)")

        assertTrue(deadline >= 0)
        assertTrue(deadline < credentials)
        assertTrue(deadline < history)
    }

    @Test
    fun `deadline policy stays tied to the audited stock artifact and exact field`() {
        val hookSource = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/AgenticSessionDeadlineHooks.kt",
        ).readText()

        assertTrue(hookSource.contains("humaneinternal.system.aibus.AIBusService"))
        assertTrue(hookSource.contains("AIMIC_TIMEOUT_MS"))
        assertEquals(
            "44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e",
            AgenticSessionDeadlineHooks.AUDITED_IRONMAN_SHA256,
        )
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
