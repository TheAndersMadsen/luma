package com.penumbraos.server

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest

/**
 * Pure decision logic for boot-time injected-package verification and
 * restoration, kept free of Android types for host-side tests.
 *
 * Observed on an operator-owned Pin: injected packages can be lost from PMS
 * across an uncontrolled reboot; `pm install -r --user 0` restored them in the
 * measured recovery run. This policy automates only the *decision* about that
 * restoration. The rules are strict and
 * fail closed:
 *
 *  - Detection is always allowed: package presence is observed and logged as
 *    content-free booleans. Observation never mutates anything.
 *  - A restoration [Decision.Attempt] is produced only when ALL hold:
 *      1. the package is one of the two recoverable injected siblings (never
 *         this package itself, never the System Injector trust anchor);
 *      2. the package is currently missing from PMS;
 *      3. the operator explicitly enabled `dev.injected_package_recovery_enabled`
 *         through the authenticated settings API (default false — the enable
 *         write is the standing authorization for this exact restoration);
 *      4. the operator pinned the exact release SHA-256 for that package in
 *         the canonical config (from `releases/<version>/SHA256SUMS`);
 *      5. a staged recovery APK on the persistent root matches that pin
 *         byte-for-byte (shared storage is writable by other apps, so the
 *         app-private, vault-backed pin is the integrity authority); and
 *      6. no restoration attempt has already run this boot (single attempt
 *         per boot; a failed install must page an operator, not loop).
 */
internal object InjectedPackageRecoveryPolicy {

    const val SERVER_PACKAGE = "com.penumbraos.server"
    const val HOOK_PACKAGE = "com.penumbraos.hook"
    const val HOOK_INJECTOR_PACKAGE = "com.penumbraos.hook.injector"
    const val SYSTEM_INJECTOR_PACKAGE = "com.penumbraos.systeminjector"

    /** Presence of every member is observed and logged, never mutated. */
    val observedPackages = listOf(
        SERVER_PACKAGE,
        HOOK_PACKAGE,
        HOOK_INJECTOR_PACKAGE,
        SYSTEM_INJECTOR_PACKAGE,
    )

    const val ENABLED_CONFIG_PATH = "dev.injected_package_recovery_enabled"

    /**
     * The only packages a restoration may ever target. This package cannot
     * restore itself (if this code runs, it is installed), and the System
     * Injector may only be replaced through its own separately authorized
     * bootstrap flow.
     */
    val pinnedDigestConfigPaths: Map<String, String> = linkedMapOf(
        HOOK_PACKAGE to "dev.injected_package_recovery_hook_sha256",
        HOOK_INJECTOR_PACKAGE to "dev.injected_package_recovery_hook_injector_sha256",
    )

    /** Directory under the persistent root holding staged recovery APKs. */
    const val RECOVERY_DIRECTORY_NAME = "recovery"

    /** Matches the dev-install route's upload bound. */
    const val MAX_RECOVERY_APK_BYTES = 512L * 1024L * 1024L

    data class Gate(
        val enabled: Boolean,
        val pinnedDigests: Map<String, String>,
    )

    /**
     * Read the recovery gate from canonical config text. Absent keys mean
     * disabled/unpinned. A present but non-canonical digest is tampering or
     * corruption and fails closed with an exception (the Rust settings
     * surface only ever persists validated 64-hex pins).
     */
    fun readGate(configText: String): Gate {
        val enabled = ConfigSecurity.readOptionalBoolean(configText, ENABLED_CONFIG_PATH) ?: false
        val pinned = LinkedHashMap<String, String>()
        for ((packageName, configPath) in pinnedDigestConfigPaths) {
            val digest = ConfigSecurity.readOptionalString(configText, configPath) ?: continue
            check(isCanonicalSha256(digest)) {
                "Pinned recovery digest for $configPath is not canonical"
            }
            pinned[packageName] = digest
        }
        return Gate(enabled, pinned)
    }

    fun isCanonicalSha256(digest: String): Boolean =
        digest.length == 64 && digest.all { it in '0'..'9' || it in 'a'..'f' }

    /** Fixed staged-artifact location for one recoverable package. */
    fun recoveryApkFile(recoveryDirectory: File, packageName: String): File =
        File(recoveryDirectory, "$packageName.apk")

    /**
     * The exact ROADMAP-documented restoration command. Building the command
     * is pure; executing it is the Android wrapper's separately gated step.
     */
    fun recoveryCommand(stagedApk: File): List<String> =
        listOf("/system/bin/pm", "install", "-r", "--user", "0", stagedApk.absolutePath)

    enum class SkipReason {
        PRESENT,
        RECOVERY_DISABLED,
        ALREADY_ATTEMPTED_THIS_BOOT,
        NO_PINNED_DIGEST,
        ARTIFACT_UNUSABLE,
        DIGEST_MISMATCH,
    }

    sealed class Decision {
        abstract val packageName: String

        data class Skip(
            override val packageName: String,
            val reason: SkipReason,
        ) : Decision()

        data class Attempt(
            override val packageName: String,
            val command: List<String>,
        ) : Decision()
    }

    /**
     * One decision per recoverable package, in fixed order. Every skip carries
     * a closed-set reason suitable for content-free logging.
     */
    fun evaluate(
        presentPackages: Map<String, Boolean>,
        gate: Gate,
        recoveryDirectory: File,
        alreadyAttemptedThisBoot: Boolean,
    ): List<Decision> = pinnedDigestConfigPaths.keys.map { packageName ->
        when {
            presentPackages[packageName] == true ->
                Decision.Skip(packageName, SkipReason.PRESENT)
            !gate.enabled ->
                Decision.Skip(packageName, SkipReason.RECOVERY_DISABLED)
            alreadyAttemptedThisBoot ->
                Decision.Skip(packageName, SkipReason.ALREADY_ATTEMPTED_THIS_BOOT)
            else -> {
                val pinnedDigest = gate.pinnedDigests[packageName]
                if (pinnedDigest == null) {
                    Decision.Skip(packageName, SkipReason.NO_PINNED_DIGEST)
                } else {
                    val stagedApk = recoveryApkFile(recoveryDirectory, packageName)
                    when (val rejection = verifyStagedArtifact(stagedApk, pinnedDigest)) {
                        null -> Decision.Attempt(packageName, recoveryCommand(stagedApk))
                        else -> Decision.Skip(packageName, rejection)
                    }
                }
            }
        }
    }

    /**
     * Returns null when the staged artifact is a plain regular file whose
     * SHA-256 equals the operator's pin, otherwise the closed skip reason.
     */
    fun verifyStagedArtifact(stagedApk: File, pinnedSha256: String): SkipReason? {
        check(isCanonicalSha256(pinnedSha256)) { "Pinned recovery digest is not canonical" }
        val path = stagedApk.toPath()
        if (Files.isSymbolicLink(path) || !stagedApk.isFile) return SkipReason.ARTIFACT_UNUSABLE
        val size = try {
            Files.readAttributes(
                path,
                java.nio.file.attribute.BasicFileAttributes::class.java,
                LinkOption.NOFOLLOW_LINKS,
            ).takeIf { it.isRegularFile }?.size()
        } catch (_: Exception) {
            null
        } ?: return SkipReason.ARTIFACT_UNUSABLE
        if (size !in 1..MAX_RECOVERY_APK_BYTES) return SkipReason.ARTIFACT_UNUSABLE

        val actual = try {
            sha256Hex(stagedApk)
        } catch (_: Exception) {
            return SkipReason.ARTIFACT_UNUSABLE
        }
        val matches = MessageDigest.isEqual(
            actual.toByteArray(Charsets.US_ASCII),
            pinnedSha256.toByteArray(Charsets.US_ASCII),
        )
        return if (matches) null else SkipReason.DIGEST_MISMATCH
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read == -1) break
                if (read > 0) digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString(separator = "") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
    }
}
