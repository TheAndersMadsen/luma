package com.penumbraos.server

import android.database.sqlite.SQLiteDatabase
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption

internal object DatabaseStorage {

    private const val TAG = "PenumbraServer"
    private const val MIGRATION_VERSION = "2"
    private const val MIGRATION_STATE_FILE_NAME = ".database-migration"
    private const val IROH_SECRET_FILE_NAME = "iroh_secret.key"
    private const val MAX_DATABASE_BYTES = 256L * 1024L * 1024L
    private const val MAX_WAL_BYTES = 256L * 1024L * 1024L
    private const val MAX_IROH_SECRET_BYTES = 4L * 1024L
    private const val COMPLETE_STATE = "version=$MIGRATION_VERSION\nstate=complete\n"
    private const val PENDING_STATE = "version=$MIGRATION_VERSION\nstate=pending\n"

    internal fun migrationStateFile(privateDatabase: File): File =
        File(checkNotNull(privateDatabase.parentFile), MIGRATION_STATE_FILE_NAME)

    internal fun migrationIsComplete(privateDatabase: File): Boolean {
        val stateFile = migrationStateFile(privateDatabase)
        checkNotSymbolicLink(stateFile, "database migration state")
        return stateFile.isFile && stateFile.readText() == COMPLETE_STATE
    }

    /**
     * Copies a quiescent SQLite database and its WAL into durable staging.
     * The pending marker makes a crash between the independent file renames
     * recoverable without ever accepting a database that is missing WAL data.
     */
    internal fun migrateLegacyDatabase(
        legacyDatabase: File,
        privateDatabase: File,
        validateDatabase: (File) -> Unit = ::validateSQLiteDatabase,
    ): Boolean {
        val stateFile = migrationStateFile(privateDatabase)
        val privateParent = checkNotNull(privateDatabase.parentFile)
        check(privateParent.exists() || privateParent.mkdirs()) {
            "Failed to create app-private database directory"
        }
        check(!Files.isSymbolicLink(privateParent.toPath()) && privateParent.isDirectory) {
            "Invalid app-private database directory"
        }
        checkNotSymbolicLink(stateFile, "database migration state")

        if (stateFile.isFile && stateFile.readText() == COMPLETE_STATE) {
            // Rust replaces this plaintext staging file with SQLCipher after
            // validation. Platform SQLite must never try to open it again.
            checkSafeRegularFile(privateDatabase, MAX_DATABASE_BYTES, "durable database")
            return false
        }

        checkSafeRegularFile(legacyDatabase, MAX_DATABASE_BYTES, "legacy database")
        val legacyWal = File(legacyDatabase.parentFile, "${legacyDatabase.name}-wal")
        val legacyIrohSecret = File(legacyDatabase.parentFile, IROH_SECRET_FILE_NAME)
        val privateWal = File(privateParent, "${privateDatabase.name}-wal")
        val privateShm = File(privateParent, "${privateDatabase.name}-shm")
        val privateIrohSecret = File(privateParent, IROH_SECRET_FILE_NAME)
        val stagedDatabase = File(privateParent, ".${privateDatabase.name}.migrating")
        val stagedWal = File(privateParent, ".${privateDatabase.name}-wal.migrating")
        val stagedIrohSecret = File(privateParent, ".$IROH_SECRET_FILE_NAME.migrating")

        if (stateFile.isFile) {
            check(stateFile.readText() == PENDING_STATE) { "Invalid database migration state" }
            removePrivateArtifact(privateDatabase)
            removePrivateArtifact(privateWal)
            removePrivateArtifact(privateShm)
            removePrivateArtifact(privateIrohSecret)
        } else {
            check(!privateDatabase.exists()) {
                "Refusing to overwrite an app-private database without migration state"
            }
            writeAtomic(stateFile, PENDING_STATE.toByteArray(StandardCharsets.US_ASCII))
        }

        listOf(stagedDatabase, stagedWal, stagedIrohSecret).forEach(::removePrivateArtifact)
        try {
            copyRegularFile(legacyDatabase, stagedDatabase, MAX_DATABASE_BYTES, "legacy database")
            if (legacyWal.exists() || Files.isSymbolicLink(legacyWal.toPath())) {
                copyRegularFile(legacyWal, stagedWal, MAX_WAL_BYTES, "legacy database WAL")
            }
            if (legacyIrohSecret.exists() || Files.isSymbolicLink(legacyIrohSecret.toPath())) {
                copyRegularFile(
                    legacyIrohSecret,
                    stagedIrohSecret,
                    MAX_IROH_SECRET_BYTES,
                    "legacy Iroh identity",
                )
            }

            moveAtomic(stagedDatabase, privateDatabase)
            if (stagedWal.exists()) moveAtomic(stagedWal, privateWal)
            if (stagedIrohSecret.exists()) moveAtomic(stagedIrohSecret, privateIrohSecret)
            restrictOwnerOnly(privateDatabase)
            if (privateWal.exists()) restrictOwnerOnly(privateWal)
            if (privateIrohSecret.exists()) restrictOwnerOnly(privateIrohSecret)

            validateDatabase(privateDatabase)
            writeAtomic(stateFile, COMPLETE_STATE.toByteArray(StandardCharsets.US_ASCII))
            return true
        } finally {
            listOf(stagedDatabase, stagedWal, stagedIrohSecret).forEach(::removePrivateArtifact)
        }
    }

    internal fun retireLegacyDatabase(legacyDatabase: File) {
        val parent = legacyDatabase.parentFile ?: return
        listOf(
            legacyDatabase,
            File(parent, "${legacyDatabase.name}-wal"),
            File(parent, "${legacyDatabase.name}-shm"),
            File(parent, IROH_SECRET_FILE_NAME),
        ).forEach(::retireLegacyArtifact)
    }

    private fun validateSQLiteDatabase(databaseFile: File) {
        val database = SQLiteDatabase.openDatabase(
            databaseFile.absolutePath,
            null,
            SQLiteDatabase.OPEN_READWRITE,
        )
        try {
            database.rawQuery("PRAGMA quick_check", null).use { cursor ->
                check(cursor.moveToFirst() && cursor.getString(0) == "ok" && !cursor.moveToNext()) {
                    "Migrated database failed SQLite quick_check"
                }
            }
            database.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null).use { cursor ->
                check(cursor.moveToFirst() && cursor.getInt(0) == 0) {
                    "Migrated database WAL checkpoint failed"
                }
            }
        } finally {
            database.close()
        }
    }

    private fun copyRegularFile(source: File, destination: File, limit: Long, label: String) {
        checkSafeRegularFile(source, limit, label)
        checkNotSymbolicLink(destination, "staged database artifact")
        FileOutputStream(destination, false).use { output ->
            source.inputStream().buffered().use { input -> input.copyTo(output) }
            output.fd.sync()
        }
        restrictOwnerOnly(destination)
    }

    private fun checkSafeRegularFile(file: File, limit: Long, label: String) {
        checkNotSymbolicLink(file, label)
        val attributes = Files.readAttributes(
            file.toPath(),
            java.nio.file.attribute.BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        check(attributes.isRegularFile && attributes.size() in 1..limit) { "Invalid $label" }
    }

    private fun checkNotSymbolicLink(file: File, label: String) {
        check(!Files.isSymbolicLink(file.toPath())) { "Refusing symbolic-link $label" }
    }

    private fun writeAtomic(destination: File, bytes: ByteArray) {
        val parent = checkNotNull(destination.parentFile)
        val temporary = File(parent, ".${destination.name}.tmp")
        checkNotSymbolicLink(destination, "database migration state")
        checkNotSymbolicLink(temporary, "database migration temp file")
        try {
            FileOutputStream(temporary, false).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            restrictOwnerOnly(temporary)
            moveAtomic(temporary, destination)
            restrictOwnerOnly(destination)
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun moveAtomic(source: File, destination: File) {
        try {
            Files.move(
                source.toPath(),
                destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(
                source.toPath(),
                destination.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
            )
        }
    }

    private fun restrictOwnerOnly(file: File) {
        file.setReadable(false, false)
        file.setWritable(false, false)
        check(file.setReadable(true, true) && file.setWritable(true, true)) {
            "Failed to restrict app-private database artifact"
        }
    }

    private fun removePrivateArtifact(file: File) {
        if (!file.exists() && !Files.isSymbolicLink(file.toPath())) return
        checkNotSymbolicLink(file, "app-private database artifact")
        check(file.isFile && file.delete()) { "Failed to remove app-private database artifact" }
    }

    private fun retireLegacyArtifact(file: File) {
        try {
            if (!file.exists() && !Files.isSymbolicLink(file.toPath())) return
            if (Files.isSymbolicLink(file.toPath())) {
                file.delete()
                return
            }
            if (file.isFile) {
                FileOutputStream(file, false).use { output ->
                    output.write("Retired app-private database artifact.\n".toByteArray())
                    output.fd.sync()
                }
            }
            file.delete()
        } catch (failure: Throwable) {
            // Shared storage is no longer authoritative after the validated
            // app-private copy, so provider-specific deletion failures are safe.
            Log.w(TAG, "Failed to retire legacy database artifact (${failure.javaClass.simpleName})")
        }
    }
}
