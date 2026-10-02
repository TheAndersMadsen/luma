package com.penumbraos.hook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalDataEnvelopeAdapterTest {
    @Test
    fun `direct protect compatibility is exact to a bounded FoodLog`() {
        assertTrue(
            LocalDataEnvelopeAdapter.shouldUseLocalFoodProtection(
                "humane.common.food.FoodLog",
                64 * 1024,
            ),
        )
        assertFalse(
            LocalDataEnvelopeAdapter.shouldUseLocalFoodProtection(
                "humane.common.food.FoodLogSummary",
                1024,
            ),
        )
        assertFalse(
            LocalDataEnvelopeAdapter.shouldUseLocalFoodProtection(
                "humane.common.food.FoodLog",
                (64 * 1024) + 1,
            ),
        )
    }

    @Test
    fun `direct reveal compatibility is exact to bounded Food domain summaries`() {
        assertTrue(LocalDataEnvelopeAdapter.shouldReadLocalFoodSummary("Food", 0))
        assertTrue(
            LocalDataEnvelopeAdapter.shouldReadLocalFoodSummary(
                "Food",
                (2 * 1024 * 1024) + (64 * 1024),
            ),
        )
        assertFalse(LocalDataEnvelopeAdapter.shouldReadLocalFoodSummary("Capture", 100))
        assertFalse(
            LocalDataEnvelopeAdapter.shouldReadLocalFoodSummary(
                "Food",
                (2 * 1024 * 1024) + (64 * 1024) + 1,
            ),
        )
    }

    @Test
    fun `only canonical plaintext is accepted for direct reveal`() {
        assertTrue(
            LocalDataEnvelopeAdapter.isCanonicalPlaintext(
                byteArrayOf(0x0a, 0x00),
                byteArrayOf(0x0a, 0x00),
            ),
        )
        assertFalse(
            LocalDataEnvelopeAdapter.isCanonicalPlaintext(
                byteArrayOf(0x0a, 0x00),
                byteArrayOf(0x0a),
            ),
        )
    }
}
