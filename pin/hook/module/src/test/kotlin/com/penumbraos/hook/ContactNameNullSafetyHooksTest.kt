package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host contract for the contact-name null guard that keeps a malformed contact
 * from crashing stock NER (`NameEntityCorrector.createNamedEntity`) on every
 * voice transcript.
 */
class ContactNameNullSafetyHooksTest {

    @Test
    fun `null name coerces to empty and real names pass through`() {
        // The crash-avoidance property: a null name must become a value whose
        // String.isEmpty() is true (so stock's !getX().isEmpty() branch is skipped)
        // rather than a null that throws.
        assertEquals("", ContactNameNullSafetyHooks.coercedName(null))
        assertTrue(ContactNameNullSafetyHooks.coercedName(null).isEmpty())

        // An already-empty name is preserved as empty (still skipped by stock).
        assertEquals("", ContactNameNullSafetyHooks.coercedName(""))
        assertTrue(ContactNameNullSafetyHooks.coercedName("").isEmpty())

        // A real name is returned unchanged, so contact matching is not weakened.
        assertEquals("Victoria", ContactNameNullSafetyHooks.coercedName("Victoria"))
        assertFalse(ContactNameNullSafetyHooks.coercedName("Victoria").isEmpty())
    }

    @Test
    fun `hook targets the Name class and only the null-returning getters`() {
        // getFullName() is deliberately excluded: it is already null-safe upstream.
        assertEquals("humane.system.contacts.Name", ContactNameNullSafetyHooks.NAME_CLASS)
        assertEquals(
            listOf("getFirstName", "getLastName", "getNickname"),
            ContactNameNullSafetyHooks.GUARDED_GETTERS,
        )
        assertFalse(
            "getFullName is null-safe upstream and must not be guarded here",
            ContactNameNullSafetyHooks.GUARDED_GETTERS.contains("getFullName"),
        )
    }

    @Test
    fun `hook is installed for ironman and coerces null to empty`() {
        val root = repositoryRoot()

        val ironmanHooks = sourceFile(
            root,
            "hook/module/src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        assertTrue(
            "ContactNameNullSafetyHooks must be installed from IronmanHooks.install()",
            ironmanHooks.contains("ContactNameNullSafetyHooks.install(cl)"),
        )

        val hook = sourceFile(
            root,
            "hook/module/src/main/kotlin/com/penumbraos/hook/ContactNameNullSafetyHooks.kt",
        ).readText()
        // An after-hook that replaces a null getter result with "".
        assertTrue(hook.contains("HookUtils.hookMethodAfter"))
        assertTrue(hook.contains("if (param.result == null)"))
        assertTrue(hook.contains("param.result = \"\""))
        assertTrue(hook.contains("humane.system.contacts.Name"))
    }

    @Test
    fun `pinned stock evidence shows the unguarded crash and the null-safe fullName`() {
        StockReference.requireReviewedApk(
            "ironman.apk",
            "5d60b33eacdc53a35ea8476d36e05f29f6fab22440ef777e44b5d4269e277232",
        )

        val nec = StockReference.decompiled(
            "ironman/sources/humaneinternal/system/concierge/nec/NameEntityCorrector.java",
            "a339e7b5d8ff445b3a9b441da5774a672efb8bd4efb92d5e13800b28db24f6ae",
        ).readText()
        // The exact unguarded dereferences this hook defends. getFullName() is
        // dereferenced too, but it never returns null (proven below), so only the
        // three raw-field getters can throw here.
        assertTrue(nec.contains("!contact.getName().getFirstName().isEmpty()"))
        assertTrue(nec.contains("!contact.getName().getLastName().isEmpty()"))
        assertTrue(nec.contains("!contact.getName().getNickname().isEmpty()"))

        val name = StockReference.decompiled(
            "ironman/sources/humane/system/contacts/Name.java",
            "ed687c70f3acc4b9e8b6dc872754be13371c6ffde93ce41e2fe1542a96cb6020",
        ).readText()
        // The three guarded getters return a raw nullable backing field.
        assertTrue(name.contains("public String getFirstName() {"))
        assertTrue(name.contains("return this.firstName;"))
        assertTrue(name.contains("public String getLastName() {"))
        assertTrue(name.contains("return this.lastName;"))
        assertTrue(name.contains("public String getNickname() {"))
        assertTrue(name.contains("return this.nickname;"))
        // getFullName() delegates to combineNames(), which filters null/empty and
        // therefore never returns null, so it is correctly left unhooked.
        assertTrue(name.contains("return combineNames(getFirstName(), getLastName());"))
        assertTrue(name.contains("return !Strings.isNullOrEmpty(s);"))
    }

    private fun sourceFile(root: File, relativePath: String): File {
        val file = File(root, relativePath)
        assertTrue("Missing source file: $relativePath", file.isFile)
        return file
    }

    private fun repositoryRoot(): File {
        val candidates = listOf(File("."), File(".."), File("../.."))
        return candidates.firstOrNull {
            File(it, "hook/module/src/main/kotlin/com/penumbraos/hook").isDirectory
        } ?: throw AssertionError("Missing repository Hook source directory")
    }
}
