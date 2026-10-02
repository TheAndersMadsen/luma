package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the installed/runtime boundary for the stock Settings.Global JPG/YUV gate.
 *
 * The DEX/reference audit covers the 21 unique Humane APKs pulled from firmware
 * 101.000470.45.20. Ironman's audited APK SHA-256 is
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e and the
 * Photography APK SHA-256 is
 * 68081fdc1a369860f2ee7ae240ae2d6d5b517b083bbdd568a7a1b815422b19a0.
 */
class PhotographyJpgSettingsGateLockedContractTest {
    @Test
    fun `installed corpus has four live reads across capture and upload stages`() {
        assertEquals(21, installedArtifacts.size)
        assertEquals(18, installedArtifacts.count(ArtifactScan::declaresSetting))
        assertEquals(3, installedArtifacts.count { !it.declaresSetting })
        assertEquals(4, installedArtifacts.sumOf(ArtifactScan::externalFieldReads))
        assertEquals(
            listOf("humane.experience.photography"),
            installedArtifacts.filter { it.externalFieldReads > 0 }.map(ArtifactScan::apk),
        )
        assertTrue(installedArtifacts.all { it.rawKeyConsumers == 0 })

        assertEquals("SAVE_JPG_IMAGES", installed.constantName)
        assertEquals("humane_photography_jpg_enabled", installed.key)
        assertEquals(
            installed.key,
            TierASymbols.FeatureFlags.SettingsGlobal.PHOTOGRAPHY_JPG_ENABLED,
        )
        assertEquals("ProtoSettings.boolSetting", installed.getter)
        assertEquals(4, installed.runtimeConsumerCount)
        assertEquals(
            setOf(
                "CameraAccessor.generateColorCameraRequest",
                "MemoryUploadWorkerImpl.constructCreateMemoryRequestBuilder",
                "AssetUploadWorkerImpl.processItem",
                "AssetUploadWorkerImpl.encryptAssetAtPath",
            ),
            installed.consumerMethods,
        )
        assertEquals(
            setOf(
                "each photo capture request",
                "each photo CreateMemory request",
                "each asset response-to-filename mapping",
                "each photo asset encryption",
            ),
            installed.readBoundaries,
        )
        assertEquals(0, installed.explicitSettingObserverCount)
        assertEquals(0, installed.nativeLibraryMatches)
        assertTrue(installed.protoSettingsRegistersInternalObserverAfterFirstRead)
        assertFalse(installed.restartRequired)
    }

    @Test
    fun `true and false select four coupled stock wire decisions`() {
        assertEquals(
            StockPhotoMode(
                cameraSavesJpg = true,
                createMemoryFormat = "JPEG",
                responseFilenameField = "secure_filename",
                protectedDataObjectId = 2,
                uploadType = "IMAGE",
            ),
            stockPhotoMode(gate = true),
        )
        assertEquals(
            StockPhotoMode(
                cameraSavesJpg = false,
                createMemoryFormat = "YUVNV21",
                responseFilenameField = "secure_raw_data_filename",
                protectedDataObjectId = 5,
                uploadType = "IMAGE",
            ),
            stockPhotoMode(gate = false),
        )

        assertTrue(installed.valueIsReadAgainBetweenPipelineStages)
        assertTrue(installed.midFlightChangeCanMixCaptureAndUploadModes)
        assertTrue(installed.contentObserverClearsBoolCache)
        assertFalse(installed.restartRequired)
    }

    @Test
    fun `stock default and observed device state stay on the safe JPG path`() {
        assertTrue(installed.firmwareDefault)
        assertNull(installed.observedStoredValue)
        assertTrue(installed.observedCurrentValue)
        assertTrue(installed.observedSettingAvailable)
        assertTrue(installed.absentValue)
        assertTrue(installed.nonzeroIntegerValue)
        assertTrue(installed.caseInsensitiveTrueStringValue)
        assertFalse(installed.zeroIntegerValue)
        assertFalse(installed.otherStringValue)
    }

    @Test
    fun `penumbra implements JPG filenames and uploads but not the YUV contract`() {
        val capture = repoFile("runtime/core/src/services/capture.rs").readText()
        val api = repoFile("runtime/core/src/api.rs").readText()
        val proto = repoFile("runtime/core/proto/humane/capture/capture.proto").readText()

        assertTrue(capture.contains("let ext = if is_video { \"mp4\" } else { \"jpg\" };"))
        assertTrue(capture.contains("secure_filename: format!(\"{base}.{ext}\")"))
        assertTrue(capture.contains("secure_raw_data_filename: String::new()"))
        assertFalse(capture.contains("photo.format"))
        assertTrue(capture.contains("find_memory_for_file(&req.filename)"))
        assertTrue(capture.contains("invalid_argument(\"unexpected upload filename\")"))
        assertTrue(capture.contains("assert_eq!(photo_file.secure_filename, \"memory_0_0.jpg\")"))
        assertTrue(capture.contains("assert_eq!(collect_filenames(&[photo]), [\"memory_0_0.jpg\"])"))

        assertTrue(proto.contains("PhotoFileFormat format = 5;"))
        assertTrue(proto.contains("string secure_filename = 5;"))
        assertTrue(proto.contains("string secure_raw_data_filename = 6;"))
        assertTrue(proto.contains("YUVNV21 = 1;"))
        assertTrue(proto.contains("JPEG = 2;"))

        assertTrue(api.contains("mime_guess::from_path(&filename)"))
        assertTrue(api.contains("serve_file(file, \"image/jpeg\", &headers)"))

        assertTrue(installed.jpgCaptureRequestImplemented)
        assertTrue(installed.jpgServerFilenameImplemented)
        assertTrue(installed.jpgUploadStorageAndServingImplemented)
        assertFalse(installed.rawServerFilenameImplemented)
        assertFalse(installed.rawUploadContractImplemented)
        assertFalse(installed.rawStoragePresentationImplemented)
        assertFalse(installed.falseModeHasParity)
    }

    @Test
    fun `catalog locks true and the dashboard only permits safe recovery`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: settings_global_keys::PHOTOGRAPHY_JPG_ENABLED", "")
            .substringBefore("key: settings_global_keys::FOOD_ENABLED", "")
        val api = (repoFile("runtime/core/src/api/feature_flags.rs").readText() + repoFile("runtime/core/src/api/feature_flags/tests.rs").readText())
        val bridge = repoFile(
            "runtime/android/src/main/kotlin/com/penumbraos/server/SettingsGlobalBridgeServer.kt",
        ).readText()
        val uploadPolicy = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/DeviceLocalUploadPolicy.kt",
        ).readText()

        assertTrue(spec.contains("default: true"))
        assertTrue(spec.contains("writable: false"))
        assertTrue(spec.contains("restart_recommended: false"))
        assertTrue(spec.contains("stock YUV mode reads only the raw-data filename"))
        assertTrue(spec.contains("Luma currently creates the JPG upload contract"))

        assertTrue(api.contains("Settings.Global feature gate `{key}` is not writable"))
        assertTrue(
            bridge.contains(
                "TierASymbols.FeatureFlags.SettingsGlobal.PHOTOGRAPHY_JPG_ENABLED",
            ),
        )

        assertTrue(uploadPolicy.contains("Keep the force argument unchanged"))
        assertTrue(uploadPolicy.contains("uploadOnWifiAndPower"))
        assertFalse(uploadPolicy.contains(installed.key))
        assertFalse(uploadPolicy.contains(installed.constantName))

        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        listOf(installed.key, installed.constantName).forEach { selector ->
            assertFalse(
                "Production Hook must not invent unsupported false/YUV parity: $selector",
                hookSources.any { it.readText().contains(selector) },
            )
        }
    }

    private fun stockPhotoMode(gate: Boolean): StockPhotoMode = if (gate) {
        StockPhotoMode(
            cameraSavesJpg = true,
            createMemoryFormat = "JPEG",
            responseFilenameField = "secure_filename",
            protectedDataObjectId = 2,
            uploadType = "IMAGE",
        )
    } else {
        StockPhotoMode(
            cameraSavesJpg = false,
            createMemoryFormat = "YUVNV21",
            responseFilenameField = "secure_raw_data_filename",
            protectedDataObjectId = 5,
            uploadType = "IMAGE",
        )
    }

    private data class StockPhotoMode(
        val cameraSavesJpg: Boolean,
        val createMemoryFormat: String,
        val responseFilenameField: String,
        val protectedDataObjectId: Int,
        val uploadType: String,
    )

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
        val consumerMethods: Set<String>,
        val readBoundaries: Set<String>,
        val explicitSettingObserverCount: Int,
        val nativeLibraryMatches: Int,
        val protoSettingsRegistersInternalObserverAfterFirstRead: Boolean,
        val restartRequired: Boolean,
        val valueIsReadAgainBetweenPipelineStages: Boolean,
        val midFlightChangeCanMixCaptureAndUploadModes: Boolean,
        val contentObserverClearsBoolCache: Boolean,
        val firmwareDefault: Boolean,
        val observedStoredValue: Boolean?,
        val observedCurrentValue: Boolean,
        val observedSettingAvailable: Boolean,
        val absentValue: Boolean,
        val nonzeroIntegerValue: Boolean,
        val caseInsensitiveTrueStringValue: Boolean,
        val zeroIntegerValue: Boolean,
        val otherStringValue: Boolean,
        val jpgCaptureRequestImplemented: Boolean,
        val jpgServerFilenameImplemented: Boolean,
        val jpgUploadStorageAndServingImplemented: Boolean,
        val rawServerFilenameImplemented: Boolean,
        val rawUploadContractImplemented: Boolean,
        val rawStoragePresentationImplemented: Boolean,
        val falseModeHasParity: Boolean,
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
            externalFieldReads = 4,
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
        constantName = "SAVE_JPG_IMAGES",
        key = "humane_photography_jpg_enabled",
        getter = "ProtoSettings.boolSetting",
        runtimeConsumerCount = 4,
        consumerMethods = setOf(
            "CameraAccessor.generateColorCameraRequest",
            "MemoryUploadWorkerImpl.constructCreateMemoryRequestBuilder",
            "AssetUploadWorkerImpl.processItem",
            "AssetUploadWorkerImpl.encryptAssetAtPath",
        ),
        readBoundaries = setOf(
            "each photo capture request",
            "each photo CreateMemory request",
            "each asset response-to-filename mapping",
            "each photo asset encryption",
        ),
        explicitSettingObserverCount = 0,
        nativeLibraryMatches = 0,
        protoSettingsRegistersInternalObserverAfterFirstRead = true,
        restartRequired = false,
        valueIsReadAgainBetweenPipelineStages = true,
        midFlightChangeCanMixCaptureAndUploadModes = true,
        contentObserverClearsBoolCache = true,
        firmwareDefault = true,
        observedStoredValue = null,
        observedCurrentValue = true,
        observedSettingAvailable = true,
        absentValue = true,
        nonzeroIntegerValue = true,
        caseInsensitiveTrueStringValue = true,
        zeroIntegerValue = false,
        otherStringValue = false,
        jpgCaptureRequestImplemented = true,
        jpgServerFilenameImplemented = true,
        jpgUploadStorageAndServingImplemented = true,
        rawServerFilenameImplemented = false,
        rawUploadContractImplemented = false,
        rawStoragePresentationImplemented = false,
        falseModeHasParity = false,
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
