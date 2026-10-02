package com.penumbraos.server

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

internal data class FitnessImportSource(
    val filename: String,
    val expectedSizeBytes: Long,
    val input: InputStream,
)

internal data class FitnessRetentionPolicy(
    val maxSessions: Int = FitnessBridgeProtocol.MAX_STORED_SESSIONS,
    val maxTotalBytes: Long = FitnessBridgeProtocol.MAX_STORED_BYTES,
    val maxAgeMs: Long = FitnessBridgeProtocol.MAX_SESSION_AGE_MS,
)

/** App-private, atomic fitness-session importer used only by the Binder bridge. */
internal class FitnessHistoryRepository(
    private val root: File,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val retention: FitnessRetentionPolicy = FitnessRetentionPolicy(),
    private val stagingId: () -> String = { UUID.randomUUID().toString() },
) {
    private val rootState = stateFor(root)

    fun importSession(
        declaration: FitnessBridgeProtocol.ExportDeclaration,
        sources: List<FitnessImportSource>,
    ): Boolean {
        var staging: File? = null
        var stagingCreated = false
        var activeStagingPath: Path? = null
        var activeStagingRegistered = false
        try {
            FitnessBridgeProtocol.validateExport(declaration)
            val sourceFilenames = sources.map(FitnessImportSource::filename)
            require(sourceFilenames.size == declaration.files.size &&
                sourceFilenames.toSet() ==
                declaration.files.map(FitnessBridgeProtocol.FileDeclaration::filename).toSet()) {
                "Fitness source set does not match declaration"
            }
            val finalDirectory: File
            synchronized(rootState.retentionLock) {
                prepareRoot()
                finalDirectory = directSessionDirectory(declaration.sessionId)
                if (finalDirectory.exists()) {
                    check(publishedSessionMatches(finalDirectory, declaration)) {
                        "Existing fitness session is incomplete or does not match its declaration"
                    }
                    return true
                }
            }

            val suffix = FitnessBridgeProtocol.requireCanonicalSessionId(stagingId())
            val stagingDirectory = File(root, ".incoming-${declaration.sessionId}-$suffix")
            staging = stagingDirectory
            require(stagingDirectory.parentFile?.canonicalFile == root.canonicalFile) {
                "Fitness staging path escaped history root"
            }
            require(!Files.isSymbolicLink(stagingDirectory.toPath())) { "Fitness staging path is a symlink" }
            val stagingPath = stagingKey(stagingDirectory)
            activeStagingPath = stagingPath
            synchronized(rootState.retentionLock) {
                check(rootState.activeStaging.add(stagingPath)) {
                    "Fitness staging path is already active"
                }
                activeStagingRegistered = true
                check(stagingDirectory.mkdir()) { "Failed to create fitness staging directory" }
                stagingCreated = true
            }

            val declared = declaration.files.associateBy { it.filename }
            sources.forEach { source ->
                val expected = checkNotNull(declared[source.filename])
                require(source.expectedSizeBytes == expected.sizeBytes) {
                    "Fitness source size does not match declaration"
                }
                copyExact(stagingDirectory, source, FitnessBridgeProtocol.maxBytesFor(source.filename))
            }
            writeManifest(stagingDirectory, declaration)
            synchronized(rootState.retentionLock) {
                moveDirectory(stagingDirectory, finalDirectory)
            }
            applyRetention()
            return true
        } finally {
            sources.forEach { runCatching { it.input.close() } }
            try {
                if (stagingCreated && staging?.let(::existsNoFollow) == true) {
                    deleteTreeNoFollow(checkNotNull(staging).toPath())
                }
            } finally {
                activeStagingPath?.takeIf { activeStagingRegistered }?.let { path ->
                    synchronized(rootState.retentionLock) {
                        rootState.activeStaging.remove(path)
                    }
                }
            }
        }
    }

    internal fun applyRetention() = synchronized(rootState.retentionLock) {
        prepareRoot()
        val now = nowMs()
        val children = root.listFiles().orEmpty()
        val sessions = children
            .filter(::isDirectSessionDirectory)
            .mapNotNull { directory ->
                val stopped = readStoppedAt(directory) ?: return@mapNotNull null
                StoredDirectory(directory, stopped, directorySize(directory))
            }
        val staging = children
            .filter(::isDirectCrashStagingDirectory)
            .filterNot { rootState.activeStaging.contains(stagingKey(it)) }
            .mapNotNull(::crashStagingDirectory)
        val retained = (sessions + staging)
            .sortedByDescending(StoredDirectory::retentionTimestampMs)
            .toMutableList()

        retained.filter { now - it.retentionTimestampMs > retention.maxAgeMs }.forEach { old ->
            deleteTreeNoFollow(old.directory.toPath())
            retained.remove(old)
        }

        var total = retained.sumOf(StoredDirectory::sizeBytes)
        while (retained.size > retention.maxSessions || total > retention.maxTotalBytes) {
            val oldest = retained.removeLastOrNull() ?: break
            deleteTreeNoFollow(oldest.directory.toPath())
            total -= oldest.sizeBytes
        }
    }

    private fun prepareRoot() {
        require(!Files.isSymbolicLink(root.toPath())) { "Fitness history root is a symlink" }
        check(root.exists() || root.mkdirs()) { "Failed to create fitness history root" }
        check(root.isDirectory) { "Fitness history root is not a directory" }
    }

    private fun directSessionDirectory(sessionId: String): File {
        FitnessBridgeProtocol.requireCanonicalSessionId(sessionId)
        val candidate = File(root, sessionId)
        require(candidate.parentFile?.canonicalFile == root.canonicalFile) {
            "Fitness session escaped history root"
        }
        require(!Files.isSymbolicLink(candidate.toPath())) { "Fitness session path is a symlink" }
        return candidate
    }

    private fun publishedSessionMatches(
        directory: File,
        declaration: FitnessBridgeProtocol.ExportDeclaration,
    ): Boolean = runCatching {
        if (!directory.isDirectory || Files.isSymbolicLink(directory.toPath())) return@runCatching false
        if (directory.parentFile?.canonicalFile != root.canonicalFile) return@runCatching false

        val expectedNames = declaration.files.mapTo(mutableSetOf()) { it.filename }
        expectedNames += FitnessBridgeProtocol.MANIFEST_FILENAME
        val children = directory.listFiles() ?: return@runCatching false
        if (children.map(File::getName).toSet() != expectedNames || children.size != expectedNames.size) {
            return@runCatching false
        }

        declaration.files.forEach { declared ->
            val file = File(directory, declared.filename)
            if (!file.isFile || Files.isSymbolicLink(file.toPath()) ||
                file.parentFile?.canonicalFile != directory.canonicalFile ||
                file.length() != declared.sizeBytes
            ) return@runCatching false
        }

        val manifestFile = File(directory, FitnessBridgeProtocol.MANIFEST_FILENAME)
        if (!manifestFile.isFile || Files.isSymbolicLink(manifestFile.toPath()) ||
            manifestFile.length() !in 1..MAX_MANIFEST_BYTES
        ) return@runCatching false
        val manifest = JSONObject(manifestFile.readText(StandardCharsets.UTF_8))
        if (jsonKeys(manifest) != MANIFEST_KEYS ||
            manifest.getInt("version") != 1 ||
            manifest.getString("session_id") != declaration.sessionId ||
            manifest.getLong("started_at_ms") != declaration.startedAtMs ||
            manifest.getLong("stopped_at_ms") != declaration.stoppedAtMs
        ) return@runCatching false

        val declaredByName = declaration.files.associateBy { it.filename }
        val seen = mutableSetOf<String>()
        val files = manifest.getJSONArray("files")
        if (files.length() != declaredByName.size) return@runCatching false
        repeat(files.length()) { index ->
            val item = files.getJSONObject(index)
            if (jsonKeys(item) != MANIFEST_FILE_KEYS) return@runCatching false
            val filename = item.getString("filename")
            val expected = declaredByName[filename] ?: return@runCatching false
            if (!seen.add(filename) || item.getLong("size_bytes") != expected.sizeBytes) {
                return@runCatching false
            }
        }
        seen == declaredByName.keys
    }.getOrDefault(false)

    private fun copyExact(staging: File, source: FitnessImportSource, maxBytes: Long) {
        require(source.filename in FitnessBridgeProtocol.ALLOWED_FILENAMES)
        val outputFile = File(staging, source.filename)
        require(outputFile.parentFile?.canonicalFile == staging.canonicalFile)
        require(!Files.isSymbolicLink(outputFile.toPath())) { "Fitness output path is a symlink" }
        var copied = 0L
        FileOutputStream(outputFile, false).use { output ->
            source.input.use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    copied = Math.addExact(copied, read.toLong())
                    require(copied <= maxBytes && copied <= source.expectedSizeBytes) {
                        "Fitness file exceeds its declared limit"
                    }
                    output.write(buffer, 0, read)
                }
            }
            require(copied == source.expectedSizeBytes) { "Fitness file ended early" }
            output.fd.sync()
        }
        restrictToOwner(outputFile)
    }

    private fun writeManifest(
        staging: File,
        declaration: FitnessBridgeProtocol.ExportDeclaration,
    ) {
        val manifest = JSONObject()
            .put("version", 1)
            .put("session_id", declaration.sessionId)
            .put("started_at_ms", declaration.startedAtMs)
            .put("stopped_at_ms", declaration.stoppedAtMs)
            .put(
                "files",
                JSONArray().apply {
                    declaration.files.sortedBy { it.filename }.forEach { file ->
                        put(
                            JSONObject()
                                .put("filename", file.filename)
                                .put("size_bytes", file.sizeBytes),
                        )
                    }
                },
            )
        val file = File(staging, FitnessBridgeProtocol.MANIFEST_FILENAME)
        FileOutputStream(file, false).use { output ->
            output.write(manifest.toString().toByteArray(StandardCharsets.UTF_8))
            output.fd.sync()
        }
        restrictToOwner(file)
    }

    private fun moveDirectory(source: File, target: File) {
        require(!target.exists()) { "Fitness session already exists" }
        try {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(source.toPath(), target.toPath())
        }
    }

    private fun readStoppedAt(directory: File): Long? {
        val manifest = File(directory, FitnessBridgeProtocol.MANIFEST_FILENAME)
        if (!manifest.isFile || Files.isSymbolicLink(manifest.toPath()) ||
            manifest.length() !in 1..MAX_MANIFEST_BYTES
        ) return null
        return runCatching {
            JSONObject(manifest.readText(StandardCharsets.UTF_8)).getLong("stopped_at_ms")
        }.getOrNull()?.takeIf { it > 0 }
    }

    private fun isDirectSessionDirectory(directory: File): Boolean =
        directory.isDirectory &&
            !Files.isSymbolicLink(directory.toPath()) &&
            runCatching {
                FitnessBridgeProtocol.requireCanonicalSessionId(directory.name)
                directory.parentFile?.canonicalFile == root.canonicalFile
            }.getOrDefault(false)

    private fun isDirectCrashStagingDirectory(directory: File): Boolean =
        Files.isDirectory(directory.toPath(), LinkOption.NOFOLLOW_LINKS) &&
            !Files.isSymbolicLink(directory.toPath()) &&
            isCanonicalStagingName(directory.name) &&
            runCatching { directory.parentFile?.canonicalFile == root.canonicalFile }.getOrDefault(false)

    private fun crashStagingDirectory(directory: File): StoredDirectory? {
        val size = runCatching { directorySize(directory) }.getOrElse {
            runCatching { deleteTreeNoFollow(directory.toPath()) }
            return null
        }
        return StoredDirectory(directory, directory.lastModified(), size)
    }

    private fun isCanonicalStagingName(name: String): Boolean {
        if (!name.startsWith(INCOMING_PREFIX)) return false
        val value = name.removePrefix(INCOMING_PREFIX)
        if (value.length != UUID_TEXT_LENGTH * 2 + 1 || value[UUID_TEXT_LENGTH] != '-') return false
        val sessionId = value.substring(0, UUID_TEXT_LENGTH)
        val nonce = value.substring(UUID_TEXT_LENGTH + 1)
        return runCatching {
            FitnessBridgeProtocol.requireCanonicalSessionId(sessionId)
            FitnessBridgeProtocol.requireCanonicalSessionId(nonce)
        }.isSuccess
    }

    private fun stagingKey(directory: File): Path = directory.absoluteFile.toPath().normalize()

    private fun jsonKeys(value: JSONObject): Set<String> {
        val result = mutableSetOf<String>()
        val iterator = value.keys()
        while (iterator.hasNext()) result += iterator.next()
        return result
    }

    private fun existsNoFollow(directory: File): Boolean =
        Files.exists(directory.toPath(), LinkOption.NOFOLLOW_LINKS)

    private fun directorySize(directory: File): Long {
        var total = 0L
        Files.walkFileTree(directory.toPath(), object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                if (!Files.isSymbolicLink(file)) total = Math.addExact(total, attrs.size())
                return FileVisitResult.CONTINUE
            }
        })
        return total
    }

    private fun deleteTreeNoFollow(path: Path) {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
        Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.deleteIfExists(file)
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(directory: Path, error: java.io.IOException?): FileVisitResult {
                if (error != null) throw error
                Files.deleteIfExists(directory)
                return FileVisitResult.CONTINUE
            }
        })
    }

    private fun restrictToOwner(file: File) {
        file.setReadable(false, false)
        file.setWritable(false, false)
        check(file.setReadable(true, true) && file.setWritable(true, true)) {
            "Failed to restrict fitness history permissions"
        }
    }

    private data class StoredDirectory(
        val directory: File,
        val retentionTimestampMs: Long,
        val sizeBytes: Long,
    )

    private class RootState {
        val retentionLock = Any()
        val activeStaging = mutableSetOf<Path>()
    }

    private companion object {
        const val MAX_MANIFEST_BYTES = 16L * 1024
        const val INCOMING_PREFIX = ".incoming-"
        const val UUID_TEXT_LENGTH = 36
        val MANIFEST_KEYS = setOf("version", "session_id", "started_at_ms", "stopped_at_ms", "files")
        val MANIFEST_FILE_KEYS = setOf("filename", "size_bytes")
        val ROOT_STATES = ConcurrentHashMap<Path, RootState>()

        fun stateFor(root: File): RootState {
            val key = root.absoluteFile.toPath().normalize()
            return ROOT_STATES.computeIfAbsent(key) { RootState() }
        }
    }
}

internal const val FITNESS_HISTORY_DIRECTORY = "fitness-history"

/** Normal boot maintenance for crash-left imports. Callers decide how to log failures. */
internal fun runFitnessHistoryRetentionMaintenance(filesDir: File) {
    FitnessHistoryRepository(File(filesDir, FITNESS_HISTORY_DIRECTORY)).applyRetention()
}
