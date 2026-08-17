package com.penumbraos.server

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbMaintenanceProviderStartContractTest {
    @Test
    fun startMethodIsFixedAndAcceptsNoArgumentOrExtras() {
        assertEquals("START", UsbMaintenanceProvider.METHOD_START)
        assertTrue(isValidUsbMaintenanceStartRequest(arg = null, hasExtras = false))
        assertFalse(isValidUsbMaintenanceStartRequest(arg = "", hasExtras = false))
        assertFalse(isValidUsbMaintenanceStartRequest(arg = "/api/settings", hasExtras = false))
        assertFalse(isValidUsbMaintenanceStartRequest(arg = null, hasExtras = true))
    }

    @Test
    fun startOutcomeUsesOnlyHttpStatusSemantics() {
        assertEquals(UsbMaintenanceStartOutcome(200, true), usbMaintenanceStartOutcome(200))
        assertEquals(UsbMaintenanceStartOutcome(299, true), usbMaintenanceStartOutcome(299))
        assertEquals(UsbMaintenanceStartOutcome(199, false), usbMaintenanceStartOutcome(199))
        assertEquals(UsbMaintenanceStartOutcome(503, false), usbMaintenanceStartOutcome(503))
    }

    @Test
    fun startPathStartsAndPollsServerThroughTheFixedSettingsProbe() {
        val source = providerSource()
        val startPath = source
            .substringAfter("private fun startServer(")
            .substringBefore("private fun enforceMaintenanceCaller()")
        assertTrue(startPath.contains("ServerService.start(appContext)"))
        assertTrue(startPath.contains("repeat(SERVER_START_RETRY_COUNT)"))
        assertTrue(startPath.contains("proxySettings(\"GET\", null, port, adminToken)"))
        assertTrue(startPath.contains("return statusOnlyResult(status)"))
    }

    @Test
    fun everyStartResultBundleIsBodyFree() {
        val source = providerSource()
        val bodyFreeResult = source
            .substringAfter("private fun statusOnlyResult(status: Int): Bundle")
            .substringBefore("private fun errorBody(message: String)")
        assertTrue(bodyFreeResult.contains("putInt(\"status\", outcome.status)"))
        assertTrue(bodyFreeResult.contains("putBoolean(\"ok\", outcome.ok)"))
        assertFalse(bodyFreeResult.contains("putString"))
        assertFalse(bodyFreeResult.contains("\"body\""))
    }

    private fun providerSource(): String =
        File("src/main/kotlin/com/penumbraos/server/UsbMaintenanceProvider.kt").readText()
}
