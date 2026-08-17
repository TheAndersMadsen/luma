package com.penumbraos.server

import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files

internal object LogStorage {

    private const val TAG = "PenumbraServer"
    private val managedPrefixes = listOf("humane-server.", "llm-requests.")

    internal fun retireLegacyLogs(legacyLogDir: File) {
        if (!legacyLogDir.exists() && !Files.isSymbolicLink(legacyLogDir.toPath())) return
        if (Files.isSymbolicLink(legacyLogDir.toPath()) || !legacyLogDir.isDirectory) {
            Log.w(TAG, "Refusing invalid legacy log directory")
            return
        }

        legacyLogDir.listFiles()?.forEach { file ->
            if (managedPrefixes.none { prefix -> file.name.startsWith(prefix) }) return@forEach
            retireManagedLog(file)
        }
        legacyLogDir.delete()
    }

    private fun retireManagedLog(file: File) {
        try {
            if (Files.isSymbolicLink(file.toPath())) {
                file.delete()
                return
            }
            if (!file.isFile) return
            FileOutputStream(file, false).use { output ->
                output.write("Retired app-private log artifact.\n".toByteArray())
                output.fd.sync()
            }
            file.delete()
        } catch (failure: Throwable) {
            Log.w(TAG, "Failed to retire legacy log artifact (${failure.javaClass.simpleName})")
        }
    }
}
