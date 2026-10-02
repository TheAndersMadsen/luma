package com.penumbraos.hook

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files

internal enum class StandaloneDockCrashLatchState {
    CLEAR,
    CURRENT_BOOT,
    PREVIOUS_BOOT,
    INVALID,
}

/**
 * A durable marker that distinguishes a normal boot from a reboot caused
 * while Ghostlock was changing kernel state. A stale marker disables the
 * feature before another attempt can turn one failed run into a reboot loop.
 */
internal object StandaloneDockCrashLatch {
    private val componentPattern = Regex("[0-9a-f]{32}")

    fun inspect(latch: File, bootId: String): StandaloneDockCrashLatchState {
        if (bootId.isBlank()) return StandaloneDockCrashLatchState.INVALID
        if (!latch.exists()) {
            return if (Files.isSymbolicLink(latch.toPath())) {
                StandaloneDockCrashLatchState.INVALID
            } else {
                StandaloneDockCrashLatchState.CLEAR
            }
        }
        if (
            !latch.isFile ||
            Files.isSymbolicLink(latch.toPath()) ||
            latch.length() !in 1..64
        ) {
            return StandaloneDockCrashLatchState.INVALID
        }
        val observed = runCatching { latch.readText().trim() }.getOrNull()
            ?.takeIf(componentPattern::matches)
            ?: return StandaloneDockCrashLatchState.INVALID
        return if (observed == StandaloneDockAttemptClaim.bootComponent(bootId)) {
            StandaloneDockCrashLatchState.CURRENT_BOOT
        } else {
            StandaloneDockCrashLatchState.PREVIOUS_BOOT
        }
    }

    fun arm(latch: File, bootId: String): Boolean {
        if (bootId.isBlank() || latch.exists() || Files.isSymbolicLink(latch.toPath())) {
            return false
        }
        val parent = latch.parentFile
        if (parent == null || !parent.isDirectory || Files.isSymbolicLink(parent.toPath())) {
            return false
        }
        if (!latch.createNewFile()) return false
        return try {
            privateFile(latch)
            FileOutputStream(latch, false).use { output ->
                output.write(
                    "${StandaloneDockAttemptClaim.bootComponent(bootId)}\n"
                        .toByteArray(Charsets.UTF_8),
                )
                output.flush()
                output.fd.sync()
            }
            inspect(latch, bootId) == StandaloneDockCrashLatchState.CURRENT_BOOT
        } catch (_: Throwable) {
            clear(latch)
            false
        }
    }

    fun clear(latch: File): Boolean {
        if (!latch.exists()) return !Files.isSymbolicLink(latch.toPath())
        if (!latch.isFile || Files.isSymbolicLink(latch.toPath())) return false
        return latch.delete()
    }

    private fun privateFile(file: File) {
        file.setReadable(false, false)
        file.setWritable(false, false)
        file.setExecutable(false, false)
        file.setReadable(true, true)
        file.setWritable(true, true)
    }
}
