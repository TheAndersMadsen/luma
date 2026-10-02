package humane.common.food

/** Exact reflection surface used by the audited stock Food protobuf. */
class FoodItem(private val requestUuid: String) {
    fun getRequestUuid(): String = requestUuid
}
