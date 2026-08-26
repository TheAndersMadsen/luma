package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RespondActionJsonCompatibilityHooksTest {
    @Test
    fun `projection contains only the two annotated stock fields`() {
        assertEquals(
            linkedMapOf("Response" to "12:34PM"),
            RespondActionJsonCompatibilityHooks.projectInputs(
                request = null,
                response = "12:34PM",
            ),
        )
        assertEquals(
            linkedMapOf("Request" to "what time is it", "Response" to "12:34PM"),
            RespondActionJsonCompatibilityHooks.projectInputs(
                request = "what time is it",
                response = "12:34PM",
            ),
        )
    }

    @Test
    fun `hook is pinned to the exact stock serializer and action classes`() {
        val source = File(
            "src/main/kotlin/com/penumbraos/hook/RespondActionJsonCompatibilityHooks.kt",
        ).readText()

        assertTrue(source.contains("humaneinternal.system.tao.ActionToJson"))
        assertTrue(
            source.contains("humaneinternal.system.intent.actions.system.RespondAction"),
        )
        assertTrue(source.contains("toInputsObject"))
        assertFalse(source.contains("mRunHasVisionAction"))
        assertFalse(source.contains("mRunId"))

        val ironman = File(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        assertTrue(ironman.contains("RespondActionJsonCompatibilityHooks.install(cl)"))
    }
}
