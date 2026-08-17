package com.penumbraos.server

import android.os.IBinder
import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.DataInputStream
import java.util.UUID

internal object FitnessBridgeProtocol {
    const val DESCRIPTOR = TierASymbols.Binder.PenumbraFitness.DESCRIPTOR
    const val IRONMAN_PACKAGE = TierASymbols.Packages.IRONMAN
    const val TRANSACTION_BEGIN_SESSION =
        TierASymbols.Binder.PenumbraFitness.TRANSACTION_BEGIN_SESSION
    const val TRANSACTION_FINISH_SESSION =
        TierASymbols.Binder.PenumbraFitness.TRANSACTION_FINISH_SESSION
    const val TRANSACTION_ABORT_SESSION =
        TierASymbols.Binder.PenumbraFitness.TRANSACTION_ABORT_SESSION

    const val STREAM_MAGIC = 0x50464E32
    const val STREAM_VERSION = 1
    const val MAX_FRAME_BYTES = 64 * 1024
    const val SUMMARY_FILE_ID = 1
    const val LOCATION_FILE_ID = 2
    const val SENSOR_FILE_ID = 3

    const val SUMMARY_FILENAME = "activity-tracking-summary.csv"
    const val LOCATION_FILENAME = "activity-tracking-location-data.gpx"
    const val SENSOR_FILENAME = "activity-tracking-sensor-data.csv"
    const val MANIFEST_FILENAME = "manifest.json"

    const val MAX_SUMMARY_BYTES = 2L * 1024 * 1024
    const val MAX_LOCATION_BYTES = 16L * 1024 * 1024
    const val MAX_SENSOR_BYTES = 256L * 1024 * 1024
    const val MAX_SESSION_BYTES = MAX_SUMMARY_BYTES + MAX_LOCATION_BYTES + MAX_SENSOR_BYTES
    const val MAX_STORED_BYTES = 512L * 1024 * 1024
    const val MAX_STORED_SESSIONS = 20
    const val MAX_SESSION_AGE_MS = 30L * 24 * 60 * 60 * 1_000
    const val MAX_SESSION_DURATION_MS = 7L * 24 * 60 * 60 * 1_000
    const val FINISH_GRACE_TIMEOUT_MS = 10_000L
    const val MAX_QUEUED_EXPORTS = 4

    val REQUIRED_FILENAMES = setOf(SUMMARY_FILENAME, LOCATION_FILENAME)
    val ALLOWED_FILENAMES = REQUIRED_FILENAMES + SENSOR_FILENAME

    data class FileDeclaration(val filename: String, val sizeBytes: Long)

    data class StreamStartDeclaration(
        val sessionId: String,
        val startedAtMs: Long,
        val filenames: List<String>,
    )

    data class ExportDeclaration(
        val sessionId: String,
        val startedAtMs: Long,
        val stoppedAtMs: Long,
        val files: List<FileDeclaration>,
    )

    fun validateStreamStart(declaration: StreamStartDeclaration): StreamStartDeclaration {
        requireCanonicalSessionId(declaration.sessionId)
        require(declaration.startedAtMs > 0) { "Fitness start time is invalid" }
        validateFilenameSet(declaration.filenames)
        return declaration
    }

    fun validateExport(declaration: ExportDeclaration): ExportDeclaration {
        requireCanonicalSessionId(declaration.sessionId)
        require(declaration.startedAtMs > 0) { "Fitness start time is invalid" }
        require(declaration.stoppedAtMs >= declaration.startedAtMs) {
            "Fitness stop time precedes start time"
        }
        require(declaration.stoppedAtMs - declaration.startedAtMs <= MAX_SESSION_DURATION_MS) {
            "Fitness session duration exceeds the limit"
        }
        validateFilenameSet(declaration.files.map(FileDeclaration::filename))
        validateFileSizes(declaration.files)
        return declaration
    }

    fun validateStreamSizes(
        start: StreamStartDeclaration,
        sizes: Map<String, Long>,
    ): Map<String, Long> {
        validateStreamStart(start)
        require(sizes.keys == start.filenames.toSet()) {
            "Fitness stream file set does not match its start declaration"
        }
        validateFileSizes(start.filenames.map { filename ->
            FileDeclaration(filename, sizes[filename] ?: 0L)
        })
        return sizes
    }

    fun requireCanonicalSessionId(value: String): String {
        val parsed = try {
            UUID.fromString(value)
        } catch (error: IllegalArgumentException) {
            throw IllegalArgumentException("Fitness session identifier is invalid", error)
        }
        require(parsed.toString() == value) { "Fitness session identifier is not canonical" }
        return value
    }

    fun fileIdFor(filename: String): Int = when (filename) {
        SUMMARY_FILENAME -> SUMMARY_FILE_ID
        LOCATION_FILENAME -> LOCATION_FILE_ID
        SENSOR_FILENAME -> SENSOR_FILE_ID
        else -> throw IllegalArgumentException("Unexpected fitness filename")
    }

    fun filenameFor(fileId: Int): String = when (fileId) {
        SUMMARY_FILE_ID -> SUMMARY_FILENAME
        LOCATION_FILE_ID -> LOCATION_FILENAME
        SENSOR_FILE_ID -> SENSOR_FILENAME
        else -> throw IllegalArgumentException("Unexpected fitness file identifier")
    }

    fun maxBytesFor(filename: String): Long = when (filename) {
        SUMMARY_FILENAME -> MAX_SUMMARY_BYTES
        LOCATION_FILENAME -> MAX_LOCATION_BYTES
        SENSOR_FILENAME -> MAX_SENSOR_BYTES
        else -> throw IllegalArgumentException("Unexpected fitness filename")
    }

    private fun validateFilenameSet(filenames: List<String>) {
        require(filenames.size in REQUIRED_FILENAMES.size..ALLOWED_FILENAMES.size) {
            "Fitness file count is invalid"
        }
        require(filenames.toSet().size == filenames.size) { "Duplicate fitness filename" }
        require(filenames.containsAll(REQUIRED_FILENAMES)) { "Fitness base files are missing" }
        require(filenames.all(ALLOWED_FILENAMES::contains)) { "Unexpected fitness filename" }
    }

    private fun validateFileSizes(files: List<FileDeclaration>) {
        var total = 0L
        files.forEach { file ->
            val limit = maxBytesFor(file.filename)
            require(file.sizeBytes in 1..limit) { "Fitness file size is invalid" }
            total = Math.addExact(total, file.sizeBytes)
        }
        require(total <= MAX_SESSION_BYTES) { "Fitness session exceeds the size limit" }
    }
}

internal object FitnessStreamWire {
    /** Returns null only when EOF occurs before any byte of the next frame identifier. */
    fun readFrameFileIdOrEof(input: DataInputStream): Int? {
        val first = input.read()
        if (first < 0) return null
        return (first shl 24) or
            (input.readUnsignedByte() shl 16) or
            (input.readUnsignedByte() shl 8) or
            input.readUnsignedByte()
    }
}

/** Incremental frame accounting, deliberately independent from Android I/O for unit testing. */
internal class FitnessStreamBounds(
    private val start: FitnessBridgeProtocol.StreamStartDeclaration,
) {
    private val sizes = LinkedHashMap<String, Long>()
    private var totalBytes = 0L

    init {
        FitnessBridgeProtocol.validateStreamStart(start)
        start.filenames.forEach { sizes[it] = 0L }
    }

    @Synchronized
    fun acceptFrame(fileId: Int, length: Int): String {
        require(length in 1..FitnessBridgeProtocol.MAX_FRAME_BYTES) {
            "Fitness stream frame size is invalid"
        }
        val filename = FitnessBridgeProtocol.filenameFor(fileId)
        val previous = sizes[filename]
            ?: throw IllegalArgumentException("Fitness stream referenced an undeclared file")
        val next = Math.addExact(previous, length.toLong())
        require(next <= FitnessBridgeProtocol.maxBytesFor(filename)) {
            "Fitness stream file exceeds its size limit"
        }
        val nextTotal = Math.addExact(totalBytes, length.toLong())
        require(nextTotal <= FitnessBridgeProtocol.MAX_SESSION_BYTES) {
            "Fitness stream session exceeds its size limit"
        }
        sizes[filename] = next
        totalBytes = nextTotal
        return filename
    }

    @Synchronized
    fun finish(): Map<String, Long> = LinkedHashMap(sizes).also { finalSizes ->
        FitnessBridgeProtocol.validateStreamSizes(start, finalSizes)
    }
}

internal sealed class FitnessCommitDecision {
    object Pending : FitnessCommitDecision()
    data class Ready(val declaration: FitnessBridgeProtocol.ExportDeclaration) : FitnessCommitDecision()
    data class Failed(val reason: String) : FitnessCommitDecision()
}

/**
 * Two-sided exactly-once gate. FINISH and pipe EOF may race; publication is released only once,
 * after both sides report the identical bounded file set and byte counts.
 */
internal class FitnessStreamCommitGate(
    private val start: FitnessBridgeProtocol.StreamStartDeclaration,
) {
    private var finishDeclaration: FitnessBridgeProtocol.ExportDeclaration? = null
    private var streamSizes: Map<String, Long>? = null
    private var terminalDecision: FitnessCommitDecision? = null

    init {
        FitnessBridgeProtocol.validateStreamStart(start)
    }

    @Synchronized
    fun acceptFinish(
        declaration: FitnessBridgeProtocol.ExportDeclaration,
    ): FitnessCommitDecision {
        terminalDecision?.let { return FitnessCommitDecision.Failed("Fitness stream is terminal") }
        if (finishDeclaration != null) return fail("Duplicate fitness finish declaration")
        return try {
            FitnessBridgeProtocol.validateExport(declaration)
            require(declaration.sessionId == start.sessionId) { "Fitness finish session does not match" }
            require(declaration.startedAtMs == start.startedAtMs) { "Fitness finish start time does not match" }
            require(declaration.files.map { it.filename }.toSet() == start.filenames.toSet()) {
                "Fitness finish file set does not match"
            }
            finishDeclaration = declaration
            evaluate()
        } catch (error: Throwable) {
            fail(error.message ?: "Fitness finish declaration is invalid")
        }
    }

    @Synchronized
    fun acceptStreamCompletion(sizes: Map<String, Long>): FitnessCommitDecision {
        terminalDecision?.let { return FitnessCommitDecision.Failed("Fitness stream is terminal") }
        if (streamSizes != null) return fail("Duplicate fitness stream completion")
        return try {
            FitnessBridgeProtocol.validateStreamSizes(start, sizes)
            streamSizes = LinkedHashMap(sizes)
            evaluate()
        } catch (error: Throwable) {
            fail(error.message ?: "Fitness stream sizes are invalid")
        }
    }

    @Synchronized
    fun abort(reason: String): FitnessCommitDecision =
        terminalDecision ?: fail(reason)

    private fun evaluate(): FitnessCommitDecision {
        val finish = finishDeclaration ?: return FitnessCommitDecision.Pending
        val streamed = streamSizes ?: return FitnessCommitDecision.Pending
        val declared = finish.files.associate { it.filename to it.sizeBytes }
        if (declared != streamed) return fail("Fitness stream sizes do not match FINISH")
        return FitnessCommitDecision.Ready(finish).also { terminalDecision = it }
    }

    private fun fail(reason: String): FitnessCommitDecision.Failed =
        FitnessCommitDecision.Failed(reason).also { terminalDecision = it }
}

internal object FitnessCallerAdmission {
    fun isAuthorized(
        callingUid: Int,
        expectedUid: Int,
        packagesForUid: Set<String>,
        processName: String?,
    ): Boolean = callingUid == expectedUid &&
        FitnessBridgeProtocol.IRONMAN_PACKAGE in packagesForUid &&
        processName == FitnessBridgeProtocol.IRONMAN_PACKAGE
}
