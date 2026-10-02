package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile

private class StandaloneDockFailure(val code: String) : Exception(code)

private data class StandaloneDockCommandResult(
    val exitCode: Int,
    val output: String,
    val timedOut: Boolean,
    val truncated: Boolean,
)

private data class StandaloneDockBootBinding(
    val bootId: String,
    val bootEpoch: String,
    val uptimeSeconds: Double,
)

/**
 * Luma-owned (INFERRED) boot runner. It is launched through app_process from
 * the stock Shell process and therefore retains the audited UID-2000 shell
 * boundary without a computer or ADB transport.
 */
object StandaloneDockMain {
    private const val TAG = "LumaStandaloneDock"
    private const val EXPECTED_PROFILE_ID = "humane-aipin-45.20-nov4"
    private const val RECOVERY_WINDOW_SECONDS = 120.0
    private const val BUGREPORT_TIMEOUT_SECONDS = 600L
    private const val EXPLOIT_TIMEOUT_SECONDS = 3_600L
    private const val COMMAND_OUTPUT_LIMIT = 64 * 1024
    private const val ASSET_LIMIT = 256 * 1024
    private const val MAX_BUGREPORT_BYTES = 1024L * 1024L * 1024L
    private const val MAX_PRIVATE_LOG_BYTES = 64L * 1024L * 1024L
    private const val REMOTE_SU = "/data/local/tmp/su"
    private const val CLAIM_ROOT = "/data/local/tmp/.luma-standalone-dock-claims"
    private const val CRASH_LATCH_PATH = "/data/local/tmp/.luma-standalone-dock-pending"
    private const val STATUS_PATH = "/data/local/tmp/luma-standalone-dock.status"
    private const val WORK_PREFIX = "/data/local/tmp/.luma-standalone-dock-work-"
    private val bootIdPattern =
        Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    @JvmStatic
    fun main(args: Array<String>) {
        val result = try {
            if (args.size != 2) throw StandaloneDockFailure("arguments")
            run(File(args[0]), File(args[1]))
            "active"
        } catch (failure: StandaloneDockFailure) {
            "failed:${failure.code}"
        } catch (_: StandaloneDockKaslrException) {
            "failed:kaslr"
        } catch (_: Throwable) {
            "failed:internal"
        }
        writeStatus(result)
        if (result == "active") {
            Log.w(TAG, "Standalone dock is active for this boot")
        } else {
            Log.e(TAG, "Standalone dock settled without root: ${result.substringAfter(':')}")
        }
    }

    private fun run(apkArgument: File, payloadArgument: File) {
        val (apk, payload) = validateArtifacts(apkArgument, payloadArgument)
        if (!featureEnabled()) throw StandaloneDockFailure("disabled")
        val crashLatch = File(CRASH_LATCH_PATH)
        if (verifyRoot()) {
            if (!StandaloneDockCrashLatch.clear(crashLatch)) {
                throw StandaloneDockFailure("crash_latch_clear")
            }
            return
        }

        when (StandaloneDockCrashLatch.inspect(crashLatch, captureBootBinding().bootId)) {
            StandaloneDockCrashLatchState.CLEAR -> Unit
            StandaloneDockCrashLatchState.CURRENT_BOOT -> {
                throw StandaloneDockFailure("attempt_in_progress")
            }
            StandaloneDockCrashLatchState.PREVIOUS_BOOT -> {
                disableFeatureAfterInterruptedAttempt()
                if (!StandaloneDockCrashLatch.clear(crashLatch)) {
                    throw StandaloneDockFailure("crash_latch_clear")
                }
                throw StandaloneDockFailure("previous_attempt_rebooted")
            }
            StandaloneDockCrashLatchState.INVALID -> {
                disableFeatureAfterInterruptedAttempt()
                throw StandaloneDockFailure("crash_latch_invalid")
            }
        }

        writeStatus("waiting:recovery_window")
        waitForRecoveryWindow()
        if (!featureEnabled()) throw StandaloneDockFailure("disabled")

        val initialBinding = captureBootBinding()
        if (!StandaloneDockAttemptClaim.acquire(File(CLAIM_ROOT), initialBinding.bootId)) {
            throw StandaloneDockFailure("boot_already_settled")
        }
        val bootComponent = StandaloneDockAttemptClaim.bootComponent(initialBinding.bootId)
        val work = File("$WORK_PREFIX$bootComponent")
        if (work.exists()) work.deleteRecursively()
        if (!work.mkdir()) throw StandaloneDockFailure("work_directory")
        privateDirectory(work)

        var bugreport: File? = null
        var crashLatchArmed = false
        try {
            val profileText = readAsset(apk, "assets/ghostlock/profile.json")
            val symbolsText = readAsset(apk, "assets/ghostlock/symbols.txt")
            val expectedPayloadSha256 =
                readAsset(apk, "assets/ghostlock/payload.sha256").trim()
            val profile = try {
                StandaloneDockProfile.parse(profileText)
            } catch (_: Throwable) {
                throw StandaloneDockFailure("profile")
            }
            if (profile.profileId != EXPECTED_PROFILE_ID) {
                throw StandaloneDockFailure("profile")
            }
            if (sha256(symbolsText.toByteArray()) != profile.symbolsSha256) {
                throw StandaloneDockFailure("symbols")
            }
            val payloadSha256 = sha256(payload)
            enforcePreflight(profile, payloadSha256, expectedPayloadSha256)

            writeStatus("running:bugreport")
            bugreport = captureBugreport()
            val serial = commandText(listOf("/system/bin/getprop", "ro.serialno"), 10)
                .takeIf(String::isNotBlank) ?: throw StandaloneDockFailure("serial")
            val kaslr = StandaloneDockKaslr.derive(
                bugreport,
                symbolsText,
                expectedBootId = initialBinding.bootId,
                expectedSerial = serial,
                expectedFingerprint = profile.fingerprint,
            )
            assertSameBoot(initialBinding, captureBootBinding(), allowBootIdChange = false)
            enforcePreflight(profile, payloadSha256, expectedPayloadSha256)
            if (!featureEnabled()) throw StandaloneDockFailure("disabled")

            val runLog = File(work, "run.log")
            createPrivateFile(runLog)
            if (!StandaloneDockCrashLatch.arm(crashLatch, initialBinding.bootId)) {
                throw StandaloneDockFailure("crash_latch_arm")
            }
            crashLatchArmed = true
            writeStatus("running:exploit")
            val exploit = ProcessBuilder("/system/bin/true")
            exploit.environment().putAll(
                StandaloneDockExploit.environment(
                    profile,
                    kaslr.runtimeTextBase,
                    payload.absolutePath,
                ),
            )
            exploit.redirectErrorStream(true)
            exploit.redirectOutput(runLog)
            val process = exploit.start()
            if (!process.waitFor(EXPLOIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroy()
                if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly()
                throw StandaloneDockFailure("exploit_timeout")
            }
            if (process.exitValue() != 0) throw StandaloneDockFailure("exploit_exit")
            if (!hasRequiredRootMarkers(runLog)) throw StandaloneDockFailure("exploit_proof")
            assertSameBoot(initialBinding, captureBootBinding(), allowBootIdChange = true)
            if (commandText(listOf("/system/bin/getenforce"), 10) != "Permissive") {
                throw StandaloneDockFailure("selinux_result")
            }
            if (!verifyRoot()) throw StandaloneDockFailure("root_verification")
        } finally {
            bugreport?.let { report -> runCatching { report.delete() } }
            work.deleteRecursively()
            if (crashLatchArmed && !StandaloneDockCrashLatch.clear(crashLatch)) {
                throw StandaloneDockFailure("crash_latch_clear")
            }
        }
    }

    private fun validateArtifacts(apkArgument: File, payloadArgument: File): Pair<File, File> {
        val apk = apkArgument.canonicalFile
        val payload = payloadArgument.canonicalFile
        val installDir = apk.parentFile ?: throw StandaloneDockFailure("artifacts")
        if (
            apk.name != "base.apk" ||
            !apk.isFile ||
            !apk.path.startsWith("/data/app/") ||
            payload.name != "libghostlock_aipin.so" ||
            !payload.isFile ||
            !payload.path.startsWith(installDir.path + File.separator + "lib" + File.separator) ||
            Files.isSymbolicLink(apk.toPath()) ||
            Files.isSymbolicLink(payload.toPath())
        ) {
            throw StandaloneDockFailure("artifacts")
        }
        return apk to payload
    }

    private fun featureEnabled(): Boolean {
        val key = TierASymbols.FeatureFlags.LumaSettingsGlobal.ROOT_ACCESS_ENABLED
        val result = runCommand(
            listOf("/system/bin/settings", "get", "global", key),
            timeoutSeconds = 10,
        )
        return result.exitCode == 0 && !result.timedOut && result.output.trim() == "1"
    }

    private fun disableFeatureAfterInterruptedAttempt() {
        val key = TierASymbols.FeatureFlags.LumaSettingsGlobal.ROOT_ACCESS_ENABLED
        val result = runCommand(
            listOf("/system/bin/settings", "put", "global", key, "0"),
            timeoutSeconds = 10,
        )
        if (
            result.exitCode != 0 ||
            result.timedOut ||
            result.truncated ||
            featureEnabled()
        ) {
            throw StandaloneDockFailure("crash_guard_disable")
        }
    }

    private fun waitForRecoveryWindow() {
        val uptime = readUptime()
        val remainingMillis = ((RECOVERY_WINDOW_SECONDS - uptime).coerceAtLeast(0.0) * 1000).toLong()
        if (remainingMillis > 0) Thread.sleep(remainingMillis)
    }

    private fun enforcePreflight(
        profile: StandaloneDockProfile,
        observedPayloadSha256: String,
        expectedPayloadSha256: String,
    ) {
        val failures = StandaloneDockPreflight.failures(
            captureDeviceSnapshot(),
            profile,
            observedPayloadSha256,
            expectedPayloadSha256,
        )
        if (failures.isNotEmpty()) {
            throw StandaloneDockFailure("preflight_${failures.joinToString("_")}")
        }
    }

    private fun captureDeviceSnapshot(): StandaloneDockDeviceSnapshot {
        val battery = runCommand(listOf("/system/bin/dumpsys", "battery"), 15)
        if (battery.exitCode != 0 || battery.timedOut || battery.truncated) {
            throw StandaloneDockFailure("battery_read")
        }
        val level = Regex("(?m)^\\s*level:\\s*(\\d+)\\s*$")
            .find(battery.output)?.groupValues?.get(1)?.toIntOrNull()
            ?.takeIf { it in 0..100 }
        val powerValues = Regex(
            "(?mi)^\\s*(?:AC|USB|Wireless) powered:\\s*(true|false)\\s*$",
        ).findAll(battery.output).map { it.groupValues[1].equals("true", true) }.toList()
        return StandaloneDockDeviceSnapshot(
            fingerprint = commandText(listOf("/system/bin/getprop", "ro.build.fingerprint"), 10),
            kernelRelease = commandText(listOf("/system/bin/uname", "-r"), 10),
            kernelVersion = commandText(listOf("/system/bin/uname", "-v"), 10),
            kernelMachine = commandText(listOf("/system/bin/uname", "-m"), 10),
            slot = commandText(listOf("/system/bin/getprop", "ro.boot.slot_suffix"), 10),
            abi = commandText(listOf("/system/bin/getprop", "ro.product.cpu.abi"), 10),
            uid = commandText(listOf("/system/bin/id", "-u"), 10),
            context = commandText(listOf("/system/bin/id", "-Z"), 10),
            selinux = commandText(listOf("/system/bin/getenforce"), 10),
            batteryLevel = level,
            powered = if (powerValues.isEmpty()) null else powerValues.any { it },
        )
    }

    private fun captureBugreport(): File {
        val result = runCommand(
            listOf("/system/bin/bugreportz"),
            timeoutSeconds = BUGREPORT_TIMEOUT_SECONDS,
        )
        if (result.exitCode != 0 || result.timedOut || result.truncated) {
            throw StandaloneDockFailure("bugreport_capture")
        }
        val path = result.output.lineSequence()
            .map(String::trim)
            .lastOrNull { it.startsWith("OK:") }
            ?.removePrefix("OK:")
            ?.trim()
            ?.takeIf(String::isNotBlank)
            ?: throw StandaloneDockFailure("bugreport_result")
        val report = File(path).canonicalFile
        if (
            !report.isFile ||
            Files.isSymbolicLink(report.toPath()) ||
            report.length() <= 0 ||
            report.length() > MAX_BUGREPORT_BYTES ||
            !report.name.endsWith(".zip") ||
            (
                !report.path.startsWith("/data/user_de/0/com.android.shell/") &&
                    !report.path.startsWith("/data/local/tmp/")
                )
        ) {
            throw StandaloneDockFailure("bugreport_path")
        }
        return report
    }

    private fun captureBootBinding(): StandaloneDockBootBinding {
        val bootId = File("/proc/sys/kernel/random/boot_id").readText().trim()
        if (!bootId.matches(bootIdPattern)) throw StandaloneDockFailure("boot_id")
        val bootEpoch = File("/proc/stat").useLines { lines ->
            lines.firstOrNull { it.startsWith("btime ") }
                ?.substringAfter("btime ")
                ?.trim()
        }.takeIf { !it.isNullOrBlank() } ?: throw StandaloneDockFailure("boot_epoch")
        return StandaloneDockBootBinding(bootId, bootEpoch, readUptime())
    }

    private fun readUptime(): Double = File("/proc/uptime").readText()
        .trim()
        .substringBefore(' ')
        .toDoubleOrNull()
        ?.takeIf { it >= 0.0 }
        ?: throw StandaloneDockFailure("uptime")

    private fun assertSameBoot(
        before: StandaloneDockBootBinding,
        after: StandaloneDockBootBinding,
        allowBootIdChange: Boolean,
    ) {
        if (
            (!allowBootIdChange && before.bootId != after.bootId) ||
            before.bootEpoch != after.bootEpoch ||
            after.uptimeSeconds < before.uptimeSeconds
        ) {
            throw StandaloneDockFailure("boot_changed")
        }
    }

    private fun verifyRoot(): Boolean {
        val su = File(REMOTE_SU)
        if (!su.isFile || Files.isSymbolicLink(su.toPath())) return false
        val result = runCommand(listOf(REMOTE_SU, "-c", "id"), timeoutSeconds = 15)
        return result.exitCode == 0 &&
            !result.timedOut &&
            !result.truncated &&
            result.output.contains("uid=0(root)")
    }

    private fun hasRequiredRootMarkers(log: File): Boolean {
        if (!log.isFile || log.length() <= 0 || log.length() > MAX_PRIVATE_LOG_BYTES) return false
        val reclaim = Regex("perf reclaim gate result verified=1 .*free=1 alloc=1")
        val credentials = Regex(
            "direct credential result uid=0 euid=0 gid=0 egid=0 .*selinux=1->0",
        )
        val broker = Regex("direct-root-summary root=1 id=1 (?:optional_)?su=1/")
        var reclaimFound = false
        var credentialsFound = false
        var brokerFound = false
        log.useLines { lines ->
            for (line in lines) {
                if (!reclaimFound && reclaim.containsMatchIn(line)) reclaimFound = true
                if (!credentialsFound && credentials.containsMatchIn(line)) credentialsFound = true
                if (!brokerFound && broker.containsMatchIn(line)) brokerFound = true
            }
        }
        return reclaimFound && credentialsFound && brokerFound
    }

    private fun readAsset(apk: File, path: String): String = ZipFile(apk).use { archive ->
        val entry = archive.getEntry(path) ?: throw StandaloneDockFailure("asset")
        if (entry.isDirectory || entry.size > ASSET_LIMIT) throw StandaloneDockFailure("asset")
        archive.getInputStream(entry).use { input ->
            String(readBounded(input, ASSET_LIMIT), Charsets.UTF_8)
        }
    }

    private fun readBounded(input: InputStream, limit: Int): ByteArray {
        val output = ByteArrayOutputStream(minOf(limit, 8 * 1024))
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (output.size() + read > limit) throw StandaloneDockFailure("asset")
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private fun commandText(command: List<String>, timeoutSeconds: Long): String {
        val result = runCommand(command, timeoutSeconds)
        if (result.exitCode != 0 || result.timedOut || result.truncated) {
            throw StandaloneDockFailure("command")
        }
        return result.output.trim()
    }

    private fun runCommand(
        command: List<String>,
        timeoutSeconds: Long,
    ): StandaloneDockCommandResult {
        val process = try {
            ProcessBuilder(command).redirectErrorStream(true).start()
        } catch (_: Throwable) {
            return StandaloneDockCommandResult(-1, "", timedOut = false, truncated = false)
        }
        val output = ByteArrayOutputStream()
        var truncated = false
        val reader = Thread {
            process.inputStream.use { input ->
                val buffer = ByteArray(4 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    val remaining = COMMAND_OUTPUT_LIMIT - output.size()
                    if (remaining > 0) output.write(buffer, 0, minOf(read, remaining))
                    if (read > remaining) truncated = true
                }
            }
        }.apply {
            isDaemon = true
            start()
        }
        val completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
        if (!completed) {
            process.destroy()
            if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly()
        }
        reader.join(5_000)
        return StandaloneDockCommandResult(
            exitCode = if (completed) process.exitValue() else -1,
            output = output.toString(Charsets.UTF_8.name()).replace("\r", ""),
            timedOut = !completed,
            truncated = truncated || reader.isAlive,
        )
    }

    private fun sha256(file: File): String = file.inputStream().use { input ->
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(1024 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
        digest.digest().hex()
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).hex()

    private fun ByteArray.hex(): String =
        joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun privateDirectory(directory: File) {
        directory.setReadable(false, false)
        directory.setWritable(false, false)
        directory.setExecutable(false, false)
        directory.setReadable(true, true)
        directory.setWritable(true, true)
        directory.setExecutable(true, true)
    }

    private fun createPrivateFile(file: File) {
        if (!file.createNewFile()) throw StandaloneDockFailure("private_file")
        file.setReadable(false, false)
        file.setWritable(false, false)
        file.setExecutable(false, false)
        file.setReadable(true, true)
        file.setWritable(true, true)
    }

    private fun writeStatus(value: String) {
        runCatching {
            val target = File(STATUS_PATH)
            val temporary = File("$STATUS_PATH.tmp")
            temporary.writeText("$value\n")
            temporary.setReadable(false, false)
            temporary.setWritable(false, false)
            temporary.setExecutable(false, false)
            temporary.setReadable(true, true)
            temporary.setWritable(true, true)
            if (!temporary.renameTo(target)) {
                target.delete()
                if (!temporary.renameTo(target)) temporary.delete()
            }
        }
    }
}
