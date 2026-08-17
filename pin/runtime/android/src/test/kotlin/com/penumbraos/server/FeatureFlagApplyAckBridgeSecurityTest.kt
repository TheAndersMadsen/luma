package com.penumbraos.server

import android.os.IBinder
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureFlagApplyAckBridgeSecurityTest {
    private val installSecret = "0123456789abcdef".repeat(4)
    private val token = SettingsGlobalBridgeAuthentication.deriveToken(installSecret)
    private val hash = "0123456789abcdef".repeat(4)

    @Test
    fun binderAdmissionRequiresExactIronmanUidPackageAndMainProcess() {
        assertEquals(
            "com.penumbraos.server.feature-flag-apply-ack.bridge.v1",
            FeatureFlagApplyAckProtocol.DESCRIPTOR,
        )
        assertEquals(
            IBinder.FIRST_CALL_TRANSACTION,
            FeatureFlagApplyAckProtocol.TRANSACTION_RECORD_APPLIED,
        )
        assertTrue(
            FeatureFlagApplyAckCallerAdmission.isAuthorized(
                1_000,
                1_000,
                setOf("hu.ma.ne.ironman"),
                42,
                listOf(FeatureFlagApplyAckProcessIdentity(42, 1_000, "hu.ma.ne.ironman")),
            ),
        )
        assertFalse(
            FeatureFlagApplyAckCallerAdmission.isAuthorized(
                1_000,
                1_000,
                setOf("hu.ma.ne.ironman", "shared.uid.peer"),
                42,
                listOf(FeatureFlagApplyAckProcessIdentity(42, 1_000, "hu.ma.ne.ironman")),
            ),
        )
        assertFalse(
            FeatureFlagApplyAckCallerAdmission.isAuthorized(
                1_000,
                1_000,
                setOf("hu.ma.ne.ironman"),
                42,
                listOf(FeatureFlagApplyAckProcessIdentity(42, 1_000, "hu.ma.ne.ironman:voiceinteractor")),
            ),
        )
        assertFalse(
            FeatureFlagApplyAckCallerAdmission.isAuthorized(
                2_000,
                1_000,
                setOf("hu.ma.ne.ironman"),
                42,
                listOf(FeatureFlagApplyAckProcessIdentity(42, 2_000, "hu.ma.ne.ironman")),
            ),
        )
        assertFalse(
            FeatureFlagApplyAckCallerAdmission.isAuthorized(
                1_000,
                1_000,
                setOf("hu.ma.ne.ironman"),
                42,
                emptyList(),
            ),
        )
        assertFalse(
            FeatureFlagApplyAckCallerAdmission.isAuthorized(
                1_000,
                1_000,
                setOf("hu.ma.ne.ironman"),
                42,
                listOf(
                    FeatureFlagApplyAckProcessIdentity(42, 1_000, "hu.ma.ne.ironman"),
                    FeatureFlagApplyAckProcessIdentity(42, 1_000, "hu.ma.ne.ironman"),
                ),
            ),
        )
    }

    @Test
    fun receiptValidationAndRepositoryAreBoundedMonotonicAndNonPersistent() {
        FeatureFlagApplyAckRepository.clearForTest()
        val first = FeatureFlagApplyAckRepository.record(hash, 7, 1_000L)
        val second = FeatureFlagApplyAckRepository.record("f".repeat(64), 8, 2_000L)
        assertEquals(1L, first.sequence)
        assertEquals(2L, second.sequence)
        assertEquals(second, FeatureFlagApplyAckRepository.latest())

        assertFails { FeatureFlagApplyAckRepository.record("A".repeat(64), 1, 3_000L) }
        assertFails { FeatureFlagApplyAckRepository.record("0".repeat(63), 1, 3_000L) }
        assertFails { FeatureFlagApplyAckRepository.record(hash, 0, 3_000L) }
        assertFails {
            FeatureFlagApplyAckRepository.record(
                hash,
                FeatureFlagApplyAckProtocol.MAX_ASSIGNMENTS + 1,
                3_000L,
            )
        }
        assertFails { FeatureFlagApplyAckRepository.record(hash, 1, 0L) }
        FeatureFlagApplyAckRepository.clearForTest()
        assertNull(FeatureFlagApplyAckRepository.latest())
    }

    @Test
    fun authenticatedLoopbackQueryReturnsOnlyTheLatestReceipt() {
        FeatureFlagApplyAckRepository.clearForTest()
        val store = NoAccessStore()
        val empty = process(query(), store)
        assertTrue(empty.getBoolean("ok"))
        assertTrue(empty.isNull("receipt"))

        FeatureFlagApplyAckRepository.record(hash, 9, 4_000L)
        val response = process(query(), store)
        assertTrue(response.getBoolean("ok"))
        val receipt = response.getJSONObject("receipt")
        assertEquals(1L, receipt.getLong("sequence"))
        assertEquals(hash, receipt.getString("assignment_set_hash"))
        assertEquals(9, receipt.getInt("assignment_count"))
        assertEquals(4_000L, receipt.getLong("applied_at_unix_ms"))
        assertEquals(
            setOf(
                "sequence",
                "assignment_set_hash",
                "assignment_count",
                "applied_at_unix_ms",
            ),
            receipt.keys().asSequence().toSet(),
        )
        assertEquals(0, store.calls)
        FeatureFlagApplyAckRepository.clearForTest()
    }

    @Test
    fun manifestExportsOnlyTheExplicitFailClosedBinderComponent() {
        val manifest = sourceFile("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:name=\".FeatureFlagApplyAckBridgeService\""))
        val component = manifest.substringAfter(
            "android:name=\".FeatureFlagApplyAckBridgeService\"",
        ).substringBefore("/>")
        assertTrue(component.contains("android:enabled=\"true\""))
        assertTrue(component.contains("android:exported=\"true\""))
        val service = sourceFile(
            "src/main/kotlin/com/penumbraos/server/FeatureFlagApplyAckBridgeService.kt",
        ).readText()
        assertTrue(service.contains("enforceIronmanCaller()"))
        assertTrue(service.contains("runningAppProcesses"))
        assertTrue(service.contains("data.enforceInterface"))
        assertFalse(service.contains("BroadcastReceiver"))
        assertFalse(service.contains("/proc/"))
        assertFalse(service.contains("/sdcard"))
    }

    @Test
    fun nativeChildRestartInvalidatesThePriorApplyReceiptBeforeLaunch() {
        val runtime = sourceFile(
            "src/main/kotlin/com/penumbraos/server/ServerRuntime.kt",
        ).readText()
        val clearReceipt = runtime.indexOf(
            "FeatureFlagApplyAckRepository.clearForRuntimeRestart()",
        )
        val nativeStart = runtime.indexOf(
            "process = NativeBridge.start(context, configPath, esimBridgeToken)",
        )
        assertTrue(clearReceipt >= 0)
        assertTrue(nativeStart > clearReceipt)
    }

    @Test
    fun acknowledgementQueryRejectsBadAuthAndEveryShapeVariation() {
        val store = NoAccessStore()
        val invalid = listOf(
            query().put("token", "0".repeat(64)),
            query().put("key", "humane_clock_enabled"),
            query().put("extra", true),
            query().also { it.remove("op") },
        )
        invalid.forEach { request ->
            assertFalse(process(request, store).getBoolean("ok"))
        }
        assertEquals(0, store.calls)
    }

    private fun query(): JSONObject = JSONObject()
        .put("version", 1)
        .put("token", token)
        .put("op", "feature_flag_ack")

    private fun process(request: JSONObject, store: SettingsGlobalStore): JSONObject =
        SettingsGlobalBridgeProtocol.process(request.toString(), token, store)

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("runtime/android", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected validation failure")
        } catch (_: IllegalArgumentException) {
        }
    }

    private class NoAccessStore : SettingsGlobalStore {
        var calls = 0

        override fun get(key: String): String? {
            calls++
            throw AssertionError("feature-flag acknowledgement query touched Settings.Global")
        }

        override fun put(key: String, value: Boolean): Boolean {
            calls++
            throw AssertionError("feature-flag acknowledgement query touched Settings.Global")
        }

        override fun delete(key: String) {
            calls++
            throw AssertionError("feature-flag acknowledgement query touched Settings.Global")
        }
    }
}
