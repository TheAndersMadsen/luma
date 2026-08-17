package com.penumbraos.server

import android.os.IBinder
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FitnessBridgeSecurityTest {
    @Test
    fun binderContractCallerAndExactAllowlistArePinned() {
        assertEquals("com.penumbraos.server.fitness.bridge.v2", FitnessBridgeProtocol.DESCRIPTOR)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION, FitnessBridgeProtocol.TRANSACTION_BEGIN_SESSION)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION + 1, FitnessBridgeProtocol.TRANSACTION_FINISH_SESSION)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION + 2, FitnessBridgeProtocol.TRANSACTION_ABORT_SESSION)
        assertEquals(0x50464E32, FitnessBridgeProtocol.STREAM_MAGIC)
        assertEquals(1, FitnessBridgeProtocol.STREAM_VERSION)
        assertEquals(64 * 1024, FitnessBridgeProtocol.MAX_FRAME_BYTES)
        assertEquals(10_000L, FitnessBridgeProtocol.FINISH_GRACE_TIMEOUT_MS)
        assertEquals(1, FitnessBridgeProtocol.fileIdFor(FitnessBridgeProtocol.SUMMARY_FILENAME))
        assertEquals(2, FitnessBridgeProtocol.fileIdFor(FitnessBridgeProtocol.LOCATION_FILENAME))
        assertEquals(3, FitnessBridgeProtocol.fileIdFor(FitnessBridgeProtocol.SENSOR_FILENAME))
        assertEquals("hu.ma.ne.ironman", FitnessBridgeProtocol.IRONMAN_PACKAGE)
        assertEquals(
            setOf(
                "activity-tracking-summary.csv",
                "activity-tracking-location-data.gpx",
                "activity-tracking-sensor-data.csv",
            ),
            FitnessBridgeProtocol.ALLOWED_FILENAMES,
        )

        assertTrue(
            FitnessCallerAdmission.isAuthorized(
                1_001,
                1_001,
                setOf("hu.ma.ne.ironman"),
                "hu.ma.ne.ironman",
            ),
        )
        assertFalse(
            FitnessCallerAdmission.isAuthorized(
                1_001,
                1_001,
                setOf("hu.ma.ne.ironman", "shared.uid.peer"),
                "shared.uid.peer",
            ),
        )
        assertFalse(
            FitnessCallerAdmission.isAuthorized(
                1_002,
                1_001,
                setOf("hu.ma.ne.ironman"),
                "hu.ma.ne.ironman",
            ),
        )
    }

    @Test
    fun validationRejectsTraversalMissingBaseFilesDuplicatesAndLimits() {
        val session = UUID.randomUUID().toString()
        assertFails {
            FitnessBridgeProtocol.validateStreamStart(
                FitnessBridgeProtocol.StreamStartDeclaration(
                    session,
                    1_000,
                    listOf(FitnessBridgeProtocol.SUMMARY_FILENAME),
                ),
            )
        }
        assertFails {
            FitnessBridgeProtocol.validateStreamStart(
                FitnessBridgeProtocol.StreamStartDeclaration(
                    session,
                    1_000,
                    listOf(
                        FitnessBridgeProtocol.SUMMARY_FILENAME,
                        FitnessBridgeProtocol.LOCATION_FILENAME,
                        "../sensor.csv",
                    ),
                ),
            )
        }
        assertFails {
            declaration("../$session", baseFiles())
                .let(FitnessBridgeProtocol::validateExport)
        }
        assertFails {
            declaration(
                session,
                listOf(file(FitnessBridgeProtocol.SUMMARY_FILENAME, 1)),
            ).let(FitnessBridgeProtocol::validateExport)
        }
        assertFails {
            declaration(
                session,
                baseFiles() + file(FitnessBridgeProtocol.SUMMARY_FILENAME, 1),
            ).let(FitnessBridgeProtocol::validateExport)
        }
        assertFails {
            declaration(
                session,
                baseFiles() + file("../sensor.csv", 1),
            ).let(FitnessBridgeProtocol::validateExport)
        }
        assertFails {
            declaration(
                session,
                listOf(
                    file(
                        FitnessBridgeProtocol.SUMMARY_FILENAME,
                        FitnessBridgeProtocol.MAX_SUMMARY_BYTES + 1,
                    ),
                    file(FitnessBridgeProtocol.LOCATION_FILENAME, 1),
                ),
            ).let(FitnessBridgeProtocol::validateExport)
        }
    }

    @Test
    fun framedStreamBoundsRejectUnknownUndeclaredOversizedAndIncompleteData() {
        val start = streamStart()
        val bounds = FitnessStreamBounds(start)
        assertFails { bounds.acceptFrame(99, 1) }
        assertFails {
            bounds.acceptFrame(
                FitnessBridgeProtocol.SUMMARY_FILE_ID,
                FitnessBridgeProtocol.MAX_FRAME_BYTES + 1,
            )
        }
        assertFails { bounds.acceptFrame(FitnessBridgeProtocol.SENSOR_FILE_ID, 1) }

        repeat(
            (FitnessBridgeProtocol.MAX_SUMMARY_BYTES /
                FitnessBridgeProtocol.MAX_FRAME_BYTES).toInt(),
        ) {
            assertEquals(
                FitnessBridgeProtocol.SUMMARY_FILENAME,
                bounds.acceptFrame(
                    FitnessBridgeProtocol.SUMMARY_FILE_ID,
                    FitnessBridgeProtocol.MAX_FRAME_BYTES,
                ),
            )
        }
        assertFails { bounds.acceptFrame(FitnessBridgeProtocol.SUMMARY_FILE_ID, 1) }
        assertFails { bounds.finish() }

        val complete = FitnessStreamBounds(start)
        complete.acceptFrame(FitnessBridgeProtocol.SUMMARY_FILE_ID, 3)
        complete.acceptFrame(FitnessBridgeProtocol.LOCATION_FILE_ID, 4)
        assertEquals(
            linkedMapOf(
                FitnessBridgeProtocol.SUMMARY_FILENAME to 3L,
                FitnessBridgeProtocol.LOCATION_FILENAME to 4L,
            ),
            complete.finish(),
        )
    }

    @Test
    fun framedStreamRecognizesEofOnlyAtAnExactFrameBoundary() {
        assertEquals(
            null,
            FitnessStreamWire.readFrameFileIdOrEof(DataInputStream(ByteArrayInputStream(byteArrayOf()))),
        )
        for (trailingBytes in 1..3) {
            assertAnyFails {
                FitnessStreamWire.readFrameFileIdOrEof(
                    DataInputStream(ByteArrayInputStream(ByteArray(trailingBytes))),
                )
            }
        }
        assertEquals(
            FitnessBridgeProtocol.LOCATION_FILE_ID,
            FitnessStreamWire.readFrameFileIdOrEof(
                DataInputStream(
                    ByteArrayInputStream(
                        byteArrayOf(0, 0, 0, FitnessBridgeProtocol.LOCATION_FILE_ID.toByte()),
                    ),
                ),
            ),
        )
    }

    @Test
    fun commitGatePublishesExactlyOnceInEitherEventOrder() {
        val start = streamStart()
        val declaration = declaration(
            start.sessionId,
            listOf(
                file(FitnessBridgeProtocol.SUMMARY_FILENAME, 3),
                file(FitnessBridgeProtocol.LOCATION_FILENAME, 4),
            ),
            startedAtMs = start.startedAtMs,
        )
        val sizes = linkedMapOf(
            FitnessBridgeProtocol.SUMMARY_FILENAME to 3L,
            FitnessBridgeProtocol.LOCATION_FILENAME to 4L,
        )

        val finishFirst = FitnessStreamCommitGate(start)
        assertTrue(finishFirst.acceptFinish(declaration) is FitnessCommitDecision.Pending)
        assertReady(finishFirst.acceptStreamCompletion(sizes), declaration)
        assertReady(finishFirst.abort("late timeout"), declaration)
        assertTrue(
            finishFirst.acceptStreamCompletion(sizes) is FitnessCommitDecision.Failed,
        )

        val streamFirst = FitnessStreamCommitGate(start)
        assertTrue(streamFirst.acceptStreamCompletion(sizes) is FitnessCommitDecision.Pending)
        assertReady(streamFirst.acceptFinish(declaration), declaration)
        assertTrue(streamFirst.acceptFinish(declaration) is FitnessCommitDecision.Failed)
    }

    @Test
    fun commitGateFailsClosedOnDuplicatesMismatchAndAbort() {
        val start = streamStart()
        val declaration = declaration(
            start.sessionId,
            listOf(
                file(FitnessBridgeProtocol.SUMMARY_FILENAME, 3),
                file(FitnessBridgeProtocol.LOCATION_FILENAME, 4),
            ),
            startedAtMs = start.startedAtMs,
        )

        val duplicateFinish = FitnessStreamCommitGate(start)
        assertTrue(duplicateFinish.acceptFinish(declaration) is FitnessCommitDecision.Pending)
        assertTrue(duplicateFinish.acceptFinish(declaration) is FitnessCommitDecision.Failed)
        assertTrue(
            duplicateFinish.acceptStreamCompletion(
                mapOf(
                    FitnessBridgeProtocol.SUMMARY_FILENAME to 3L,
                    FitnessBridgeProtocol.LOCATION_FILENAME to 4L,
                ),
            ) is FitnessCommitDecision.Failed,
        )

        val mismatch = FitnessStreamCommitGate(start)
        assertTrue(mismatch.acceptFinish(declaration) is FitnessCommitDecision.Pending)
        assertTrue(
            mismatch.acceptStreamCompletion(
                mapOf(
                    FitnessBridgeProtocol.SUMMARY_FILENAME to 3L,
                    FitnessBridgeProtocol.LOCATION_FILENAME to 5L,
                ),
            ) is FitnessCommitDecision.Failed,
        )

        val aborted = FitnessStreamCommitGate(start)
        assertTrue(aborted.abort("producer failed") is FitnessCommitDecision.Failed)
        assertTrue(aborted.acceptFinish(declaration) is FitnessCommitDecision.Failed)
    }

    @Test
    fun importIsAtomicBoundedAndIncludesOptionalExtraData() {
        val root = Files.createTempDirectory("fitness-history-test").toFile()
        try {
            val session = UUID.randomUUID().toString()
            val payloads = linkedMapOf(
                FitnessBridgeProtocol.SUMMARY_FILENAME to
                    "Splits,Pace (min/km),Elapsed Time,Cumulative Distance (km),Moving Time,Motion Breakdown,Step Count\n1,PT6M,PT10M,1.25,PT8M,walk,1500\n"
                        .toByteArray(),
                FitnessBridgeProtocol.LOCATION_FILENAME to "<gpx></gpx>".toByteArray(),
                FitnessBridgeProtocol.SENSOR_FILENAME to "ax,ay\n1,2\n".toByteArray(),
            )
            val declaration = declaration(
                session,
                payloads.map { (name, bytes) -> file(name, bytes.size.toLong()) },
            )
            assertTrue(
                FitnessHistoryRepository(root, nowMs = { 2_000 }).importSession(
                    declaration,
                    sources(payloads),
                ),
            )
            val directory = File(root, session)
            assertTrue(directory.isDirectory)
            payloads.forEach { (name, bytes) ->
                assertTrue(File(directory, name).readBytes().contentEquals(bytes))
            }
            assertFalse(root.listFiles().orEmpty().any { it.name.startsWith(".incoming-") })
            val manifest = JSONObject(File(directory, FitnessBridgeProtocol.MANIFEST_FILENAME).readText())
            assertEquals(1, manifest.getInt("version"))
            assertEquals(session, manifest.getString("session_id"))
            assertEquals(3, manifest.getJSONArray("files").length())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun shortOrOversizedStreamsNeverPublishPartialSession() {
        val root = Files.createTempDirectory("fitness-history-limit-test").toFile()
        try {
            val session = UUID.randomUUID().toString()
            val declaration = declaration(
                session,
                listOf(
                    file(FitnessBridgeProtocol.SUMMARY_FILENAME, 2),
                    file(FitnessBridgeProtocol.LOCATION_FILENAME, 2),
                ),
            )
            assertFails {
                FitnessHistoryRepository(root).importSession(
                    declaration,
                    listOf(
                        source(FitnessBridgeProtocol.SUMMARY_FILENAME, 2, byteArrayOf(1)),
                        source(FitnessBridgeProtocol.LOCATION_FILENAME, 2, byteArrayOf(1, 2)),
                    ),
                )
            }
            assertFalse(File(root, session).exists())
            assertFalse(root.listFiles().orEmpty().any { it.name.startsWith(".incoming-") })
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun preStagingValidationAndSourceSetFailuresCloseEveryInput() {
        val root = Files.createTempDirectory("fitness-history-preflight-close-test").toFile()
        try {
            val invalidInputs = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails {
                FitnessHistoryRepository(root).importSession(
                    declaration("not-a-session-id", baseFiles()),
                    invalidInputs.sources,
                )
            }
            assertTrue(invalidInputs.inputs.all(CloseTrackingInputStream::closed))

            val session = UUID.randomUUID().toString()
            val mismatchedInputs = trackingSources(listOf(FitnessBridgeProtocol.SUMMARY_FILENAME))
            assertFails {
                FitnessHistoryRepository(root).importSession(
                    declaration(session, baseFiles()),
                    mismatchedInputs.sources,
                )
            }
            assertTrue(mismatchedInputs.inputs.all(CloseTrackingInputStream::closed))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun rootAndDirectSessionPathFailuresCloseEveryInput() {
        val parent = Files.createTempDirectory("fitness-history-path-close-test").toFile()
        val rootFile = File(parent, "not-a-directory").apply { writeText("occupied") }
        val outside = Files.createTempDirectory("fitness-history-symlink-target").toFile()
        try {
            val rootFailure = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails {
                FitnessHistoryRepository(rootFile).importSession(
                    declaration(UUID.randomUUID().toString(), baseFiles()),
                    rootFailure.sources,
                )
            }
            assertTrue(rootFailure.inputs.all(CloseTrackingInputStream::closed))

            val root = File(parent, "history").apply { assertTrue(mkdir()) }
            val session = UUID.randomUUID().toString()
            val finalPath = File(root, session).toPath()
            Files.createSymbolicLink(finalPath, outside.toPath())
            val directPathFailure = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails {
                FitnessHistoryRepository(root).importSession(
                    declaration(session, baseFiles()),
                    directPathFailure.sources,
                )
            }
            assertTrue(directPathFailure.inputs.all(CloseTrackingInputStream::closed))
            Files.deleteIfExists(finalPath)
        } finally {
            parent.deleteRecursively()
            outside.deleteRecursively()
        }
    }

    @Test
    fun stagingCreationFailureClosesInputsWithoutDeletingCollidingObject() {
        val root = Files.createTempDirectory("fitness-history-staging-close-test").toFile()
        val session = UUID.randomUUID().toString()
        val nonce = UUID.randomUUID().toString()
        val collision = File(root, ".incoming-$session-$nonce").apply { writeText("keep") }
        try {
            val tracked = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails {
                FitnessHistoryRepository(root, stagingId = { nonce }).importSession(
                    declaration(session, baseFiles()),
                    tracked.sources,
                )
            }
            assertTrue(tracked.inputs.all(CloseTrackingInputStream::closed))
            assertTrue(collision.isFile)
            assertEquals("keep", collision.readText())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun existingTargetMustBeACompleteMatchingPublishedSession() {
        val root = Files.createTempDirectory("fitness-history-existing-target-test").toFile()
        try {
            val arbitrarySession = UUID.randomUUID().toString()
            val arbitraryTarget = File(root, arbitrarySession).apply { writeText("not a session") }
            val arbitraryInputs = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails {
                FitnessHistoryRepository(root).importSession(
                    declaration(arbitrarySession, baseFiles()),
                    arbitraryInputs.sources,
                )
            }
            assertTrue(arbitraryInputs.inputs.all(CloseTrackingInputStream::closed))
            assertEquals("not a session", arbitraryTarget.readText())

            val corruptSession = UUID.randomUUID().toString()
            val corruptDirectory = File(root, corruptSession).apply { assertTrue(mkdir()) }
            File(corruptDirectory, FitnessBridgeProtocol.MANIFEST_FILENAME).writeText("{}")
            val corruptInputs = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails {
                FitnessHistoryRepository(root).importSession(
                    declaration(corruptSession, baseFiles()),
                    corruptInputs.sources,
                )
            }
            assertTrue(corruptInputs.inputs.all(CloseTrackingInputStream::closed))

            val publishedSession = UUID.randomUUID().toString()
            val payloads = linkedMapOf(
                FitnessBridgeProtocol.SUMMARY_FILENAME to byteArrayOf(1),
                FitnessBridgeProtocol.LOCATION_FILENAME to byteArrayOf(2),
            )
            val published = declaration(
                publishedSession,
                payloads.map { (name, bytes) -> file(name, bytes.size.toLong()) },
            )
            val repository = FitnessHistoryRepository(root, nowMs = { published.stoppedAtMs })
            assertTrue(repository.importSession(published, sources(payloads)))

            val idempotentInputs = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertTrue(repository.importSession(published, idempotentInputs.sources))
            assertTrue(idempotentInputs.inputs.all(CloseTrackingInputStream::closed))

            val mismatchedInputs = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails {
                repository.importSession(
                    published.copy(stoppedAtMs = published.stoppedAtMs + 1),
                    mismatchedInputs.sources,
                )
            }
            assertTrue(mismatchedInputs.inputs.all(CloseTrackingInputStream::closed))

            assertTrue(
                File(
                    File(root, publishedSession),
                    FitnessBridgeProtocol.LOCATION_FILENAME,
                ).delete(),
            )
            val incompleteInputs = trackingSources(FitnessBridgeProtocol.REQUIRED_FILENAMES)
            assertFails { repository.importSession(published, incompleteInputs.sources) }
            assertTrue(incompleteInputs.inputs.all(CloseTrackingInputStream::closed))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun retentionDeletesExpiredAndOverBudgetCrashStagingDirectories() {
        val ageRoot = Files.createTempDirectory("fitness-history-staging-age-test").toFile()
        val budgetRoot = Files.createTempDirectory("fitness-history-staging-budget-test").toFile()
        try {
            val now = 10_000L
            val expired = crashStagingDirectory(ageRoot, 3, now - 1_000)
            val recent = crashStagingDirectory(ageRoot, 3, now - 100)
            val malformed = File(ageRoot, ".incoming-not-canonical").apply { assertTrue(mkdir()) }
            FitnessHistoryRepository(
                ageRoot,
                nowMs = { now },
                retention = FitnessRetentionPolicy(maxSessions = 20, maxTotalBytes = 1_024, maxAgeMs = 500),
            ).applyRetention()
            assertFalse(expired.exists())
            assertTrue(recent.exists())
            assertTrue(malformed.exists())

            val oldest = crashStagingDirectory(budgetRoot, 3, 100)
            val middle = crashStagingDirectory(budgetRoot, 3, 200)
            val newest = crashStagingDirectory(budgetRoot, 3, 300)
            FitnessHistoryRepository(
                budgetRoot,
                nowMs = { 1_000 },
                retention = FitnessRetentionPolicy(maxSessions = 2, maxTotalBytes = 5, maxAgeMs = 10_000),
            ).applyRetention()
            assertFalse(oldest.exists())
            assertFalse(middle.exists())
            assertTrue(newest.exists())
        } finally {
            ageRoot.deleteRecursively()
            budgetRoot.deleteRecursively()
        }
    }

    @Test
    fun crossInstanceRetentionNeverSweepsAnActiveStagingDirectory() {
        val root = Files.createTempDirectory("fitness-history-active-staging-test").toFile()
        val session = UUID.randomUUID().toString()
        val nonce = UUID.randomUUID().toString()
        val blocker = BlockingOneByteInputStream()
        val failure = AtomicReference<Throwable?>()
        val importer = FitnessHistoryRepository(
            root,
            stagingId = { nonce },
        )
        val startupSweeper = FitnessHistoryRepository(
            File(root, "."),
            retention = FitnessRetentionPolicy(maxSessions = 0, maxTotalBytes = 0, maxAgeMs = 0),
        )
        val declaration = declaration(session, baseFiles())
        val thread = Thread {
            try {
                importer.importSession(
                    declaration,
                    listOf(
                        FitnessImportSource(FitnessBridgeProtocol.SUMMARY_FILENAME, 1, blocker),
                        source(FitnessBridgeProtocol.LOCATION_FILENAME, 1, byteArrayOf(2)),
                    ),
                )
            } catch (error: Throwable) {
                failure.set(error)
            }
        }
        try {
            thread.start()
            assertTrue(blocker.readStarted.await(5, TimeUnit.SECONDS))
            val staging = File(root, ".incoming-$session-$nonce")
            assertTrue(staging.isDirectory)
            startupSweeper.applyRetention()
            assertTrue(staging.isDirectory)
        } finally {
            blocker.allowRead.countDown()
            thread.join(5_000)
            assertFalse(thread.isAlive)
            failure.get()?.let { throw AssertionError("fitness import failed", it) }
            root.deleteRecursively()
        }
    }

    @Test
    fun bootMaintenanceDeletesExpiredCrashStagingDirectory() {
        val filesDir = Files.createTempDirectory("fitness-history-boot-maintenance-test").toFile()
        try {
            val root = File(filesDir, FITNESS_HISTORY_DIRECTORY).apply { assertTrue(mkdir()) }
            val expired = crashStagingDirectory(
                root,
                sizeBytes = 3,
                lastModifiedMs = System.currentTimeMillis() -
                    FitnessBridgeProtocol.MAX_SESSION_AGE_MS - 60_000,
            )

            runFitnessHistoryRetentionMaintenance(filesDir)

            assertFalse(expired.exists())
        } finally {
            filesDir.deleteRecursively()
        }
    }

    @Test
    fun normalServerStartupReachesBestEffortFitnessRetentionMaintenance() {
        val text = sourceFile(
            "src/main/kotlin/com/penumbraos/server/ServerService.kt",
        ).readText()
        assertTrue(text.contains("runFitnessHistoryRetentionMaintenance(filesDir)"))
        assertTrue(text.contains("Fitness history startup retention failed"))
    }

    @Test
    fun retentionDeletesOldestSessionsAndExpiredSessions() {
        val root = Files.createTempDirectory("fitness-history-retention-test").toFile()
        var now = 10_000L
        val repository = FitnessHistoryRepository(
            root,
            nowMs = { now },
            retention = FitnessRetentionPolicy(maxSessions = 2, maxTotalBytes = 1_024, maxAgeMs = 500),
        )
        try {
            val sessions = (0 until 3).map {
                val id = UUID.randomUUID().toString()
                val bytes = linkedMapOf(
                    FitnessBridgeProtocol.SUMMARY_FILENAME to byteArrayOf(1),
                    FitnessBridgeProtocol.LOCATION_FILENAME to byteArrayOf(2),
                )
                repository.importSession(
                    declaration(
                        id,
                        bytes.map { (name, value) -> file(name, value.size.toLong()) },
                        startedAtMs = now - 10,
                        stoppedAtMs = now,
                    ),
                    sources(bytes),
                )
                now += 100
                id
            }
            assertFalse(File(root, sessions[0]).exists())
            assertTrue(File(root, sessions[1]).exists())
            assertTrue(File(root, sessions[2]).exists())

            now += 1_000
            repository.applyRetention()
            assertFalse(File(root, sessions[1]).exists())
            assertFalse(File(root, sessions[2]).exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun totalSizeRetentionRemovesPublishedSessionWhenBudgetIsExceeded() {
        val root = Files.createTempDirectory("fitness-history-total-retention-test").toFile()
        val repository = FitnessHistoryRepository(
            root,
            nowMs = { 2_000 },
            retention = FitnessRetentionPolicy(maxSessions = 20, maxTotalBytes = 1, maxAgeMs = 10_000),
        )
        try {
            val session = UUID.randomUUID().toString()
            val payloads = linkedMapOf(
                FitnessBridgeProtocol.SUMMARY_FILENAME to byteArrayOf(1),
                FitnessBridgeProtocol.LOCATION_FILENAME to byteArrayOf(2),
            )
            repository.importSession(
                declaration(
                    session,
                    payloads.map { (name, bytes) -> file(name, bytes.size.toLong()) },
                ),
                sources(payloads),
            )
            assertFalse(File(root, session).exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun manifestRegistersExplicitExportedService() {
        val text = TierAManifestTestPlaceholders.resolve(
            sourceFile("src/main/AndroidManifest.xml").readText(),
        )
        assertTrue(text.contains("android:name=\".FitnessBridgeService\""))
        assertTrue(text.contains("<package android:name=\"hu.ma.ne.ironman\""))
    }

    @Test
    fun bridgeRetainsAStartedServiceHoldUntilReadersAndImportsAreIdle() {
        val text = sourceFile(
            "src/main/kotlin/com/penumbraos/server/FitnessBridgeService.kt",
        ).readText()
        assertTrue(text.contains("startService(Intent(this, FitnessBridgeService::class.java))"))
        assertTrue(text.contains("return START_NOT_STICKY"))
        assertTrue(text.contains("claimedSessions"))
        assertTrue(text.contains("stopSelfResult(latestStartId)"))
        assertTrue(text.contains("if (destroying ||"))
    }

    @Test
    fun partialImportSourceConstructionClosesEarlierInputs() {
        var firstClosed = false
        val firstInput = object : ByteArrayInputStream(byteArrayOf(1)) {
            override fun close() {
                firstClosed = true
                super.close()
            }
        }
        assertAnyFails {
            buildFitnessImportSources(
                listOf(
                    FitnessBridgeProtocol.SUMMARY_FILENAME,
                    FitnessBridgeProtocol.LOCATION_FILENAME,
                ),
            ) { filename ->
                if (filename == FitnessBridgeProtocol.LOCATION_FILENAME) {
                    throw IllegalStateException("second source failed")
                }
                FitnessImportSource(filename, 1, firstInput)
            }
        }
        assertTrue(firstClosed)
    }

    private data class TrackingSources(
        val sources: List<FitnessImportSource>,
        val inputs: List<CloseTrackingInputStream>,
    )

    private class CloseTrackingInputStream(
        bytes: ByteArray = byteArrayOf(1),
    ) : ByteArrayInputStream(bytes) {
        var closed = false
            private set

        override fun close() {
            closed = true
            super.close()
        }
    }

    private class BlockingOneByteInputStream : InputStream() {
        val readStarted = CountDownLatch(1)
        val allowRead = CountDownLatch(1)
        private var emitted = false

        override fun read(): Int {
            if (emitted) return -1
            readStarted.countDown()
            check(allowRead.await(5, TimeUnit.SECONDS)) { "Timed out waiting to release input" }
            emitted = true
            return 1
        }
    }

    private fun trackingSources(filenames: Collection<String>): TrackingSources {
        val inputs = filenames.map { CloseTrackingInputStream() }
        return TrackingSources(
            sources = filenames.zip(inputs).map { (filename, input) ->
                FitnessImportSource(filename, 1, input)
            },
            inputs = inputs,
        )
    }

    private fun crashStagingDirectory(
        root: File,
        sizeBytes: Int,
        lastModifiedMs: Long,
    ): File {
        val directory = File(
            root,
            ".incoming-${UUID.randomUUID()}-${UUID.randomUUID()}",
        )
        assertTrue(directory.mkdir())
        File(directory, "partial").writeBytes(ByteArray(sizeBytes))
        assertTrue(directory.setLastModified(lastModifiedMs))
        return directory
    }

    private fun declaration(
        sessionId: String,
        files: List<FitnessBridgeProtocol.FileDeclaration>,
        startedAtMs: Long = 1_000,
        stoppedAtMs: Long = 2_000,
    ) = FitnessBridgeProtocol.ExportDeclaration(sessionId, startedAtMs, stoppedAtMs, files)

    private fun streamStart(
        sessionId: String = UUID.randomUUID().toString(),
        startedAtMs: Long = 1_000,
    ) = FitnessBridgeProtocol.StreamStartDeclaration(
        sessionId,
        startedAtMs,
        listOf(
            FitnessBridgeProtocol.SUMMARY_FILENAME,
            FitnessBridgeProtocol.LOCATION_FILENAME,
        ),
    )

    private fun baseFiles() = listOf(
        file(FitnessBridgeProtocol.SUMMARY_FILENAME, 1),
        file(FitnessBridgeProtocol.LOCATION_FILENAME, 1),
    )

    private fun file(name: String, size: Long) =
        FitnessBridgeProtocol.FileDeclaration(name, size)

    private fun source(name: String, size: Long, bytes: ByteArray) =
        FitnessImportSource(name, size, ByteArrayInputStream(bytes))

    private fun sources(payloads: Map<String, ByteArray>) = payloads.map { (name, bytes) ->
        source(name, bytes.size.toLong(), bytes)
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected failure")
        } catch (_: IllegalArgumentException) {
        } catch (_: IllegalStateException) {
        } catch (_: ArithmeticException) {
        }
    }

    private fun assertAnyFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected failure")
        } catch (expected: AssertionError) {
            throw expected
        } catch (_: Throwable) {
        }
    }

    private fun assertReady(
        decision: FitnessCommitDecision,
        declaration: FitnessBridgeProtocol.ExportDeclaration,
    ) {
        assertTrue(decision is FitnessCommitDecision.Ready)
        assertEquals(declaration, (decision as FitnessCommitDecision.Ready).declaration)
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("runtime/android", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
