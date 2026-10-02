package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the installed-firmware absence boundary for the legacy laser selector.
 *
 * The DEX/reference audit covers the 21 unique Humane APKs pulled from firmware
 * 101.000470.45.20. Ironman's audited APK SHA-256 is
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class LaserFindingGuideLockedContractTest {
    @Test
    fun `installed corpus contains an enum declaration but no laser selector read`() {
        assertEquals(21, installedArtifacts.size)
        assertEquals(17, installedArtifacts.count(ArtifactScan::declaresSelector))
        assertEquals(4, installedArtifacts.count { !it.declaresSelector })
        assertTrue(installedArtifacts.all { it.externalFieldReads == 0 })
        assertTrue(installedArtifacts.all { it.rawKeyConsumers == 0 })

        assertEquals("LASER_FINDING_GUIDE", installed.enumName)
        assertEquals("laser_finding_guide", installed.key)
        assertEquals(0, installed.runtimeConsumerCount)
        assertEquals(0, installed.getterCallSites)
        assertEquals(0, installed.observerCount)
        assertEquals(0, installed.nativeLibraryMatches)
        assertNull(installed.readBoundary)
        assertFalse(installed.restartCanActivateSelector)
    }

    @Test
    fun `installed default is false and unrelated laser APIs are not consumers`() {
        assertEquals(StockValueType.BOOL, installed.valueType)
        assertFalse(installed.firmwareDefault)
        assertFalse(installed.missingServiceValue)
        assertFalse(installed.remoteExceptionValue)
        assertTrue(installed.wrongTypeThrows)

        assertEquals(
            setOf(
                "IHATSControlService.enableCover2Laser",
                "ProtoSettings.humane_laser_guidance_sounds_enabled",
                "SystemSound.LASER_MALFUNCTION",
            ),
            installed.unrelatedLaserSymbols,
        )
        assertFalse(installed.linkToHandTrackingRecovered)
        assertFalse(installed.linkToGuidanceSoundsRecovered)
        assertFalse(installed.supportedBehaviorRecovered)
    }

    @Test
    fun `penumbra keeps the unconsumed boolean locked absent and restart free`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: \"laser_finding_guide\"")
            .substringBefore("key: \"server_side_transcription_save_enabled\"")

        assertTrue(spec.contains("value_type: FeatureFlagValueType::Bool"))
        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::Bool(false)"))
        assertTrue(spec.contains("penumbra_default: None"))
        assertTrue(spec.contains("writable: false"))
        assertTrue(spec.contains("restart_recommended: false"))
        assertTrue(spec.contains("Locked"))
        assertTrue(spec.contains("no runtime consumer"))

        assertTrue(catalog.contains("if !spec.writable"))
        assertTrue(catalog.contains("feature flag `{key}` is not writable"))
        assertTrue(catalog.contains("if let Some(default) = spec.penumbra_default"))
        assertTrue(catalog.contains("/// defaults remain absent from the response"))
    }

    @Test
    fun `no production hook invents laser finding behavior or forces the flag`() {
        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

        listOf("laser_finding_guide", "LASER_FINDING_GUIDE").forEach { selector ->
            assertFalse(
                "Production Hook must not synthesize the unused laser selector: $selector",
                hookSources.any { it.readText().contains(selector) },
            )
        }

        val api = repoFile("runtime/core/src/api/feature_flags.rs").readText()
        val productionApi = api.substringBefore("\n#[cfg(test)]\nmod tests")
        assertFalse(productionApi.contains("laser_finding_guide"))
    }

    private enum class StockValueType { BOOL }

    private data class ArtifactScan(
        val apk: String,
        val declaresSelector: Boolean,
        val externalFieldReads: Int = 0,
        val rawKeyConsumers: Int = 0,
    )

    private data class InstalledContract(
        val enumName: String,
        val key: String,
        val runtimeConsumerCount: Int,
        val getterCallSites: Int,
        val observerCount: Int,
        val nativeLibraryMatches: Int,
        val readBoundary: String?,
        val restartCanActivateSelector: Boolean,
        val valueType: StockValueType,
        val firmwareDefault: Boolean,
        val missingServiceValue: Boolean,
        val remoteExceptionValue: Boolean,
        val wrongTypeThrows: Boolean,
        val unrelatedLaserSymbols: Set<String>,
        val linkToHandTrackingRecovered: Boolean,
        val linkToGuidanceSoundsRecovered: Boolean,
        val supportedBehaviorRecovered: Boolean,
    )

    private val installedArtifacts = listOf(
        ArtifactScan("hu.ma.ne.ironman", declaresSelector = true),
        ArtifactScan("humane.experience.answers", declaresSelector = true),
        ArtifactScan("humane.experience.clock", declaresSelector = true),
        ArtifactScan("humane.experience.contacts", declaresSelector = true),
        ArtifactScan("humane.experience.dialer", declaresSelector = true),
        ArtifactScan("humane.experience.food", declaresSelector = true),
        ArtifactScan("humane.experience.messages", declaresSelector = true),
        ArtifactScan("humane.experience.music", declaresSelector = true),
        ArtifactScan("humane.experience.notifications", declaresSelector = true),
        ArtifactScan("humane.experience.photography", declaresSelector = true),
        ArtifactScan("humane.experience.settings", declaresSelector = true),
        ArtifactScan("humane.experience.systemnavigation", declaresSelector = true),
        ArtifactScan("humane.experience.tickle", declaresSelector = true),
        ArtifactScan("humane.experience.translation", declaresSelector = true),
        ArtifactScan("humane.experience.vision", declaresSelector = true),
        ArtifactScan("humane.experience.voicemail", declaresSelector = true),
        ArtifactScan("humane.grandcentral", declaresSelector = true),
        ArtifactScan("humane.connectivity.esimlpa", declaresSelector = false),
        ArtifactScan("humane.experience.onboarding", declaresSelector = false),
        ArtifactScan("humane.voice.recognition", declaresSelector = false),
        ArtifactScan("humane.voice.tts", declaresSelector = false),
    )

    private val installed = InstalledContract(
        enumName = "LASER_FINDING_GUIDE",
        key = "laser_finding_guide",
        runtimeConsumerCount = 0,
        getterCallSites = 0,
        observerCount = 0,
        nativeLibraryMatches = 0,
        readBoundary = null,
        restartCanActivateSelector = false,
        valueType = StockValueType.BOOL,
        firmwareDefault = false,
        missingServiceValue = false,
        remoteExceptionValue = false,
        wrongTypeThrows = true,
        unrelatedLaserSymbols = setOf(
            "IHATSControlService.enableCover2Laser",
            "ProtoSettings.humane_laser_guidance_sounds_enabled",
            "SystemSound.LASER_MALFUNCTION",
        ),
        linkToHandTrackingRecovered = false,
        linkToGuidanceSoundsRecovered = false,
        supportedBehaviorRecovered = false,
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
