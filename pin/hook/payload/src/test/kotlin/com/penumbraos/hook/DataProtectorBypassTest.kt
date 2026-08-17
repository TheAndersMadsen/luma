package com.penumbraos.hook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DataProtectorBypassTest {
    @Test
    fun `direct protect bypass is exact to a bounded FoodLog`() {
        assertTrue(
            DataProtectorBypass.shouldBypassFoodProtect(
                "humane.common.food.FoodLog",
                64 * 1024,
            ),
        )
        assertFalse(
            DataProtectorBypass.shouldBypassFoodProtect(
                "humane.common.food.FoodLogSummary",
                1024,
            ),
        )
        assertFalse(
            DataProtectorBypass.shouldBypassFoodProtect(
                "humane.common.food.FoodLog",
                (64 * 1024) + 1,
            ),
        )
    }

    @Test
    fun `direct reveal bypass is exact to bounded Food domain summaries`() {
        assertTrue(DataProtectorBypass.shouldAttemptFoodSummaryReveal("Food", 0))
        assertTrue(
            DataProtectorBypass.shouldAttemptFoodSummaryReveal(
                "Food",
                (2 * 1024 * 1024) + (64 * 1024),
            ),
        )
        assertFalse(DataProtectorBypass.shouldAttemptFoodSummaryReveal("Capture", 100))
        assertFalse(
            DataProtectorBypass.shouldAttemptFoodSummaryReveal(
                "Food",
                (2 * 1024 * 1024) + (64 * 1024) + 1,
            ),
        )
    }

    @Test
    fun `only canonical plaintext is accepted for direct reveal`() {
        assertTrue(
            DataProtectorBypass.isCanonicalPlaintext(
                byteArrayOf(0x0a, 0x00),
                byteArrayOf(0x0a, 0x00),
            ),
        )
        assertFalse(
            DataProtectorBypass.isCanonicalPlaintext(
                byteArrayOf(0x0a, 0x00),
                byteArrayOf(0x0a),
            ),
        )
    }
}
