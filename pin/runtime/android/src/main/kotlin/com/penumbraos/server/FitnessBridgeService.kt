package com.penumbraos.server

import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import android.os.ParcelFileDescriptor
import android.os.Parcelable
import android.util.Log
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * Explicit, UID-and-process-authenticated producer stream for stock fitness sessions.
 *
 * Ironman can write its stock activity files, but SELinux intentionally prevents the system-app
 * process from reopening those ironman_data_file paths for reading. The hook therefore mirrors
 * only the three exact stock writer payloads into a server-created anonymous pipe while the stock
 * session is live. This service drains bounded frames directly to app-private temporary files and
 * publishes them only after a clean frame-boundary EOF and an exact matching FINISH declaration.
 */
class FitnessBridgeService : Service() {
    private val binder = FitnessBridgeBinder()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val sessionLock = Any()
    private val activeSessions = LinkedHashMap<String, ActiveSession>()
    private val claimedSessions = LinkedHashSet<ActiveSession>()
    private var lifecycleEpoch = 0L
    private var latestStartId = 0
    private var destroying = false
    private val readerExecutor = ThreadPoolExecutor(
        FitnessBridgeProtocol.MAX_QUEUED_EXPORTS,
        FitnessBridgeProtocol.MAX_QUEUED_EXPORTS,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(FitnessBridgeProtocol.MAX_QUEUED_EXPORTS),
    )
    private val timeoutExecutor = ScheduledThreadPoolExecutor(1).apply {
        removeOnCancelPolicy = true
    }

    private val repository by lazy {
        FitnessHistoryRepository(File(filesDir, FITNESS_HISTORY_DIRECTORY))
    }

    override fun onCreate() {
        super.onCreate()
        runCatching { cleanupStaleStreams() }
            .onFailure { Log.w(TAG, "Fitness stream cleanup failed: ${it.javaClass.simpleName}") }
        runCatching { repository.applyRetention() }
            .onFailure { Log.w(TAG, "Fitness history retention failed", it) }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        synchronized(sessionLock) { latestStartId = maxOf(latestStartId, startId) }
        scheduleStopIfIdle()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        val sessions = synchronized(sessionLock) {
            destroying = true
            (activeSessions.values + claimedSessions).distinct().also {
                activeSessions.clear()
                claimedSessions.clear()
            }
        }
        sessions.forEach { session ->
            session.gate.abort("Fitness bridge service stopped")
            cleanupClaimedSession(session)
        }
        timeoutExecutor.shutdownNow()
        readerExecutor.shutdownNow()
        super.onDestroy()
    }

    private inner class FitnessBridgeBinder : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            enforceIronmanCaller()
            if (code == INTERFACE_TRANSACTION) {
                requireNotNull(reply).writeString(FitnessBridgeProtocol.DESCRIPTOR)
                return true
            }
            if (flags and FLAG_ONEWAY != 0 || reply == null || code !in SUPPORTED_TRANSACTIONS) {
                throw SecurityException("Unsupported fitness bridge transaction")
            }

            data.enforceInterface(FitnessBridgeProtocol.DESCRIPTOR)
            when (code) {
                FitnessBridgeProtocol.TRANSACTION_BEGIN_SESSION -> transactBegin(data, reply)
                FitnessBridgeProtocol.TRANSACTION_FINISH_SESSION -> transactFinish(data, reply)
                FitnessBridgeProtocol.TRANSACTION_ABORT_SESSION -> transactAbort(data, reply)
            }
            return true
        }

        private fun transactBegin(data: Parcel, reply: Parcel) {
            val sessionId = data.readString().orEmpty()
            val startedAtMs = data.readLong()
            val fileCount = data.readInt()
            requireValidFileCount(fileCount)
            val filenames = List(fileCount) { data.readString().orEmpty() }
            require(data.dataAvail() == 0) { "Unexpected fitness BEGIN data" }
            val start = FitnessBridgeProtocol.validateStreamStart(
                FitnessBridgeProtocol.StreamStartDeclaration(sessionId, startedAtMs, filenames),
            )
            val result = beginSession(start)
            reply.writeNoException()
            if (result == null) {
                reply.writeInt(0)
                return
            }
            reply.writeInt(1)
            reply.writeInt(1)
            try {
                result.writeDescriptor.writeToParcel(reply, Parcelable.PARCELABLE_WRITE_RETURN_VALUE)
            } finally {
                runCatching { result.writeDescriptor.close() }
            }
        }

        private fun transactFinish(data: Parcel, reply: Parcel) {
            val sessionId = data.readString().orEmpty()
            val stoppedAtMs = data.readLong()
            val fileCount = data.readInt()
            requireValidFileCount(fileCount)
            val files = List(fileCount) {
                FitnessBridgeProtocol.FileDeclaration(
                    data.readString().orEmpty(),
                    data.readLong(),
                )
            }
            require(data.dataAvail() == 0) { "Unexpected fitness FINISH data" }
            val accepted = finishSession(sessionId, stoppedAtMs, files)
            reply.writeNoException()
            reply.writeInt(if (accepted) 1 else 0)
        }

        private fun transactAbort(data: Parcel, reply: Parcel) {
            val sessionId = FitnessBridgeProtocol.requireCanonicalSessionId(
                data.readString().orEmpty(),
            )
            require(data.dataAvail() == 0) { "Unexpected fitness ABORT data" }
            val accepted = abortSession(sessionId, "Fitness stream aborted by producer")
            reply.writeNoException()
            reply.writeInt(if (accepted) 1 else 0)
        }
    }

    private fun beginSession(
        start: FitnessBridgeProtocol.StreamStartDeclaration,
    ): BeginResult? {
        val directory: File
        val pipe: Array<ParcelFileDescriptor>
        val session: ActiveSession
        synchronized(sessionLock) {
            if (destroying || activeSessions.size + claimedSessions.size >=
                FitnessBridgeProtocol.MAX_QUEUED_EXPORTS ||
                activeSessions.containsKey(start.sessionId) ||
                claimedSessions.any { it.start.sessionId == start.sessionId }
            ) return null
            directory = createStreamDirectory(start.sessionId)
            try {
                pipe = ParcelFileDescriptor.createReliablePipe()
            } catch (error: Throwable) {
                deleteTreeNoFollow(directory.toPath())
                throw error
            }
            session = ActiveSession(start, directory, pipe[0])
            activeSessions[start.sessionId] = session
            lifecycleEpoch++
        }

        try {
            checkNotNull(startService(Intent(this, FitnessBridgeService::class.java))) {
                "Fitness bridge could not acquire its started-service hold"
            }
            session.timeout = timeoutExecutor.schedule(
                { abortSession(start.sessionId, "Fitness stream timed out") },
                FitnessBridgeProtocol.MAX_SESSION_DURATION_MS,
                TimeUnit.MILLISECONDS,
            )
            readerExecutor.execute { readSession(session) }
        } catch (_: RejectedExecutionException) {
            terminateSession(session, "Fitness bridge capacity is unavailable")
            runCatching { pipe[1].close() }
            return null
        } catch (error: Throwable) {
            terminateSession(session, "Fitness stream could not start")
            runCatching { pipe[1].close() }
            throw error
        }
        return BeginResult(pipe[1])
    }

    private fun finishSession(
        sessionId: String,
        stoppedAtMs: Long,
        files: List<FitnessBridgeProtocol.FileDeclaration>,
    ): Boolean {
        FitnessBridgeProtocol.requireCanonicalSessionId(sessionId)
        val session = synchronized(sessionLock) { activeSessions[sessionId] } ?: return false
        val declaration = FitnessBridgeProtocol.ExportDeclaration(
            sessionId,
            session.start.startedAtMs,
            stoppedAtMs,
            files,
        )
        return when (val decision = session.gate.acceptFinish(declaration)) {
            FitnessCommitDecision.Pending -> {
                armCompletionGraceTimeout(session)
                true
            }
            is FitnessCommitDecision.Ready -> dispatchCommit(session, decision.declaration, false)
            is FitnessCommitDecision.Failed -> {
                terminateSession(session, decision.reason)
                false
            }
        }
    }

    private fun abortSession(sessionId: String, reason: String): Boolean {
        val session = synchronized(sessionLock) { activeSessions[sessionId] } ?: return false
        if (session.gate.abort(reason) is FitnessCommitDecision.Ready) return false
        return terminateSession(session, reason)
    }

    private fun readSession(session: ActiveSession) {
        val sizes = try {
            readStreamToFiles(session)
        } catch (error: Throwable) {
            val reason = "Fitness stream failed: ${error.javaClass.simpleName}"
            session.gate.abort(reason)
            terminateSession(session, reason)
            Log.w(TAG, reason)
            return
        }
        when (val decision = session.gate.acceptStreamCompletion(sizes)) {
            FitnessCommitDecision.Pending -> armCompletionGraceTimeout(session)
            is FitnessCommitDecision.Ready -> dispatchCommit(session, decision.declaration, true)
            is FitnessCommitDecision.Failed -> terminateSession(session, decision.reason)
        }
    }

    private fun armCompletionGraceTimeout(session: ActiveSession) {
        val next = try {
            timeoutExecutor.schedule(
                { abortSession(session.start.sessionId, "Fitness stream completion timed out") },
                FitnessBridgeProtocol.FINISH_GRACE_TIMEOUT_MS,
                TimeUnit.MILLISECONDS,
            )
        } catch (_: RejectedExecutionException) {
            terminateSession(session, "Fitness completion timeout could not be armed")
            return
        }
        val previous = synchronized(sessionLock) {
            if (activeSessions[session.start.sessionId] !== session) {
                next.cancel(false)
                return@synchronized null
            }
            session.timeout.also { session.timeout = next }
        }
        previous?.cancel(false)
    }

    private fun readStreamToFiles(session: ActiveSession): Map<String, Long> {
        val bounds = FitnessStreamBounds(session.start)
        val outputs = LinkedHashMap<String, FileOutputStream>()
        try {
            session.start.filenames.forEach { filename ->
                outputs[filename] = FileOutputStream(streamFile(session.directory, filename), false)
            }
            DataInputStream(
                BufferedInputStream(ParcelFileDescriptor.AutoCloseInputStream(session.readDescriptor)),
            ).use { input ->
                require(input.readInt() == FitnessBridgeProtocol.STREAM_MAGIC) {
                    "Fitness stream magic is invalid"
                }
                require(input.readInt() == FitnessBridgeProtocol.STREAM_VERSION) {
                    "Fitness stream version is unsupported"
                }
                while (true) {
                    val fileId = FitnessStreamWire.readFrameFileIdOrEof(input) ?: break
                    val length = input.readInt()
                    val filename = bounds.acceptFrame(fileId, length)
                    val payload = ByteArray(length)
                    input.readFully(payload)
                    checkNotNull(outputs[filename]).write(payload)
                }
            }
            outputs.values.forEach { output ->
                output.flush()
                output.fd.sync()
            }
            return bounds.finish()
        } finally {
            outputs.values.forEach { runCatching { it.close() } }
        }
    }

    private fun dispatchCommit(
        session: ActiveSession,
        declaration: FitnessBridgeProtocol.ExportDeclaration,
        inline: Boolean,
    ): Boolean {
        if (!claimSession(session)) return false
        if (inline) {
            publishClaimedSession(session, declaration)
            return true
        }
        return try {
            readerExecutor.execute { publishClaimedSession(session, declaration) }
            true
        } catch (_: RejectedExecutionException) {
            cleanupClaimedSession(session)
            false
        }
    }

    private fun publishClaimedSession(
        session: ActiveSession,
        declaration: FitnessBridgeProtocol.ExportDeclaration,
    ) {
        try {
            val declared = declaration.files.associateBy { it.filename }
            val sources = buildFitnessImportSources(session.start.filenames) { filename ->
                val file = streamFile(session.directory, filename)
                val size = checkNotNull(declared[filename]).sizeBytes
                require(file.length() == size) { "Fitness temporary file size changed" }
                FitnessImportSource(filename, size, FileInputStream(file))
            }
            repository.importSession(declaration, sources)
            Log.i(TAG, "Fitness stream export completed")
        } catch (error: Throwable) {
            Log.w(TAG, "Fitness stream export failed: ${error.javaClass.simpleName}")
        } finally {
            cleanupClaimedSession(session)
        }
    }

    private fun claimSession(session: ActiveSession): Boolean = synchronized(sessionLock) {
        if (activeSessions[session.start.sessionId] !== session) return@synchronized false
        activeSessions.remove(session.start.sessionId)
        claimedSessions.add(session)
        session.timeout?.cancel(false)
        session.closePipe()
        true
    }

    private fun terminateSession(session: ActiveSession, reason: String): Boolean {
        val removed = synchronized(sessionLock) {
            if (activeSessions[session.start.sessionId] !== session) return@synchronized false
            activeSessions.remove(session.start.sessionId)
            true
        }
        if (!removed) return false
        session.gate.abort(reason)
        cleanupClaimedSession(session)
        return true
    }

    private fun cleanupClaimedSession(session: ActiveSession) {
        synchronized(sessionLock) { claimedSessions.remove(session) }
        session.timeout?.cancel(false)
        session.closePipe()
        runCatching { deleteTreeNoFollow(session.directory.toPath()) }
        scheduleStopIfIdle()
    }

    private fun scheduleStopIfIdle() {
        val epoch = synchronized(sessionLock) {
            if (destroying || activeSessions.isNotEmpty() || claimedSessions.isNotEmpty()) return
            lifecycleEpoch
        }
        mainHandler.post {
            synchronized(sessionLock) {
                if (destroying || lifecycleEpoch != epoch || activeSessions.isNotEmpty() ||
                    claimedSessions.isNotEmpty()
                ) return@synchronized
                // A self-start request may still be waiting for onStartCommand. In that case its
                // callback will schedule another idle check with the corresponding startId.
                if (latestStartId > 0) stopSelfResult(latestStartId)
            }
        }
    }

    private fun createStreamDirectory(sessionId: String): File {
        FitnessBridgeProtocol.requireCanonicalSessionId(sessionId)
        val root = streamRoot()
        val directory = File(root, ".stream-$sessionId-${UUID.randomUUID()}")
        require(directory.parentFile?.canonicalFile == root.canonicalFile) {
            "Fitness stream directory escaped its root"
        }
        require(!Files.isSymbolicLink(directory.toPath())) {
            "Fitness stream directory is a symlink"
        }
        check(directory.mkdir()) { "Failed to create fitness stream directory" }
        return directory
    }

    private fun streamRoot(): File {
        val root = File(cacheDir, STREAM_DIRECTORY)
        require(!Files.isSymbolicLink(root.toPath())) { "Fitness stream root is a symlink" }
        check(root.exists() || root.mkdirs()) { "Failed to create fitness stream root" }
        check(root.isDirectory) { "Fitness stream root is not a directory" }
        return root
    }

    private fun streamFile(directory: File, filename: String): File {
        require(filename in FitnessBridgeProtocol.ALLOWED_FILENAMES)
        val file = File(directory, filename)
        require(file.parentFile?.canonicalFile == directory.canonicalFile) {
            "Fitness stream file escaped its session directory"
        }
        require(!Files.isSymbolicLink(file.toPath())) { "Fitness stream file is a symlink" }
        return file
    }

    private fun cleanupStaleStreams() {
        val root = streamRoot()
        root.listFiles().orEmpty().forEach { entry ->
            if (entry.name.startsWith(".stream-")) deleteTreeNoFollow(entry.toPath())
        }
    }

    private fun deleteTreeNoFollow(path: Path) {
        if (!Files.exists(path)) return
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

    private fun enforceIronmanCaller() {
        val callingUid = Binder.getCallingUid()
        val callingPid = Binder.getCallingPid()
        val expectedUid = try {
            packageManager.getPackageUid(FitnessBridgeProtocol.IRONMAN_PACKAGE, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            throw SecurityException("Authorized fitness caller is unavailable")
        }
        val packages = packageManager.getPackagesForUid(callingUid).orEmpty().toSet()
        val processName = readProcessName(callingPid)
        if (!FitnessCallerAdmission.isAuthorized(
                callingUid,
                expectedUid,
                packages,
                processName,
            )
        ) throw SecurityException("Caller is not authorized for fitness export")
    }

    private fun readProcessName(pid: Int): String? = runCatching {
        File("/proc/$pid/cmdline").inputStream().buffered().use { input ->
            val bytes = ByteArray(MAX_PROCESS_NAME_BYTES)
            val count = input.read(bytes)
            if (count <= 0) return@use null
            bytes.copyOf(count)
                .takeWhile { it != 0.toByte() }
                .toByteArray()
                .toString(Charsets.UTF_8)
                .takeIf { it.isNotBlank() }
        }
    }.getOrNull()

    private fun requireValidFileCount(fileCount: Int) {
        require(fileCount in FitnessBridgeProtocol.REQUIRED_FILENAMES.size..
            FitnessBridgeProtocol.ALLOWED_FILENAMES.size) {
            "Fitness file count is invalid"
        }
    }

    private data class BeginResult(val writeDescriptor: ParcelFileDescriptor)

    private class ActiveSession(
        val start: FitnessBridgeProtocol.StreamStartDeclaration,
        val directory: File,
        val readDescriptor: ParcelFileDescriptor,
        val gate: FitnessStreamCommitGate = FitnessStreamCommitGate(start),
    ) {
        @Volatile
        var timeout: ScheduledFuture<*>? = null

        fun closePipe() {
            runCatching { readDescriptor.close() }
        }
    }

    private companion object {
        const val TAG = "PenumbraServer"
        const val STREAM_DIRECTORY = "fitness-streams"
        const val MAX_PROCESS_NAME_BYTES = 256
        val SUPPORTED_TRANSACTIONS = setOf(
            FitnessBridgeProtocol.TRANSACTION_BEGIN_SESSION,
            FitnessBridgeProtocol.TRANSACTION_FINISH_SESSION,
            FitnessBridgeProtocol.TRANSACTION_ABORT_SESSION,
        )
    }
}

/** Closes already-opened inputs if constructing any later source fails. */
internal fun buildFitnessImportSources(
    filenames: List<String>,
    factory: (String) -> FitnessImportSource,
): List<FitnessImportSource> {
    val sources = ArrayList<FitnessImportSource>(filenames.size)
    try {
        filenames.forEach { filename -> sources += factory(filename) }
        return sources
    } catch (error: Throwable) {
        sources.forEach { source -> runCatching { source.input.close() } }
        throw error
    }
}
