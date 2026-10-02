package com.penumbraos.systeminjector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.system.Os
import android.util.Log
import com.penumbraos.systeminjector.runtimepolicy.PolicyRegistry
import java.io.File
import java.util.zip.ZipFile

/**
 * Broadcast receiver for the installer (runs as UID 1000 in system_server).
 *
 * Receives: com.penumbraos.systeminjector.INSTALL
 * With the extra: apk_path (String). The path to the APK to install.
 *
 * Flow:
 *   1. Patch manifest (add sharedUserId)
 *   2. Re-sign with embedded keystore
 *   3. Verify cert matches TARGET_CERT_HEX
 *   4. Copy signed APK to /data/app/<dirname>/base.apk
 *   5. Register the package in packages.xml
 *   6. Write packages-backup.xml
 *   7. Kill system_server (triggers reboot, PMS reads new packages-backup.xml)
 */
class InstallReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "LumaInstaller"
        private const val APP_DIR_CLEANUP_TIMEOUT_MS = 10_000L
        private const val APP_DIR_CLEANUP_POLL_MS = 100L
        const val ACTION_INSTALL = "com.penumbraos.systeminjector.INSTALL"
        const val EXTRA_APK_PATH = "apk_path"

        /** ABI string to instruction set name, matching VMRuntime.ABI_TO_INSTRUCTION_SET_MAP */
        private val ABI_TO_INSTRUCTION_SET = mapOf(
            "arm64-v8a" to "arm64",
            "armeabi-v7a" to "arm",
            "x86" to "x86",
            "x86_64" to "x86_64"
        )
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_INSTALL) return

        val apkPath = intent.getStringExtra(EXTRA_APK_PATH)
        if (apkPath.isNullOrBlank()) {
            Log.e(TAG, "Missing apk_path extra")
            return
        }

        Thread {
            try {
                install(context, listOf(File(apkPath)))
            } catch (e: SecurityException) {
                // Safety abort, cert mismatch, do NOT proceed
                Log.e(TAG, "SAFETY ABORT: ${e.message}")
            } catch (e: Exception) {
                Log.e(TAG, "Install failed", e)
            }
        }.start()
    }

    private data class PreparedInstall(
        val packageName: String,
        val signedApk: File,
        val appDir: File,
        val replaceExisting: Boolean,
        val workDir: File,
        val inputApk: File,
    )

    private data class WrittenInstalls(
        val registrations: List<PackageRegistryWriter.Registration>,
        val createdAppDirs: List<File>,
    )

    /** Install one or more APK files and apply them with one packages-backup.xml write/restart. */
    fun install(
        context: Context,
        inputApks: List<File>,
        approvedReplacementPaths: Map<String, String> = emptyMap(),
        restartSystemServer: Boolean = true,
    ) {
        require(inputApks.isNotEmpty()) { "No APKs supplied for install" }
        Log.w(TAG, "Starting install of ${inputApks.size} APK(s)")

        val missingApk = inputApks.firstOrNull { !it.exists() }
        if (missingApk != null) {
            Log.e(TAG, "APK not found: ${missingApk.absolutePath}")
            throw IllegalStateException("APK not found: ${missingApk.absolutePath}")
        }

        val inputPackageNames = inputApks.map { ApkPatcher.extractPackageName(it) }.toSet()
        check(inputPackageNames.size == inputApks.size) { "Batch contains duplicate package names" }
        PackageReplacementGuard.validate(inputPackageNames, approvedReplacementPaths)

        val prepared = prepareInstalls(context, inputApks, approvedReplacementPaths.keys)
        val trackedPackagesBeforeInstall = PolicyRegistry.loadTrackedPackages(context)
        var written: WrittenInstalls? = null
        try {
            check(prepared.map { it.packageName }.toSet() == inputPackageNames) {
                "Package names changed while preparing staged APKs"
            }
            // Patch/sign work can be slow. Re-read PMS before touching /data/app so a package that
            // appeared after provider preflight is rejected before its code or settings are changed.
            PackageReplacementGuard.validate(inputPackageNames, approvedReplacementPaths)
            val completedWrites = writePreparedInstalls(prepared, approvedReplacementPaths)
            written = completedWrites
            registerRuntimePolicies(context, prepared)
            cleanupPreparedInstalls(prepared)
            // Validation and settings mutation share the same PMS lock scope, so a concurrent
            // package operation cannot insert a live entry between the two operations. For a
            // live install, kill system_server without releasing the lock so no normal PMS write
            // can replace the pending packages-backup.xml transaction.
            PackageReplacementGuard.withValidatedLock(
                inputPackageNames,
                approvedReplacementPaths,
            ) {
                PackageRegistryWriter.writeBatch(completedWrites.registrations)
                if (restartSystemServer) {
                    Log.w(TAG, "Killing system_server while holding PMS lock...")
                    Os.kill(Os.getpid(), 9)
                    // SIGKILL should never return control to this process. If it is delayed,
                    // retain the PMS lock rather than exposing the committed backup to a writer.
                    // Interrupts must not unwind this scope and release PMS.mLock.
                    while (true) {
                        try {
                            Thread.sleep(Long.MAX_VALUE)
                        } catch (_: InterruptedException) {
                            // Keep waiting with the lock held until SIGKILL terminates the process.
                        }
                    }
                }
            }
        } catch (e: Throwable) {
            if (!PolicyRegistry.replaceTrackedPackages(context, trackedPackagesBeforeInstall)) {
                Log.e(TAG, "Failed rolling back runtime policy registry after install failure")
            }
            cleanupPreparedInstalls(prepared)
            written?.let { cleanupCreatedAppDirs(it.createdAppDirs) }
            throw e
        }
        Log.w(TAG, "packages-backup.xml written for ${prepared.size} package(s)")
    }

    private fun prepareInstalls(
        context: Context,
        inputApks: List<File>,
        approvedReplacements: Set<String>,
    ): List<PreparedInstall> {
        val prepared = mutableListOf<PreparedInstall>()
        val workDirs = mutableListOf<File>()

        try {
            for ((index, inputApk) in inputApks.withIndex()) {
                Log.w(TAG, "Preparing install of ${inputApk.absolutePath}")

                val safeName = inputApk.name.replace(Regex("[^A-Za-z0-9._-]"), "_")
                val workDir = File(context.cacheDir, "patch_work_${System.nanoTime()}_${index}_$safeName")
                workDirs += workDir
                val result = ApkPatcher.patch(
                    inputApk = inputApk,
                    assetOpener = context.assets::open,
                    workDir = workDir
                )
                check(
                    result.signedApk.isFile &&
                        result.signedApk.length() >= 1L &&
                        result.signedApk.length() <= StagingIo.MAX_STAGED_APK_BYTES
                ) { "Patched APK has an invalid size" }

                Log.w(TAG, "Patched package: ${result.packageName}")

                val appDirName = "${result.packageName}-injected"
                val appDir = File("/data/app/$appDirName")

                prepared += PreparedInstall(
                    packageName = result.packageName,
                    signedApk = result.signedApk,
                    appDir = appDir,
                    replaceExisting = result.packageName in approvedReplacements,
                    workDir = workDir,
                    inputApk = inputApk,
                )
            }
            return prepared
        } catch (failure: Throwable) {
            workDirs.asReversed().forEach { workDir ->
                runCatching { workDir.deleteRecursively() }
                    .onFailure { Log.e(TAG, "Failed cleaning patch work directory", it) }
            }
            inputApks.forEach { inputApk ->
                runCatching { if (inputApk.exists()) inputApk.delete() }
                    .onFailure { Log.e(TAG, "Failed cleaning staged APK", it) }
            }
            throw failure
        }
    }

    private fun writePreparedInstalls(
        prepared: List<PreparedInstall>,
        approvedReplacementPaths: Map<String, String>,
    ): WrittenInstalls {
        prepared.forEach(::waitForAppDirRemoval)
        PackageReplacementGuard.validate(
            packageNames = prepared.map { it.packageName }.toSet(),
            approvedReplacementPaths = approvedReplacementPaths,
        )
        val createdAppDirs = mutableListOf<File>()
        try {
            val registrations = prepared.map { install ->
                check(install.appDir.mkdirs()) {
                    "Failed to create app directory: ${install.appDir.absolutePath}"
                }
                createdAppDirs += install.appDir
                Os.chmod(install.appDir.absolutePath, 505) // 0771

                val targetApk = File(install.appDir, "base.apk")
                check(
                    install.signedApk.length() >= 1L &&
                        install.signedApk.length() <= StagingIo.MAX_STAGED_APK_BYTES
                ) { "Signed APK has an invalid size" }
                install.signedApk.inputStream().use { input ->
                    targetApk.outputStream().use { output ->
                        StagingIo.copyBounded(input, output)
                        output.fd.sync()
                    }
                }
                Os.chmod(targetApk.absolutePath, 420) // 0644
                Log.w(TAG, "APK copied to ${targetApk.absolutePath}")

                val primaryCpuAbi = extractNativeLibs(targetApk, install.appDir)
                if (primaryCpuAbi != null) {
                    Log.w(TAG, "Extracted native libs for ABI: $primaryCpuAbi")
                }

                PackageRegistryWriter.Registration(
                    packageName = install.packageName,
                    codePath = install.appDir.absolutePath,
                    sharedUserId = 1000,
                    primaryCpuAbi = primaryCpuAbi,
                    replaceExisting = install.replaceExisting,
                )
            }
            return WrittenInstalls(registrations, createdAppDirs.toList())
        } catch (e: Exception) {
            cleanupCreatedAppDirs(createdAppDirs)
            throw e
        }
    }

    private fun cleanupCreatedAppDirs(appDirs: Collection<File>) {
        for (appDir in appDirs.toList().asReversed()) {
            try {
                if (!appDir.deleteRecursively()) {
                    Log.e(TAG, "Failed rolling back app directory: ${appDir.absolutePath}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed rolling back app directory: ${appDir.absolutePath}", e)
            }
        }
    }

    private fun waitForAppDirRemoval(install: PreparedInstall) {
        if (!install.appDir.exists()) return
        if (!install.replaceExisting) {
            throw IllegalStateException(
                "Refusing to overwrite existing app directory: ${install.appDir.absolutePath}"
            )
        }

        val deadlineNanos = System.nanoTime() + APP_DIR_CLEANUP_TIMEOUT_MS * 1_000_000L
        while (install.appDir.exists() && System.nanoTime() < deadlineNanos) {
            Thread.sleep(APP_DIR_CLEANUP_POLL_MS)
        }
        check(!install.appDir.exists()) {
            "Timed out waiting for Package Manager to remove old code directory: " +
                install.appDir.absolutePath
        }
    }

    private fun registerRuntimePolicies(context: Context, prepared: List<PreparedInstall>) {
        for (install in prepared) {
            check(PolicyRegistry.addTrackedPackage(context, install.packageName)) {
                "Failed to register ${install.packageName} for runtime seInfo policy"
            }
        }
    }

    private fun cleanupPreparedInstalls(prepared: List<PreparedInstall>) {
        for (install in prepared) {
            try {
                if (install.workDir.exists() && !install.workDir.deleteRecursively()) {
                    Log.e(TAG, "Failed deleting patch work directory: ${install.workDir.absolutePath}")
                }
                if (install.inputApk.exists() && !install.inputApk.delete()) {
                    Log.e(TAG, "Failed deleting staged APK: ${install.inputApk.absolutePath}")
                }
            } catch (e: Exception) {
                // Package settings are already committed. Cache cleanup must not turn success
                // into an ambiguous failure response.
                Log.e(TAG, "Failed cleaning install cache for ${install.packageName}", e)
            }
        }
    }

    /**
     * Extract native libraries from an APK to appDir/lib/<ISA>/.
     *
     * Scans the APK zip for entries matching lib/<abi>/\*.so and extracts them
     * to the on-disk layout PMS expects for cluster installs:
     *   <appDir>/lib/<instructionSet>/<name>.so
     *
     * For example, lib/arm64-v8a/liblsplant.so -> <appDir>/lib/arm64/liblsplant.so
     *
     * @param apkFile The APK file to extract from (must already be on disk)
     * @param appDir The app install directory (e.g. /data/app/com.example-injected)
     * @return The ABI string (e.g. "arm64-v8a") if native libs were found, null otherwise
     */
    private fun extractNativeLibs(apkFile: File, appDir: File): String? {
        var detectedAbi: String? = null
        var zipEntryCount = 0
        var nativeLibraryCount = 0
        var totalExtractedBytes = 0L
        val extractedNames = mutableSetOf<String>()

        ZipFile(apkFile).use { zip ->
            for (entry in zip.entries()) {
                zipEntryCount += 1
                check(zipEntryCount <= NativeLibraryPolicy.MAX_ZIP_ENTRIES) {
                    "APK exceeds native-library ZIP entry scan limit"
                }
                if (entry.isDirectory) continue
                val name = entry.name

                // Match lib/<abi>/<something>.so
                if (!name.startsWith("lib/") || !name.endsWith(".so")) continue
                val parts = name.split("/")
                if (parts.size != 3) continue

                val abi = parts[1]
                val soName = parts[2]
                val instructionSet = ABI_TO_INSTRUCTION_SET[abi] ?: continue
                check(NativeLibraryPolicy.isSafeLibraryName(soName)) {
                    "Unsafe native library filename: $name"
                }
                nativeLibraryCount += 1
                check(nativeLibraryCount <= NativeLibraryPolicy.MAX_NATIVE_LIBRARIES) {
                    "APK exceeds native library count limit"
                }

                // Use the first ABI we encounter
                if (detectedAbi == null) {
                    detectedAbi = abi
                }

                // Only extract for the first ABI (don't mix ABIs)
                if (abi != detectedAbi) continue
                check(extractedNames.add(soName)) {
                    "Duplicate native library filename for selected ABI: $soName"
                }

                val declaredSize = entry.size
                check(
                    NativeLibraryPolicy.fitsExtractionSizeLimits(
                        libraryBytes = declaredSize,
                        previouslyExtractedBytes = totalExtractedBytes,
                    )
                ) { "Native library exceeds extraction size limit: $name" }

                val libDir = File(appDir, "lib/$instructionSet")
                libDir.mkdirs()
                Os.chmod(libDir.parentFile!!.absolutePath, 493) // 0755
                Os.chmod(libDir.absolutePath, 493) // 0755

                val outFile = File(libDir, soName)
                val remainingTotal = NativeLibraryPolicy.MAX_TOTAL_LIBRARY_BYTES - totalExtractedBytes
                val copyLimit = minOf(
                    NativeLibraryPolicy.MAX_SINGLE_LIBRARY_BYTES,
                    remainingTotal,
                )
                val copiedBytes = try {
                    zip.getInputStream(entry).use { input ->
                        outFile.outputStream().use { output ->
                            StagingIo.copyBounded(input, output, copyLimit)
                        }
                    }
                } catch (limit: StagingSizeLimitExceededException) {
                    throw IllegalStateException(
                        "Native library exceeded extraction limit: $name",
                        limit,
                    )
                }
                check(copiedBytes == declaredSize) {
                    "Native library size changed during extraction: $name"
                }
                totalExtractedBytes += copiedBytes
                Os.chmod(outFile.absolutePath, 493) // 0755
                Log.w(TAG, "Extracted: $name -> ${outFile.absolutePath}")
            }
        }

        return detectedAbi
    }
}
