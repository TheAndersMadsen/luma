package com.penumbraos.systeminjector

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile

internal object StagingAccessPolicy {
    private val authorizedUids = setOf(
        0,    // root
        1000, // system
        2000, // shell (adb content commands)
    )

    fun isAuthorized(uid: Int): Boolean = uid in authorizedUids
}

internal object InjectorManagedPackagePolicy {
    private const val PER_USER_RANGE = 100_000
    private const val SYSTEM_SHARED_USER_ID = 1000

    fun isEligibleForKeepDataUpdate(packageName: String, uid: Int, sourceDir: String?): Boolean {
        return uid % PER_USER_RANGE == SYSTEM_SHARED_USER_ID &&
            sourceDir == "/data/app/$packageName-injected/base.apk"
    }
}

/**
 * Admits only the exact artifact continuity left by an interrupted, already-approved update.
 * This is deliberately separate from [InjectorManagedPackagePolicy]: a restored randomized path
 * is recovery evidence for one retry, not a generally injector-owned code path.
 */
internal object FailedUpdateContinuityPolicy {
    private const val SYSTEM_UID = 1000
    private const val SYSTEM_INJECTOR_PACKAGE = "com.penumbraos.systeminjector"
    private val packageNamePattern =
        Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
    private val sha256Pattern = Regex("[a-f0-9]{64}")

    fun hasRequiredProvenance(
        packageName: String,
        uid: Int,
        sourceDir: String?,
        tracked: Boolean,
        priorApprovalMatches: Boolean,
    ): Boolean =
        packageName != SYSTEM_INJECTOR_PACKAGE &&
            packageName.matches(packageNamePattern) &&
            uid == SYSTEM_UID &&
            tracked &&
            priorApprovalMatches &&
            isSafeRandomizedSourceDir(packageName, sourceDir)

    fun isEligible(
        packageName: String,
        uid: Int,
        sourceDir: String?,
        tracked: Boolean,
        priorApprovalMatches: Boolean,
        installedArtifactIsSafe: Boolean,
        stagedSha256: String,
        installedSha256: String,
    ): Boolean =
        hasRequiredProvenance(
            packageName = packageName,
            uid = uid,
            sourceDir = sourceDir,
            tracked = tracked,
            priorApprovalMatches = priorApprovalMatches,
        ) &&
            installedArtifactIsSafe &&
            stagedSha256.matches(sha256Pattern) &&
            installedSha256.matches(sha256Pattern) &&
            MessageDigest.isEqual(
                stagedSha256.toByteArray(Charsets.US_ASCII),
                installedSha256.toByteArray(Charsets.US_ASCII),
            )

    fun isSafeRandomizedSourceDir(packageName: String, sourceDir: String?): Boolean {
        if (!packageName.matches(packageNamePattern) || sourceDir == null) return false
        val token = "[A-Za-z0-9_-]{1,128}={0,2}"
        return sourceDir.matches(
            Regex(
                "/data/app/~~$token/${Regex.escape(packageName)}-$token/base\\.apk"
            )
        )
    }

    fun isSafeRegularArtifact(file: File, expectedBytes: Long): Boolean {
        if (expectedBytes !in 1L..StagingIo.MAX_STAGED_APK_BYTES) return false
        return try {
            val absoluteFile = file.absoluteFile
            absoluteFile.path == absoluteFile.toPath().normalize().toString() &&
                absoluteFile.canonicalFile == absoluteFile &&
                Files.isRegularFile(absoluteFile.toPath(), LinkOption.NOFOLLOW_LINKS) &&
                absoluteFile.length() == expectedBytes
        } catch (_: IOException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }
}

internal data class ReplacementApproval(
    val stagedSha256: String,
    val expectedBaseApkPath: String?,
)

/**
 * Durable replacement approvals bind the staged digest to the exact PackageSetting code path
 * observed before uninstall. A legacy digest-only value can be read solely so the provider can
 * upgrade it under a fresh locked PMS snapshot before allowing another mutation.
 */
internal object ReplacementApprovalPolicy {
    private const val VERSION_PREFIX = "v2:"
    private val sha256Pattern = Regex("[a-f0-9]{64}")

    fun encode(packageName: String, approval: ReplacementApproval): String {
        require(approval.stagedSha256.matches(sha256Pattern)) { "Invalid approval digest" }
        val expectedPath = requireNotNull(approval.expectedBaseApkPath) {
            "A durable replacement approval requires an exact code path"
        }
        require(isSafeExpectedBaseApkPath(packageName, expectedPath)) {
            "Invalid approval code path"
        }
        val encodedPath = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(expectedPath.toByteArray(Charsets.UTF_8))
        return "$VERSION_PREFIX${approval.stagedSha256}:$encodedPath"
    }

    fun decode(packageName: String, storedValue: String?): ReplacementApproval? {
        if (storedValue == null) return null
        if (storedValue.matches(sha256Pattern)) {
            return ReplacementApproval(storedValue, expectedBaseApkPath = null)
        }
        if (!storedValue.startsWith(VERSION_PREFIX)) return null
        val fields = storedValue.removePrefix(VERSION_PREFIX).split(":")
        if (fields.size != 2 || !fields[0].matches(sha256Pattern)) return null
        val expectedPath = try {
            Base64.getUrlDecoder().decode(fields[1]).toString(Charsets.UTF_8)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (!isSafeExpectedBaseApkPath(packageName, expectedPath)) return null
        return ReplacementApproval(fields[0], expectedPath)
    }

    fun isSafeExpectedBaseApkPath(packageName: String, path: String): Boolean =
        path == "/data/app/$packageName-injected/base.apk" ||
            FailedUpdateContinuityPolicy.isSafeRandomizedSourceDir(packageName, path)
}

internal data class InstallBatchArtifact(
    val filename: String,
    val packageName: String,
    val stagedSha256: String,
)

/** Immutable identity selected by the provider-issued retry token. */
internal data class InstallBatchIdentity(
    val artifacts: List<InstallBatchArtifact>,
    val approvedReplacementPaths: Map<String, String>,
) {
    init {
        require(artifacts.isNotEmpty()) { "Install transaction cannot be empty" }
        require(artifacts.map { it.filename }.toSet().size == artifacts.size) {
            "Install transaction contains duplicate filenames"
        }
        require(artifacts.map { it.packageName }.toSet().size == artifacts.size) {
            "Install transaction contains duplicate packages"
        }
        require(artifacts.all { StagingFilenamePolicy.isValid(it.filename) }) {
            "Install transaction contains an invalid filename"
        }
        require(artifacts.all { it.stagedSha256.matches(Regex("[a-f0-9]{64}")) }) {
            "Install transaction contains an invalid digest"
        }
        require(artifacts.map { it.packageName }.toSet().containsAll(approvedReplacementPaths.keys)) {
            "Replacement identity is outside the install transaction"
        }
        require(approvedReplacementPaths.all { (packageName, path) ->
            ReplacementApprovalPolicy.isSafeExpectedBaseApkPath(packageName, path)
        }) { "Install transaction contains an invalid replacement code path" }
    }

    val filenames: List<String>
        get() = artifacts.map { it.filename }

    val packageNames: List<String>
        get() = artifacts.map { it.packageName }
}

/**
 * Holds at most one duplicate-response lease. The token never accepts filenames from the retry;
 * it selects the already claimed, ordered filename/package/digest identity created by the initial
 * provider call.
 */
internal class InstallRetryLeaseStore(
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val tokenFactory: () -> String = {
        UUID.randomUUID().toString().replace("-", "")
    },
    private val leaseTtlMillis: Long = DEFAULT_LEASE_TTL_MILLIS,
) {
    data class Lease(
        val token: String,
        val identity: InstallBatchIdentity,
        val expiresAtMillis: Long,
    )

    private var pending: Lease? = null

    init {
        require(leaseTtlMillis > 0) { "Retry lease TTL must be positive" }
    }

    @Synchronized
    fun create(identity: InstallBatchIdentity): Lease {
        check(pending == null) { "An install retry transaction is already pending" }
        val token = tokenFactory()
        check(token.matches(Regex("[a-f0-9]{32}"))) { "Invalid install retry token" }
        val now = nowMillis()
        val expiresAt = Math.addExact(now, leaseTtlMillis)
        return Lease(token, identity, expiresAt).also { pending = it }
    }

    @Synchronized
    fun take(token: String): Lease? {
        val lease = pending ?: return null
        if (token != lease.token || nowMillis() >= lease.expiresAtMillis) return null
        pending = null
        return lease
    }

    @Synchronized
    fun cancel(token: String): Lease? {
        val lease = pending ?: return null
        if (token != lease.token) return null
        pending = null
        return lease
    }

    @Synchronized
    fun removeExpired(): Lease? {
        val lease = pending ?: return null
        if (nowMillis() < lease.expiresAtMillis) return null
        pending = null
        return lease
    }

    @Synchronized
    fun hasPending(): Boolean = pending != null

    companion object {
        const val DEFAULT_LEASE_TTL_MILLIS = 10L * 60L * 1000L
    }
}

internal class StagingWriteTracker {
    sealed interface WriteOutcome {
        data object Success : WriteOutcome
        data class Failure(val message: String) : WriteOutcome
    }

    class WriteToken internal constructor(internal val filename: String) {
        private val completion = CompletableFuture<WriteOutcome>()

        internal fun complete(outcome: WriteOutcome) {
            completion.complete(outcome)
        }

        fun await(timeoutMillis: Long): WriteOutcome =
            completion.get(timeoutMillis, TimeUnit.MILLISECONDS)
    }

    sealed interface ClaimResult {
        data object Claimed : ClaimResult
        data class Busy(val writes: List<WriteToken>) : ClaimResult
        data class Rejected(val message: String) : ClaimResult
    }

    private val activeWrites = mutableMapOf<String, WriteToken>()
    private val failedWrites = mutableMapOf<String, String>()
    private val claimedFiles = mutableSetOf<String>()

    @Synchronized
    fun begin(filename: String): WriteToken {
        check(filename !in claimedFiles) { "Staged file is currently claimed for install: $filename" }
        check(filename !in activeWrites) { "Staged file already has an active write: $filename" }
        failedWrites.remove(filename)
        return WriteToken(filename).also { activeWrites[filename] = it }
    }

    @Synchronized
    fun finish(token: WriteToken, outcome: WriteOutcome) {
        if (activeWrites[token.filename] !== token) return
        activeWrites.remove(token.filename)
        when (outcome) {
            WriteOutcome.Success -> failedWrites.remove(token.filename)
            is WriteOutcome.Failure -> failedWrites[token.filename] = outcome.message
        }
        token.complete(outcome)
    }

    @Synchronized
    fun claim(filenames: Set<String>): ClaimResult {
        val alreadyClaimed = filenames.firstOrNull { it in claimedFiles }
        if (alreadyClaimed != null) {
            return ClaimResult.Rejected("Staged file is already claimed: $alreadyClaimed")
        }
        val failed = filenames.firstNotNullOfOrNull { filename ->
            failedWrites[filename]?.let { "$filename: $it" }
        }
        if (failed != null) return ClaimResult.Rejected("Staging write failed: $failed")

        val active = filenames.mapNotNull(activeWrites::get)
        if (active.isNotEmpty()) return ClaimResult.Busy(active)

        claimedFiles.addAll(filenames)
        return ClaimResult.Claimed
    }

    @Synchronized
    fun release(filenames: Set<String>) {
        claimedFiles.removeAll(filenames)
    }

    @Synchronized
    fun claimForDiscard(filename: String): Boolean {
        if (filename in activeWrites || filename in claimedFiles) return false
        failedWrites.remove(filename)
        claimedFiles.add(filename)
        return true
    }
}

internal class StagingQuotaTracker(
    private val maxFiles: Int = MAX_STAGED_FILES,
    private val maxTotalBytes: Long = MAX_STAGING_BYTES,
    private val maxFileBytes: Long = StagingIo.MAX_STAGED_APK_BYTES,
    private val maxConcurrentWrites: Int = MAX_CONCURRENT_WRITES,
) {
    data class PublishedFile(val name: String, val size: Long)
    class Reservation internal constructor(
        internal val id: Long,
        internal val filename: String,
        val maxBytes: Long,
    )

    private val reservations = mutableMapOf<Long, Reservation>()
    private var nextId = 1L

    @Synchronized
    fun reserve(filename: String, publishedFiles: Collection<PublishedFile>): Reservation {
        require(StagingFilenamePolicy.isValid(filename)) { "Invalid filename: $filename" }
        check(reservations.size < maxConcurrentWrites) {
            "Too many concurrent staging writes"
        }
        check(publishedFiles.all { it.size >= 0 }) { "Invalid staged file size" }
        check(publishedFiles.map { it.name }.toSet().size == publishedFiles.size) {
            "Duplicate staged file inventory"
        }

        val effectiveNames = publishedFiles.mapTo(mutableSetOf()) { it.name }
        effectiveNames += reservations.values.map { it.filename }
        check(filename in effectiveNames || effectiveNames.size < maxFiles) {
            "Staging file quota exceeded"
        }

        val publishedBytes = publishedFiles.fold(0L) { total, file ->
            check(total <= maxTotalBytes - file.size) { "Staging byte quota exceeded" }
            total + file.size
        }
        val reservedBytes = reservations.values.fold(0L) { total, reservation ->
            check(total <= maxTotalBytes - reservation.maxBytes) { "Staging byte quota exceeded" }
            total + reservation.maxBytes
        }
        val availableBytes = maxTotalBytes - publishedBytes - reservedBytes
        check(availableBytes > 0) { "Staging byte quota exceeded" }
        val reservation = Reservation(
            id = nextId++,
            filename = filename,
            maxBytes = minOf(maxFileBytes, availableBytes),
        )
        reservations[reservation.id] = reservation
        return reservation
    }

    @Synchronized
    fun release(reservation: Reservation) {
        if (reservations[reservation.id] === reservation) {
            reservations.remove(reservation.id)
        }
    }

    companion object {
        const val MAX_STAGED_FILES = 32
        const val MAX_STAGING_BYTES = 1024L * 1024L * 1024L
        const val MAX_CONCURRENT_WRITES = 2
    }
}

internal object StagingFilenamePolicy {
    private val filenamePattern = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
    fun isValid(filename: String): Boolean =
        filename.matches(filenamePattern) && !filename.contains("..")
}

internal object InstallBatchPolicy {
    const val MAX_BATCH_APKS = 16
    const val MAX_BATCH_BYTES = 1024L * 1024L * 1024L

    fun validateSizes(sizes: Collection<Long>) {
        require(sizes.isNotEmpty()) { "No staged APKs in batch" }
        require(sizes.size <= MAX_BATCH_APKS) { "Install batch exceeds $MAX_BATCH_APKS APKs" }
        var total = 0L
        for (size in sizes) {
            require(size >= 1L && size <= StagingIo.MAX_STAGED_APK_BYTES) {
                "Invalid staged APK size: $size"
            }
            require(total <= MAX_BATCH_BYTES - size) {
                "Install batch exceeds the $MAX_BATCH_BYTES-byte limit"
            }
            total += size
        }
    }
}

internal object NativeLibraryPolicy {
    const val MAX_ZIP_ENTRIES = 10_000
    const val MAX_NATIVE_LIBRARIES = 256
    const val MAX_SINGLE_LIBRARY_BYTES = 512L * 1024L * 1024L
    const val MAX_TOTAL_LIBRARY_BYTES = 1024L * 1024L * 1024L
    private val libraryNamePattern = Regex("[A-Za-z0-9][A-Za-z0-9._+-]{0,124}\\.so")

    fun isSafeLibraryName(name: String): Boolean = name.matches(libraryNamePattern)

    fun fitsExtractionSizeLimits(libraryBytes: Long, previouslyExtractedBytes: Long): Boolean =
        libraryBytes >= 0L &&
            previouslyExtractedBytes >= 0L &&
            libraryBytes <= MAX_SINGLE_LIBRARY_BYTES &&
            previouslyExtractedBytes <= MAX_TOTAL_LIBRARY_BYTES - libraryBytes
}

internal object ApkArchivePolicy {
    const val MAX_ZIP_ENTRIES = 10_000
    const val MAX_SINGLE_ENTRY_BYTES = 512L * 1024L * 1024L
    const val MAX_TOTAL_UNCOMPRESSED_BYTES = 1024L * 1024L * 1024L

    fun validate(apk: File) {
        ZipFile(apk).use { zip ->
            var entryCount = 0
            var totalBytes = 0L
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            val entryNames = mutableSetOf<String>()
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                entryCount += 1
                require(entryCount <= MAX_ZIP_ENTRIES) {
                    "APK archive exceeds $MAX_ZIP_ENTRIES entries"
                }
                val entryPath = if (entry.isDirectory) entry.name.removeSuffix("/") else entry.name
                require(
                    entryPath.isNotEmpty() &&
                        entryPath.length <= 512 &&
                        !entryPath.startsWith('/') &&
                        !entryPath.contains('\\') &&
                        entryPath.none(Char::isISOControl) &&
                        entryPath.split('/').all { it.isNotEmpty() && it != "." && it != ".." }
                ) { "APK archive contains an unsafe entry path" }
                require(entryNames.add(entry.name)) { "APK archive contains a duplicate entry" }
                if (entry.isDirectory) continue
                val size = entry.size
                require(size >= 0L && size <= MAX_SINGLE_ENTRY_BYTES) {
                    "APK archive entry has invalid uncompressed size: ${entry.name}"
                }
                require(totalBytes <= MAX_TOTAL_UNCOMPRESSED_BYTES - size) {
                    "APK archive exceeds the uncompressed-size limit"
                }
                var actualSize = 0L
                zip.getInputStream(entry).use { input ->
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        if (read == 0) continue
                        require(actualSize <= MAX_SINGLE_ENTRY_BYTES - read) {
                            "APK archive entry expands beyond its size limit: ${entry.name}"
                        }
                        require(totalBytes <= MAX_TOTAL_UNCOMPRESSED_BYTES - read) {
                            "APK archive expands beyond its total size limit"
                        }
                        actualSize += read
                        totalBytes += read
                    }
                }
                require(actualSize == size) {
                    "APK archive entry size mismatch: ${entry.name}"
                }
            }
        }
    }
}

internal class StagingSizeLimitExceededException(maxBytes: Long) :
    IOException("Staged APK exceeds the ${maxBytes}-byte limit")

internal object StagingIo {
    const val MAX_STAGED_APK_BYTES: Long = 512L * 1024L * 1024L

    fun copyBounded(
        input: InputStream,
        output: OutputStream,
        maxBytes: Long = MAX_STAGED_APK_BYTES,
    ): Long {
        require(maxBytes >= 0) { "maxBytes must be non-negative" }

        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var totalBytes = 0L
        while (true) {
            val bytesRead = input.read(buffer)
            if (bytesRead == -1) break
            if (bytesRead == 0) continue
            if (totalBytes > maxBytes - bytesRead) {
                throw StagingSizeLimitExceededException(maxBytes)
            }

            output.write(buffer, 0, bytesRead)
            totalBytes += bytesRead
        }
        return totalBytes
    }
}
