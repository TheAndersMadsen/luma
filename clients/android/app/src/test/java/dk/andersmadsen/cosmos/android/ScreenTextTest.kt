package dk.andersmadsen.cosmos.android

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenTextTest {
    private fun node(text: String, password: Boolean = false, visible: Boolean = true) = ScreenTextNode(text, password, visible)

    @Test
    fun keepsVisibleTextOnceInOrderAndSkipsPasswordsAndHiddenViews() {
        val nodes = listOf(
            node("Inbox"), node("  Invoice 42  "), node("hunter2", password = true), node("Draft", visible = false),
            node("Inbox"), node("   "), node("Pay by Friday"), node("Invoice 42"),
        )
        assertEquals("Inbox\nInvoice 42\nPay by Friday", ScreenText.extract(nodes))
        assertEquals("", ScreenText.extract(listOf(node("secret", password = true), node("gone", visible = false))))
    }

    @Test
    fun boundsTheTextToWholeCharactersWithinTheByteLimit() {
        val long = "é".repeat(5000)
        val bounded = ScreenText.extract(listOf(node(long)), maxBytes = 8000)
        assertEquals(8000, bounded.toByteArray().size)
        assertEquals(4000, bounded.length)
        val pair = ScreenText.truncateUtf8("ab😀cd", 5)
        assertEquals("ab", pair)
        assertEquals("ab😀", ScreenText.truncateUtf8("ab😀cd", 6))
        assertEquals("ab😀cd", ScreenText.truncateUtf8("ab😀cd", 8))
        val lines = ScreenText.extract(List(3000) { node("line $it") })
        assertTrue(lines.toByteArray().size <= NativeSurface.MAX_CONTEXT_BYTES)
        assertTrue(lines.startsWith("line 0\nline 1\n"))
    }

    @Test
    fun recognisesEveryPasswordInputVariation() {
        assertTrue(ScreenText.isPasswordInput(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD))
        assertTrue(ScreenText.isPasswordInput(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD))
        assertTrue(ScreenText.isPasswordInput(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS))
        assertTrue(ScreenText.isPasswordInput(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD))
        assertFalse(ScreenText.isPasswordInput(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS))
        assertFalse(ScreenText.isPasswordInput(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_NORMAL))
        assertFalse(ScreenText.isPasswordInput(InputType.TYPE_NULL))
    }
}
