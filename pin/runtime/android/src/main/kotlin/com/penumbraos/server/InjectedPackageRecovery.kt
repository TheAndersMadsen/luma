package com.penumbraos.server

import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * Boot-time verification (always on, observation only) and gated restoration
 * (default OFF) of the injected sibling packages.
 *
 * Observed on an operator-owned Pin: injected packages can disappear from PMS
 * across an uncontrolled reboot; `pm install -r --user 0` restored them in the
 * measured recovery run. This component automates that restoration only under
 * strict, fail-closed conditions decided by
 * [InjectedPackageRecoveryPolicy]:
 *
 *  - With the gate off (`dev.injected_package_recovery_enabled = false`, the
 *    shipped default) this component only LOGS content-free presence booleans
 *    and skip reasons. It changes no state.
 *  - EXECUTION AUTHORIZATION: the operator turning that flag on through the
 *    authenticated settings API — together with pinning each package's exact
 *    release SHA-256 — is the explicit standing authorization for the
 *    restoration. Both live in the canonical config, so the authorization
 *    itself survives an app data-clear via the system-CE vault snapshot.
 *  - The restoration installs a MISSING package only, from a staged APK whose
 *    digest matches the operator's pin, at most once per boot. It never
 *    touches an installed package, never targets this package or the System
 *    Injector, and never enumerates or manipulates PackageInstaller sessions.
 */
internal object InjectedPackageRecovery {

    private const val TAG = "PenumbraServer"

    /**
     * After a data-clear the canonical config only exists again once
     * `ServerService.onCreate` has restored the vault snapshot. The boot check
     * is not latency-sensitive; wait out the startup burst before reading the
     * gate so the restored (vault-backed) authorization is what gets read.
     */
    private const val BOOT_SETTLE_DELAY_MS = 20_000L

    private const val PM_TIMEOUT_SECONDS = 180L
    private const val ATTEMPT_MARKER_FILE_NAME = ".injected-package-recovery-attempt"

    fun scheduleBootCheck(context: Context) {
        val application = context.applicationContext
        Thread({
            try {
                runBootCheck(application)
            } catch (t: Throwable) {
                // Content-free: never leak config or filesystem detail.
                Log.e(TAG, "Injected-package boot check failed (${t.javaClass.simpleName})")
            }
        }, "penumbra-injected-package-recovery").apply {
            isDaemon = true
            start()
        }
    }

    private fun runBootCheck(context: Context) {
        Thread.sleep(BOOT_SETTLE_DELAY_MS)

        // Observation is always on and content-free: fixed package names of
        // this project's own components and presence booleans only.
        val present = InjectedPackageRecoveryPolicy.observedPackages.associateWith { name ->
            isPackagePresent(context, name)
        }
        Log.w(
            TAG,
            "Injected package presence: " +
                present.entries.joinToString(separator = ", ") { "${it.key}=${it.value}" },
        )

        val recoverableMissing = InjectedPackageRecoveryPolicy.pinnedDigestConfigPaths.keys
            .any { present[it] != true }
        if (!recoverableMissing) return

        val gate = readGate(context)
        val bootCount = currentBootCount(context)
        val markerFile = File(context.filesDir, ATTEMPT_MARKER_FILE_NAME)
        // Without a boot identity the once-per-boot bound cannot be proven;
        // fail closed to observation-only.
        val alreadyAttemptedThisBoot =
            bootCount == null || readAttemptMarker(markerFile) == bootCount

        val decisions = InjectedPackageRecoveryPolicy.evaluate(
            present,
            gate,
            recoveryDirectory(),
            alreadyAttemptedThisBoot,
        )

        for (decision in decisions) {
            when (decision) {
                is InjectedPackageRecoveryPolicy.Decision.Skip -> Log.w(
                    TAG,
                    "Injected-package recovery skipped for " +
                        "${decision.packageName}: ${decision.reason}",
                )
                is InjectedPackageRecoveryPolicy.Decision.Attempt -> {
                    // Record the attempt BEFORE executing so a crash mid-install
                    // cannot turn the boot path into an install loop.
                    if (bootCount != null) writeAttemptMarker(markerFile, bootCount)
                    executeRecovery(decision)
                }
            }
        }
    }

    private fun readGate(context: Context): InjectedPackageRecoveryPolicy.Gate {
        val configFile = File(context.filesDir, PersistentConfigVaultFormat.CONFIG_FILE_NAME)
        if (Files.isSymbolicLink(configFile.toPath()) || !configFile.isFile) {
            return InjectedPackageRecoveryPolicy.Gate(enabled = false, pinnedDigests = emptyMap())
        }
        return InjectedPackageRecoveryPolicy.readGate(configFile.readText())
    }

    private fun recoveryDirectory(): File =
        File(
            BootstrapConfig.ensurePersistentRoot(),
            InjectedPackageRecoveryPolicy.RECOVERY_DIRECTORY_NAME,
        )

    private fun isPackagePresent(context: Context, packageName: String): Boolean = try {
        context.packageManager.getPackageInfo(packageName, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    private fun currentBootCount(context: Context): Int? = try {
        Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)
    } catch (_: Settings.SettingNotFoundException) {
        null
    }

    private fun readAttemptMarker(markerFile: File): Int? {
        if (Files.isSymbolicLink(markerFile.toPath()) || !markerFile.isFile) return null
        return try {
            markerFile.readText().trim().toIntOrNull()
        } catch (_: Exception) {
            null
        }
    }

    private fun writeAttemptMarker(markerFile: File, bootCount: Int) {
        try {
            check(!Files.isSymbolicLink(markerFile.toPath())) {
                "Refusing symbolic-link recovery marker"
            }
            markerFile.writeText("$bootCount\n")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed writing recovery attempt marker (${t.javaClass.simpleName})")
        }
    }

    /**
     * Execute one policy-approved restoration. Reaching this point required:
     * package missing from PMS, operator gate enabled (authenticated settings
     * write, vault-durable), digest pin present, staged artifact matching the
     * pin, and no prior attempt this boot. The command is exactly the
     * ROADMAP-documented `pm install -r --user 0 <staged apk>`; success is
     * still only claimed as an exit code — package identity is re-verified by
     * the next boot's presence observation, never inferred here.
     */
    private fun executeRecovery(decision: InjectedPackageRecoveryPolicy.Decision.Attempt) {
        Log.w(TAG, "Injected-package recovery attempting restoration of ${decision.packageName}")
        try {
            val process = ProcessBuilder(decision.command)
                .redirectErrorStream(true)
                .start()
            process.outputStream.close()
            // Drain and discard installer output so the child cannot block on a
            // full pipe; only the content-free exit code is ever logged.
            val drain = Thread({
                try {
                    process.inputStream.use { stream ->
                        val buffer = ByteArray(4096)
                        while (stream.read(buffer) != -1) {
                            // discard
                        }
                    }
                } catch (_: Throwable) {
                }
            }, "penumbra-injected-package-recovery-drain")
            drain.isDaemon = true
            drain.start()

            if (!process.waitFor(PM_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                Log.e(
                    TAG,
                    "Injected-package recovery timed out for ${decision.packageName}",
                )
                return
            }
            Log.w(
                TAG,
                "Injected-package recovery finished for ${decision.packageName}: " +
                    "exit=${process.exitValue()}",
            )
        } catch (t: Throwable) {
            Log.e(
                TAG,
                "Injected-package recovery failed for ${decision.packageName} " +
                    "(${t.javaClass.simpleName})",
            )
        }
    }
}
