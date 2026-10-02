package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the stock wireless-charging request boundary recovered from the
 * installed Ironman, Photography, and Onboarding bytecode. This is a static
 * reverse-engineering contract. Its physical behavior is not device-verified.
 */
class WirelessChargingStockParityContractTest {
    @Test
    fun `pinned stock artifacts retain their distinct requests and failure behavior`() {
        pinnedApks.forEach { StockReference.requireReviewedApk(it.relativePath, it.sha256) }
        val sources = pinnedSources.associate { evidence ->
            evidence.relativePath to
                StockReference.decompiled(evidence.relativePath, evidence.sha256).readText()
        }

        val proxy = sources.getValue(IRONMAN_WLC_PROXY)
        assertContains(proxy, "case 9:")
        assertContains(proxy, "byte _result8 = disableTx_2(_arg08, _arg12);")
        assertContains(proxy, "this.mRemote.transact(9, _data, _reply, 0);")
        assertContains(proxy, "byte _result = _reply.readByte();")

        val ironman = sources.getValue(IRONMAN_WLC_CALLER)
        assertContains(sources.getValue(IRONMAN_BUILD_CONFIG), "String FLAVOR = \"ironman\"")
        assertContains(ironman, "mWlcService.disableTx_2(BuildConfig.FLAVOR, seconds);")
        assertContains(ironman, "disableTxWithTimeout(90);")
        assertContains(ironman, "catch (RemoteException e)")

        val photographyWrapper = sources.getValue(PHOTOGRAPHY_WLC_WRAPPER)
        assertContains(photographyWrapper, "service.disableTx_2(\"photography\", seconds);")

        val capture = sources.getValue(PHOTOGRAPHY_CAPTURE_CALLER)
        assertContains(capture, "this.mWirelessChargingService.disableTxWithTimeout(wlcTimeout);")
        assertContains(capture, "catch (RemoteException e)")
        assertContains(capture, "capture(action2).whenComplete")
        assertContains(
            sources.getValue(PHOTOGRAPHY_PHOTO_TIMEOUT),
            "Config.sharedInstance().photography.numPhotosPerBurst) * 1.5d",
        )
        assertContains(
            sources.getValue(PHOTOGRAPHY_VIDEO_TIMEOUT),
            "Config.sharedInstance().photography.videoDuration) + 2.0d",
        )

        val upload = sources.getValue(PHOTOGRAPHY_UPLOAD_CALLER)
        assertContains(upload, "int WLC_DISABLE_DURATION = 120;")
        assertContains(
            upload,
            "this.mWirelessChargingService.disableTxWithTimeout(WLC_DISABLE_DURATION);",
        )
        assertContains(upload, "return CompletableFuture.failedFuture(e);")

        val onboarding = sources.getValue(ONBOARDING_WLC_CALLER)
        assertContains(onboarding, "disableTxWithTimeout(90);")
        assertContains(onboarding, "this.mWlcService.disableTx_2(\"onboarding\", i);")
        assertContains(onboarding, "catch (RemoteException e)")
    }

    @Test
    fun `production hooks leave every wlc disable request stock owned`() {
        val root = repositoryRoot()
        val hookSources = File(
            root,
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

        listOf(
            "humane.wlc.IWlcService",
            "disableTx",
            "disableTx_2",
        ).forEach { stockBoundary ->
            assertFalse(
                "Production Hook must leave stock WLC calls untouched: $stockBoundary",
                hookSources.any { it.readText().contains(stockBoundary) },
            )
        }

        val broadDisableSelector = Regex("startsWith\\s*\\(\\s*\"disableTx\"")
        assertFalse(
            "Production Hook must not intercept a family of WLC methods by prefix",
            hookSources.any { broadDisableSelector.containsMatchIn(it.readText()) },
        )

        val syntheticSuccess = Regex("param\\.result\\s*=\\s*0\\.toByte\\(\\)")
        assertFalse(
            "Production Hook must not synthesize WLC success",
            hookSources.any {
                val source = it.readText()
                source.contains("disableTx") && syntheticSuccess.containsMatchIn(source)
            },
        )
    }

    /** A stock app in `apks/` or a jadx file in `decompiled/`, at its reviewed SHA-256. */
    private data class PinnedEvidence(
        val relativePath: String,
        val sha256: String,
    )

    private val pinnedApks = listOf(
        PinnedEvidence(
            "ironman.apk",
            "5d60b33eacdc53a35ea8476d36e05f29f6fab22440ef777e44b5d4269e277232",
        ),
        PinnedEvidence(
            "humane_photography.apk",
            "8b7a68950d2415f3cf329a4f588ac91fb2ef8b2bc7c1e09c30b9648d0791f6c0",
        ),
        PinnedEvidence(
            "humane_onboarding.apk",
            "6f7a6f70149c58b1aeefd25e95fecbf4aaddcdb1a8d0f4cbd254bfaeb721b525",
        ),
    )

    private val pinnedSources = listOf(
        PinnedEvidence(IRONMAN_WLC_PROXY, "9a5a089a0ca5e239a019d06e0dc6bfe2fc1fe3d88bfe3e83b90b290c6544bec9"),
        PinnedEvidence(IRONMAN_WLC_CALLER, "0108b93803bb31e5af07cff018379148fbbc801eadcb30697ff61aa187995a95"),
        PinnedEvidence(IRONMAN_BUILD_CONFIG, "9ec02a938634edf29e0a39e6d21149bf3d9627e7ff257f4faf93ceab6c8962e5"),
        PinnedEvidence(PHOTOGRAPHY_WLC_WRAPPER, "333e4f96ec070e4fd518ac0102240563b61583c2b18cd08510a936a096fa2c5d"),
        PinnedEvidence(PHOTOGRAPHY_CAPTURE_CALLER, "a773474a440772a207105982a6305f5f086e5bedad9afa28c912c3af9604da0d"),
        PinnedEvidence(PHOTOGRAPHY_PHOTO_TIMEOUT, "08a3c692e886fcc9a56bb34cf9b4b38bdf6e87ac70c798e7f85d8382703e2195"),
        PinnedEvidence(PHOTOGRAPHY_VIDEO_TIMEOUT, "4007158a890828031b1a16be5cb0800cc215d2ea0fce45e141a8cb0ec6db464a"),
        PinnedEvidence(PHOTOGRAPHY_UPLOAD_CALLER, "7ffce65e250d60a4c9bd353096fa56572ff1cf33b75c02b33a62d0d2f0c17a86"),
        PinnedEvidence(ONBOARDING_WLC_CALLER, "fa923e2e6eee92741bfa22fdbb82e2ab778e49ee74c28c9383f85f9c6eedb73c"),
    )

    private fun assertContains(source: String, expected: String) {
        assertTrue("Missing pinned stock behavior: $expected", source.contains(expected))
    }

    private fun repositoryRoot(): File {
        val candidates = listOf(File("."), File(".."), File("../.."))
        return candidates.firstOrNull {
            File(it, "hook/module/src/main/kotlin/com/penumbraos/hook").isDirectory
        } ?: throw AssertionError("Missing repository Hook source directory")
    }

    private companion object {
        const val IRONMAN_WLC_PROXY =
            "ironman/sources/humane/wlc/IWlcService.java"
        const val IRONMAN_WLC_CALLER =
            "ironman/sources/humaneinternal/system/power/WirelessCharging.java"
        const val IRONMAN_BUILD_CONFIG =
            "ironman/sources/humaneinternal/system/BuildConfig.java"
        const val PHOTOGRAPHY_WLC_WRAPPER =
            "humane_photography/sources/dependency/implementations/WirelessChargingServiceWrapper.java"
        const val PHOTOGRAPHY_CAPTURE_CALLER =
            "humane_photography/sources/action/BaseCaptureActionHandler.java"
        const val PHOTOGRAPHY_PHOTO_TIMEOUT =
            "humane_photography/sources/action/CapturePhotographActionHandler.java"
        const val PHOTOGRAPHY_VIDEO_TIMEOUT =
            "humane_photography/sources/action/CaptureVideoActionHandler.java"
        const val PHOTOGRAPHY_UPLOAD_CALLER =
            "humane_photography/sources/worker/upload/AssetUploadWorkerImpl.java"
        const val ONBOARDING_WLC_CALLER =
            "humane_onboarding/sources/humane/experience/onboarding/OnboardingWLCCoordinator.java"
    }
}
