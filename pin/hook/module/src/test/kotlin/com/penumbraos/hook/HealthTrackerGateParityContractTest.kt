package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the only installed consumer of the misleadingly named
 * Settings.Global health-tracker gate. The contract was recovered from the
 * installed System Navigation APK. It is a weather/ALS experiment, not the
 * stock activity tracker.
 */
class HealthTrackerGateParityContractTest {
    @Test
    fun `installed home weather view snapshots the gate when the widget is constructed`() {
        assertEquals(
            "humane.experience.systemnavigation.widgets.HomeWeatherView",
            installed.consumerClass,
        )
        assertEquals("ProtoSettings.HEALTH_TRACKER_ENABLED", installed.setting)
        assertEquals(ReadBoundary.WIDGET_CONSTRUCTION, installed.readBoundary)
        assertFalse(installed.registersSettingObserver)
        assertTrue(installed.requiresWidgetRecreation)
        assertTrue(installed.requiresProcessRestartForReliableApply)
    }

    @Test
    fun `enabled behavior remains the exact stock uv and ambient light experiment`() {
        assertTrue(installed.addsUvLabelOnlyWhenEnabledAtConstruction)
        assertEquals(60, installed.minimumAlsSampleIntervalSeconds)
        assertEquals(15_000_000, installed.directSunlightClearThreshold)
        assertEquals(40_000_000, installed.directSunlightLuxThreshold)
        assertEquals(15_000_000, installed.directSunlightIrThreshold)
        assertTrue(installed.recordsAlsNotableEvent)
        assertFalse(installed.callsCsvWriterFromHomeWeather)
        assertTrue(installed.uvLabelRequiresDirectSunlight)
        assertTrue(installed.uvLabelUsesWeatherResponseValue)
    }

    @Test
    fun `registry exposes the opt in setting with truthful restart guidance`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: \"humane_health_tracker_enabled\"")
            .substringBefore("key: \"humane_cmu_ultra_enabled\"")

        assertTrue(spec.contains("default: false"))
        assertTrue(spec.contains("writable: true"))
        assertTrue(spec.contains("restart_recommended: true"))
        assertTrue(spec.contains("HomeWeather UV/ambient-light behavior"))
        assertTrue(spec.contains("not fitness history"))
    }

    @Test
    fun `replacement acknowledges stock notable event shapes and retains queryable history`() {
        val events = repoFile("runtime/core/src/services/events.rs").readText()

        assertTrue(events.contains("yield acknowledge_event(event)?"))
        assertTrue(events.contains("yield IngestBatchResponse {"))
        assertTrue(events.contains("event_identifier: response,"))
        assertTrue(events.contains("db.upsert_notable_event(&event)"))
        assertTrue(events.contains("Ok(Response::new(EventsQueryResponse { events }))"))
        assertFalse(events.contains("INSERT INTO"))
        assertFalse(events.contains("File::create"))
    }

    @Test
    fun `fitness action gating stays separate and production hooks do not force health on`() {
        val hookSources = repoFile("hook/module/src/main/kotlin/com/penumbraos/hook")
            .walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .toList()

        assertFalse(
            hookSources.any {
                val source = it.readText()
                source.contains("HEALTH_TRACKER_ENABLED") ||
                    source.contains("humane_health_tracker_enabled")
            },
        )
    }

    private enum class ReadBoundary { WIDGET_CONSTRUCTION }

    private data class InstalledHealthGateContract(
        val consumerClass: String,
        val setting: String,
        val readBoundary: ReadBoundary,
        val registersSettingObserver: Boolean,
        val requiresWidgetRecreation: Boolean,
        val requiresProcessRestartForReliableApply: Boolean,
        val addsUvLabelOnlyWhenEnabledAtConstruction: Boolean,
        val minimumAlsSampleIntervalSeconds: Int,
        val directSunlightClearThreshold: Int,
        val directSunlightLuxThreshold: Int,
        val directSunlightIrThreshold: Int,
        val recordsAlsNotableEvent: Boolean,
        val callsCsvWriterFromHomeWeather: Boolean,
        val uvLabelRequiresDirectSunlight: Boolean,
        val uvLabelUsesWeatherResponseValue: Boolean,
    )

    private val installed = InstalledHealthGateContract(
        consumerClass = "humane.experience.systemnavigation.widgets.HomeWeatherView",
        setting = "ProtoSettings.HEALTH_TRACKER_ENABLED",
        readBoundary = ReadBoundary.WIDGET_CONSTRUCTION,
        registersSettingObserver = false,
        requiresWidgetRecreation = true,
        requiresProcessRestartForReliableApply = true,
        addsUvLabelOnlyWhenEnabledAtConstruction = true,
        minimumAlsSampleIntervalSeconds = 60,
        directSunlightClearThreshold = 15_000_000,
        directSunlightLuxThreshold = 40_000_000,
        directSunlightIrThreshold = 15_000_000,
        recordsAlsNotableEvent = true,
        callsCsvWriterFromHomeWeather = false,
        uvLabelRequiresDirectSunlight = true,
        uvLabelUsesWeatherResponseValue = true,
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
