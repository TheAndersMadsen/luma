package com.penumbraos.server

import dev.luma.gestures.GestureConfig
import dev.luma.gestures.GestureObservation
import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Device settings -> authoritative SDK -> observation round trip. See docs/gestures.md. */
class GestureDeviceAcceptanceTest {
    private class Store : GestureSettingsStore {
        var raw: String? = null
        var writable = true
        override fun read() = raw
        override fun write(value: String): Boolean {
            if (writable) raw = value
            return writable
        }
    }

    private fun config(mode: String = "observe") = JSONObject("""
        {"schema_version":1,"mode":"$mode","bindings":[
          {"fingers":["middle"],"hold_ms":300,"feature":"open_music"}]}
    """)

    @Test fun settingsRoundTripConflictInvalidInputAndWriteFailure() {
        val store = Store()
        val device = GestureSettings(store)
        val initial = device.read()
        assertEquals("off", initial.getJSONObject("config").getString("mode"))
        val saved = device.update(JSONObject().put("revision", initial.getString("revision")).put("config", config()))
        assertEquals("observe", saved.getJSONObject("config").getString("mode"))
        assertEquals(saved.getString("revision"), device.read().getString("revision"))
        assertEquals(GestureConfig.parse(store.raw).toJson().toString(), saved.getJSONObject("config").toString())
        try {
            device.update(JSONObject().put("revision", initial.getString("revision")).put("config", config("active")))
            fail("stale editor accepted")
        } catch (error: GestureRequestException) { assertEquals("conflict", error.code) }
        val revision = saved.getString("revision")
        for (bad in listOf(config().put("shell", "anything"), config().also {
            it.getJSONArray("bindings").getJSONObject(0).put("feature", "pinch_to_copy")
        })) {
            try {
                device.update(JSONObject().put("revision", revision).put("config", bad))
                fail("invalid configuration accepted")
            } catch (error: GestureRequestException) { assertEquals("invalid_request", error.code) }
            assertEquals(revision, device.read().getString("revision"))
        }
        store.writable = false
        try {
            device.update(JSONObject().put("revision", revision).put("config", config("active")))
            fail("failed storage write reported success")
        } catch (error: GestureRequestException) { assertEquals("operation_failed", error.code) }
        File("build/reports/gestures/device-acceptance.json").also { file ->
            requireNotNull(file.parentFile).mkdirs()
            file.writeText(JSONObject().put("kind", "synthetic_device_acceptance")
                .put("physical_pin_verified", false).put("settings", device.read()).toString(2))
        }
    }

    @Test fun corruptSettingsCanBeDisabledAndSessionFeaturesCannotBeFingerBindings() {
        val store = Store().also { it.raw = "broken" }
        val device = GestureSettings(store)
        val invalid = device.read()
        assertFalse(invalid.getBoolean("valid"))
        val off = device.update(JSONObject().put("revision", invalid.getString("revision"))
            .put("config", GestureConfig.OFF.toJson()))
        assertTrue(off.getBoolean("valid"))
        val catalog = off.getJSONArray("catalog")
        val clip = (0 until catalog.length()).map(catalog::getJSONObject).single { it.getString("id") == "pinch_to_copy" }
        assertTrue(clip.getBoolean("available"))
        assertEquals("pinch_session", clip.getString("trigger"))
    }

    @Test fun observationsAreBoundedExpireAndCannotForgeCurrentTime() {
        val reports = GestureObservations()
        val observation = GestureObservation.idle(1_000, "suspended", "home_required").toJson()
        reports.record(observation.toString(), 1_000)
        assertEquals("suspended", reports.read(1_100)!!.getString("status"))
        assertNull(reports.read(2_001))
        try { reports.record(observation.put("elapsed_ms", 5_000).toString(), 1_000); fail("future report accepted") }
        catch (_: IllegalArgumentException) { }
        try { reports.record("x".repeat(16_385), 1_000); fail("unbounded report accepted") }
        catch (_: IllegalArgumentException) { }
        try { GestureObservation.parse(observation.put("status", "made_up")); fail("unknown status accepted") }
        catch (_: IllegalArgumentException) { }
    }

    @Test fun launcherBridgeRejectsSharedUidPeersAndOtherProcesses() {
        assertTrue(GestureCallerAdmission.allowed(1000, 42, 1000, "humane.experience.systemnavigation", listOf(42 to "humane.experience.systemnavigation")))
        assertFalse(GestureCallerAdmission.allowed(1001, 42, 1000, "humane.experience.systemnavigation", listOf(42 to "humane.experience.systemnavigation")))
        assertFalse(GestureCallerAdmission.allowed(1000, 42, 1000, "humane.experience.systemnavigation", listOf(42 to "another.system.process")))
        assertFalse(GestureCallerAdmission.allowed(1000, 42, 1000, "humane.experience.systemnavigation", emptyList()))
    }
}
