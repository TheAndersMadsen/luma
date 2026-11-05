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

    @Test
    fun `a boot exposes one primary and one retry claim slot`() {
        val root = Files.createTempDirectory("luma-dock-claim").toFile()
        try {
            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-one", 1))
            assertFalse(StandaloneDockAttemptClaim.acquire(root, "boot-one", 1))
            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-one", 2))
            assertFalse(StandaloneDockAttemptClaim.acquire(root, "boot-one", 2))

            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-two", 1))
            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-two", 2))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `the retry slot keeps the host-side primary slot name untouched`() {
        val root = Files.createTempDirectory("luma-dock-claim").toFile()
        try {
            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-one", 1))
            val component = StandaloneDockAttemptClaim.bootComponent("boot-one")
            assertTrue(File(root, "attempt-$component.lock").isDirectory)
            assertFalse(File(root, "attempt-$component.retry.lock").exists())

            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-one", 2))
            assertTrue(File(root, "attempt-$component.retry.lock").isDirectory)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `sweeping stale boots keeps both slots of the claiming boot`() {
        val root = Files.createTempDirectory("luma-dock-claim").toFile()
        try {
            val stale = File(root, "attempt-${"1".repeat(32)}.lock")
            assertTrue(stale.mkdirs())
            val component = StandaloneDockAttemptClaim.bootComponent("boot-one")
            val livePrimary = File(root, "attempt-$component.lock")
            val liveRetry = File(root, "attempt-$component.retry.lock")

            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-one", 1))
            assertTrue(livePrimary.isDirectory)
            assertTrue(StandaloneDockAttemptClaim.acquire(root, "boot-one", 2))
            assertTrue(livePrimary.isDirectory)
            assertTrue(liveRetry.isDirectory)
            assertFalse(stale.exists())
        } finally {
            root.deleteRecursively()
        }
    }
}
