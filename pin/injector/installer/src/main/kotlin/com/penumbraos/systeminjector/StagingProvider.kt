package com.penumbraos.systeminjector

import android.content.ContentProvider
import android.content.Context
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.util.Log
import com.penumbraos.systeminjector.runtimepolicy.LaunchPolicyInstaller
import com.penumbraos.systeminjector.runtimepolicy.PolicyRegistry
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.FileVisitResult
import java.nio.file.StandardCopyOption
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * ContentProvider that stages APK files for installation.
 *
 * Because the installer runs inside system_server (UID 1000), it cannot read
 * files from /data/local/tmp (SELinux: system_server denied open on
 * shell_data_file). And returning a raw file FD to the caller doesn't work
 * either — the caller (adb shell, running as `shell` domain) gets denied
 * write to `system_data_file`.
 *
 * The solution: return a **pipe** FD. The caller writes bytes into the pipe
 * (SELinux allows shell to write to pipes). A background thread inside
 * system_server reads from the pipe and writes to the actual file on disk
 * (SELinux allows system_server to write to its own data files).
 *
 * Authority: com.penumbraos.systeminjector.staging
 *
 * Usage from CLI (two steps):
 *
 *   # 1. Stage the APK (pipes bytes through Binder into system_server's cache)
 *   adb shell content write \
 *     --uri content://com.penumbraos.systeminjector.staging/foo.apk \
 *     < foo.apk
 *
 *   # 2. Trigger install of the staged file
 *   adb shell content call \
 *     --uri content://com.penumbraos.systeminjector.staging \
 *     --method install --arg foo.apk
 */
class StagingProvider : ContentProvider() {

    companion object {
        private const val TAG = "SystemInjector"
        private const val STAGING_WRITE_TIMEOUT_MS = 120_000L
        private const val COMMIT_START_DELAY_MS = 2_000L
        private const val APPROVAL_PREFS = "pending_update_approvals"
        private const val APPROVAL_KEY_PREFIX = "package:"
        private const val INJECTOR_PACKAGE = "com.penumbraos.systeminjector"
        const val AUTHORITY = "com.penumbraos.systeminjector.staging"
        const val RESULT_MESSAGE = "message"
    }

    private val stagingWrites = StagingWriteTracker()
    private val stagingQuota = StagingQuotaTracker()
    private val retryLeases = InstallRetryLeaseStore()
    private val installInProgress = AtomicBoolean(false)
    private val installRequestInProgress = AtomicBoolean(false)

    /**
     * Providers injected into system_server receive a system Context whose
     * applicationContext may legitimately be null on production firmware.
     * Prefer the application context when present, but retain the provider
     * context as the system-safe fallback.
     */
    private fun providerContext(): Context {
        val providerContext = requireNotNull(context) { "StagingProvider is not attached" }
        return providerContext.applicationContext ?: providerContext
    }

    private fun enforceAuthorizedCaller() {
        val callingUid = Binder.getCallingUid()
        if (!StagingAccessPolicy.isAuthorized(callingUid)) {
            Log.e(TAG, "StagingProvider: rejected caller UID $callingUid")
            throw SecurityException("UID $callingUid is not authorized to use $AUTHORITY")
        }
    }

    private data class InstalledPackageState(val uid: Int, val sourceDir: String?)

    private fun installedPackageState(packageName: String): InstalledPackageState? {
        return try {
            val applicationInfo = context!!.packageManager.getPackageInfo(packageName, 0).applicationInfo
                ?: throw IllegalStateException("Installed package $packageName has no ApplicationInfo")
            InstalledPackageState(applicationInfo.uid, applicationInfo.sourceDir)
        } catch (_: android.content.pm.PackageManager.NameNotFoundException) {
            null
        }
    }

    private fun stagingDir(): File {
        val dir = File(context!!.cacheDir, "injector-staging")
        dir.mkdirs()
        return dir
    }

    private fun publishedStagingFiles(directory: File): List<StagingQuotaTracker.PublishedFile> =
        directory.listFiles()
            .orEmpty()
            .filter { it.isFile && !it.name.startsWith(".") }
            .map { StagingQuotaTracker.PublishedFile(it.name, it.length()) }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        enforceAuthorizedCaller()
        releaseExpiredRetryLease()

        require(uri.pathSegments.size == 1) { "URI must contain exactly one filename" }
        val filename = uri.lastPathSegment
            ?: throw IllegalArgumentException("URI must end with a filename")

        require(StagingFilenamePolicy.isValid(filename)) {
            "Invalid filename: $filename"
        }

        val stagingDirectory = stagingDir()
        val file = File(stagingDirectory, filename)

        Log.w(TAG, "StagingProvider: openFile $filename (mode=$mode)")

        if (!mode.contains("w")) {
            throw FileNotFoundException("Staged APK reads are not supported")
        }

        // Write mode: return a pipe; system_server drains it to disk
        val reservation = stagingQuota.reserve(filename, publishedStagingFiles(stagingDirectory))
        val pipe = try {
            ParcelFileDescriptor.createReliablePipe()
        } catch (failure: Throwable) {
            stagingQuota.release(reservation)
            throw failure
        }
        val readEnd = pipe[0]  // we read from this inside system_server
        val writeEnd = pipe[1] // returned to caller (shell)
        val writeToken = try {
            stagingWrites.begin(filename)
        } catch (failure: Throwable) {
            readEnd.close()
            writeEnd.close()
            stagingQuota.release(reservation)
            throw failure
        }
        val tempFile = File(stagingDirectory, ".${UUID.randomUUID()}.tmp")

        val worker = Thread {
            var input: FileInputStream? = null
            var pipeClosedWithError = false
            try {
                input = FileInputStream(readEnd.fileDescriptor)
                FileOutputStream(tempFile).use { output ->
                    StagingIo.copyBounded(input, output, reservation.maxBytes)
                    // A reliable pipe can reach EOF because the writer called closeWithError().
                    // Do not publish a partial APK until the peer status has been checked.
                    readEnd.checkError()
                    output.fd.sync()
                }
                Files.move(
                    tempFile.toPath(),
                    file.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
                stagingWrites.finish(writeToken, StagingWriteTracker.WriteOutcome.Success)
                Log.w(TAG, "StagingProvider: staged $filename (${file.length()} bytes)")
            } catch (e: Throwable) {
                val errorMessage = e.message ?: e.javaClass.simpleName
                stagingWrites.finish(
                    writeToken,
                    StagingWriteTracker.WriteOutcome.Failure(errorMessage),
                )
                Log.e(TAG, "StagingProvider: error writing $filename", e)
                try {
                    readEnd.closeWithError(errorMessage.take(256))
                    pipeClosedWithError = true
                } catch (closeError: Exception) {
                    Log.e(TAG, "StagingProvider: failed signaling pipe error for $filename", closeError)
                }
            } finally {
                if (tempFile.exists() && !tempFile.delete()) {
                    Log.e(TAG, "StagingProvider: failed to remove temp file ${tempFile.name}")
                }
                try {
                    input?.close()
                } catch (_: Exception) {
                    // closeWithError may already have closed the underlying descriptor.
                }
                try {
                    if (!pipeClosedWithError) readEnd.close()
                } finally {
                    stagingQuota.release(reservation)
                }
            }
        }
        try {
            worker.start()
        } catch (failure: Throwable) {
            stagingWrites.finish(
                writeToken,
                StagingWriteTracker.WriteOutcome.Failure(
                    failure.message ?: failure.javaClass.simpleName,
                ),
            )
            runCatching { readEnd.close() }
            runCatching { writeEnd.close() }
            stagingQuota.release(reservation)
            throw failure
        }

        return writeEnd
    }

    /**
     * Handle `content call --method install --arg <filename>,<filename>,...`
     *
     * Duplicate installed packages are reported to the host without mutating package state.
     * The host is responsible for a keep-data uninstall and an explicit retry.
     */
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        enforceAuthorizedCaller()
        releaseExpiredRetryLease()

        return when (method) {
            "install" -> handleInstall(arg)
            "retry_install" -> handleRetryInstall(arg)
            "cancel_install" -> handleCancelInstall(arg)
            "activate_updates" -> handleActivateUpdates(arg)
            "finalize_bootstrap_replacement" -> handleFinalizeBootstrapReplacement(arg)
            else -> {
                Log.e(TAG, "StagingProvider: unknown method '$method'")
                Bundle().apply {
                    putString(RESULT_MESSAGE, "Unknown method: $method")
                }
            }
        }
    }

    /**
     * Physical-maintenance bootstrap leaves the old injector directory intact as rollback media.
     * Only the newly activated injector can remove that exact, digest-bound inactive directory.
     */
    private fun handleFinalizeBootstrapReplacement(arg: String?): Bundle {
        val identityToken = Binder.clearCallingIdentity()
        return try {
            val request = BootstrapReplacementSafety.parseFinalizeArgument(arg)
            val activeState = installedPackageState(INJECTOR_PACKAGE)
                ?: error("Active injector package is missing")
            val inactiveDirectory = BootstrapReplacementSafety.validateCurrentAndInactivePaths(
                activeState.sourceDir,
                request,
            )
            val inactiveBaseApk = File(inactiveDirectory, "base.apk")
            if (!inactiveDirectory.exists()) {
                // PMS may remove the duplicate old package directory during its parallel data-app
                // scan. Absence is already the desired finalized state and deletes nothing else.
                return Bundle().apply { putString(RESULT_MESSAGE, "OK") }
            }
            check(inactiveDirectory.isDirectory) { "Inactive injector path is not a directory" }
            check(!Files.isSymbolicLink(inactiveDirectory.toPath())) {
                "Inactive injector directory is a symbolic link"
            }
            check(inactiveDirectory.canonicalPath == inactiveDirectory.absolutePath) {
                "Inactive injector directory is not canonical"
            }
            check(inactiveBaseApk.isFile && !Files.isSymbolicLink(inactiveBaseApk.toPath())) {
                "Inactive injector base APK is missing or invalid"
            }
            val actualDigest = sha256(inactiveBaseApk)
            check(
                MessageDigest.isEqual(
                    request.oldDigest.toByteArray(Charsets.US_ASCII),
                    actualDigest.toByteArray(Charsets.US_ASCII),
                )
            ) { "Inactive injector APK digest mismatch" }

            Files.walkFileTree(
                inactiveDirectory.toPath(),
                object : SimpleFileVisitor<java.nio.file.Path>() {
                    override fun visitFile(
                        file: java.nio.file.Path,
                        attrs: BasicFileAttributes,
                    ): FileVisitResult {
                        Files.delete(file)
                        return FileVisitResult.CONTINUE
                    }

                    override fun postVisitDirectory(
                        dir: java.nio.file.Path,
                        exc: java.io.IOException?,
                    ): FileVisitResult {
                        if (exc != null) throw exc
                        Files.delete(dir)
                        return FileVisitResult.CONTINUE
                    }
                },
            )
            check(!inactiveDirectory.exists()) { "Inactive injector directory deletion was incomplete" }
            Bundle().apply { putString(RESULT_MESSAGE, "OK") }
        } catch (failure: Throwable) {
            Log.e(TAG, "Bootstrap replacement finalization rejected", failure)
            Bundle().apply {
                putString(
                    RESULT_MESSAGE,
                    "FINALIZE_REJECTED:${failure.message ?: failure.javaClass.simpleName}",
                )
            }
        } finally {
            Binder.restoreCallingIdentity(identityToken)
        }
    }

    private fun handleActivateUpdates(arg: String?): Bundle {
        val packageNames = arg
            ?.split(",")
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()
        if (packageNames.isEmpty() || packageNames.toSet().size != packageNames.size) {
            return Bundle().apply { putString(RESULT_MESSAGE, "Invalid activation package list") }
        }

        for (packageName in packageNames) {
            if (!packageName.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))) {
                return Bundle().apply { putString(RESULT_MESSAGE, "Invalid activation package: $packageName") }
            }
            val installedState = installedPackageState(packageName)
                ?: return Bundle().apply { putString(RESULT_MESSAGE, "Activation package missing: $packageName") }
            if (
                !InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate(
                    packageName,
                    installedState.uid,
                    installedState.sourceDir,
                )
            ) {
                return Bundle().apply {
                    putString(RESULT_MESSAGE, "Activation package is not injector-managed: $packageName")
                }
            }
        }

        val identityToken = Binder.clearCallingIdentity()
        try {
            for (packageName in packageNames) {
                if (!PolicyRegistry.addTrackedPackage(providerContext(), packageName)) {
                    return Bundle().apply {
                        putString(RESULT_MESSAGE, "Failed registering update policy: $packageName")
                    }
                }
            }
            val refreshResult = LaunchPolicyInstaller.refreshPolicies(providerContext())
            val requiredPackages = packageNames.toSet()
            if (!refreshResult.succeededFor(requiredPackages)) {
                val failedRequired = requiredPackages
                    .filterNot(refreshResult.successfulPackages::contains)
                    .sorted()
                Log.e(
                    TAG,
                    "Runtime policy activation failed for $failedRequired: " +
                        (refreshResult.globalFailure ?: "package policy/app-data provisioning failed"),
                )
                return Bundle().apply {
                    putString(
                        RESULT_MESSAGE,
                        "ACTIVATION_POLICY_FAILED:${failedRequired.joinToString(",")}",
                    )
                }
            }
            clearDuplicateApproval(packageNames.toSet())
        } finally {
            Binder.restoreCallingIdentity(identityToken)
        }
        return Bundle().apply { putString(RESULT_MESSAGE, "OK") }
    }

    private fun handleInstall(arg: String?): Bundle {
        return handleSerializedInstall {
            if (retryLeases.hasPending()) {
                Bundle().apply { putString(RESULT_MESSAGE, "INSTALL_TRANSACTION_IN_PROGRESS") }
            } else {
                handleInstallRequest(arg)
            }
        }
    }

    private fun handleRetryInstall(arg: String?): Bundle {
        val token = arg?.trim().orEmpty()
        if (!token.matches(Regex("[a-f0-9]{32}"))) {
            return Bundle().apply { putString(RESULT_MESSAGE, "INVALID_INSTALL_TRANSACTION") }
        }
        return handleSerializedInstall {
            val lease = retryLeases.take(token)
                ?: return@handleSerializedInstall Bundle().apply {
                    putString(RESULT_MESSAGE, "INVALID_INSTALL_TRANSACTION")
                }
            handleInstallFiles(
                filenames = lease.identity.filenames,
                retryIdentity = lease.identity,
                claimsAlreadyHeld = true,
            )
        }
    }

    private fun handleCancelInstall(arg: String?): Bundle {
        val token = arg?.trim().orEmpty()
        if (!token.matches(Regex("[a-f0-9]{32}"))) {
            return Bundle().apply { putString(RESULT_MESSAGE, "INVALID_INSTALL_TRANSACTION") }
        }
        retryLeases.cancel(token)?.let { lease ->
            stagingWrites.release(lease.identity.filenames.toSet())
        }
        // Cancellation is idempotent: the retry may already have consumed the lease.
        return Bundle().apply { putString(RESULT_MESSAGE, "OK") }
    }

    private inline fun handleSerializedInstall(action: () -> Bundle): Bundle {
        if (installInProgress.get() || !installRequestInProgress.compareAndSet(false, true)) {
            return Bundle().apply { putString(RESULT_MESSAGE, "INSTALL_IN_PROGRESS") }
        }
        return try {
            action()
        } finally {
            installRequestInProgress.set(false)
        }
    }

    private fun handleInstallRequest(arg: String?): Bundle {
        val filenames = arg
            ?.split(",")
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()

        return handleInstallFiles(filenames, retryIdentity = null, claimsAlreadyHeld = false)
    }

    private fun handleInstallFiles(
        filenames: List<String>,
        retryIdentity: InstallBatchIdentity?,
        claimsAlreadyHeld: Boolean,
    ): Bundle {

        if (filenames.isEmpty()) {
            Log.e(TAG, "StagingProvider: install called without APK filenames")
            return Bundle().apply {
                putString(RESULT_MESSAGE, "Missing batch APK filenames")
            }
        }

        val filenameSet = filenames.toSet()
        if (filenameSet.size != filenames.size) {
            return Bundle().apply {
                putString(RESULT_MESSAGE, "Duplicate staged filename in batch")
            }
        }
        if (filenames.size > InstallBatchPolicy.MAX_BATCH_APKS) {
            return Bundle().apply {
                putString(RESULT_MESSAGE, "Install batch exceeds ${InstallBatchPolicy.MAX_BATCH_APKS} APKs")
            }
        }
        if (!claimsAlreadyHeld) {
            when (val claimError = claimStagedFiles(filenameSet)) {
                null -> Unit
                else -> return Bundle().apply { putString(RESULT_MESSAGE, claimError) }
            }
        }

        var retainClaimsForInstall = false
        try {

            val stagedApks = mutableListOf<File>()
            for (filename in filenames) {
                val stagedApk = stagedFileFor(filename)
                    ?: return Bundle().apply { putString(RESULT_MESSAGE, "Invalid filename: $filename") }
                if (!stagedApk.exists() || !stagedApk.isFile) {
                    Log.e(TAG, "StagingProvider: staged file not found: ${stagedApk.absolutePath}")
                    return Bundle().apply {
                        putString(RESULT_MESSAGE, "Staged file not found: $filename")
                    }
                }
                stagedApks += stagedApk
            }
            try {
                InstallBatchPolicy.validateSizes(stagedApks.map { it.length() })
                stagedApks.forEach(ApkArchivePolicy::validate)
            } catch (failure: IllegalArgumentException) {
                return Bundle().apply {
                    putString(RESULT_MESSAGE, failure.message ?: "Invalid install batch size")
                }
            } catch (failure: Exception) {
                Log.e(TAG, "Failed validating staged APK archive", failure)
                return Bundle().apply {
                    putString(RESULT_MESSAGE, "Invalid staged APK archive")
                }
            }

            val packages = mutableListOf<String>()
            for ((filename, stagedApk) in filenames.zip(stagedApks)) {
                val packageName = extractPackageNameForInstall(stagedApk)
                    ?: return Bundle().apply { putString(RESULT_MESSAGE, "Failed reading package name: $filename") }
                if (packages.contains(packageName)) {
                    return Bundle().apply {
                        putString(RESULT_MESSAGE, "DUPLICATE_BATCH_PACKAGE:$packageName")
                    }
                }
                packages += packageName
            }

            val appContext = providerContext()
            val packageSet = packages.toSet()
            val stagedByPackage = packages.zip(stagedApks).toMap()
            val stagedDigests = try {
                stagedByPackage.mapValues { (_, apk) -> sha256(apk) }
            } catch (failure: Exception) {
                Log.e(TAG, "Failed hashing staged APK batch", failure)
                return Bundle().apply { putString(RESULT_MESSAGE, "Failed hashing staged APK") }
            }
            val currentArtifacts = filenames.indices.map { index ->
                val packageName = packages[index]
                InstallBatchArtifact(
                    filename = filenames[index],
                    packageName = packageName,
                    stagedSha256 = stagedDigests.getValue(packageName),
                )
            }
            if (retryIdentity != null && retryIdentity.artifacts != currentArtifacts) {
                return Bundle().apply { putString(RESULT_MESSAGE, "INSTALL_TRANSACTION_MISMATCH") }
            }

            val approvalRecords = loadReplacementApprovals(stagedDigests)
            val previouslyApprovedReplacements = approvalRecords.keys
            val trackedPackages = PolicyRegistry.loadTrackedPackages(appContext)
            val installedDuplicates = mutableListOf<String>()
            val expectedLivePackagePaths = mutableMapOf<String, String>()

            for (packageName in packages) {
                val stagedApk = stagedByPackage.getValue(packageName)
                val installedState = installedPackageState(packageName)
                if (packageName == INJECTOR_PACKAGE) {
                    return Bundle().apply {
                        putString(RESULT_MESSAGE, "SELF_UPDATE_REQUIRES_BOOTSTRAP")
                    }
                }

                if (installedState != null) {
                    val strictlyManaged = InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate(
                        packageName,
                        installedState.uid,
                        installedState.sourceDir,
                    )
                    val continuityRecovered = !strictlyManaged &&
                        isEligibleForFailedUpdateContinuity(
                            packageName = packageName,
                            installedState = installedState,
                            stagedApk = stagedApk,
                            stagedDigest = stagedDigests.getValue(packageName),
                            tracked = packageName in trackedPackages,
                            priorApprovalMatches = packageName in previouslyApprovedReplacements,
                        )

                    if (!strictlyManaged && !continuityRecovered) {
                        Log.e(
                            TAG,
                            "Refusing keep-data update for $packageName with " +
                                "UID ${installedState.uid}, sourceDir=${installedState.sourceDir}"
                        )
                        return Bundle().apply {
                            putString(
                                RESULT_MESSAGE,
                                "UPDATE_NOT_ELIGIBLE:$packageName:uid=${installedState.uid}"
                            )
                        }
                    }
                    if (continuityRecovered) {
                        Log.w(
                            TAG,
                            "Admitting digest-bound failed-update continuity for $packageName " +
                                "from ${installedState.sourceDir}",
                        )
                    }
                    Log.w(TAG, "Duplicate package detected for $packageName")
                    installedDuplicates += packageName
                    expectedLivePackagePaths[packageName] = requireNotNull(installedState.sourceDir)
                }
            }

            if (installedDuplicates.isNotEmpty()) {
                if (retryIdentity != null) {
                    return Bundle().apply { putString(RESULT_MESSAGE, "RETRY_PACKAGE_STILL_LIVE") }
                }
                val states = try {
                    PackageReplacementGuard.validateBeforeUninstall(
                        packageNames = packageSet,
                        expectedLivePackagePaths = expectedLivePackagePaths,
                        approvedReplacementPaths = approvalRecords.mapValues { it.value.expectedBaseApkPath },
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "StagingProvider: pre-uninstall batch validation rejected", e)
                    return Bundle().apply {
                        putString(RESULT_MESSAGE, "REPLACEMENT_PREFLIGHT_FAILED")
                    }
                }
                val replacementPackages = installedDuplicates.toSet() + previouslyApprovedReplacements
                val approvedReplacementPaths = try {
                    bindReplacementPaths(
                        states,
                        replacementPackages,
                        approvalRecords.mapValues { it.value.expectedBaseApkPath },
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "StagingProvider: replacement identity binding rejected", e)
                    return Bundle().apply { putString(RESULT_MESSAGE, "REPLACEMENT_PREFLIGHT_FAILED") }
                }
                if (!recordReplacementApprovals(stagedDigests, approvedReplacementPaths)) {
                    return Bundle().apply { putString(RESULT_MESSAGE, "APPROVAL_PERSIST_FAILED") }
                }

                val lease = try {
                    retryLeases.create(
                        InstallBatchIdentity(
                            artifacts = currentArtifacts,
                            approvedReplacementPaths = approvedReplacementPaths,
                        )
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "StagingProvider: failed creating immutable retry lease", e)
                    return Bundle().apply { putString(RESULT_MESSAGE, "INSTALL_TRANSACTION_FAILED") }
                }
                retainClaimsForInstall = true
                return Bundle().apply {
                    putString(
                        RESULT_MESSAGE,
                        "DUPLICATE_TRANSACTION:${lease.token};" +
                            "PACKAGES:${installedDuplicates.joinToString(",")}",
                    )
                }
            }

            val stagedApksForInstall = stagedApks.toList()
            val approvedReplacementPaths = if (retryIdentity != null) {
                val durablePaths = approvalRecords.mapValues { it.value.expectedBaseApkPath }
                if (
                    durablePaths.keys != retryIdentity.approvedReplacementPaths.keys ||
                    durablePaths.any { (packageName, path) ->
                        path == null || retryIdentity.approvedReplacementPaths[packageName] != path
                    }
                ) {
                    return Bundle().apply { putString(RESULT_MESSAGE, "INSTALL_TRANSACTION_MISMATCH") }
                }
                retryIdentity.approvedReplacementPaths
            } else if (approvalRecords.isNotEmpty()) {
                val states = try {
                    PackageReplacementGuard.validateBeforeUninstall(
                        packageNames = packageSet,
                        expectedLivePackagePaths = emptyMap(),
                        approvedReplacementPaths = approvalRecords.mapValues {
                            it.value.expectedBaseApkPath
                        },
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "StagingProvider: retained replacement binding rejected", e)
                    return Bundle().apply { putString(RESULT_MESSAGE, "REPLACEMENT_PREFLIGHT_FAILED") }
                }
                val boundPaths = try {
                    bindReplacementPaths(
                        states,
                        approvalRecords.keys,
                        approvalRecords.mapValues { it.value.expectedBaseApkPath },
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "StagingProvider: retained replacement identity rejected", e)
                    return Bundle().apply { putString(RESULT_MESSAGE, "REPLACEMENT_PREFLIGHT_FAILED") }
                }
                if (!recordReplacementApprovals(stagedDigests, boundPaths)) {
                    return Bundle().apply { putString(RESULT_MESSAGE, "APPROVAL_PERSIST_FAILED") }
                }
                boundPaths
            } else {
                emptyMap()
            }

            try {
                PackageReplacementGuard.validate(packageSet, approvedReplacementPaths)
            } catch (e: Exception) {
                Log.e(TAG, "StagingProvider: replacement preflight rejected", e)
                return Bundle().apply {
                    putString(RESULT_MESSAGE, "REPLACEMENT_PREFLIGHT_FAILED")
                }
            }

            if (!installInProgress.compareAndSet(false, true)) {
                return Bundle().apply { putString(RESULT_MESSAGE, "INSTALL_IN_PROGRESS") }
            }

            Log.w(TAG, "StagingProvider: installing ${stagedApksForInstall.size} APK(s)")
            retainClaimsForInstall = true
            try {
                Thread {
                    try {
                        // Let the accepted response reach adb before the final transaction kills
                        // system_server. Install completion is established only by post-reboot
                        // verification of every returned package.
                        Thread.sleep(COMMIT_START_DELAY_MS)
                        InstallReceiver().install(
                            appContext,
                            stagedApksForInstall,
                            approvedReplacementPaths,
                            restartSystemServer = true,
                        )
                    } catch (e: Throwable) {
                        Log.e(TAG, "Install failed", e)
                    } finally {
                        // Successful commit kills this process while holding PMS.mLock. This path
                        // executes only on failure, permitting a digest-approved recovery retry.
                        installInProgress.set(false)
                        stagingWrites.release(filenameSet)
                    }
                }.start()
            } catch (e: Throwable) {
                Log.e(TAG, "Failed starting install worker", e)
                installInProgress.set(false)
                stagingWrites.release(filenameSet)
                retainClaimsForInstall = false
                return Bundle().apply { putString(RESULT_MESSAGE, "INSTALL_FAILED") }
            }

            return Bundle().apply {
                putString(
                    RESULT_MESSAGE,
                    "ACCEPTED_PACKAGES:${packages.joinToString(",")};" +
                        "REPLACEMENTS:${approvedReplacementPaths.keys.sorted().joinToString(",")}",
                )
            }
        } finally {
            if (!retainClaimsForInstall) stagingWrites.release(filenameSet)
        }
    }

    private fun approvalKey(packageName: String): String = APPROVAL_KEY_PREFIX + packageName

    private fun approvalPreferences() = context!!
        .createDeviceProtectedStorageContext()
        .getSharedPreferences(APPROVAL_PREFS, android.content.Context.MODE_PRIVATE)

    private fun isEligibleForFailedUpdateContinuity(
        packageName: String,
        installedState: InstalledPackageState,
        stagedApk: File,
        stagedDigest: String,
        tracked: Boolean,
        priorApprovalMatches: Boolean,
    ): Boolean {
        if (
            !FailedUpdateContinuityPolicy.hasRequiredProvenance(
                packageName = packageName,
                uid = installedState.uid,
                sourceDir = installedState.sourceDir,
                tracked = tracked,
                priorApprovalMatches = priorApprovalMatches,
            )
        ) {
            return false
        }

        val installedApk = File(installedState.sourceDir ?: return false)
        val expectedBytes = stagedApk.length()
        if (!FailedUpdateContinuityPolicy.isSafeRegularArtifact(installedApk, expectedBytes)) {
            return false
        }

        return try {
            val installedDigest = sha256(installedApk)
            val eligible = FailedUpdateContinuityPolicy.isEligible(
                packageName = packageName,
                uid = installedState.uid,
                sourceDir = installedState.sourceDir,
                tracked = tracked,
                priorApprovalMatches = priorApprovalMatches,
                installedArtifactIsSafe = true,
                stagedSha256 = stagedDigest,
                installedSha256 = installedDigest,
            )
            eligible &&
                FailedUpdateContinuityPolicy.isSafeRegularArtifact(installedApk, expectedBytes) &&
                installedPackageState(packageName) == installedState
        } catch (failure: Exception) {
            Log.e(TAG, "Failed verifying restored artifact continuity for $packageName", failure)
            false
        }
    }

    private fun recordReplacementApprovals(
        stagedDigests: Map<String, String>,
        approvedReplacementPaths: Map<String, String>,
    ): Boolean {
        return try {
            val editor = approvalPreferences().edit()
            for ((packageName, expectedBaseApkPath) in approvedReplacementPaths) {
                val digest = stagedDigests[packageName] ?: return false
                val encoded = ReplacementApprovalPolicy.encode(
                    packageName,
                    ReplacementApproval(digest, expectedBaseApkPath),
                )
                editor.putString(approvalKey(packageName), encoded)
            }
            editor.commit()
        } catch (e: Exception) {
            Log.e(TAG, "Failed recording durable update approval", e)
            false
        }
    }

    private fun loadReplacementApprovals(
        stagedDigests: Map<String, String>,
    ): Map<String, ReplacementApproval> {
        val prefs = approvalPreferences()
        return stagedDigests.mapNotNull { (packageName, stagedDigest) ->
            val approval = ReplacementApprovalPolicy.decode(
                packageName,
                prefs.getString(approvalKey(packageName), null),
            ) ?: return@mapNotNull null
            if (
                MessageDigest.isEqual(
                    approval.stagedSha256.toByteArray(Charsets.US_ASCII),
                    stagedDigest.toByteArray(Charsets.US_ASCII),
                )
            ) {
                packageName to approval
            } else {
                null
            }
        }.toMap()
    }

    private fun bindReplacementPaths(
        states: Map<String, PackageReplacementGuard.PackageState>,
        replacementPackages: Set<String>,
        approvedExpectedPaths: Map<String, String?>,
    ): Map<String, String> = replacementPackages.associateWith { packageName ->
        val state = states[packageName]
            ?: error("Replacement package $packageName has no PMS state")
        val approvedPath = approvedExpectedPaths[packageName]
        val priorCodeDirectoryExists = if (
            state is PackageReplacementGuard.PackageState.Missing && approvedPath != null
        ) {
            File(approvedPath).parentFile?.exists() == true
        } else {
            false
        }
        ReplacementPathBindingPolicy.bind(
            packageName = packageName,
            state = state,
            approvedExpectedBaseApkPath = approvedPath,
            priorCodeDirectoryExists = priorCodeDirectoryExists,
        )
    }

    private fun clearDuplicateApproval(packageNames: Set<String>) {
        try {
            val editor = approvalPreferences().edit()
            packageNames.forEach { editor.remove(approvalKey(it)) }
            if (!editor.commit()) {
                Log.e(TAG, "Failed clearing committed update approvals for $packageNames")
            }
        } catch (e: Exception) {
            // The package transaction is already committed; a stale digest-bound approval is
            // safer than reporting failure for an install that will become live after restart.
            Log.e(TAG, "Failed clearing committed update approvals for $packageNames", e)
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read == -1) break
                if (read > 0) digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun claimStagedFiles(filenames: Set<String>): String? {
        val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(STAGING_WRITE_TIMEOUT_MS)
        while (true) {
            when (val claim = stagingWrites.claim(filenames)) {
                StagingWriteTracker.ClaimResult.Claimed -> return null
                is StagingWriteTracker.ClaimResult.Rejected -> return claim.message
                is StagingWriteTracker.ClaimResult.Busy -> {
                    for (write in claim.writes) {
                        val remainingNanos = deadlineNanos - System.nanoTime()
                        if (remainingNanos <= 0) return "Timed out waiting for staged APK write"
                        val remainingMillis = TimeUnit.NANOSECONDS.toMillis(remainingNanos).coerceAtLeast(1)
                        try {
                            when (val outcome = write.await(remainingMillis)) {
                                StagingWriteTracker.WriteOutcome.Success -> Unit
                                is StagingWriteTracker.WriteOutcome.Failure -> {
                                    return "Staging write failed: ${outcome.message}"
                                }
                            }
                        } catch (e: Exception) {
                            return "Failed waiting for staged APK write: ${e.message ?: e.javaClass.simpleName}"
                        }
                    }
                }
            }
        }
    }

    private fun releaseExpiredRetryLease() {
        retryLeases.removeExpired()?.let { expired ->
            stagingWrites.release(expired.identity.filenames.toSet())
            Log.e(TAG, "Expired install retry transaction ${expired.token}")
        }
    }

    private fun stagedFileFor(filename: String): File? {
        if (!StagingFilenamePolicy.isValid(filename)) {
            Log.e(TAG, "Invalid filename: $filename")
            return null
        }
        return File(stagingDir(), filename)
    }

    private fun extractPackageNameForInstall(stagedApk: File): String? {
        return try {
            ApkPatcher.extractPackageName(stagedApk)
        } catch (e: Exception) {
            Log.e(TAG, "Failed reading package name from staged APK", e)
            null
        }
    }

    override fun onCreate(): Boolean {
        stagingDir().listFiles { file -> file.name.startsWith(".") && file.name.endsWith(".tmp") }
            ?.forEach { staleTemp ->
                if (!staleTemp.delete()) {
                    Log.e(TAG, "StagingProvider: failed removing stale temp file ${staleTemp.name}")
                }
            }
        return true
    }

    // Required overrides — not otherwise used
    override fun query(u: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? {
        enforceAuthorizedCaller()
        return null
    }

    override fun getType(uri: Uri): String? {
        enforceAuthorizedCaller()
        return "application/vnd.android.package-archive"
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? {
        enforceAuthorizedCaller()
        return null
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int {
        enforceAuthorizedCaller()
        if (uri.pathSegments.size != 1) return 0
        val filename = uri.lastPathSegment ?: return 0
        if (!StagingFilenamePolicy.isValid(filename) || !stagingWrites.claimForDiscard(filename)) {
            return 0
        }
        return try {
            val file = File(stagingDir(), filename)
            if (!file.exists() || file.delete()) 1 else 0
        } finally {
            stagingWrites.release(setOf(filename))
        }
    }

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int {
        enforceAuthorizedCaller()
        return 0
    }
}
