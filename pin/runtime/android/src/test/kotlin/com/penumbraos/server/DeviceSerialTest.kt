package com.penumbraos.server

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceSerialTest {
    @Test
    fun reporterAndNativeLauncherShareAndroidSerialResolver() {
        fun source(name: String): String {
            val relative = "src/main/kotlin/com/penumbraos/server/$name.kt"
            return listOf(File(relative), File("runtime/android", relative))
                .first { it.isFile }.readText()
        }
        assertTrue(source("DeviceStatusReporter").contains("DeviceSerial.read()"))
        val launcher = source("NativeBridge")
        assertTrue(launcher.contains("DeviceSerial.exportTo(processBuilder.environment(), DeviceSerial.read())"))
        assertTrue(launcher.indexOf("DeviceSerial.exportTo") < launcher.indexOf("processBuilder.start()"))
    }

    @Test
    fun deniedPropertiesFallBackToAndroidIdentity() {
        assertEquals("PIN-123", DeviceSerial.resolve({ throw SecurityException() }, { "pin-123" }))
        assertEquals("PIN-123", DeviceSerial.resolve({ "" }, { "pin-123" }))
    }

    @Test
    fun triesBothPropertiesBeforeFrameworkFallback() {
        val reads = mutableListOf<String>()
        assertEquals("PIN_123", DeviceSerial.resolve({ name ->
            reads.add(name)
            if (name == "ro.boot.serialno") "pin_123" else "unknown"
        }, { error("unexpected framework read") }))
        assertEquals(listOf("ro.serialno", "ro.boot.serialno"), reads)
    }

    @Test
    fun unavailableOrMalformedIdentityFailsClosed() {
        for (value in listOf("", "  ", "unknown", "UNKNOWN", "null", "pin/123", "é123", "x".repeat(129))) {
            assertNull(DeviceSerial.resolve({ value }, { value }))
        }
        assertNull(DeviceSerial.resolve({ throw SecurityException() }, { throw SecurityException() }))
    }

    @Test
    fun launcherReplacesOrRemovesInheritedIdentity() {
        val environment = mutableMapOf("LUMA_DEVICE_SERIAL" to "STALE", "OTHER" to "retained")
        DeviceSerial.exportTo(environment, "pin-123")
        assertEquals("PIN-123", environment["LUMA_DEVICE_SERIAL"])
        DeviceSerial.exportTo(environment, null)
        assertFalse(environment.containsKey("LUMA_DEVICE_SERIAL"))
        assertEquals("retained", environment["OTHER"])
        DeviceSerial.exportTo(environment, "unknown")
        assertFalse(environment.containsKey("LUMA_DEVICE_SERIAL"))
    }
}
