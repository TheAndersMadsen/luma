package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Test

class TelephonyCompatibilityHooksTest {
    @Test
    fun `keeps a carrier supplied host number`() {
        assertEquals(
            "+4512345678",
            TelephonyCompatibilityHooks.hostAddressOrFallback("+4512345678"),
        )
    }

    @Test
    fun `uses a stable local identity when carrier omits the line number`() {
        assertEquals(
            "penumbra-self",
            TelephonyCompatibilityHooks.hostAddressOrFallback(null),
        )
        assertEquals(
            "penumbra-self",
            TelephonyCompatibilityHooks.hostAddressOrFallback(""),
        )
        assertEquals(
            "penumbra-self",
            TelephonyCompatibilityHooks.hostAddressOrFallback("   "),
        )
    }
}
