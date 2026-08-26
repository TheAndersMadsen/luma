package com.penumbraos.server

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process
import android.os.UserManager
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.util.UUID

/**
 * A deliberately tiny broker loaded into system_server on demand. Package
 * Manager may recreate this app's CE directory during boot, so the durable
 * snapshot lives in system CE storage outside package app-data reconciliation.
 *
 * The call surface accepts no paths or bytes. It can only copy a fixed,
 * validated artifact set between this package's CE files directory and the
 * fixed system-owned vault.
 */
class PersistentConfigVaultProvider : ContentProvider() {

    companion object {
        const val AUTHORITY = "com.penumbraos.server.configvault"
        const val METHOD_RESTORE = "restore"
        const val METHOD_COMMIT = "commit"

        private const val TAG = "PenumbraConfigVault"
        private const val VAULT_ROOT_PATH = "/data/system_ce/0/penumbraos"
        private const val VAULT_FILE_NAME = "config.snapshot"
        private const val STATUS = "status"
        private const val STATUS_ABSENT = "absent"
        private const val STATUS_RESTORED = "restored"
        private const val STATUS_COMMITTED = "committed"
        private const val STATUS_ERROR = "error"
        private const val GENERATION = "generation"
        private const val DIGEST = "digest"
        private const val CONFIG_DIGEST = "config_digest"
        private const val ERROR_KIND = "error_kind"
    }

    private val operationLock = Any()

    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        enforceSystemUidCaller()
        return try {
            requireUserUnlocked()
            synchronized(operationLock) {
                when (method) {
                    METHOD_RESTORE -> restore()
                    METHOD_COMMIT -> commit()
                    else -> throw IllegalArgumentException("Unsupported vault method")
                }
            }
        } catch (security: SecurityException) {
            throw security
        } catch (failure: Throwable) {
            // This provider executes inside system_server. Never allow a vault
            // failure to escape across its component boundary.
            Log.e(TAG, "Vault $method failed (${failure.javaClass.simpleName})")
            Bundle().apply {
                putString(STATUS, STATUS_ERROR)
                putString(ERROR_KIND, failure.javaClass.simpleName)
            }
        }
    }

    private fun restore(): Bundle {
        val vaultFile = File(VAULT_ROOT_PATH, VAULT_FILE_NAME)
        if (!vaultFile.exists() && !Files.isSymbolicLink(vaultFile.toPath())) {
            return Bundle().apply { putString(STATUS, STATUS_ABSENT) }
        }

        val snapshot = readSnapshot(vaultFile)
        val filesDir = credentialFilesDir()
        checkSafeDirectory(filesDir, "credential files")

        // The schema marker is the commit record for the local artifact set.
        // Remove it before replacement and restore it last.
        removeArtifact(File(filesDir, PersistentConfigVaultFormat.SECURITY_SCHEMA_FILE_NAME))
        syncDirectory(filesDir)

        restoreArtifact(
            filesDir,
            PersistentConfigVaultFormat.CONFIG_FILE_NAME,
            checkNotNull(snapshot.files[PersistentConfigVaultFormat.CONFIG_FILE_NAME]),
        )
        restoreOptionalArtifact(
            filesDir,
            PersistentConfigVaultFormat.LOCAL_CONFIG_FILE_NAME,
            snapshot.files[PersistentConfigVaultFormat.LOCAL_CONFIG_FILE_NAME],
        )
        restoreArtifact(
            filesDir,
            PersistentConfigVaultFormat.ESIM_TOKEN_FILE_NAME,
            checkNotNull(snapshot.files[PersistentConfigVaultFormat.ESIM_TOKEN_FILE_NAME]),
        )
        restoreOptionalArtifact(
            filesDir,
            PersistentConfigVaultFormat.SPOTIFY_AUTH_FILE_NAME,
            snapshot.files[PersistentConfigVaultFormat.SPOTIFY_AUTH_FILE_NAME],
        )
        restoreOptionalArtifact(
            filesDir,
            PersistentConfigVaultFormat.ACTIVATION_RECORD_FILE_NAME,
            snapshot.files[PersistentConfigVaultFormat.ACTIVATION_RECORD_FILE_NAME],
        )
        restoreArtifact(
            filesDir,
            PersistentConfigVaultFormat.SECURITY_SCHEMA_FILE_NAME,
            checkNotNull(snapshot.files[PersistentConfigVaultFormat.SECURITY_SCHEMA_FILE_NAME]),
        )

        Log.w(TAG, "Restored credential-encrypted configuration generation ${snapshot.generation}")
        return successBundle(
            STATUS_RESTORED,
            snapshot.generation,
            snapshot.digestHex,
            PersistentConfigVaultFormat.sha256Hex(
                checkNotNull(snapshot.files[PersistentConfigVaultFormat.CONFIG_FILE_NAME]),
            ),
        )
    }

    private fun commit(): Bundle {
        val filesDir = credentialFilesDir()
        checkSafeDirectory(filesDir, "credential files")
        val files = linkedMapOf<String, ByteArray>()
        for (name in PersistentConfigVaultFormat.allowedFiles.sorted()) {
            val file = artifactFile(filesDir, name)
            val required = name == PersistentConfigVaultFormat.CONFIG_FILE_NAME ||
                name == PersistentConfigVaultFormat.SECURITY_SCHEMA_FILE_NAME ||
                name == PersistentConfigVaultFormat.ESIM_TOKEN_FILE_NAME
            val bytes = readArtifact(file, required)
            if (bytes != null) files[name] = bytes
        }

        val root = ensureVaultRoot()
        val vaultFile = File(root, VAULT_FILE_NAME)
        val previous = if (vaultFile.exists() || Files.isSymbolicLink(vaultFile.toPath())) {
            readSnapshot(vaultFile)
        } else {
            null
        }
        val configDigest = PersistentConfigVaultFormat.sha256Hex(
            checkNotNull(files[PersistentConfigVaultFormat.CONFIG_FILE_NAME]),
        )
        if (previous != null && sameArtifacts(previous.files, files)) {
            return successBundle(
                STATUS_COMMITTED,
                previous.generation,
                previous.digestHex,
                configDigest,
            )
        }
        val previousGeneration = previous?.generation ?: 0L
        check(previousGeneration < Long.MAX_VALUE) { "Vault generation exhausted" }
        val generation = previousGeneration + 1
        val encoded = PersistentConfigVaultFormat.encode(generation, files)
        writeAtomic(vaultFile, encoded.bytes)
        syncDirectory(root)

        Log.w(TAG, "Committed credential-encrypted configuration generation $generation")
        return successBundle(STATUS_COMMITTED, generation, encoded.digestHex, configDigest)
    }

    private fun sameArtifacts(
        first: Map<String, ByteArray>,
        second: Map<String, ByteArray>,
    ): Boolean = first.keys == second.keys && first.keys.all { name ->
        first[name]?.contentEquals(second[name]) == true
    }

    private fun credentialFilesDir(): File {
        val providerContext = checkNotNull(context) { "Provider context unavailable" }
        // This provider is explicitly not direct-boot-aware, so its ordinary
        // package context is credential protected.
        return providerContext.filesDir
    }

    private fun artifactFile(filesDir: File, name: String): File = File(filesDir, name)

    private fun requireUserUnlocked() {
        val providerContext = checkNotNull(context) { "Provider context unavailable" }
        val userManager = providerContext.getSystemService(UserManager::class.java)
        check(userManager?.isUserUnlocked == true) { "Credential-encrypted storage is locked" }
    }

    private fun ensureVaultRoot(): File {
        val root = File(VAULT_ROOT_PATH)
        if (root.exists() || Files.isSymbolicLink(root.toPath())) {
            checkSafeDirectory(root, "vault")
        } else {
            val parent = checkNotNull(root.parentFile)
            checkSafeDirectory(parent, "vault parent")
            Files.createDirectory(root.toPath())
            Os.chmod(root.absolutePath, 0b111000000)
            syncDirectory(parent)
        }
        Os.chmod(root.absolutePath, 0b111000000)
        return root
    }

    private fun checkSafeDirectory(directory: File, label: String) {
        check(!Files.isSymbolicLink(directory.toPath()) && directory.isDirectory) {
            "Invalid $label directory"
        }
    }

    private fun readSnapshot(file: File): PersistentConfigVaultFormat.Snapshot {
        val bytes = readBoundedRegularFile(
            file,
            PersistentConfigVaultFormat.MAX_BUNDLE_BYTES,
            required = true,
        )
        return PersistentConfigVaultFormat.decode(checkNotNull(bytes))
    }

    private fun readArtifact(file: File, required: Boolean): ByteArray? =
        readBoundedRegularFile(file, PersistentConfigVaultFormat.MAX_ARTIFACT_BYTES, required)

    private fun readBoundedRegularFile(file: File, limit: Int, required: Boolean): ByteArray? {
        val path = file.toPath()
        if (!file.exists() && !Files.isSymbolicLink(path)) {
            check(!required) { "Required vault artifact unavailable" }
            return null
        }
        check(!Files.isSymbolicLink(path)) { "Refusing symbolic-link vault artifact" }
        val attributes = Files.readAttributes(
            path,
            java.nio.file.attribute.BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        check(attributes.isRegularFile && attributes.size() in 0..limit.toLong()) {
            "Invalid vault artifact"
        }
        val bytes = Files.readAllBytes(path)
        check(bytes.size <= limit) { "Vault artifact exceeds size limit" }
        return bytes
    }

    private fun restoreOptionalArtifact(filesDir: File, name: String, bytes: ByteArray?) {
        if (bytes == null) {
            removeArtifact(File(filesDir, name))
            syncDirectory(filesDir)
        } else {
            restoreArtifact(filesDir, name, bytes)
        }
    }

    private fun restoreArtifact(filesDir: File, name: String, bytes: ByteArray) {
        check(name in PersistentConfigVaultFormat.allowedFiles) { "Invalid restore artifact" }
        writeAtomic(File(filesDir, name), bytes)
        syncDirectory(filesDir)
    }

    private fun removeArtifact(file: File) {
        check(!Files.isSymbolicLink(file.toPath())) { "Refusing symbolic-link restore target" }
        if (file.exists()) check(file.delete()) { "Failed to remove restore artifact" }
    }

    private fun writeAtomic(destination: File, bytes: ByteArray) {
        val parent = checkNotNull(destination.parentFile)
        checkSafeDirectory(parent, "artifact parent")
        check(!Files.isSymbolicLink(destination.toPath())) { "Refusing symbolic-link destination" }
        val temporary = File(parent, ".${destination.name}.${UUID.randomUUID()}.tmp")
        check(temporary.createNewFile()) { "Failed to create vault temp file" }
        try {
            Os.chmod(temporary.absolutePath, 0b110000000)
            FileOutputStream(temporary, false).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            try {
                Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
            Os.chmod(destination.absolutePath, 0b110000000)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun syncDirectory(directory: File) {
        val descriptor = Os.open(
            directory.absolutePath,
            OsConstants.O_RDONLY or OsConstants.O_CLOEXEC,
            0,
        )
        try {
            Os.fsync(descriptor)
        } finally {
            Os.close(descriptor)
        }
    }

    private fun enforceSystemUidCaller() {
        if (Binder.getCallingUid() != Process.SYSTEM_UID) {
            throw SecurityException("Config vault is restricted to the Android system UID")
        }
    }

    private fun successBundle(
        status: String,
        generation: Long,
        digest: String,
        configDigest: String,
    ): Bundle =
        Bundle().apply {
            putString(STATUS, status)
            putLong(GENERATION, generation)
            putString(DIGEST, digest)
            putString(CONFIG_DIGEST, configDigest)
        }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0
}
