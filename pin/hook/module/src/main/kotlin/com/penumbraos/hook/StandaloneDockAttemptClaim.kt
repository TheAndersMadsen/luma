package com.penumbraos.hook

import java.io.File
import java.security.MessageDigest
import java.nio.file.Files

internal object StandaloneDockAttemptClaim {
    private const val CLAIM_PREFIX = "attempt-"

    fun bootComponent(bootId: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bootId.toByteArray(Charsets.UTF_8))
            .take(16)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    /**
     * Atomically consumes one runner opportunity for this kernel boot. A
     * benign preflight failure still settles the boot. The kernel exploit is
     * never retried until the boot ID changes.
     */
    fun acquire(root: File, bootId: String): Boolean {
        if (bootId.isBlank()) return false
        if (root.exists() && (!root.isDirectory || Files.isSymbolicLink(root.toPath()))) return false
        if (!root.exists() && !root.mkdirs()) return false
        root.setReadable(false, false)
        root.setWritable(false, false)
        root.setExecutable(false, false)
        root.setReadable(true, true)
        root.setWritable(true, true)
        root.setExecutable(true, true)

        val current = File(root, "$CLAIM_PREFIX${bootComponent(bootId)}.lock")
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
                    candidate.name.startsWith(CLAIM_PREFIX) &&
                    candidate.name.endsWith(".lock")
            }
            .forEach(File::deleteRecursively)
        return true
    }
}
