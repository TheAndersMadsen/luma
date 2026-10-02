package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards Penumbra's delivery boundary for the installed firmware's only
 * touchcode-timeout consumer. The physical stock contract was recovered from
 * Ironman SHA-256 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class TouchcodeTimeoutParityContractTest {
    @Test
    fun `installed sole consumer samples milliseconds at every scheduling boundary`() {
        assertEquals(
            "humane.system.gesture.TouchcodeManager",
            installed.consumerClass,
        )
        assertEquals("scheduleOrExtendAutoFinish", installed.consumerMethod)
        assertEquals("getIntValue", installed.getter)
        assertEquals("TOUCHCODE_TIMEOUT_MILLIS", installed.feature)
        assertEquals("Delay.performDelayed", installed.scheduler)
        assertEquals(TimeoutUnit.MILLISECONDS, installed.unit)
        assertEquals(
            setOf(
                ReadBoundary.ACTIVATION,
                ReadBoundary.RESET_OR_RING,
                ReadBoundary.CODE_GESTURE,
            ),
            installed.readBoundaries,
        )

        // A flag-only update does not replace a Delay already in the Handler
        // queue. The next gesture/reset/session schedules from the live cache.
        assertFalse(installed.reschedulesPendingDelayOnFlagCallback)
    }

    @Test
    fun `missing read and explicit zero retain stocks immediate timeout semantics`() {
        assertEquals(5_000, installed.firmwareDefaultMillis)
        assertEquals(0, installed.missingOrFailedReadMillis)
        assertTrue(installed.handlerClampsNonPositiveDelayToImmediate)
        assertEquals(
            "touchcode_timeout_millis",
            TierASymbols.FeatureFlags.Cloud.TOUCHCODE_TIMEOUT_MILLIS,
        )

        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: cloud_keys::TOUCHCODE_TIMEOUT_MILLIS", "")
            .substringBefore("key: cloud_keys::LASER_FINDING_GUIDE", "")
        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::Int(5_000)"))
        assertTrue(spec.contains("penumbra_default: None"))
        assertTrue(spec.contains("restart_recommended: false"))

        // Penumbra rejects only values below zero, so zero remains the exact
        // stock immediate-expiry value rather than being silently rewritten.
        assertTrue(catalog.contains("key == cloud_keys::TOUCHCODE_TIMEOUT_MILLIS"))
        assertTrue(catalog.contains("&& *value < 0"))
    }

    @Test
    fun `firmware default stays absent while live overrides use a bounded typed integer`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val service = repoFile("runtime/core/src/services/featureflags.rs").readText()
        assertTrue(catalog.contains("/// defaults remain absent from the response"))
        assertTrue(catalog.contains("i32::try_from(*value).is_err()"))
        assertTrue(catalog.contains("feature_flag_assignment::Val::ValInt(value)"))
        assertTrue(catalog.contains("actual_type != spec.value_type"))

    }

    @Test
    fun `stock binder cache is acknowledged before dashboard reports the change applied`() {
        val ironman = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        val acknowledgement = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/FeatureFlagApplyAckHooks.kt",
        ).readText()

        assertTrue(ironman.contains("FeatureFlagApplyAckHooks.install(cl)"))
        assertTrue(acknowledgement.contains("\"setServerFlags\""))
        assertTrue(acknowledgement.contains("\"getFlagAssignment\""))
        assertTrue(acknowledgement.contains("exactReadBack"))
        assertTrue(acknowledgement.contains("applyLock.lock()"))
        assertFalse(acknowledgement.contains("updateServerFlag"))
    }

    @Test
    fun `production hooks leave touchcode scheduling entirely stock owned`() {
        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

        listOf(
            "TOUCHCODE_TIMEOUT_MILLIS",
            "touchcode_timeout_millis",
            "humane.system.gesture.TouchcodeManager",
            "scheduleOrExtendAutoFinish",
            "humane.ui.Delay",
        ).forEach { stockContract ->
            assertFalse(
                "Production Hook must leave stock Touchcode scheduling untouched: $stockContract",
                hookSources.any { it.readText().contains(stockContract) },
            )
        }
    }

    private enum class TimeoutUnit { MILLISECONDS }

    private enum class ReadBoundary {
        ACTIVATION,
        RESET_OR_RING,
        CODE_GESTURE,
    }

    private data class InstalledTouchcodeContract(
        val consumerClass: String,
        val consumerMethod: String,
        val getter: String,
        val feature: String,
        val scheduler: String,
        val unit: TimeoutUnit,
        val readBoundaries: Set<ReadBoundary>,
        val firmwareDefaultMillis: Int,
        val missingOrFailedReadMillis: Int,
        val handlerClampsNonPositiveDelayToImmediate: Boolean,
        val reschedulesPendingDelayOnFlagCallback: Boolean,
    )

    private val installed = InstalledTouchcodeContract(
        consumerClass = "humane.system.gesture.TouchcodeManager",
        consumerMethod = "scheduleOrExtendAutoFinish",
        getter = "getIntValue",
        feature = "TOUCHCODE_TIMEOUT_MILLIS",
        scheduler = "Delay.performDelayed",
        unit = TimeoutUnit.MILLISECONDS,
        readBoundaries = setOf(
            ReadBoundary.ACTIVATION,
            ReadBoundary.RESET_OR_RING,
            ReadBoundary.CODE_GESTURE,
        ),
        firmwareDefaultMillis = 5_000,
        missingOrFailedReadMillis = 0,
        handlerClampsNonPositiveDelayToImmediate = true,
        reschedulesPendingDelayOnFlagCallback = false,
    )

    private fun repoFile(relativePath: String): File {
        val candidates = listOf(
            File(relativePath),
            File("..", relativePath),
            File("../..", relativePath),
        )
        return candidates.firstOrNull { it.exists() }
            ?: throw AssertionError("Missing repository contract path: $relativePath")
    }
}
