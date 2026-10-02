package com.penumbraos.server

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IrohBootstrapContractTest {
    @Test
    fun freshPinBootsBeforeCenterAssignsItsBridgeIdentity() {
        val source = File("src/main/assets/bootstrap-config.toml").readText()
        assertTrue(source.contains("iroh_remote_center_enabled = false"))
        assertFalse(source.contains("iroh_remote_center_enabled = true"))
        assertFalse(source.contains("iroh_remote_center_allowed_peers"))
    }
}
