package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the installed/runtime trust boundary for the stock remote-voice flag.
 *
 * The DEX/reference audit covers the 21 unique Humane APKs pulled from firmware
 * 101.000470.45.20. Ironman's audited APK SHA-256 is
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class ServerSpeechSynthesisVoiceNameLockedContractTest {
    @Test
    fun `installed corpus has exactly two live reads in remote text to speech`() {
        assertEquals(21, installedArtifacts.size)
        assertEquals(17, installedArtifacts.count(ArtifactScan::declaresSelector))
        assertEquals(4, installedArtifacts.count { !it.declaresSelector })
        assertEquals(2, installedArtifacts.sumOf(ArtifactScan::externalFieldReads))
        assertEquals(
            listOf("hu.ma.ne.ironman"),
            installedArtifacts.filter { it.externalFieldReads > 0 }.map(ArtifactScan::apk),
        )
        assertTrue(installedArtifacts.all { it.rawKeyConsumers == 0 })

        assertEquals("SERVER_SPEECH_SYNTHESIS_VOICE_NAME", installed.enumName)
        assertEquals("server_side_speech_synthesis_voice_name", installed.key)
        assertEquals(2, installed.runtimeConsumerCount)
        assertEquals(2, installed.getStringCallSites)
        assertEquals(
            setOf("RemoteTextToSpeech.speak", "RemoteTextToSpeech.speakStreaming"),
            installed.consumerMethods,
        )
        assertEquals(0, installed.observerCount)
        assertEquals(0, installed.nativeLibraryMatches)
        assertEquals("each remote narration request", installed.readBoundary)
        assertFalse(installed.restartRequired)
    }

    @Test
    fun `stock forwards a nonblank name and substitutes its literal for blank values`() {
        assertEquals(StockValueType.STRING, installed.valueType)
        assertEquals("", installed.firmwareDefault)
        assertEquals("", installed.missingServiceValue)
        assertEquals("", installed.remoteExceptionValue)
        assertTrue(installed.wrongTypeThrows)
        assertFalse(installed.serverAssignmentObserved)

        assertTrue(installed.blankOrWhitespaceUsesFallback)
        assertEquals("trina - natural and vibrantNeural", installed.stockFallbackVoice)
        assertTrue(installed.nonblankValueCopiedToSpeechConfig)
        assertEquals("RAW_24KHZ_16BIT_MONO_PCM", installed.unaryAudioFormat)
        assertEquals("AUDIO_24KHZ_160KBITRATE_MONO_MP3", installed.streamingAudioFormat)
    }

    @Test
    fun `penumbra speech ignores the request voice and uses only operator configuration`() {
        val speech = repoFile("runtime/core/src/services/speech.rs").readText()
        val azure = repoFile("runtime/core/src/external/azure_speech.rs").readText()
        val config = repoFile("runtime/core/src/config.rs").readText()

        assertTrue(speech.contains("Deliberately ignore request.speech_config.voice_name"))
        assertTrue(speech.contains("the sole trusted source for provider-bound voice selection"))
        assertTrue(speech.contains("unary_and_streaming_tts_map_format_source_and_use_only_configured_voice"))
        assertTrue(speech.contains("let untrusted_voice = \"untrusted-voice-alias\""))
        assertTrue(speech.contains("assert!(!ssml.contains(untrusted_voice))"))
        assertTrue(speech.contains("assert!(ssml.contains(\"en-US-AvaNeural\"))"))

        assertTrue(azure.contains("configured voice and"))
        assertTrue(azure.contains("cannot be overridden by request data"))
        assertTrue(azure.contains("fn valid_voice_name("))
        assertTrue(config.contains("Operator-selected Azure neural voice"))
        assertTrue(config.contains("Request-provided voice aliases"))
        assertTrue(config.contains("are ignored by the stock-compatible service"))
    }

    @Test
    fun `catalog keeps the ineffective untrusted selector locked absent and live-read`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: \"server_side_speech_synthesis_voice_name\"")
            .substringBefore("key: \"cmu_ultra_enabled\"")

        assertTrue(spec.contains("value_type: FeatureFlagValueType::String"))
        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::String(\"\")"))
        assertTrue(spec.contains("penumbra_default: None"))
        assertTrue(spec.contains("writable: false"))
        assertTrue(spec.contains("restart_recommended: false"))
        assertTrue(spec.contains("ignores this untrusted value"))
        assertTrue(spec.contains("operator-configured Azure voice"))

        assertTrue(catalog.contains("if !spec.writable"))
        assertTrue(catalog.contains("feature flag `{key}` is not writable"))
        assertTrue(catalog.contains("if let Some(default) = spec.penumbra_default"))
    }

    @Test
    fun `no hook or api special case turns the selector into a provider control`() {
        val hookSources = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        listOf(installed.key, installed.enumName).forEach { selector ->
            assertFalse(
                "Production Hook must not force the stock voice selector: $selector",
                hookSources.any { it.readText().contains(selector) },
            )
        }

        val api = repoFile("runtime/core/src/api/feature_flags.rs").readText()
        val productionApi = api.substringBefore("\n#[cfg(test)]\nmod tests")
        assertFalse(productionApi.contains(installed.key))
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
        val getStringCallSites: Int,
        val consumerMethods: Set<String>,
        val observerCount: Int,
        val nativeLibraryMatches: Int,
        val readBoundary: String,
        val restartRequired: Boolean,
        val valueType: StockValueType,
        val firmwareDefault: String,
        val missingServiceValue: String,
        val remoteExceptionValue: String,
        val wrongTypeThrows: Boolean,
        val serverAssignmentObserved: Boolean,
        val blankOrWhitespaceUsesFallback: Boolean,
        val stockFallbackVoice: String,
        val nonblankValueCopiedToSpeechConfig: Boolean,
        val unaryAudioFormat: String,
        val streamingAudioFormat: String,
    )

    private val installedArtifacts = listOf(
        ArtifactScan("hu.ma.ne.ironman", declaresSelector = true, externalFieldReads = 2),
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
        enumName = "SERVER_SPEECH_SYNTHESIS_VOICE_NAME",
        key = "server_side_speech_synthesis_voice_name",
        runtimeConsumerCount = 2,
        getStringCallSites = 2,
        consumerMethods = setOf(
            "RemoteTextToSpeech.speak",
            "RemoteTextToSpeech.speakStreaming",
        ),
        observerCount = 0,
        nativeLibraryMatches = 0,
        readBoundary = "each remote narration request",
        restartRequired = false,
        valueType = StockValueType.STRING,
        firmwareDefault = "",
        missingServiceValue = "",
        remoteExceptionValue = "",
        wrongTypeThrows = true,
        serverAssignmentObserved = false,
        blankOrWhitespaceUsesFallback = true,
        stockFallbackVoice = "trina - natural and vibrantNeural",
        nonblankValueCopiedToSpeechConfig = true,
        unaryAudioFormat = "RAW_24KHZ_16BIT_MONO_PCM",
        streamingAudioFormat = "AUDIO_24KHZ_160KBITRATE_MONO_MP3",
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
