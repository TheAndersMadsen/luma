package com.penumbraos.hook

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneDockAttemptClaimTest {
    @Test
    fun `a boot can atomically claim the standalone runner only once`() {
        val root = Files.createTempDirectory("luma-dock-claim").toFile()
        try {
            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-one"))
            assertFalse(StandaloneDockAttemptClaim.acquire(root, "boot-one"))
            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-two"))

            val claims = root.listFiles().orEmpty().filter(File::isDirectory)
            assertTrue(claims.size == 1)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `unsafe boot identifiers are reduced to fixed path components`() {
        val component = StandaloneDockAttemptClaim.bootComponent("../../private boot id\n")
        assertTrue(component.matches(Regex("[0-9a-f]{32}")))
        assertFalse(component.contains("private"))
    }
}
