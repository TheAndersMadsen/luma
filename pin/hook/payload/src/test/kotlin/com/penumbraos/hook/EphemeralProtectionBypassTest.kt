package com.penumbraos.hook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EphemeralProtectionBypassTest {
    @Test
    fun onlyExactFoodChannelsAndMessageTypesUseCompatibilityEnvelopes() {
        assertTrue(
            EphemeralProtectionBypass.shouldBypassFoodEncrypt(
                "ai_bus.chat_completion",
                "humane.aibus.ChatCompletionRequest",
            ),
        )
        assertTrue(
            EphemeralProtectionBypass.shouldBypassFoodEncrypt(
                "ai_bus.get_food_item",
                "humane.aibus.GetFoodItemRequest",
            ),
        )
        assertTrue(
            EphemeralProtectionBypass.shouldBypassFoodEncrypt(
                "ai_bus.analyze_image",
                "humane.aibus.AnalyzeFoodImageRequest",
            ),
        )
        assertTrue(
            EphemeralProtectionBypass.shouldBypassFoodDecrypt(
                "ai_bus.get_food_item",
                "humane.aibus.GetFoodItemResponse",
            ),
        )

        assertFalse(
            EphemeralProtectionBypass.shouldBypassFoodEncrypt(
                "ai_bus.synapse",
                "humane.aibus.SynapseUnderstandingRequest",
            ),
        )
        assertFalse(
            EphemeralProtectionBypass.shouldBypassFoodEncrypt(
                "ai_bus.get_food_item",
                "humane.aibus.ChatCompletionRequest",
            ),
        )
        assertFalse(
            EphemeralProtectionBypass.shouldBypassFoodDecrypt(
                "ai_bus.get_food_item",
                "humane.aibus.ChatCompletionResponse",
            ),
        )
        assertFalse(EphemeralProtectionBypass.shouldPrepareFoodChannel(null))
        assertFalse(EphemeralProtectionBypass.shouldPrepareFoodChannel("ai_bus.nearby"))
    }
}
