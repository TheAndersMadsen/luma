package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the installed/runtime boundary for the stock Settings.Global photo-sharing gate.
 *
 * The DEX/reference audit covers the 21 unique Humane APKs pulled from firmware
 * 101.000470.45.20. Ironman's audited APK SHA-256 is
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e and the
 * Photography APK SHA-256 is
 * 68081fdc1a369860f2ee7ae240ae2d6d5b517b083bbdd568a7a1b815422b19a0.
 */
class PhotoSharingSettingsGateLockedContractTest {
    @Test
    fun `installed corpus has one real read at Recents menu construction`() {
        assertEquals(21, installedArtifacts.size)
        assertEquals(18, installedArtifacts.count(ArtifactScan::declaresSetting))
        assertEquals(3, installedArtifacts.count { !it.declaresSetting })
        assertEquals(1, installedArtifacts.sumOf(ArtifactScan::externalFieldReads))
        assertEquals(
            listOf("humane.experience.photography"),
            installedArtifacts.filter { it.externalFieldReads > 0 }.map(ArtifactScan::apk),
        )
        assertTrue(installedArtifacts.all { it.rawKeyConsumers == 0 })

        assertEquals("PHOTO_SHARING_ENABLED", installed.constantName)
        assertEquals("humane_photo_sharing_enabled", installed.key)
        assertEquals(
            installed.key,
            TierASymbols.FeatureFlags.SettingsGlobal.PHOTO_SHARING_ENABLED,
        )
        assertEquals("ProtoSettings.boolSetting", installed.getter)
        assertEquals(1, installed.runtimeConsumerCount)
        assertEquals("RecentsMenu constructor", installed.readBoundary)
        assertEquals(0, installed.explicitSettingObserverCount)
        assertEquals(0, installed.nativeLibraryMatches)
        assertTrue(installed.protoSettingsRegistersInternalObserverAfterFirstRead)
        assertTrue(installed.defaultExperienceMenuConstructsFreshRecentsMenu)
        assertFalse(installed.restartRequired)
    }

    @Test
    fun `false stays informational while true selects the incomplete remote path`() {
        assertEquals(
            ShareAffordance.UPLOAD_ERROR_WITHOUT_SHARE,
            shareAffordance(canUpload = false, lowResolutionUploaded = true, gate = true),
        )
        assertEquals(
            ShareAffordance.COMING_SOON_DIALOG,
            shareAffordance(canUpload = true, lowResolutionUploaded = false, gate = false),
        )
        assertEquals(
            ShareAffordance.COMING_SOON_DIALOG,
            shareAffordance(canUpload = true, lowResolutionUploaded = true, gate = false),
        )
        assertEquals(
            ShareAffordance.OMITTED_UNTIL_LOW_RESOLUTION_UPLOAD,
            shareAffordance(canUpload = true, lowResolutionUploaded = false, gate = true),
        )
        assertEquals(
            ShareAffordance.REMOTE_LINK_TO_MESSAGES,
            shareAffordance(canUpload = true, lowResolutionUploaded = true, gate = true),
        )

        assertEquals("Coming Soon", installed.disabledDialogHeader)
        assertEquals(
            "Visit humane.center from a browser to share & download captures.",
            installed.disabledDialogBody,
        )
        assertFalse(installed.disabledPathCallsShareBackend)
        assertTrue(installed.enabledPathCallsGetMemoryShareLink)
        assertTrue(installed.enabledPathRoutesComposeMessageAction)
        assertTrue(installed.enabledPathAttachesLocalThumbnail)
        assertFalse(installed.gateChangesCaptureOrUploadPolicy)
    }

    @Test
    fun `stock default is absent false and the next menu observes changes without restart`() {
        assertFalse(installed.firmwareDefault)
        assertNull(installed.observedStoredValue)
        assertFalse(installed.observedCurrentValue)
        assertTrue(installed.observedSettingAvailable)
        assertFalse(installed.absentValue)
        assertTrue(installed.nonzeroIntegerValue)
        assertTrue(installed.caseInsensitiveTrueStringValue)
        assertFalse(installed.otherStringValue)

        assertTrue(installed.boolValueIsCached)
        assertTrue(installed.contentObserverClearsBoolCache)
        assertTrue(installed.nextMenuConstructionReadsRefreshedValue)
        assertTrue(installed.existingMenuKeepsCapturedHandler)
        assertFalse(installed.restartRequired)
    }

    @Test
    fun `penumbra has local media but not the signed share and import backend`() {
        val capture = repoFile("runtime/core/src/services/capture.rs").readText()
        val proto = repoFile("runtime/core/proto/humane/capture/capture.proto").readText()
        val api = repoFile("runtime/core/src/api.rs").readText()
        val main = repoFile("runtime/core/src/boot/mod.rs").readText()

        assertTrue(capture.contains("Capture.GetMemoryShareLink (stub)"))
        assertTrue(capture.contains("share_link: String::new()"))
        assertTrue(capture.contains("Capture.SaveSharedMemory (stub)"))
        assertTrue(capture.contains("created_memory_uuid: String::new()"))
        assertTrue(capture.contains("Capture.GetShareLinkContents (stub)"))
        assertTrue(capture.contains("decrypted_thumbnail_bytes: vec![]"))

        assertTrue(proto.contains("rpc GetMemoryShareLink"))
        assertTrue(proto.contains("rpc SaveSharedMemory"))
        assertTrue(proto.contains("rpc GetShareLinkContents"))
        assertTrue(proto.contains("message ShareLinkData"))
        assertTrue(proto.contains("string memory_uuid = 1;"))
        assertTrue(proto.contains("string signature = 2;"))
        assertTrue(proto.contains("int64 expiry = 3;"))

        assertTrue(api.contains(".route(\"/api/memories\", get(list_memories))"))
        assertFalse(api.contains(".route(\"/share"))
        assertFalse(api.contains(".route(\"/api/share"))
        assertTrue(main.contains("api::require_admin_auth"))

        assertEquals(1, installed.installedIncomingPreviewConsumerCount)
        assertEquals(
            "Messages.ShareLinkUtil.downloadImageAndSave",
            installed.incomingPreviewConsumer,
        )
        assertEquals(
            "https://(.*)humane.center/share/capture/(.*)\\?expiry=(.*)signature=(.*)",
            installed.stockShareLinkRegex,
        )
        assertEquals(15, installed.incomingPreviewDeadlineSeconds)
        assertTrue(installed.incomingPreviewSendsMemoryUuidSignatureAndExpiry)
        assertEquals(0, installed.installedSaveSharedMemoryConsumerCount)
        assertTrue(installed.emptyStubLinkPassesStockNullCheck)
        assertTrue(installed.emptyStubLinkCanReachMessageComposer)
        assertTrue(installed.emptyStubLinkLeavesOnlyLocalThumbnailUseful)
        assertFalse(installed.signedExpiringPublicLinkImplemented)
        assertFalse(installed.recipientRetrievalBackendImplemented)
        assertFalse(installed.sharedMemoryImportBackendImplemented)
        assertTrue(installed.emptyPreviewBytesReturnedWithoutSignatureOrExpiryValidation)
        assertTrue(installed.localCaptureAndCenterMediaIndependent)
    }

    @Test
    fun `catalog locks safe false while preserving stale value recovery`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: settings_global_keys::PHOTO_SHARING_ENABLED", "")
            .substringBefore("key: settings_global_keys::PHOTOGRAPHY_JPG_ENABLED", "")
        val api = (repoFile("runtime/core/src/api/feature_flags.rs").readText() + repoFile("runtime/core/src/api/feature_flags/tests.rs").readText())
        val bridge = repoFile(
            "runtime/android/src/main/kotlin/com/penumbraos/server/SettingsGlobalBridgeServer.kt",
        ).readText()

        assertTrue(spec.contains("default: false"))
        assertTrue(spec.contains("writable: false"))
        assertTrue(spec.contains("restart_recommended: false"))
        assertTrue(spec.contains("remote share/import backend is not restored"))
        assertTrue(spec.contains("local capture and Center media remain available"))
        assertTrue(spec.contains("each Recents menu open"))

        assertTrue(api.contains("A locked gate still accepts its declared safe default or null"))
        assertTrue(api.contains("value.is_some_and(|value| value != spec.default)"))
        assertTrue(api.contains("Settings.Global feature gate `{key}` is not writable"))
        assertTrue(
            bridge.contains(
                "TierASymbols.FeatureFlags.SettingsGlobal.PHOTO_SHARING_ENABLED",
            ),
        )

        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        listOf(installed.key, installed.constantName).forEach { selector ->
            assertFalse(
                "Production Hook must not force the locked photo-sharing selector: $selector",
                hookSources.any { it.readText().contains(selector) },
            )
        }
    }

    private fun shareAffordance(
        canUpload: Boolean,
        lowResolutionUploaded: Boolean,
        gate: Boolean,
    ): ShareAffordance = when {
        !canUpload -> ShareAffordance.UPLOAD_ERROR_WITHOUT_SHARE
        lowResolutionUploaded || !gate -> if (gate) {
            ShareAffordance.REMOTE_LINK_TO_MESSAGES
        } else {
            ShareAffordance.COMING_SOON_DIALOG
        }
        else -> ShareAffordance.OMITTED_UNTIL_LOW_RESOLUTION_UPLOAD
    }

    private enum class ShareAffordance {
        UPLOAD_ERROR_WITHOUT_SHARE,
        COMING_SOON_DIALOG,
        OMITTED_UNTIL_LOW_RESOLUTION_UPLOAD,
        REMOTE_LINK_TO_MESSAGES,
    }

    private data class ArtifactScan(
        val apk: String,
        val declaresSetting: Boolean,
        val externalFieldReads: Int = 0,
        val rawKeyConsumers: Int = 0,
    )

    private data class InstalledContract(
        val constantName: String,
        val key: String,
        val getter: String,
        val runtimeConsumerCount: Int,
        val readBoundary: String,
        val explicitSettingObserverCount: Int,
        val nativeLibraryMatches: Int,
        val protoSettingsRegistersInternalObserverAfterFirstRead: Boolean,
        val defaultExperienceMenuConstructsFreshRecentsMenu: Boolean,
        val restartRequired: Boolean,
        val disabledDialogHeader: String,
        val disabledDialogBody: String,
        val disabledPathCallsShareBackend: Boolean,
        val enabledPathCallsGetMemoryShareLink: Boolean,
        val enabledPathRoutesComposeMessageAction: Boolean,
        val enabledPathAttachesLocalThumbnail: Boolean,
        val gateChangesCaptureOrUploadPolicy: Boolean,
        val firmwareDefault: Boolean,
        val observedStoredValue: Boolean?,
        val observedCurrentValue: Boolean,
        val observedSettingAvailable: Boolean,
        val absentValue: Boolean,
        val nonzeroIntegerValue: Boolean,
        val caseInsensitiveTrueStringValue: Boolean,
        val otherStringValue: Boolean,
        val boolValueIsCached: Boolean,
        val contentObserverClearsBoolCache: Boolean,
        val nextMenuConstructionReadsRefreshedValue: Boolean,
        val existingMenuKeepsCapturedHandler: Boolean,
        val installedIncomingPreviewConsumerCount: Int,
        val incomingPreviewConsumer: String,
        val stockShareLinkRegex: String,
        val incomingPreviewDeadlineSeconds: Int,
        val incomingPreviewSendsMemoryUuidSignatureAndExpiry: Boolean,
        val installedSaveSharedMemoryConsumerCount: Int,
        val emptyStubLinkPassesStockNullCheck: Boolean,
        val emptyStubLinkCanReachMessageComposer: Boolean,
        val emptyStubLinkLeavesOnlyLocalThumbnailUseful: Boolean,
        val signedExpiringPublicLinkImplemented: Boolean,
        val recipientRetrievalBackendImplemented: Boolean,
        val sharedMemoryImportBackendImplemented: Boolean,
        val emptyPreviewBytesReturnedWithoutSignatureOrExpiryValidation: Boolean,
        val localCaptureAndCenterMediaIndependent: Boolean,
    )

    private val installedArtifacts = listOf(
        ArtifactScan("hu.ma.ne.ironman", declaresSetting = true),
        ArtifactScan("humane.experience.answers", declaresSetting = true),
        ArtifactScan("humane.experience.clock", declaresSetting = true),
        ArtifactScan("humane.experience.contacts", declaresSetting = true),
        ArtifactScan("humane.experience.dialer", declaresSetting = true),
        ArtifactScan("humane.experience.food", declaresSetting = true),
        ArtifactScan("humane.experience.messages", declaresSetting = true),
        ArtifactScan("humane.experience.music", declaresSetting = true),
        ArtifactScan("humane.experience.notifications", declaresSetting = true),
        ArtifactScan("humane.experience.onboarding", declaresSetting = true),
        ArtifactScan(
            "humane.experience.photography",
            declaresSetting = true,
            externalFieldReads = 1,
        ),
        ArtifactScan("humane.experience.settings", declaresSetting = true),
        ArtifactScan("humane.experience.systemnavigation", declaresSetting = true),
        ArtifactScan("humane.experience.tickle", declaresSetting = true),
        ArtifactScan("humane.experience.translation", declaresSetting = true),
        ArtifactScan("humane.experience.vision", declaresSetting = true),
        ArtifactScan("humane.experience.voicemail", declaresSetting = true),
        ArtifactScan("humane.grandcentral", declaresSetting = true),
        ArtifactScan("humane.connectivity.esimlpa", declaresSetting = false),
        ArtifactScan("humane.voice.recognition", declaresSetting = false),
        ArtifactScan("humane.voice.tts", declaresSetting = false),
    )

    private val installed = InstalledContract(
        constantName = "PHOTO_SHARING_ENABLED",
        key = "humane_photo_sharing_enabled",
        getter = "ProtoSettings.boolSetting",
        runtimeConsumerCount = 1,
        readBoundary = "RecentsMenu constructor",
        explicitSettingObserverCount = 0,
        nativeLibraryMatches = 0,
        protoSettingsRegistersInternalObserverAfterFirstRead = true,
        defaultExperienceMenuConstructsFreshRecentsMenu = true,
        restartRequired = false,
        disabledDialogHeader = "Coming Soon",
        disabledDialogBody = "Visit humane.center from a browser to share & download captures.",
        disabledPathCallsShareBackend = false,
        enabledPathCallsGetMemoryShareLink = true,
        enabledPathRoutesComposeMessageAction = true,
        enabledPathAttachesLocalThumbnail = true,
        gateChangesCaptureOrUploadPolicy = false,
        firmwareDefault = false,
        observedStoredValue = null,
        observedCurrentValue = false,
        observedSettingAvailable = true,
        absentValue = false,
        nonzeroIntegerValue = true,
        caseInsensitiveTrueStringValue = true,
        otherStringValue = false,
        boolValueIsCached = true,
        contentObserverClearsBoolCache = true,
        nextMenuConstructionReadsRefreshedValue = true,
        existingMenuKeepsCapturedHandler = true,
        installedIncomingPreviewConsumerCount = 1,
        incomingPreviewConsumer = "Messages.ShareLinkUtil.downloadImageAndSave",
        stockShareLinkRegex =
            "https://(.*)humane.center/share/capture/(.*)\\?expiry=(.*)signature=(.*)",
        incomingPreviewDeadlineSeconds = 15,
        incomingPreviewSendsMemoryUuidSignatureAndExpiry = true,
        installedSaveSharedMemoryConsumerCount = 0,
        emptyStubLinkPassesStockNullCheck = true,
        emptyStubLinkCanReachMessageComposer = true,
        emptyStubLinkLeavesOnlyLocalThumbnailUseful = true,
        signedExpiringPublicLinkImplemented = false,
        recipientRetrievalBackendImplemented = false,
        sharedMemoryImportBackendImplemented = false,
        emptyPreviewBytesReturnedWithoutSignatureOrExpiryValidation = true,
        localCaptureAndCenterMediaIndependent = true,
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
