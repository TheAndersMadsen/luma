package com.penumbraos.hook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FoodEnvelopeCompatibilityTest {
    @Test
    fun onlyExactFoodChannelsAndMessageTypesUseCompatibilityEnvelopes() {
        assertTrue(
            FoodEnvelopeCompatibility.shouldEncodeLocalFoodRequest(
                "ai_bus.chat_completion",
                "humane.aibus.ChatCompletionRequest",
            ),
        )
        assertTrue(
            FoodEnvelopeCompatibility.shouldEncodeLocalFoodRequest(
                "ai_bus.get_food_item",
                "humane.aibus.GetFoodItemRequest",
            ),
        )
        assertTrue(
            FoodEnvelopeCompatibility.shouldEncodeLocalFoodRequest(
                "ai_bus.analyze_image",
                "humane.aibus.AnalyzeFoodImageRequest",
            ),
        )
        assertTrue(
            FoodEnvelopeCompatibility.shouldDecodeLocalFoodResponse(
                "ai_bus.get_food_item",
                "humane.aibus.GetFoodItemResponse",
            ),
        )

        assertFalse(
            FoodEnvelopeCompatibility.shouldEncodeLocalFoodRequest(
                "ai_bus.synapse",
                "humane.aibus.SynapseUnderstandingRequest",
            ),
        )
        assertFalse(
            FoodEnvelopeCompatibility.shouldEncodeLocalFoodRequest(
                "ai_bus.get_food_item",
                "humane.aibus.ChatCompletionRequest",
            ),
        )
        assertFalse(
            FoodEnvelopeCompatibility.shouldDecodeLocalFoodResponse(
                "ai_bus.get_food_item",
                "humane.aibus.ChatCompletionResponse",
            ),
        )
        assertFalse(FoodEnvelopeCompatibility.shouldPrepareFoodChannel(null))
        assertFalse(FoodEnvelopeCompatibility.shouldPrepareFoodChannel("ai_bus.nearby"))
    }
}
