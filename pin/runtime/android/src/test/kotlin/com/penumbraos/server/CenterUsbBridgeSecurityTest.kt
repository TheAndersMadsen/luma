package com.penumbraos.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CenterUsbBridgeSecurityTest {
    @Test
    fun trustedAndroidServiceAndAdbUidsAreAccepted() {
        listOf(0, 1000, 2000).forEach { uid ->
            assertTrue(isTrustedUsbPeerUid(uid))
        }
    }

    @Test
    fun applicationAndInvalidUidsAreRejected() {
        listOf(Int.MIN_VALUE, -1, 1, 999, 1001, 1999, 2001, 10_000, Int.MAX_VALUE).forEach { uid ->
            assertFalse(isTrustedUsbPeerUid(uid))
        }
    }
}
