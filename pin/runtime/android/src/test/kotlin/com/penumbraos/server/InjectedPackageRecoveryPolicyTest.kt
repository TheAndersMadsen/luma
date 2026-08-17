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

class InjectedPackageRecoveryPolicyTest {

    private val hook = InjectedPackageRecoveryPolicy.HOOK_PACKAGE
    private val hookInjector = InjectedPackageRecoveryPolicy.HOOK_INJECTOR_PACKAGE

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun tempDirectory(): File =
        Files.createTempDirectory("penumbra-injected-recovery").toFile()

    private fun stageApk(directory: File, packageName: String, bytes: ByteArray): Pair<File, String> {
        val file = InjectedPackageRecoveryPolicy.recoveryApkFile(directory, packageName)
        file.writeBytes(bytes)
        return file to sha256Hex(bytes)
    }

    private fun allMissing(): Map<String, Boolean> =
        InjectedPackageRecoveryPolicy.observedPackages.associateWith { false }
            .plus(InjectedPackageRecoveryPolicy.SERVER_PACKAGE to true)

    @Test
    fun gateDefaultsToDisabledWithoutDevKeys() {
        val gate = InjectedPackageRecoveryPolicy.readGate(
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
        val gate = InjectedPackageRecoveryPolicy.readGate(
            """
            [dev]
            injected_package_recovery_enabled = true
            injected_package_recovery_hook_sha256 = "$hookDigest"
            """.trimIndent() + "\n",
        )
        assertTrue(gate.enabled)
        assertEquals(mapOf(hook to hookDigest), gate.pinnedDigests)
    }

    @Test
    fun gateFailsClosedOnNonCanonicalPin() {
        for (bad in listOf("abc", "AB".repeat(32), "zz".repeat(32))) {
            try {
                InjectedPackageRecoveryPolicy.readGate(
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
        val (_, digest) = stageApk(directory, hook, byteArrayOf(1, 2, 3))
        val decisions = InjectedPackageRecoveryPolicy.evaluate(
            allMissing().plus(hook to true).plus(hookInjector to true),
            InjectedPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(hook to digest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        )
        assertTrue(
            decisions.all {
                it is InjectedPackageRecoveryPolicy.Decision.Skip &&
                    it.reason == InjectedPackageRecoveryPolicy.SkipReason.PRESENT
            },
        )
    }

    @Test
    fun disabledGateOnlyObserves() {
        val directory = tempDirectory()
        val (_, digest) = stageApk(directory, hook, byteArrayOf(4, 5, 6))
        val decisions = InjectedPackageRecoveryPolicy.evaluate(
            allMissing(),
            InjectedPackageRecoveryPolicy.Gate(
                enabled = false,
                pinnedDigests = mapOf(hook to digest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        )
        assertTrue(
            decisions.all {
                it is InjectedPackageRecoveryPolicy.Decision.Skip &&
                    it.reason == InjectedPackageRecoveryPolicy.SkipReason.RECOVERY_DISABLED
            },
        )
    }

    @Test
    fun oneAttemptPerBootIsEnforcedByTheMarker() {
        val directory = tempDirectory()
        val (_, digest) = stageApk(directory, hook, byteArrayOf(7))
        val decisions = InjectedPackageRecoveryPolicy.evaluate(
            allMissing(),
            InjectedPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(hook to digest),
            ),
            directory,
            alreadyAttemptedThisBoot = true,
        )
        assertTrue(
            decisions.all {
                it is InjectedPackageRecoveryPolicy.Decision.Skip &&
                    it.reason ==
                    InjectedPackageRecoveryPolicy.SkipReason.ALREADY_ATTEMPTED_THIS_BOOT
            },
        )
    }

    @Test
    fun recoveryRequiresPinArtifactAndExactDigest() {
        val directory = tempDirectory()
        val (stagedHook, hookDigest) = stageApk(directory, hook, byteArrayOf(9, 9, 9))

        // hook: staged + pinned + matching → the only Attempt, with the exact
        // ROADMAP-documented restoration command.
        // hookInjector: no pin → skipped.
        val decisions = InjectedPackageRecoveryPolicy.evaluate(
            allMissing(),
            InjectedPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(hook to hookDigest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        )
        assertEquals(2, decisions.size)
        val attempt = decisions.filterIsInstance<InjectedPackageRecoveryPolicy.Decision.Attempt>()
            .single()
        assertEquals(hook, attempt.packageName)
        assertEquals(
            listOf("/system/bin/pm", "install", "-r", "--user", "0", stagedHook.absolutePath),
            attempt.command,
        )
        val skip = decisions.filterIsInstance<InjectedPackageRecoveryPolicy.Decision.Skip>()
            .single()
        assertEquals(hookInjector, skip.packageName)
        assertEquals(InjectedPackageRecoveryPolicy.SkipReason.NO_PINNED_DIGEST, skip.reason)

        // Pinned but nothing staged → unusable artifact, no attempt.
        val missingArtifact = InjectedPackageRecoveryPolicy.evaluate(
            allMissing(),
            InjectedPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(hookInjector to hookDigest),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        ).filterIsInstance<InjectedPackageRecoveryPolicy.Decision.Skip>()
            .single { it.packageName == hookInjector }
        assertEquals(
            InjectedPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            missingArtifact.reason,
        )

        // Staged bytes that do not match the pin → mismatch, no attempt.
        stageApk(directory, hookInjector, byteArrayOf(1))
        val mismatch = InjectedPackageRecoveryPolicy.evaluate(
            allMissing(),
            InjectedPackageRecoveryPolicy.Gate(
                enabled = true,
                pinnedDigests = mapOf(hookInjector to "ee".repeat(32)),
            ),
            directory,
            alreadyAttemptedThisBoot = false,
        ).filterIsInstance<InjectedPackageRecoveryPolicy.Decision.Skip>()
            .single { it.packageName == hookInjector }
        assertEquals(InjectedPackageRecoveryPolicy.SkipReason.DIGEST_MISMATCH, mismatch.reason)
    }

    @Test
    fun recoveryOnlyEverTargetsTheTwoInjectedSiblings() {
        val targets = InjectedPackageRecoveryPolicy.pinnedDigestConfigPaths.keys
        assertEquals(setOf(hook, hookInjector), targets)
        assertFalse(InjectedPackageRecoveryPolicy.SERVER_PACKAGE in targets)
        assertFalse(InjectedPackageRecoveryPolicy.SYSTEM_INJECTOR_PACKAGE in targets)

        // Even with every observed package missing, decisions exist only for
        // the recoverable siblings.
        val decisions = InjectedPackageRecoveryPolicy.evaluate(
            InjectedPackageRecoveryPolicy.observedPackages.associateWith { false },
            InjectedPackageRecoveryPolicy.Gate(enabled = true, pinnedDigests = emptyMap()),
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
            InjectedPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            InjectedPackageRecoveryPolicy.verifyStagedArtifact(absent, digest),
        )

        val empty = File(directory, "empty.apk").apply { writeBytes(ByteArray(0)) }
        assertEquals(
            InjectedPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            InjectedPackageRecoveryPolicy.verifyStagedArtifact(empty, digest),
        )

        val target = File(directory, "target.apk").apply { writeBytes(byteArrayOf(1, 2)) }
        val link = File(directory, "link.apk")
        Files.createSymbolicLink(link.toPath(), target.toPath())
        assertEquals(
            InjectedPackageRecoveryPolicy.SkipReason.ARTIFACT_UNUSABLE,
            InjectedPackageRecoveryPolicy.verifyStagedArtifact(link, digest),
        )

        val bytes = byteArrayOf(3, 4, 5)
        val real = File(directory, "real.apk").apply { writeBytes(bytes) }
        assertEquals(
            InjectedPackageRecoveryPolicy.SkipReason.DIGEST_MISMATCH,
            InjectedPackageRecoveryPolicy.verifyStagedArtifact(real, digest),
        )
        assertNull(InjectedPackageRecoveryPolicy.verifyStagedArtifact(real, sha256Hex(bytes)))
    }
}
