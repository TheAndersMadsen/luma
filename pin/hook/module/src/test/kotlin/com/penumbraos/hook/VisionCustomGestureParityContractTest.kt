package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards Penumbra's boundary around the installed custom-vision gesture.
 *
 * The stock contract was recovered from Ironman SHA-256
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e
 * and humane.experience.vision SHA-256
 * 1c88b960fa158545aeadccde8313ca9c3436f009d022462da277dda3ad9727a6.
 */
class VisionCustomGestureParityContractTest {
    @Test
    fun `installed sole flag consumer snapshots the live value at session begin`() {
        assertEquals(1, installed.flagReadCallSites)
        assertEquals(
            "humaneinternal.system.gesture.IntentRecognitionAction",
            installed.consumerClass,
        )
        assertEquals("beganAction", installed.readBoundary)
        assertEquals("getBoolValue", installed.getter)
        assertEquals("VISION_CUSTOM_GESTURE_ENABLED", installed.feature)
        assertEquals("ONE_FINGER_TAP_THEN_HOLD", installed.gesture)
        assertEquals(
            "INTENT_RECOGNITION_WITH_VISION_PREFETCH",
            installed.mappedAction,
        )
        assertFalse(installed.registersFlagObserver)
        assertTrue(installed.endAndCancelUseBeginSnapshot)

        // False suppresses the whole custom-gesture session. A change after
        // begin cannot partially start its end/cancel path.
        val action = InstalledVisionGestureAction(liveFlag = false)
        action.begin()
        assertEquals(0, action.startedSessions)
        assertNull(action.visionRequested)
        action.liveFlag = true
        action.endSuccessfully()
        assertEquals(0, action.prefetchedFrames)

        // The next begin samples true without recreating Ironman. A later
        // false update does not tear down the already-started session.
        action.begin()
        assertEquals(1, action.startedSessions)
        assertEquals("VISION", action.visionRequested)
        action.liveFlag = false
        action.endSuccessfully()
        assertEquals(1, action.prefetchedFrames)

        // The following session samples false again, proving both live edges.
        action.begin()
        action.liveFlag = true
        action.cancel()
        assertEquals(1, action.startedSessions)
        assertEquals(0, action.discardedFrames)
    }

    @Test
    fun `stock false fallback and penumbra true baseline remain typed and live`() {
        assertFalse(installed.firmwareDefault)
        assertFalse(installed.missingOrFailedRead)
        assertEquals(
            "vision_custom_gesture_enabled",
            TierASymbols.FeatureFlags.Cloud.VISION_CUSTOM_GESTURE_ENABLED,
        )

        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: VISION_CUSTOM_GESTURE_KEY", "")
            .substringBefore("key: cloud_keys::QUICK_ACTIONS_REMAPPING_ENABLED", "")
        assertTrue(spec.contains("value_type: FeatureFlagValueType::Bool"))
        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::Bool(false)"))
        assertTrue(
            spec.contains(
                "penumbra_default: Some(FeatureFlagDefault::Bool(true))",
            ),
        )
        assertTrue(spec.contains("restart_recommended: false"))
        assertTrue(
            catalog.contains(
                "ConfiguredFeatureFlagValue::Bool(value) => feature_flag_assignment::Val::ValBool(value)",
            ),
        )

        val service = repoFile("runtime/core/src/services/featureflags.rs").readText()
        assertTrue(service.contains("let config = self.config.read().await;"))
        assertTrue(service.contains("proto_assignments(&config.feature_flags)"))
    }

    @Test
    fun `enabled stock session reaches the restored analyze image path`() {
        assertEquals("VISION", installed.enabledVisionRequested)
        assertTrue(installed.transcriptionActivatedByVision)
        assertEquals(500L, installed.successfulEndDelayMillis)
        assertEquals("prefetchFrame(runId)", installed.successfulEndCapture)
        assertEquals("discardFrame(runId)", installed.cancelCapture)
        assertEquals(
            listOf(
                "SynapseUserRequest(vision_requested=VISION, runId)",
                "UnderstandScene(runId)",
                "captureFrameAndAnalyze(runId)",
                "ImageFetcher.fetchImage(runId)",
                "IAiBusBridge.analyzeImage(runId, JPEG)",
                "AIBus.AnalyzeImage(runId)",
            ),
            installed.enabledPath,
        )

        // The stock gesture path above is what the Compatibility Layer restores.
        // Its local runtime counterpart (synapse vision, the analyze-image
        // service, and the image store) was deleted with the local planner;
        // Cosmos owns the vision turn now.
    }

    @Test
    fun `dashboard save requests stock sync and exact binder cache acknowledgement`() {
        val api = repoFile("runtime/core/src/api/feature_flags.rs").readText()
        val ironman = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        val acknowledgement = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/FeatureFlagApplyAckHooks.kt",
        ).readText()

        assertTrue(api.contains("request_immediate_feature_flag_sync().await"))
        assertTrue(api.contains("FORCE_FLAG_SYNC_ACTION"))
        assertTrue(api.contains("publish_feature_flags_and_sync("))
        assertTrue(ironman.contains("FeatureFlagApplyAckHooks.install(cl)"))
        assertTrue(acknowledgement.contains("\"setServerFlags\""))
        assertTrue(acknowledgement.contains("\"getFlagAssignment\""))
        assertTrue(acknowledgement.contains("exactReadBack"))
        assertTrue(acknowledgement.contains("applyLock.lock()"))
        assertFalse(acknowledgement.contains("updateServerFlag"))
    }

    @Test
    fun `production hooks do not replace the stock custom gesture decision`() {
        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

        listOf(
            "vision_custom_gesture_enabled",
            "VISION_CUSTOM_GESTURE_ENABLED",
            "mIsVisionGestureEnabled",
            "humaneinternal.system.gesture.IntentRecognitionAction",
        ).forEach { stockContract ->
            assertFalse(
                "Production Hook must leave the stock vision gate untouched: $stockContract",
                hookSources.any { it.readText().contains(stockContract) },
            )
        }

        // VisionTraceHooks observes only the downstream voice/AnalyzeImage
        // calls. It neither reads the gate nor substitutes a return value.
        val trace = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/VisionTraceHooks.kt",
        ).readText()
        assertFalse(trace.contains("FeatureFlagManager"))
        assertFalse(Regex("""param\.result\s*=(?!=)""").containsMatchIn(trace))
        assertFalse(Regex("""param\.throwable\s*=(?!=)""").containsMatchIn(trace))
        assertTrue(trace.contains("voice_request run="))
        assertTrue(trace.contains("analyze_image_start run="))
    }

    private data class InstalledVisionGestureContract(
        val flagReadCallSites: Int,
        val consumerClass: String,
        val readBoundary: String,
        val getter: String,
        val feature: String,
        val gesture: String,
        val mappedAction: String,
        val registersFlagObserver: Boolean,
        val endAndCancelUseBeginSnapshot: Boolean,
        val firmwareDefault: Boolean,
        val missingOrFailedRead: Boolean,
        val enabledVisionRequested: String,
        val transcriptionActivatedByVision: Boolean,
        val successfulEndDelayMillis: Long,
        val successfulEndCapture: String,
        val cancelCapture: String,
        val enabledPath: List<String>,
    )

    private class InstalledVisionGestureAction(var liveFlag: Boolean) {
        private var enabledForSession = false
        var startedSessions = 0
            private set
        var prefetchedFrames = 0
            private set
        var discardedFrames = 0
            private set
        var visionRequested: String? = null
            private set

        fun begin() {
            enabledForSession = liveFlag
            if (!enabledForSession) {
                visionRequested = null
                return
            }
            startedSessions += 1
            visionRequested = "VISION"
        }

        fun endSuccessfully() {
            if (enabledForSession) prefetchedFrames += 1
        }

        fun cancel() {
            if (enabledForSession) discardedFrames += 1
        }
    }

    private val installed = InstalledVisionGestureContract(
        flagReadCallSites = 1,
        consumerClass = "humaneinternal.system.gesture.IntentRecognitionAction",
        readBoundary = "beganAction",
        getter = "getBoolValue",
        feature = "VISION_CUSTOM_GESTURE_ENABLED",
        gesture = "ONE_FINGER_TAP_THEN_HOLD",
        mappedAction = "INTENT_RECOGNITION_WITH_VISION_PREFETCH",
        registersFlagObserver = false,
        endAndCancelUseBeginSnapshot = true,
        firmwareDefault = false,
        missingOrFailedRead = false,
        enabledVisionRequested = "VISION",
        transcriptionActivatedByVision = true,
        successfulEndDelayMillis = 500L,
        successfulEndCapture = "prefetchFrame(runId)",
        cancelCapture = "discardFrame(runId)",
        enabledPath = listOf(
            "SynapseUserRequest(vision_requested=VISION, runId)",
            "UnderstandScene(runId)",
            "captureFrameAndAnalyze(runId)",
            "ImageFetcher.fetchImage(runId)",
            "IAiBusBridge.analyzeImage(runId, JPEG)",
            "AIBus.AnalyzeImage(runId)",
        ),
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
