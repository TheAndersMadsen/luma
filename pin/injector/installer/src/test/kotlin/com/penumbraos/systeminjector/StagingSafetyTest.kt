package com.penumbraos.systeminjector

import com.penumbraos.systeminjector.runtimepolicy.LaunchPolicyInstaller
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class StagingSafetyTest {
    private class FakeSettings(val mPackages: Map<String, Any>)

    private class FakeLivePackage(private val baseApkPath: String) {
        fun getBaseApkPath(): String = baseApkPath
    }

    @Test
    fun `only privileged and adb caller UIDs are authorized`() {
        assertTrue(StagingAccessPolicy.isAuthorized(0))
        assertTrue(StagingAccessPolicy.isAuthorized(1000))
        assertTrue(StagingAccessPolicy.isAuthorized(2000))

        assertFalse(StagingAccessPolicy.isAuthorized(-1))
        assertFalse(StagingAccessPolicy.isAuthorized(999))
        assertFalse(StagingAccessPolicy.isAuthorized(1001))
        assertFalse(StagingAccessPolicy.isAuthorized(1999))
        assertFalse(StagingAccessPolicy.isAuthorized(2001))
    }

    @Test
    fun `keep-data updates require injector path and system shared app ID`() {
        assertTrue(
            InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate(
                "com.example.app",
                1000,
                "/data/app/com.example.app-injected/base.apk",
            )
        )
        assertTrue(
            InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate(
                "com.example.app",
                101000,
                "/data/app/com.example.app-injected/base.apk",
            )
        )
        assertFalse(
            InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate(
                "com.example.app",
                10123,
                "/data/app/com.example.app-injected/base.apk",
            )
        )
        assertFalse(
            InjectorManagedPackagePolicy.isEligibleForKeepDataUpdate(
                "com.example.app",
                1000,
                "/data/app/~~random/com.example.app-random/base.apk",
            )
        )
    }

    @Test
    fun `failed update continuity requires every exact provenance gate`() {
        val packageName = "com.penumbraos.server"
        val randomizedSource =
            "/data/app/~~KbdWg25D7Im5LfFCIGgoVw==/" +
                "$packageName-YlA7YoI9r3RuH_dF88r8eA==/base.apk"
        val digest = "a".repeat(64)

        fun eligible(
            candidatePackage: String = packageName,
            uid: Int = 1000,
            sourceDir: String? = randomizedSource,
            tracked: Boolean = true,
            priorApprovalMatches: Boolean = true,
            installedArtifactIsSafe: Boolean = true,
            stagedSha256: String = digest,
            installedSha256: String = digest,
        ): Boolean = FailedUpdateContinuityPolicy.isEligible(
            packageName = candidatePackage,
            uid = uid,
            sourceDir = sourceDir,
            tracked = tracked,
            priorApprovalMatches = priorApprovalMatches,
            installedArtifactIsSafe = installedArtifactIsSafe,
            stagedSha256 = stagedSha256,
            installedSha256 = installedSha256,
        )

        assertTrue(eligible())
        assertFalse(
            eligible(
                candidatePackage = "com.penumbraos.systeminjector",
                sourceDir =
                    "/data/app/~~safe/com.penumbraos.systeminjector-random/base.apk",
            )
        )
        assertFalse(eligible(uid = 101000))
        assertFalse(eligible(tracked = false))
        assertFalse(eligible(priorApprovalMatches = false))
        assertFalse(eligible(installedArtifactIsSafe = false))
        assertFalse(eligible(installedSha256 = "b".repeat(64)))
        assertFalse(eligible(stagedSha256 = "not-a-digest"))
        assertFalse(eligible(sourceDir = "/data/app/$packageName-injected/base.apk"))
        assertFalse(eligible(sourceDir = "/data/app/$packageName-random/base.apk"))
        assertFalse(
            eligible(
                sourceDir =
                    "/data/app/~~safe/${packageName}.helper-random/base.apk"
            )
        )
        assertFalse(
            eligible(
                sourceDir =
                    "/data/app/~~safe/$packageName-random/../other/base.apk"
            )
        )
    }

    @Test
    fun `failed update continuity accepts only an exact regular artifact`() {
        val testRoot = Files.createTempDirectory(
            File(".").absoluteFile.toPath().normalize(),
            "continuity-policy-",
        ).toFile()
        try {
            val artifact = File(testRoot, "base.apk")
            artifact.writeBytes(byteArrayOf(1, 2, 3, 4))
            assertTrue(FailedUpdateContinuityPolicy.isSafeRegularArtifact(artifact, 4L))
            assertFalse(FailedUpdateContinuityPolicy.isSafeRegularArtifact(artifact, 3L))
            assertFalse(
                FailedUpdateContinuityPolicy.isSafeRegularArtifact(
                    artifact,
                    StagingIo.MAX_STAGED_APK_BYTES + 1L,
                )
            )

            val symlink = File(testRoot, "linked.apk")
            Files.createSymbolicLink(symlink.toPath(), artifact.toPath())
            assertFalse(FailedUpdateContinuityPolicy.isSafeRegularArtifact(symlink, 4L))
        } finally {
            testRoot.deleteRecursively()
        }
    }

    @Test
    fun `bounded copy accepts a payload exactly at the limit`() {
        val payload = byteArrayOf(1, 2, 3, 4)
        val output = ByteArrayOutputStream()

        val copied = StagingIo.copyBounded(
            input = ByteArrayInputStream(payload),
            output = output,
            maxBytes = payload.size.toLong(),
        )

        assertEquals(payload.size.toLong(), copied)
        assertArrayEquals(payload, output.toByteArray())
    }

    @Test
    fun `bounded copy rejects bytes beyond the limit`() {
        val output = ByteArrayOutputStream()

        assertThrows(StagingSizeLimitExceededException::class.java) {
            StagingIo.copyBounded(
                input = ByteArrayInputStream(byteArrayOf(1, 2, 3, 4, 5)),
                output = output,
                maxBytes = 4,
            )
        }
        assertTrue(output.size() <= 4)
    }

    @Test
    fun `replacement guard allows approved retained setting with stale parsed package`() {
        val baseApkPath = "/data/app/com.example.app-injected/base.apk"
        val retainedAfterKeepDataUninstall = PackageReplacementGuard.classifySetting(
            sharedUserId = 1000,
            hasParsedPackage = true,
            settingBaseApkPath = baseApkPath,
            liveBaseApkPath = null,
        )

        assertEquals(
            PackageReplacementGuard.PackageState.Retained(
                sharedUserId = 1000,
                hasParsedPackage = true,
                baseApkPath = baseApkPath,
            ),
            retainedAfterKeepDataUninstall,
        )
        assertTrue(
            PackageReplacementGuard.isAllowed(
                retainedAfterKeepDataUninstall,
                replacementApproved = true,
                expectedBaseApkPath = baseApkPath,
            )
        )
    }

    @Test
    fun `replacement guard rejects actual live duplicate despite replacement approval`() {
        val baseApkPath = "/data/app/com.example.app-injected/base.apk"
        val liveDuplicate = PackageReplacementGuard.classifySetting(
            sharedUserId = 1000,
            hasParsedPackage = true,
            settingBaseApkPath = baseApkPath,
            liveBaseApkPath = baseApkPath,
        )

        assertEquals(PackageReplacementGuard.PackageState.Live(1000, baseApkPath), liveDuplicate)
        assertFalse(
            PackageReplacementGuard.isAllowed(
                liveDuplicate,
                replacementApproved = true,
                expectedBaseApkPath = baseApkPath,
            )
        )
    }

    @Test
    fun `replacement guard keeps approval and system shared UID gates`() {
        val baseApkPath = "/data/app/com.example.app-injected/base.apk"
        assertFalse(
            PackageReplacementGuard.isAllowed(
                PackageReplacementGuard.PackageState.Retained(
                    sharedUserId = 10123,
                    hasParsedPackage = true,
                    baseApkPath = baseApkPath,
                ),
                replacementApproved = true,
                expectedBaseApkPath = baseApkPath,
            )
        )
        assertTrue(
            PackageReplacementGuard.isAllowed(
                PackageReplacementGuard.PackageState.Missing,
                replacementApproved = false,
            )
        )
        assertFalse(
            PackageReplacementGuard.isAllowed(
                PackageReplacementGuard.PackageState.Retained(
                    sharedUserId = 1000,
                    hasParsedPackage = true,
                    baseApkPath = baseApkPath,
                ),
                replacementApproved = false,
            )
        )
        assertFalse(
            PackageReplacementGuard.isAllowed(
                PackageReplacementGuard.PackageState.Retained(
                    sharedUserId = 1000,
                    hasParsedPackage = true,
                    baseApkPath = baseApkPath,
                ),
                replacementApproved = true,
                expectedBaseApkPath = "/data/app/com.example.other-injected/base.apk",
            )
        )
    }

    @Test
    fun `approved missing package reuses only an absent controlled prior path`() {
        val packageName = "com.penumbraos.hook.injector"
        val approvedPath = "/data/app/$packageName-injected/base.apk"

        assertEquals(
            approvedPath,
            ReplacementPathBindingPolicy.bind(
                packageName = packageName,
                state = PackageReplacementGuard.PackageState.Missing,
                approvedExpectedBaseApkPath = approvedPath,
                priorCodeDirectoryExists = false,
            ),
        )
        assertThrows(IllegalStateException::class.java) {
            ReplacementPathBindingPolicy.bind(
                packageName = packageName,
                state = PackageReplacementGuard.PackageState.Missing,
                approvedExpectedBaseApkPath = approvedPath,
                priorCodeDirectoryExists = true,
            )
        }
        assertThrows(IllegalStateException::class.java) {
            ReplacementPathBindingPolicy.bind(
                packageName = packageName,
                state = PackageReplacementGuard.PackageState.Missing,
                approvedExpectedBaseApkPath = null,
                priorCodeDirectoryExists = false,
            )
        }
        assertThrows(IllegalStateException::class.java) {
            ReplacementPathBindingPolicy.bind(
                packageName = packageName,
                state = PackageReplacementGuard.PackageState.Missing,
                approvedExpectedBaseApkPath = "/data/app/com.example.other-injected/base.apk",
                priorCodeDirectoryExists = false,
            )
        }
    }

    @Test
    fun `pre-uninstall validation proves live server and retained hook as one batch`() {
        val server = "com.penumbraos.server"
        val hook = "com.penumbraos.hook"
        val fresh = "com.penumbraos.fresh"
        val serverPath =
            "/data/app/~~safe/$server-random/base.apk"
        val hookPath = "/data/app/$hook-injected/base.apk"
        val validStates = mapOf(
            server to PackageReplacementGuard.PackageState.Live(
                sharedUserId = 1000,
                baseApkPath = serverPath,
            ),
            hook to PackageReplacementGuard.PackageState.Retained(
                sharedUserId = 1000,
                hasParsedPackage = false,
                baseApkPath = hookPath,
            ),
            fresh to PackageReplacementGuard.PackageState.Missing,
        )

        PackageReplacementGuard.validateBeforeUninstallStates(
            states = validStates,
            expectedLivePackagePaths = mapOf(server to serverPath),
            approvedReplacementPaths = mapOf(server to serverPath, hook to hookPath),
        )

        assertThrows(IllegalStateException::class.java) {
            PackageReplacementGuard.validateBeforeUninstallStates(
                states = validStates,
                expectedLivePackagePaths = mapOf(server to serverPath),
                approvedReplacementPaths = mapOf(server to serverPath),
            )
        }
        assertThrows(IllegalStateException::class.java) {
            PackageReplacementGuard.validateBeforeUninstallStates(
                states = validStates +
                    (server to PackageReplacementGuard.PackageState.Live(10123, serverPath)),
                expectedLivePackagePaths = mapOf(server to serverPath),
                approvedReplacementPaths = mapOf(server to serverPath, hook to hookPath),
            )
        }
        assertThrows(IllegalStateException::class.java) {
            PackageReplacementGuard.validateBeforeUninstallStates(
                states = validStates +
                    (server to PackageReplacementGuard.PackageState.Retained(
                        sharedUserId = 1000,
                        baseApkPath = serverPath,
                    )),
                expectedLivePackagePaths = mapOf(server to serverPath),
                approvedReplacementPaths = mapOf(server to serverPath, hook to hookPath),
            )
        }
        assertThrows(IllegalStateException::class.java) {
            PackageReplacementGuard.validateBeforeUninstallStates(
                states = validStates +
                    (hook to PackageReplacementGuard.PackageState.Live(1000, hookPath)),
                expectedLivePackagePaths = mapOf(server to serverPath),
                approvedReplacementPaths = mapOf(server to serverPath, hook to hookPath),
            )
        }
        assertThrows(IllegalStateException::class.java) {
            PackageReplacementGuard.validateBeforeUninstallStates(
                states = validStates,
                expectedLivePackagePaths = mapOf(
                    server to "/data/app/~~other/$server-replaced/base.apk"
                ),
                approvedReplacementPaths = mapOf(server to serverPath, hook to hookPath),
            )
        }
        assertThrows(IllegalStateException::class.java) {
            PackageReplacementGuard.validateBeforeUninstallStates(
                states = validStates,
                expectedLivePackagePaths = mapOf(server to serverPath),
                approvedReplacementPaths = mapOf(
                    server to "/data/app/~~old/$server-old/base.apk",
                    hook to hookPath,
                ),
            )
        }
    }

    @Test
    fun `live package without Settings entry is inconsistent rather than fresh`() {
        val packageName = "com.example.app"
        val livePath = "/data/app/~~safe/com.example.app-random/base.apk"
        val inconsistent = PackageReplacementGuard.inspectLocked(
            settings = FakeSettings(emptyMap()),
            livePackages = mutableMapOf<String, Any>(
                packageName to FakeLivePackage(livePath)
            ),
            packageName = packageName,
        )

        assertEquals(
            PackageReplacementGuard.PackageState.InconsistentLive(livePath, null),
            inconsistent,
        )
        assertFalse(
            PackageReplacementGuard.isAllowed(
                inconsistent,
                replacementApproved = false,
            )
        )
    }

    @Test
    fun `concurrent package replacement cannot change retained identity before retry`() {
        val packageName = "com.penumbraos.server"
        val provenPath = "/data/app/~~proven/$packageName-proven/base.apk"
        val replacementPath = "/data/app/~~raced/$packageName-raced/base.apk"

        PackageReplacementGuard.validateBeforeUninstallStates(
            states = mapOf(
                packageName to PackageReplacementGuard.PackageState.Live(1000, provenPath)
            ),
            expectedLivePackagePaths = mapOf(packageName to provenPath),
            approvedReplacementPaths = mapOf(packageName to null),
        )

        assertFalse(
            PackageReplacementGuard.isAllowed(
                state = PackageReplacementGuard.PackageState.Retained(
                    sharedUserId = 1000,
                    baseApkPath = replacementPath,
                ),
                replacementApproved = true,
                expectedBaseApkPath = provenPath,
            )
        )
    }

    @Test
    fun `durable replacement approval binds digest to exact retained code path`() {
        val packageName = "com.penumbraos.server"
        val path = "/data/app/~~safe/$packageName-random/base.apk"
        val approval = ReplacementApproval("a".repeat(64), path)
        val encoded = ReplacementApprovalPolicy.encode(packageName, approval)

        assertEquals(approval, ReplacementApprovalPolicy.decode(packageName, encoded))
        assertEquals(
            ReplacementApproval("b".repeat(64), expectedBaseApkPath = null),
            ReplacementApprovalPolicy.decode(packageName, "b".repeat(64)),
        )
        assertEquals(null, ReplacementApprovalPolicy.decode(packageName, "v2:bad:not-base64"))
        assertThrows(IllegalArgumentException::class.java) {
            ReplacementApprovalPolicy.encode(
                packageName,
                approval.copy(expectedBaseApkPath = "/data/app/com.example.other-injected/base.apk"),
            )
        }
    }

    @Test
    fun `staging tracker waits for atomic completion and blocks claimed rewrites`() {
        val tracker = StagingWriteTracker()
        val token = tracker.begin("app.apk")
        val busy = tracker.claim(setOf("app.apk"))
        assertTrue(busy is StagingWriteTracker.ClaimResult.Busy)

        tracker.finish(token, StagingWriteTracker.WriteOutcome.Success)
        assertEquals(StagingWriteTracker.WriteOutcome.Success, token.await(100))
        assertEquals(
            StagingWriteTracker.ClaimResult.Claimed,
            tracker.claim(setOf("app.apk")),
        )
        assertThrows(IllegalStateException::class.java) {
            tracker.begin("app.apk")
        }

        tracker.release(setOf("app.apk"))
        val failedToken = tracker.begin("app.apk")
        tracker.finish(failedToken, StagingWriteTracker.WriteOutcome.Failure("too large"))
        val rejected = tracker.claim(setOf("app.apk"))
        assertTrue(rejected is StagingWriteTracker.ClaimResult.Rejected)
    }

    @Test
    fun `duplicate response lease keeps ordered staged siblings immutable through retry`() {
        val tracker = StagingWriteTracker()
        val batch = setOf("update.apk", "fresh-sibling.apk")
        val identity = InstallBatchIdentity(
            artifacts = listOf(
                InstallBatchArtifact("update.apk", "com.example.update", "a".repeat(64)),
                InstallBatchArtifact("fresh-sibling.apk", "com.example.fresh", "b".repeat(64)),
            ),
            approvedReplacementPaths = mapOf(
                "com.example.update" to "/data/app/com.example.update-injected/base.apk"
            ),
        )
        val leases = InstallRetryLeaseStore(
            nowMillis = { 100L },
            tokenFactory = { "c".repeat(32) },
            leaseTtlMillis = 1_000L,
        )

        assertEquals(StagingWriteTracker.ClaimResult.Claimed, tracker.claim(batch))
        val lease = leases.create(identity)

        assertThrows(IllegalStateException::class.java) {
            tracker.begin("fresh-sibling.apk")
        }
        assertEquals(null, leases.take("d".repeat(32)))
        assertThrows(IllegalStateException::class.java) {
            tracker.begin("fresh-sibling.apk")
        }
        assertEquals(identity, leases.take(lease.token)?.identity)

        // The provider transfers the still-held claim to its install worker after token consume.
        assertThrows(IllegalStateException::class.java) {
            tracker.begin("fresh-sibling.apk")
        }
        tracker.release(batch)
        tracker.begin("fresh-sibling.apk")
    }

    @Test
    fun `bootstrap finalizer accepts only a distinct active replacement and digest-bound old path`() {
        val request = BootstrapReplacementSafety.parseFinalizeArgument(
            "/data/app/com.penumbraos.systeminjector-injected," + "a".repeat(64)
        )
        assertEquals(
            "/data/app/com.penumbraos.systeminjector-injected",
            BootstrapReplacementSafety.validateCurrentAndInactivePaths(
                "/data/app/com.penumbraos.systeminjector-replacement-012345abcdef/base.apk",
                request,
            ).path,
        )

        assertThrows(IllegalArgumentException::class.java) {
            BootstrapReplacementSafety.parseFinalizeArgument(
                "/data/app/../system," + "a".repeat(64)
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BootstrapReplacementSafety.validateCurrentAndInactivePaths(
                "/data/app/com.penumbraos.systeminjector-injected/base.apk",
                request,
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BootstrapReplacementSafety.validateCurrentAndInactivePaths(
                "/data/app/com.penumbraos.systeminjector-replacement-012345abcdef/base.apk",
                request.copy(
                    oldCodePath = "/data/app/com.penumbraos.systeminjector-replacement-012345abcdef"
                ),
            )
        }
    }

    @Test
    fun `staging quota bounds files bytes and concurrent writers`() {
        val quota = StagingQuotaTracker(
            maxFiles = 2,
            maxTotalBytes = 10,
            maxFileBytes = 8,
            maxConcurrentWrites = 1,
        )
        val first = quota.reserve(
            "first.apk",
            listOf(StagingQuotaTracker.PublishedFile("existing.apk", 2)),
        )
        assertEquals(8, first.maxBytes)
        assertThrows(IllegalStateException::class.java) {
            quota.reserve("second.apk", emptyList())
        }
        quota.release(first)
        assertThrows(IllegalStateException::class.java) {
            quota.reserve(
                "third.apk",
                listOf(
                    StagingQuotaTracker.PublishedFile("one.apk", 1),
                    StagingQuotaTracker.PublishedFile("two.apk", 1),
                ),
            )
        }
    }

    @Test
    fun `batch and native library policies reject resource amplification inputs`() {
        InstallBatchPolicy.validateSizes(listOf(1, StagingIo.MAX_STAGED_APK_BYTES))
        assertThrows(IllegalArgumentException::class.java) {
            InstallBatchPolicy.validateSizes(List(InstallBatchPolicy.MAX_BATCH_APKS + 1) { 1L })
        }
        assertThrows(IllegalArgumentException::class.java) {
            InstallBatchPolicy.validateSizes(listOf(InstallBatchPolicy.MAX_BATCH_BYTES, 1))
        }
        assertTrue(NativeLibraryPolicy.isSafeLibraryName("libpin-runtime.so"))
        assertFalse(NativeLibraryPolicy.isSafeLibraryName("../runtime.so"))
        assertFalse(NativeLibraryPolicy.isSafeLibraryName("nested/runtime.so"))
    }

    @Test
    fun `native library policy admits the measured signed server payload`() {
        val codexServerBytes = 217_128_768L
        val penumbraServerBytes = 148_876_288L
        val signedServerTotalNativeBytes = 384_319_880L
        val remainingNativeLibrariesBytes =
            signedServerTotalNativeBytes - codexServerBytes - penumbraServerBytes
        var extractedBytes = 0L

        for (
            libraryBytes in listOf(
                codexServerBytes,
                penumbraServerBytes,
                remainingNativeLibrariesBytes,
            )
        ) {
            assertTrue(
                NativeLibraryPolicy.fitsExtractionSizeLimits(
                    libraryBytes = libraryBytes,
                    previouslyExtractedBytes = extractedBytes,
                )
            )
            extractedBytes += libraryBytes
        }

        assertEquals(signedServerTotalNativeBytes, extractedBytes)
    }

    @Test
    fun `native library policy accepts exact boundaries and rejects bytes above them`() {
        val singleLibraryLimit = 512L * 1024L * 1024L
        val totalLibraryLimit = 1024L * 1024L * 1024L

        assertEquals(singleLibraryLimit, NativeLibraryPolicy.MAX_SINGLE_LIBRARY_BYTES)
        assertEquals(totalLibraryLimit, NativeLibraryPolicy.MAX_TOTAL_LIBRARY_BYTES)
        assertTrue(
            NativeLibraryPolicy.fitsExtractionSizeLimits(
                libraryBytes = singleLibraryLimit,
                previouslyExtractedBytes = 0L,
            )
        )
        assertTrue(
            NativeLibraryPolicy.fitsExtractionSizeLimits(
                libraryBytes = 1L,
                previouslyExtractedBytes = totalLibraryLimit - 1L,
            )
        )
        assertFalse(
            NativeLibraryPolicy.fitsExtractionSizeLimits(
                libraryBytes = singleLibraryLimit + 1L,
                previouslyExtractedBytes = 0L,
            )
        )
        assertFalse(
            NativeLibraryPolicy.fitsExtractionSizeLimits(
                libraryBytes = 1L,
                previouslyExtractedBytes = totalLibraryLimit,
            )
        )
    }

    @Test
    fun `activation result succeeds only for every explicitly required package`() {
        val result = LaunchPolicyInstaller.RefreshResult(
            successfulPackages = setOf("com.example.one"),
            failedPackages = setOf("com.example.two"),
        )
        assertTrue(result.succeededFor(setOf("com.example.one")))
        assertFalse(result.succeededFor(setOf("com.example.one", "com.example.two")))
        assertFalse(
            result.copy(globalFailure = "reflection failed")
                .succeededFor(setOf("com.example.one"))
        )
    }

    @Test
    fun `APK archive validation streams contents and rejects traversal entries`() {
        val valid = Files.createTempFile("archive-policy-valid", ".apk").toFile()
        val invalid = Files.createTempFile("archive-policy-invalid", ".apk").toFile()
        try {
            ZipOutputStream(valid.outputStream()).use { zip ->
                zip.putNextEntry(ZipEntry("assets/config.json"))
                zip.write("{}".toByteArray())
                zip.closeEntry()
            }
            ApkArchivePolicy.validate(valid)

            ZipOutputStream(invalid.outputStream()).use { zip ->
                zip.putNextEntry(ZipEntry("../escape.so"))
                zip.write(byteArrayOf(1))
                zip.closeEntry()
            }
            assertThrows(IllegalArgumentException::class.java) {
                ApkArchivePolicy.validate(invalid)
            }
        } finally {
            valid.delete()
            invalid.delete()
        }
    }
}
