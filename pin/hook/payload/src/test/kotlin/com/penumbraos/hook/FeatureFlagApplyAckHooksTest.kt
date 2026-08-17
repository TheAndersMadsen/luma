package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureFlagApplyAckHooksTest {
    @Test
    fun assignmentDigestIsOrderIndependentAndProtobufSensitive() {
        val alpha = encoded("alpha", byteArrayOf(0x28, 0x00, 0x32, 0x05, 0x61, 0x6c, 0x70, 0x68, 0x61))
        val beta = encoded("beta", byteArrayOf(0x28, 0x01, 0x32, 0x04, 0x62, 0x65, 0x74, 0x61))
        val expected = FeatureFlagApplyAckHooks.stableAssignmentSetHash(listOf(alpha, beta))

        assertEquals(
            "75b7c255d4945121a919df3fa4045b2bcee13e515366ac7d6ef056db38add660",
            expected,
        )
        assertEquals(
            expected,
            FeatureFlagApplyAckHooks.stableAssignmentSetHash(listOf(beta, alpha)),
        )
        assertNotEquals(
            expected,
            FeatureFlagApplyAckHooks.stableAssignmentSetHash(
                listOf(alpha, beta.copy(protobuf = beta.protobuf + 0x00)),
            ),
        )
        assertEquals(64, checkNotNull(expected).length)
        assertTrue(expected.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun assignmentDigestRejectsDuplicatesAndUnboundedInput() {
        val assignment = encoded("same", byteArrayOf(0x32, 0x04, 0x73, 0x61, 0x6d, 0x65))
        assertEquals(
            null,
            FeatureFlagApplyAckHooks.stableAssignmentSetHash(listOf(assignment, assignment)),
        )
        assertEquals(
            null,
            FeatureFlagApplyAckHooks.stableAssignmentSetHash(
                listOf(encoded("x", ByteArray(16 * 1024 + 1))),
            ),
        )
    }

    @Test
    fun exactReadBackRequiresEveryTypedValue() {
        val expected = listOf(
            applied("enabled", 0, "true"),
            applied("timeout", 2, "7500"),
        )
        val actual = expected.associateBy { it.key }.toMutableMap()
        assertTrue(FeatureFlagApplyAckHooks.appliedAssignmentsMatch(expected, actual::get))

        actual["timeout"] = applied("timeout", 2, "7501")
        assertFalse(FeatureFlagApplyAckHooks.appliedAssignmentsMatch(expected, actual::get))
        actual["timeout"] = applied("timeout", 3, "7500")
        assertFalse(FeatureFlagApplyAckHooks.appliedAssignmentsMatch(expected, actual::get))
        actual.remove("timeout")
        assertFalse(FeatureFlagApplyAckHooks.appliedAssignmentsMatch(expected, actual::get))
    }

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
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
