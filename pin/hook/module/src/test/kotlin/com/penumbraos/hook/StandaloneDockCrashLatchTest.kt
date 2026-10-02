package com.penumbraos.hook

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneDockCrashLatchTest {
    @Test
    fun `a clean completion clears the current boot latch`() {
        val root = Files.createTempDirectory("luma-dock-crash-latch")
        val latch = root.resolve("pending").toFile()
        try {
            assertEquals(
                StandaloneDockCrashLatchState.CLEAR,
                StandaloneDockCrashLatch.inspect(latch, "boot-one"),
            )
            assertTrue(StandaloneDockCrashLatch.arm(latch, "boot-one"))
            assertEquals(
                StandaloneDockCrashLatchState.CURRENT_BOOT,
                StandaloneDockCrashLatch.inspect(latch, "boot-one"),
            )
            assertTrue(StandaloneDockCrashLatch.clear(latch))
            assertEquals(
                StandaloneDockCrashLatchState.CLEAR,
                StandaloneDockCrashLatch.inspect(latch, "boot-one"),
            )
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun `an interrupted attempt is visible on the next boot`() {
        val root = Files.createTempDirectory("luma-dock-crash-latch")
        val latch = root.resolve("pending").toFile()
        try {
            assertTrue(StandaloneDockCrashLatch.arm(latch, "boot-one"))
            assertEquals(
                StandaloneDockCrashLatchState.PREVIOUS_BOOT,
                StandaloneDockCrashLatch.inspect(latch, "boot-two"),
            )
            assertFalse(StandaloneDockCrashLatch.arm(latch, "boot-two"))
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun `a malformed or linked latch fails closed without touching its target`() {
        val root = Files.createTempDirectory("luma-dock-crash-latch")
        val target = root.resolve("target")
        val latch = root.resolve("pending")
        try {
            Files.write(target, "keep".toByteArray())
            Files.createSymbolicLink(latch, target.fileName)

            assertEquals(
                StandaloneDockCrashLatchState.INVALID,
                StandaloneDockCrashLatch.inspect(latch.toFile(), "boot-one"),
            )
            assertFalse(StandaloneDockCrashLatch.clear(latch.toFile()))
            assertEquals("keep", String(Files.readAllBytes(target)))
        } finally {
            root.toFile().deleteRecursively()
        }
    }
}
