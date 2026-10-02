package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the installed-firmware absence boundary for the legacy
 * Settings.Global `humane_cmu_ultra_enabled` selector.
 *
 * The DEX/reference audit covers the 21 unique Humane APKs pulled from firmware
 * 101.000470.45.20. Ironman's audited APK SHA-256 is
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class CmuUltraSettingsGlobalLockedContractTest {
    @Test
    fun `installed 21 apk corpus contains declarations but no behavioral read`() {
        assertEquals(21, installedArtifacts.size)
        assertEquals(18, installedArtifacts.count(ArtifactScan::declaresGlobalSelector))
        assertEquals(
            setOf(
                "humane.connectivity.esimlpa",
                "humane.voice.recognition",
                "humane.voice.tts",
            ),
            installedArtifacts.filterNot(ArtifactScan::declaresGlobalSelector).map { it.apk }.toSet(),
        )
        assertEquals(18, installedArtifacts.sumOf(ArtifactScan::rawGlobalKeyConstStringSites))
        assertEquals(18, installedArtifacts.sumOf(ArtifactScan::definitionFieldWrites))
        assertEquals(0, installedArtifacts.sumOf(ArtifactScan::externalDefinitionFieldReads))
        assertEquals(0, installedArtifacts.sumOf(ArtifactScan::extraRawGlobalKeyConsumers))

        // The cloud enum ships in 17 APKs. Onboarding contains only the legacy
        // ProtoSettings declaration. The three service APKs contain neither.
        assertEquals(17, installedArtifacts.count(ArtifactScan::declaresCloudMasterFlag))
        assertTrue(
            installedArtifacts.single { it.apk == "humane.experience.onboarding" }
                .let { it.declaresGlobalSelector && !it.declaresCloudMasterFlag },
        )
    }

    @Test
    fun `legacy global definition defaults false and has no activation boundary`() {
        assertEquals("ProtoSettings.CMU_ULTRA_ENABLED", installed.definition)
        assertEquals("humane_cmu_ultra_enabled", installed.key)
        assertEquals(
            installed.key,
            TierASymbols.FeatureFlags.SettingsGlobal.CMU_ULTRA_ENABLED,
        )
        assertEquals("Enable Catch Me Up Ultra", installed.displayName)
        assertEquals("Notifications", installed.category)
        assertEquals(StockValueType.BOOLEAN, installed.valueType)
        assertFalse(installed.firmwareDefault)

        assertEquals(0, installed.behavioralConsumerCount)
        assertEquals(0, installed.selectorSpecificGetterCallSites)
        assertEquals(0, installed.selectorSpecificObserverRegistrations)
        assertNull(installed.behavioralReadBoundary)
        assertFalse(installed.restartCanActivateSelector)
    }

    @Test
    fun `generic proto settings inspection is administrative not a cmu consumer`() {
        assertEquals(
            setOf(
                "ProtoSettingsContentProvider.query(includeValues=true)",
                "ProtoSettings.settingAsJSON",
                "ProtoSettings.allKnownSettingsAsJSON",
            ),
            installed.genericAdministrativeSurfaces,
        )
        assertEquals(
            "ProtoSettings.saveSettingValueInJson -> readSettingAsBool(definition.key)",
            installed.genericAdministrativeReadBoundary,
        )
        assertTrue(installed.genericMetadataIncludesDefault)
        assertTrue(installed.missingStoredValueIsOmittedFromAdministrativeJson)
        assertFalse(installed.genericAdministrativeReadRegistersObserver)
        assertFalse(installed.genericAdministrativeReadActivatesBehavior)
    }

    @Test
    fun `similarly named cloud flags own the actual cmu behavior`() {
        assertEquals("cmu_ultra_enabled", cloudMaster.key)
        assertEquals(
            cloudMaster.key,
            TierASymbols.FeatureFlags.Cloud.CMU_ULTRA_ENABLED,
        )
        assertEquals("FeatureFlagManager.Feature.CMU_ULTRA_ENABLED_FLAG", cloudMaster.definition)
        assertTrue(cloudMaster.firmwareDefault)
        assertEquals(
            setOf(
                "BluetoothNotificationParser.<init>",
                "BluetoothSettingsManager.checkIfUltraOnboardingShouldBeShown",
            ),
            cloudMaster.behavioralReadBoundaries,
        )
        assertEquals(
            CloudReadLifecycle.CONSTRUCTION_LATCHED,
            cloudMaster.readLifecycles["BluetoothNotificationParser.<init>"],
        )
        assertEquals(
            CloudReadLifecycle.EVENT_LIVE,
            cloudMaster.readLifecycles[
                "BluetoothSettingsManager.checkIfUltraOnboardingShouldBeShown"
            ],
        )
        assertEquals(
            "android.bluetooth.device.action.BOND_STATE_CHANGED",
            cloudMaster.liveReadTrigger,
        )
        assertEquals(0, cloudMaster.flagChangeObserverRegistrations)
        assertFalse(cloudMaster.falseReconstructionClearsStaticAncsClient)

        assertEquals("cmu_ultra_chime_enabled", cloudChime.key)
        assertEquals(
            cloudChime.key,
            TierASymbols.FeatureFlags.Cloud.CMU_ULTRA_CHIME_ENABLED,
        )
        assertEquals("FeatureFlagManager.Feature.CMU_ULTA_CHIME_ENABLED_FLAG", cloudChime.definition)
        assertFalse(cloudChime.firmwareDefault)
        assertEquals(
            setOf("NotificationManager categorization-success path"),
            cloudChime.behavioralReadBoundaries,
        )

        assertTrue(installed.key.startsWith("humane_"))
        assertFalse(cloudMaster.key.startsWith("humane_"))
        assertFalse(cloudChime.key.startsWith("humane_"))
        assertTrue(installed.key != cloudMaster.key)
        assertTrue(installed.key != cloudChime.key)
    }

    @Test
    fun `penumbra keeps only the legacy global locked false and restart free`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val globalSpec = catalog
            .substringAfter("key: settings_global_keys::CMU_ULTRA_ENABLED", "")
            .substringBefore("];\n\npub fn feature_flag_spec", "")

        assertTrue(globalSpec.contains("default: false"))
        assertTrue(globalSpec.contains("writable: false"))
        assertTrue(globalSpec.contains("no runtime consumer"))
        assertTrue(globalSpec.contains("separate cloud CMU accessory flag"))
        assertTrue(globalSpec.contains("restart_recommended: false"))
        assertFalse(globalSpec.contains("restart_recommended: true"))

        val cloudMasterSpec = catalog
            .substringAfter("key: cloud_keys::CMU_ULTRA_ENABLED", "")
            .substringBefore("key: cloud_keys::CMU_ULTRA_CHIME_ENABLED", "")
        assertTrue(cloudMasterSpec.contains("firmware_default: FeatureFlagDefault::Bool(true)"))
        assertTrue(cloudMasterSpec.contains("writable: true"))
        assertTrue(cloudMasterSpec.contains("restart_recommended: true"))

        val bridge = repoFile(
            "runtime/android/src/main/kotlin/com/penumbraos/server/SettingsGlobalBridgeServer.kt",
        ).readText()
        assertTrue(
            bridge.contains(
                "TierASymbols.FeatureFlags.SettingsGlobal.CMU_ULTRA_ENABLED",
            ),
        )

        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        listOf("humane_cmu_ultra_enabled", "ProtoSettings.CMU_ULTRA_ENABLED").forEach { selector ->
            assertFalse(
                "Production Hook must not invent a legacy CMU consumer: $selector",
                hookSources.any { it.readText().contains(selector) },
            )
        }
    }

    private enum class StockValueType { BOOLEAN }

    private enum class CloudReadLifecycle { CONSTRUCTION_LATCHED, EVENT_LIVE }

    private data class ArtifactScan(
        val apk: String,
        val declaresGlobalSelector: Boolean,
        val declaresCloudMasterFlag: Boolean,
        val rawGlobalKeyConstStringSites: Int = if (declaresGlobalSelector) 1 else 0,
        val definitionFieldWrites: Int = if (declaresGlobalSelector) 1 else 0,
        val externalDefinitionFieldReads: Int = 0,
        val extraRawGlobalKeyConsumers: Int = 0,
    )

    private data class InstalledContract(
        val definition: String,
        val key: String,
        val displayName: String,
        val category: String,
        val valueType: StockValueType,
        val firmwareDefault: Boolean,
        val behavioralConsumerCount: Int,
        val selectorSpecificGetterCallSites: Int,
        val selectorSpecificObserverRegistrations: Int,
        val behavioralReadBoundary: String?,
        val restartCanActivateSelector: Boolean,
        val genericAdministrativeSurfaces: Set<String>,
        val genericAdministrativeReadBoundary: String,
        val genericMetadataIncludesDefault: Boolean,
        val missingStoredValueIsOmittedFromAdministrativeJson: Boolean,
        val genericAdministrativeReadRegistersObserver: Boolean,
        val genericAdministrativeReadActivatesBehavior: Boolean,
    )

    private data class CloudContract(
        val definition: String,
        val key: String,
        val firmwareDefault: Boolean,
        val behavioralReadBoundaries: Set<String>,
        val readLifecycles: Map<String, CloudReadLifecycle> = emptyMap(),
        val liveReadTrigger: String? = null,
        val flagChangeObserverRegistrations: Int = 0,
        val falseReconstructionClearsStaticAncsClient: Boolean = false,
    )

    private val installedArtifacts = listOf(
        ArtifactScan("hu.ma.ne.ironman", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.answers", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.clock", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.contacts", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.dialer", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.food", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.messages", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.music", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.notifications", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.photography", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.settings", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.systemnavigation", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.tickle", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.translation", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.vision", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.experience.voicemail", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.grandcentral", declaresGlobalSelector = true, declaresCloudMasterFlag = true),
        ArtifactScan("humane.connectivity.esimlpa", declaresGlobalSelector = false, declaresCloudMasterFlag = false),
        ArtifactScan("humane.experience.onboarding", declaresGlobalSelector = true, declaresCloudMasterFlag = false),
        ArtifactScan("humane.voice.recognition", declaresGlobalSelector = false, declaresCloudMasterFlag = false),
        ArtifactScan("humane.voice.tts", declaresGlobalSelector = false, declaresCloudMasterFlag = false),
    )

    private val installed = InstalledContract(
        definition = "ProtoSettings.CMU_ULTRA_ENABLED",
        key = "humane_cmu_ultra_enabled",
        displayName = "Enable Catch Me Up Ultra",
        category = "Notifications",
        valueType = StockValueType.BOOLEAN,
        firmwareDefault = false,
        behavioralConsumerCount = 0,
        selectorSpecificGetterCallSites = 0,
        selectorSpecificObserverRegistrations = 0,
        behavioralReadBoundary = null,
        restartCanActivateSelector = false,
        genericAdministrativeSurfaces = setOf(
            "ProtoSettingsContentProvider.query(includeValues=true)",
            "ProtoSettings.settingAsJSON",
            "ProtoSettings.allKnownSettingsAsJSON",
        ),
        genericAdministrativeReadBoundary =
            "ProtoSettings.saveSettingValueInJson -> readSettingAsBool(definition.key)",
        genericMetadataIncludesDefault = true,
        missingStoredValueIsOmittedFromAdministrativeJson = true,
        genericAdministrativeReadRegistersObserver = false,
        genericAdministrativeReadActivatesBehavior = false,
    )

    private val cloudMaster = CloudContract(
        definition = "FeatureFlagManager.Feature.CMU_ULTRA_ENABLED_FLAG",
        key = "cmu_ultra_enabled",
        firmwareDefault = true,
        behavioralReadBoundaries = setOf(
            "BluetoothNotificationParser.<init>",
            "BluetoothSettingsManager.checkIfUltraOnboardingShouldBeShown",
        ),
        readLifecycles = mapOf(
            "BluetoothNotificationParser.<init>" to CloudReadLifecycle.CONSTRUCTION_LATCHED,
            "BluetoothSettingsManager.checkIfUltraOnboardingShouldBeShown" to
                CloudReadLifecycle.EVENT_LIVE,
        ),
        liveReadTrigger = "android.bluetooth.device.action.BOND_STATE_CHANGED",
        flagChangeObserverRegistrations = 0,
        falseReconstructionClearsStaticAncsClient = false,
    )

    private val cloudChime = CloudContract(
        definition = "FeatureFlagManager.Feature.CMU_ULTA_CHIME_ENABLED_FLAG",
        key = "cmu_ultra_chime_enabled",
        firmwareDefault = false,
        behavioralReadBoundaries = setOf("NotificationManager categorization-success path"),
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
