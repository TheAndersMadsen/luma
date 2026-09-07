package dk.andersmadsen.cosmos.android

import android.text.InputType

/** One text-bearing view from the assist structure, reduced to what the extraction needs. */
data class ScreenTextNode(val text: String, val isPassword: Boolean, val isVisible: Boolean)

/** What the owner explicitly attaches: the app's name and package and the visible text, already bounded. */
data class ScreenContext(val app: String, val packageName: String, val text: String)

/**
 * Pure extraction of the text that was on screen when Cosmos opened. Visible,
 * non-password nodes only, in structure order, each distinct line once, bounded
 * to [NativeSurface.MAX_CONTEXT_BYTES] of UTF-8 at a character boundary.
 */
object ScreenText {
    /** Password input variations, visible or not, are never read. */
    fun isPasswordInput(inputType: Int): Boolean {
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return when (inputType and InputType.TYPE_MASK_CLASS) {
            InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    fun extract(nodes: List<ScreenTextNode>, maxBytes: Int = NativeSurface.MAX_CONTEXT_BYTES): String {
        val seen = LinkedHashSet<String>()
        for (node in nodes) {
            if (node.isPassword || !node.isVisible) continue
            val line = node.text.trim()
            if (line.isNotEmpty()) seen.add(line)
        }
        return truncateUtf8(seen.joinToString("\n"), maxBytes)
    }

    /** The longest prefix within [maxBytes] of UTF-8 that does not split a character or surrogate pair. */
    fun truncateUtf8(text: String, maxBytes: Int): String {
        if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return text
        var bytes = 0
        var index = 0
        while (index < text.length) {
            val point = text.codePointAt(index)
            val width = when { point < 0x80 -> 1; point < 0x800 -> 2; point < 0x10000 -> 3; else -> 4 }
            if (bytes + width > maxBytes) break
            bytes += width
            index += Character.charCount(point)
        }
        return text.substring(0, index)
    }
}
