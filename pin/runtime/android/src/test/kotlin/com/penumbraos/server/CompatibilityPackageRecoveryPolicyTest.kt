package com.penumbraos.server

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CompatibilityPackageRecoveryPolicyTest {

    private val compatibilityLayer = CompatibilityPackageRecoveryPolicy.HOOK_PACKAGE
    private val compatibilityLoader =
        CompatibilityPackageRecoveryPolicy.COMPATIBILITY_LOADER_PACKAGE

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun tempDirectory(): File =
        Files.createTempDirectory("penumbra-compatibility-recovery").toFile()

    private fun stageApk(
        directory: File,
        packageName: String,
        bytes: ByteArray,
    ): Pair<File, String> {
        val file = CompatibilityPackageRecoveryPolicy.recoveryApkFile(directory, packageName)
        file.writeBytes(bytes)
        return file to sha256Hex(bytes)
    }

    private fun allMissing(): Map<String, Boolean> =
        CompatibilityPackageRecoveryPolicy.observedPackages.associateWith { false }
            .plus(CompatibilityPackageRecoveryPolicy.SERVER_PACKAGE to true)

    @Test
    fun gateDefaultsToDisabledWithoutDevKeys() {
        val gate = CompatibilityPackageRecoveryPolicy.readGate(
            """
            [llm]
            provider = "echo"

            [dev]
            apk_install_enabled = false
            """.trimIndent() + "\n",
        )
        assertFalse(gate.enabled)
        assertTrue(gate.pinnedDigests.isEmpty())
    }

    @Test
    fun gateParsesEnabledFlagAndCanonicalPins() {
        val hookDigest = "ab".repeat(32)
        val gate = CompatibilityPackageRecoveryPolicy.readGate(
            """
            [dev]
            injected_package_recovery_enabled = true
            injected_package_recovery_hook_sha256 = "$hookDigest"
            """.trimIndent() + "\n",
        )
        assertTrue(gate.enabled)
        assertEquals(mapOf(compatibilityLayer to hookDigest), gate.pinnedDigests)
    }

    @Test
    fun gateFailsClosedOnNonCanonicalPin() {
        for (bad in listOf("abc", "AB".repeat(32), "zz".repeat(32))) {
            try {
                CompatibilityPackageRecoveryPolicy.readGate(
                    "[dev]\ninjected_package_recovery_hook_sha256 = \"$bad\"\n",
                )
                fail("digest $bad must be rejected")
            } catch (_: IllegalStateException) {
                // fail closed
            }
        }
    }

    @Test
    fun presentPackagesAreNeverRecovered() {
        val directory = tempDirectory()
        val (_, digest) = stageApk(directory, compatibilityLayer, byteArrayOf(1, 2, 3))
        val decisions = CompatibilityPackageRecoveryPolicy.evaluate(
            allMissing().plus(compatibilityLayer to true).plus(compatibilityLoader to true),
            CompatibilityPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(compatibilityLayer to digest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        )
        assertTrue(
            decisions.all {
                it is CompatibilityPackageRecoveryPolicy.Decision.Skip &&
                    it.reason == CompatibilityPackageRecoveryPolicy.SkipReason.PRESENT
            },
        )
    }

    @Test
    fun disabledGateOnlyObserves() {
        val directory = tempDirectory()
        val (_, digest) = stageApk(directory, compatibilityLayer, byteArrayOf(4, 5, 6))
        val decisions = CompatibilityPackageRecoveryPolicy.evaluate(
            allMissing(),
            CompatibilityPackageRecoveryPolicy.Gate(
                enabled = false,
                pinnedDigests = mapOf(compatibilityLayer to digest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        )
        assertTrue(
            decisions.all {
                it is CompatibilityPackageRecoveryPolicy.Decision.Skip &&
                    it.reason == CompatibilityPackageRecoveryPolicy.SkipReason.RECOVERY_DISABLED
            },
        )
    }

    @Test
    fun oneAttemptPerBootIsEnforcedByTheMarker() {
        val directory = tempDirectory()
        val (_, digest) = stageApk(directory, compatibilityLayer, byteArrayOf(7))
        val decisions = CompatibilityPackageRecoveryPolicy.evaluate(
            allMissing(),
            CompatibilityPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(compatibilityLayer to digest),
            ),
            directory,
            alreadyAttemptedThisBoot = true,
        )
        assertTrue(
            decisions.all {
                it is CompatibilityPackageRecoveryPolicy.Decision.Skip &&
                    it.reason ==
                    CompatibilityPackageRecoveryPolicy.SkipReason.ALREADY_ATTEMPTED_THIS_BOOT
            },
        )
    }

    @Test
    fun recoveryRequiresPinArtifactAndExactDigest() {
        val directory = tempDirectory()
        val (stagedHook, hookDigest) =
            stageApk(directory, compatibilityLayer, byteArrayOf(9, 9, 9))

        // Compatibility Layer: staged + pinned + matching → the only Attempt,
        // with the exact ROADMAP-documented restoration command.
        // Compatibility Loader: no pin → skipped.
        val decisions = CompatibilityPackageRecoveryPolicy.evaluate(
            allMissing(),
            CompatibilityPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(compatibilityLayer to hookDigest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        )
        assertEquals(2, decisions.size)
        val attempt = decisions
            .filterIsInstance<CompatibilityPackageRecoveryPolicy.Decision.Attempt>()
            .single()
        assertEquals(compatibilityLayer, attempt.packageName)
        assertEquals(
            listOf("/system/bin/pm", "install", "-r", "--user", "0", stagedHook.absolutePath),
            attempt.command,
        )
        val skip = decisions
            .filterIsInstance<CompatibilityPackageRecoveryPolicy.Decision.Skip>()
            .single()
        assertEquals(compatibilityLoader, skip.packageName)
        assertEquals(
            CompatibilityPackageRecoveryPolicy.SkipReason.NO_PINNED_DIGEST,
            skip.reason,
        )

        // Pinned but nothing staged → unusable artifact, no attempt.
        val missingArtifact = CompatibilityPackageRecoveryPolicy.evaluate(
            allMissing(),
            CompatibilityPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(compatibilityLoader to hookDigest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        ).filterIsInstance<CompatibilityPackageRecoveryPolicy.Decision.Skip>()
            .single { it.packageName == compatibilityLoader }
        assertEquals(
            CompatibilityPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            missingArtifact.reason,
        )

        // Staged bytes that do not match the pin → mismatch, no attempt.
        stageApk(directory, compatibilityLoader, byteArrayOf(1))
        val mismatch = CompatibilityPackageRecoveryPolicy.evaluate(
            allMissing(),
            CompatibilityPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(compatibilityLoader to "ee".repeat(32)),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        ).filterIsInstance<CompatibilityPackageRecoveryPolicy.Decision.Skip>()
            .single { it.packageName == compatibilityLoader }
        assertEquals(
            CompatibilityPackageRecoveryPolicy.SkipReason.DIGEST_MISMATCH,
            mismatch.reason,
        )
    }

    @Test
    fun recoveryOnlyEverTargetsTheTwoCompatibilitySiblings() {
        val targets = CompatibilityPackageRecoveryPolicy.pinnedDigestConfigPaths.keys
        assertEquals(setOf(compatibilityLayer, compatibilityLoader), targets)
        assertFalse(CompatibilityPackageRecoveryPolicy.SERVER_PACKAGE in targets)
        assertFalse(CompatibilityPackageRecoveryPolicy.DEVICE_INSTALLER_PACKAGE in targets)

        // Even with every observed package missing, decisions exist only for
        // the recoverable siblings.
        val decisions = CompatibilityPackageRecoveryPolicy.evaluate(
            CompatibilityPackageRecoveryPolicy.observedPackages.associateWith { false },
            CompatibilityPackageRecoveryPolicy.Gate(enabled = true, pinnedDigests = emptyMap()),
            tempDirectory(),
            alreadyAttemptedThisBoot = false,
        )
        assertEquals(targets.toList(), decisions.map { it.packageName })
    }

    @Test
    fun stagedArtifactValidationRejectsUnusableFiles() {
        val directory = tempDirectory()
        val digest = "ab".repeat(32)

        val absent = File(directory, "absent.apk")
        assertEquals(
            CompatibilityPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            CompatibilityPackageRecoveryPolicy.verifyStagedArtifact(absent, digest),
        )

        val empty = File(directory, "empty.apk").apply { writeBytes(ByteArray(0)) }
        assertEquals(
            CompatibilityPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            CompatibilityPackageRecoveryPolicy.verifyStagedArtifact(empty, digest),
        )

        val target = File(directory, "target.apk").apply { writeBytes(byteArrayOf(1, 2)) }
        val link = File(directory, "link.apk")
        Files.createSymbolicLink(link.toPath(), target.toPath())
        assertEquals(
            CompatibilityPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            CompatibilityPackageRecoveryPolicy.verifyStagedArtifact(link, digest),
        )

        val bytes = byteArrayOf(3, 4, 5)
        val real = File(directory, "real.apk").apply { writeBytes(bytes) }
        assertEquals(
            CompatibilityPackageRecoveryPolicy.SkipReason.DIGEST_MISMATCH,
            CompatibilityPackageRecoveryPolicy.verifyStagedArtifact(real, digest),
        )
        assertNull(
            CompatibilityPackageRecoveryPolicy.verifyStagedArtifact(real, sha256Hex(bytes)),
        )
    }
}
