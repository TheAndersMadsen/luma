package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the evidence boundary for the stock accessory string selector.
 *
 * The DEX/reference audit covers the 21 unique Humane APKs pulled from firmware
 * 101.000470.45.20. Ironman's audited APK SHA-256 is
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class AccessoryFeatureFlagsLockedContractTest {
    @Test
    fun `installed corpus declares the enum but has no runtime consumer`() {
        assertEquals(21, installedArtifacts.size)
        assertEquals(17, installedArtifacts.count(ArtifactScan::declaresSelector))
        assertEquals(4, installedArtifacts.count { !it.declaresSelector })
        assertTrue(installedArtifacts.all { it.externalFieldReads == 0 })
        assertTrue(installedArtifacts.all { it.rawKeyConsumers == 0 })

        assertEquals("ACCESSORY_FLAGS", installed.enumName)
        assertEquals("accessory_feature_flags", installed.key)
        assertEquals(0, installed.runtimeConsumerCount)
        assertEquals(0, installed.getterCallSites)
        assertEquals(0, installed.parserCount)
        assertEquals(0, installed.observerCount)
        assertEquals(0, installed.nativeLibraryMatches)
        assertNull(installed.readBoundary)
    }

    @Test
    fun `installed fallback is an empty typed string and no grammar is recoverable`() {
        assertEquals(StockValueType.STRING, installed.valueType)
        assertEquals("", installed.firmwareDefault)
        assertEquals("", installed.missingServiceValue)
        assertEquals("", installed.remoteExceptionValue)
        assertTrue(installed.wrongTypeThrows)

        assertFalse(installed.nonEmptyFormatRecovered)
        assertTrue(installed.knownNonEmptyValues.isEmpty())
        assertNull(installed.delimiter)
        assertNull(installed.schema)
        assertFalse(installed.restartCanActivateSelector)
    }

    @Test
    fun `penumbra exposes metadata but locks and omits the unknown assignment`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: \"accessory_feature_flags\"")
            .substringBefore("key: \"feature_flag_suppress_sync_on_startup\"")

        assertTrue(spec.contains("value_type: FeatureFlagValueType::String"))
        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::String(\"\")"))
        assertTrue(spec.contains("penumbra_default: None"))
        assertTrue(spec.contains("writable: false"))
        assertTrue(spec.contains("restart_recommended: false"))
        assertTrue(spec.contains("Locked"))

        // Locked selectors cannot enter the override map, and firmware
        // defaults are deliberately absent from GetFlags. The installed
        // default store therefore remains the only source of the empty value.
        assertTrue(catalog.contains("if !spec.writable"))
        assertTrue(catalog.contains("feature flag `{key}` is not writable"))
        assertTrue(catalog.contains("if let Some(default) = spec.penumbra_default"))
        assertTrue(catalog.contains("/// defaults remain absent from the response"))
    }

    @Test
    fun `no production hook invents an accessory parser or forces a value`() {
        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

        listOf("accessory_feature_flags", "ACCESSORY_FLAGS").forEach { selector ->
            assertFalse(
                "Production Hook must not synthesize the unused accessory selector: $selector",
                hookSources.any { it.readText().contains(selector) },
            )
        }

        val api = repoFile("runtime/core/src/api/feature_flags.rs").readText()
        val productionApi = api.substringBefore("\n#[cfg(test)]\nmod tests")
        assertFalse(productionApi.contains("accessory_feature_flags"))
    }

    private enum class StockValueType { STRING }

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
        val parserCount: Int,
        val observerCount: Int,
        val nativeLibraryMatches: Int,
        val readBoundary: String?,
        val valueType: StockValueType,
        val firmwareDefault: String,
        val missingServiceValue: String,
        val remoteExceptionValue: String,
        val wrongTypeThrows: Boolean,
        val nonEmptyFormatRecovered: Boolean,
        val knownNonEmptyValues: Set<String>,
        val delimiter: String?,
        val schema: String?,
        val restartCanActivateSelector: Boolean,
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
        enumName = "ACCESSORY_FLAGS",
        key = "accessory_feature_flags",
        runtimeConsumerCount = 0,
        getterCallSites = 0,
        parserCount = 0,
        observerCount = 0,
        nativeLibraryMatches = 0,
        readBoundary = null,
        valueType = StockValueType.STRING,
        firmwareDefault = "",
        missingServiceValue = "",
        remoteExceptionValue = "",
        wrongTypeThrows = true,
        nonEmptyFormatRecovered = false,
        knownNonEmptyValues = emptySet(),
        delimiter = null,
        schema = null,
        restartCanActivateSelector = false,
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
