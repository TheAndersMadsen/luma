package com.penumbraos.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CodexOnDeviceRuntimeTest {

    @Test
    fun localBridgeTokenIsCanonicalDeterministicAndDomainSeparated() {
        val firstSecret = "a".repeat(64)
        val secondSecret = "b".repeat(64)

        val first = CodexOnDeviceRuntime.deriveLocalBridgeToken(firstSecret)
        val repeated = CodexOnDeviceRuntime.deriveLocalBridgeToken(firstSecret)
        val second = CodexOnDeviceRuntime.deriveLocalBridgeToken(secondSecret)

        assertEquals(first, repeated)
        assertNotEquals(firstSecret, first)
        assertNotEquals(first, second)
        assertEquals(64, first.length)
        assertTrue(first.all { it in '0'..'9' || it in 'a'..'f' })
    }
}
