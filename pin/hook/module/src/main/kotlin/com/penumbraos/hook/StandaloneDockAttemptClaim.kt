package com.penumbraos.hook

import java.io.File
import java.security.MessageDigest
import java.nio.file.Files

internal object StandaloneDockAttemptClaim {
    private const val CLAIM_PREFIX = "attempt-"
    private const val CLAIM_SUFFIX = ".lock"
    private const val RETRY_MARKER = ".retry"

    fun bootComponent(bootId: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bootId.toByteArray(Charsets.UTF_8))
            .take(16)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    fun acquire(root: File, bootId: String): Boolean = acquire(root, bootId, 1)

    /**
     * Atomically consumes one runner execution slot for this kernel boot.
     * Execution 1 keeps the directory name the host-side wrapper takes, so
     * the docked-computer path and the on-device runner still share one
     * primary slot; execution 2 is the on-device runner's single guarded
     * retry from [StandaloneDockRetryPolicy]. The kernel exploit is executed
     * at most [StandaloneDockRetryPolicy.MAX_EXECUTIONS_PER_BOOT] times per
     * boot, and a slot once consumed is never given back within its boot.
     */
    fun acquire(root: File, bootId: String, execution: Int): Boolean {
        if (bootId.isBlank()) return false
        if (execution !in 1..StandaloneDockRetryPolicy.MAX_EXECUTIONS_PER_BOOT) return false
        if (root.exists() && (!root.isDirectory || Files.isSymbolicLink(root.toPath()))) return false
        if (!root.exists() && !root.mkdirs()) return false
        root.setReadable(false, false)
        root.setWritable(false, false)
        root.setExecutable(false, false)
        root.setReadable(true, true)
        root.setWritable(true, true)
        root.setExecutable(true, true)

        val component = bootComponent(bootId)
        val primary = "$CLAIM_PREFIX$component$CLAIM_SUFFIX"
        val retry = "$CLAIM_PREFIX$component$RETRY_MARKER$CLAIM_SUFFIX"
        val current = File(root, if (execution == 1) primary else retry)
        if (!current.mkdir()) return false
        current.setReadable(false, false)
        current.setWritable(false, false)
        current.setExecutable(false, false)
        current.setReadable(true, true)
        current.setWritable(true, true)
        current.setExecutable(true, true)

        root.listFiles().orEmpty()
            .filter { candidate ->
                candidate != current &&
                    candidate.name != primary &&
                    candidate.name != retry &&
                    candidate.name.startsWith(CLAIM_PREFIX) &&
                    candidate.name.endsWith(CLAIM_SUFFIX)
            }
            .forEach(File::deleteRecursively)
        return true
    }
}
