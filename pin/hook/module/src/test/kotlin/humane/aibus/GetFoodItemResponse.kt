package humane.aibus

import humane.common.food.FoodItem

/** Exact best-item reflection surface used by the audited stock Food protobuf. */
class GetFoodItemResponse(
    private val bestFoodItem: FoodItem?,
    private val alternateFoodItems: List<FoodItem> = emptyList(),
) {
    fun hasBestFoodItem(): Boolean = bestFoodItem != null

    fun getBestFoodItem(): FoodItem = checkNotNull(bestFoodItem)

    fun getAlternateFoodItemsList(): List<FoodItem> = alternateFoodItems
}
