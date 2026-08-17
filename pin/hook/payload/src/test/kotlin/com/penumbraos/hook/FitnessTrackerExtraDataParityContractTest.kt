package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the optional raw-data boundary of the installed stock activity tracker.
 *
 * The stock contract was recovered from Ironman SHA-256
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class FitnessTrackerExtraDataParityContractTest {
    @Test
    fun `installed flag has three reads in the stock activity tracker only`() {
        assertEquals(3, installed.flagReadCallSites)
        assertEquals("humane.system.fitness.ActivityTracker", installed.consumerClass)
        assertEquals("FITNESS_TRACKER_EXTRA_DATA_ENABLED", installed.feature)
        assertEquals("getBoolValue", installed.getter)
        assertEquals(
            listOf(
                ReadBoundary.CREATE_OPTIONAL_SENSOR_WRITER,
                ReadBoundary.REGISTER_OPTIONAL_SENSOR_LISTENERS,
                ReadBoundary.WRITE_EACH_MAGNETOMETER_ROW,
            ),
            installed.readBoundaries,
        )
        assertFalse(installed.registersFlagObserver)
        assertFalse(installed.restartsProcessForFlagChange)
    }

    @Test
    fun `extra mode adds only wakeup inertial listeners and the raw sensor csv`() {
        assertEquals(
            listOf(
                SensorContract(AndroidSensor.ACCELEROMETER, 1, wakeup = true),
                SensorContract(AndroidSensor.GYROSCOPE, 4, wakeup = true),
                SensorContract(AndroidSensor.MAGNETIC_FIELD, 2, wakeup = true),
            ),
            installed.extraSensors,
        )
        assertEquals(10_000, installed.samplingPeriodMicros)
        assertEquals(0, installed.maxReportLatencyMicros)
        assertEquals("activity-tracking-sensor-data.csv", installed.optionalFile)
        assertEquals(
            listOf(
                "ax", "ay", "az", "at",
                "gx", "gy", "gz", "gt",
                "mx", "my", "mz", "mt",
                "cmc", "steps", "lat", "lon", "alt", "acc", "utc",
            ),
            installed.optionalColumns,
        )

        // These sources and files are part of ordinary fitness tracking. The
        // extra flag only repeats their latest values in the optional CSV.
        assertEquals(
            setOf("step counter", "CMC motion classification", "GPS"),
            installed.baseSensors,
        )
        assertEquals(
            setOf(
                "activity-tracking-summary.csv",
                "activity-tracking-location-data.gpx",
            ),
            installed.requiredFiles,
        )
    }

    @Test
    fun `session boundary and per-row reads preserve installed live semantics`() {
        val tracker = InstalledExtraDataTracker(liveFlag = false)

        // Enabling after a false start cannot create a missing writer or add
        // subscriptions to a running session. A new tracking session, not a
        // process restart, is the activation boundary.
        tracker.start()
        tracker.liveFlag = true
        tracker.onMagnetometerEvent()
        assertFalse(tracker.sensorWriterOpen)
        assertFalse(tracker.extraListenersRegistered)
        assertEquals(0, tracker.sensorRows)
        tracker.stop()

        tracker.start()
        assertTrue(tracker.sensorWriterOpen)
        assertTrue(tracker.extraListenersRegistered)
        tracker.onMagnetometerEvent()
        assertEquals(1, tracker.sensorRows)

        // Disabling is consulted for every magnetometer row, so persistence
        // stops immediately. Stock does not unregister the already-active
        // inertial listeners or close the writer until stop().
        tracker.liveFlag = false
        tracker.onMagnetometerEvent()
        assertEquals(1, tracker.sensorRows)
        assertTrue(tracker.sensorWriterOpen)
        assertTrue(tracker.extraListenersRegistered)

        // A same-session re-enable resumes rows in the existing file.
        tracker.liveFlag = true
        tracker.onMagnetometerEvent()
        assertEquals(2, tracker.sensorRows)
        tracker.stop()
        assertFalse(tracker.sensorWriterOpen)
        assertFalse(tracker.extraListenersRegistered)
    }

    @Test
    fun `penumbra keeps the extra gate typed optional and dependent on base fitness`() {
        assertFalse(installed.firmwareDefault)
        assertFalse(installed.missingOrFailedRead)
        assertEquals("FITNESS_TRACKER_ENABLED", installed.requiredBaseFeature)
        assertEquals(
            "fitness_tracker_enabled",
            TierASymbols.FeatureFlags.Cloud.FITNESS_TRACKER_ENABLED,
        )
        assertEquals(
            "fitness_tracker_extra_data_enabled",
            TierASymbols.FeatureFlags.Cloud.FITNESS_TRACKER_EXTRA_DATA_ENABLED,
        )

        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED", "")
            .substringBefore("cloud_keys::ESIM_QR_SCANNER_ENABLED", "")
        assertTrue(spec.contains("value_type: FeatureFlagValueType::Bool"))
        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::Bool(false)"))
        assertTrue(spec.contains("penumbra_default: None"))
        assertTrue(spec.contains("writable: true"))
        assertTrue(spec.contains("restart_recommended: false"))

        assertTrue(
            catalog.contains(
                "cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED,\n            cloud_keys::FITNESS_TRACKER_ENABLED,",
            ),
        )
        val dependencyTest = catalog
            .substringAfter("fn dependent_flags_require_their_stock_prerequisites()", "")
            .substringBefore("}")
        assertTrue(
            dependencyTest.contains(
                "cloud_keys::FITNESS_TRACKER_EXTRA_DATA_ENABLED",
            ),
        )

        val service = repoFile("runtime/core/src/services/featureflags.rs").readText()
        assertTrue(service.contains("let config = self.config.read().await;"))
        assertTrue(service.contains("proto_assignments(&config.feature_flags)"))
    }

    @Test
    fun `history mirror retains the optional file without forcing the flag`() {
        val hooks = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/FitnessHistoryHooks.kt",
        ).readText()
        assertTrue(hooks.contains("val REQUIRED_FILENAMES = setOf(SUMMARY, LOCATION)"))
        assertTrue(hooks.contains("val ALLOWED_FILENAMES = REQUIRED_FILENAMES + SENSOR"))
        assertTrue(hooks.contains("const val MAX_SENSOR_BYTES = 256L * 1024 * 1024"))
        assertTrue(hooks.contains("if (param.throwable != null) return"))
        assertTrue(hooks.contains("mirrorSuccessfulWrite(writer, content)"))
        assertFalse(hooks.contains("FITNESS_TRACKER_EXTRA_DATA_ENABLED"))
        assertFalse(hooks.contains("fitness_tracker_extra_data_enabled"))

        val protocol = repoFile(
            "runtime/android/src/main/kotlin/com/penumbraos/server/FitnessBridgeProtocol.kt",
        ).readText()
        assertTrue(protocol.contains("const val MAX_STORED_BYTES = 512L * 1024 * 1024"))
        assertTrue(protocol.contains("const val MAX_STORED_SESSIONS = 20"))
        assertTrue(protocol.contains("const val MAX_SESSION_AGE_MS = 30L * 24 * 60 * 60 * 1_000"))
        assertTrue(protocol.contains("val ALLOWED_FILENAMES = REQUIRED_FILENAMES + SENSOR_FILENAME"))

        val historyApi = repoFile("runtime/core/src/api/fitness.rs").readText()
        assertTrue(historyApi.contains("HeaderValue::from_static(\"no-store\")"))
        assertTrue(historyApi.contains("delete(delete_session)"))
        assertTrue(historyApi.contains("get(list_sessions).delete(clear_sessions)"))

        val apiMain = repoFile("runtime/core/src/main.rs").readText()
        assertTrue(apiMain.contains("api::require_admin_auth"))
    }

    private enum class ReadBoundary {
        CREATE_OPTIONAL_SENSOR_WRITER,
        REGISTER_OPTIONAL_SENSOR_LISTENERS,
        WRITE_EACH_MAGNETOMETER_ROW,
    }

    private enum class AndroidSensor {
        ACCELEROMETER,
        GYROSCOPE,
        MAGNETIC_FIELD,
    }

    private data class SensorContract(
        val sensor: AndroidSensor,
        val type: Int,
        val wakeup: Boolean,
    )

    private data class InstalledExtraDataContract(
        val flagReadCallSites: Int,
        val consumerClass: String,
        val feature: String,
        val getter: String,
        val readBoundaries: List<ReadBoundary>,
        val registersFlagObserver: Boolean,
        val restartsProcessForFlagChange: Boolean,
        val extraSensors: List<SensorContract>,
        val samplingPeriodMicros: Int,
        val maxReportLatencyMicros: Int,
        val optionalFile: String,
        val optionalColumns: List<String>,
        val baseSensors: Set<String>,
        val requiredFiles: Set<String>,
        val firmwareDefault: Boolean,
        val missingOrFailedRead: Boolean,
        val requiredBaseFeature: String,
    )

    private class InstalledExtraDataTracker(var liveFlag: Boolean) {
        var sensorWriterOpen = false
            private set
        var extraListenersRegistered = false
            private set
        var sensorRows = 0
            private set

        fun start() {
            sensorWriterOpen = liveFlag
            extraListenersRegistered = liveFlag
        }

        fun onMagnetometerEvent() {
            if (!extraListenersRegistered || !liveFlag || !sensorWriterOpen) return
            sensorRows += 1
        }

        fun stop() {
            sensorWriterOpen = false
            extraListenersRegistered = false
        }
    }

    private val installed = InstalledExtraDataContract(
        flagReadCallSites = 3,
        consumerClass = "humane.system.fitness.ActivityTracker",
        feature = "FITNESS_TRACKER_EXTRA_DATA_ENABLED",
        getter = "getBoolValue",
        readBoundaries = listOf(
            ReadBoundary.CREATE_OPTIONAL_SENSOR_WRITER,
            ReadBoundary.REGISTER_OPTIONAL_SENSOR_LISTENERS,
            ReadBoundary.WRITE_EACH_MAGNETOMETER_ROW,
        ),
        registersFlagObserver = false,
        restartsProcessForFlagChange = false,
        extraSensors = listOf(
            SensorContract(AndroidSensor.ACCELEROMETER, 1, wakeup = true),
            SensorContract(AndroidSensor.GYROSCOPE, 4, wakeup = true),
            SensorContract(AndroidSensor.MAGNETIC_FIELD, 2, wakeup = true),
        ),
        samplingPeriodMicros = 10_000,
        maxReportLatencyMicros = 0,
        optionalFile = "activity-tracking-sensor-data.csv",
        optionalColumns = listOf(
            "ax", "ay", "az", "at",
            "gx", "gy", "gz", "gt",
            "mx", "my", "mz", "mt",
            "cmc", "steps", "lat", "lon", "alt", "acc", "utc",
        ),
        baseSensors = setOf("step counter", "CMC motion classification", "GPS"),
        requiredFiles = setOf(
            "activity-tracking-summary.csv",
            "activity-tracking-location-data.gpx",
        ),
        firmwareDefault = false,
        missingOrFailedRead = false,
        requiredBaseFeature = "FITNESS_TRACKER_ENABLED",
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
