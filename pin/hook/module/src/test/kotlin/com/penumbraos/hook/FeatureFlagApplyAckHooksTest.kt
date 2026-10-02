package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureFlagApplyAckHooksTest {


    @Test
    fun sourceUsesOnlyTheStockSyncAndExplicitBinderPaths() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/FeatureFlagApplyAckHooks.kt",
        ).readText()
        val ironman = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        assertTrue(source.contains("convertFeatureFlagAssignments"))
        assertTrue(source.contains("setServerFlags"))
        assertTrue(source.contains("getFlagAssignment"))
        assertTrue(source.contains("FeatureFlagApplyAckBridgeService"))
        assertTrue(source.contains("applyLock.lock()"))
        assertTrue(source.contains("applyLock.unlock()"))
        assertTrue(source.contains("Context.BIND_AUTO_CREATE,\n                publisher,"))
        assertFalse(source.contains("publisher.execute { publish(snapshot) }"))
        assertTrue(ironman.contains("FeatureFlagApplyAckHooks.install(cl)"))
        assertFalse(source.contains("sendBroadcast"))
        assertFalse(source.contains("/sdcard"))
    }

    private fun encoded(name: String, protobuf: ByteArray) =
        FeatureFlagApplyAckHooks.EncodedAssignment(name, "", protobuf)

    private fun applied(key: String, type: Int, value: String) =
        FeatureFlagApplyAckHooks.AppliedAssignment(key, type.toByte(), value)

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
