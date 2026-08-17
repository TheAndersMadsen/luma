package com.penumbraos.stockaibus.contract

/**
 * Version-pinned Binder contract recovered from the stock Ironman APK.
 *
 * This is a wire model, not a replacement implementation. It gives the future
 * local bridge one authoritative transaction table instead of scattering
 * transaction numbers, parcel ordering, and protobuf names across reflection
 * hooks.
 */
object StockAiBusContract {
    const val DESCRIPTOR = TierASymbols.Binder.AiBusBridge.DESCRIPTOR
    const val STREAM_OBSERVER_DESCRIPTOR = TierASymbols.Binder.StreamObserver.DESCRIPTOR
    const val STOCK_VERSION = "rc/release1.3-47-g17e3fb9551"
    const val IRONMAN_SHA256 = "44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e"

    // Named codes for the transactions Penumbra intercepts or inspects. Callers
    // must use these instead of re-deriving `IBinder.FIRST_CALL_TRANSACTION + n`
    // locally, which is how the same number ended up hand-maintained in several
    // files. `transactionCodesMatchTheTable` pins each one to [transactions].
    const val TRANSACTION_ANALYZE_IMAGE =
        TierASymbols.Binder.AiBusBridge.TRANSACTION_ANALYZE_IMAGE
    const val TRANSACTION_SYNAPSE_UNDERSTANDING =
        TierASymbols.Binder.AiBusBridge.TRANSACTION_SYNAPSE_UNDERSTANDING

    /** Argument count stock declares for [code], or null if it is unknown. */
    fun argumentCount(code: Int): Int? = transaction(code)?.arguments?.size

    val transactions: List<Transaction> = listOf(
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ANALYZE_IMAGE,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_ANALYZE_IMAGE,
            CallStyle.SYNCHRONOUS,
            arguments = listOf(
                string("question"),
                string("utterance"),
                string("runId"),
                bool("provideFoodHint"),
                bool("provideGeminiHint"),
                string("debugOutDirectory"),
                sharedMemory("imageJpegBytes"),
            ),
            response = WireValue.ByteArray(TierASymbols.ProtoKids.ANALYZE_IMAGE_RESPONSE),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_SYNAPSE_UNDERSTANDING,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_SYNAPSE_UNDERSTANDING,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_REQUEST),
                proto("location", TierASymbols.ProtoKids.LOCATION_ENVELOPE),
                string("runId"),
                observer(
                    "responseHandler",
                    TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_RESPONSE,
                ),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_SMART_PLAYLIST,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_ENCRYPTED_SMART_PLAYLIST,
            CallStyle.SYNCHRONOUS,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.SMART_PLAYLIST_REQUEST),
            ),
            response = WireValue.Proto(TierASymbols.ProtoKids.SMART_PLAYLIST_RESPONSE),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_CAN_TRANSLATE,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_CAN_TRANSLATE,
            CallStyle.SYNCHRONOUS,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.CAN_TRANSLATE_REQUEST),
            ),
            response = WireValue.Proto(TierASymbols.ProtoKids.CAN_TRANSLATE_RESPONSE),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_TRANSLATE_TEXT,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_TRANSLATE_TEXT,
            CallStyle.SYNCHRONOUS,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.TRANSLATE_TEXT_REQUEST),
            ),
            response = WireValue.Proto(TierASymbols.ProtoKids.TRANSLATE_TEXT_RESPONSE),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_TRANSLATE_CONVERSATION,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_TRANSLATE_CONVERSATION,
            CallStyle.BIDIRECTIONAL_STREAM,
            arguments = listOf(
                observer(
                    "responseObserver",
                    TierASymbols.ProtoKids.TRANSLATE_CONVERSATION_RESPONSE,
                ),
            ),
            response = WireValue.StreamObserver(
                TierASymbols.ProtoKids.TRANSLATE_CONVERSATION_REQUEST,
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_STREAM_AI_BUS,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAM_AI_BUS,
            CallStyle.BIDIRECTIONAL_STREAM,
            arguments = listOf(
                observer("responseObserver", TierASymbols.ProtoKids.AI_RESPONSE),
            ),
            response = WireValue.StreamObserver(TierASymbols.ProtoKids.AI_REQUEST),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_FETCH_HOME_SCREEN_WEATHER,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_FETCH_HOME_SCREEN_WEATHER,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                location("location"),
                observer("responseObserver", TierASymbols.ProtoKids.WEATHER_RESPONSE),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_NEARBY_SEARCH,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_ENCRYPTED_NEARBY_SEARCH,
            CallStyle.SYNCHRONOUS,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.NEARBY_SEARCH_REQUEST),
            ),
            response = WireValue.Proto(TierASymbols.ProtoKids.NEARBY_SEARCH_RESPONSE),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_GEO_LOCATE_REQUEST,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_ENCRYPTED_GEO_LOCATE_REQUEST,
            CallStyle.SYNCHRONOUS,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.GEO_LOCATE_REQUEST),
            ),
            response = WireValue.Proto(TierASymbols.ProtoKids.GEO_LOCATE_RESPONSE),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_CHAT_COMPLETION,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_CHAT_COMPLETION,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.CHAT_COMPLETION_REQUEST),
                observer("responseObserver", TierASymbols.ProtoKids.CHAT_COMPLETION_RESPONSE),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_GENERATE_INTERSTITIAL,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_GENERATE_INTERSTITIAL,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.ACTION_BASED_INTERSTITIAL_REQUEST),
                string("runId"),
                observer(
                    "responseObserver",
                    TierASymbols.ProtoKids.ACTION_BASED_INTERSTITIAL_RESPONSE,
                ),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_NAVIGATION_DIRECTIONS,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_NAVIGATION_DIRECTIONS,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.NAVIGATION_DIRECTIONS_REQUEST),
                proto("location", TierASymbols.ProtoKids.LOCATION_ENVELOPE),
                observer(
                    "responseObserver",
                    TierASymbols.ProtoKids.NAVIGATION_DIRECTIONS_RESPONSE,
                ),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_TEXT_TO_SPEECH,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_TEXT_TO_SPEECH,
            CallStyle.SYNCHRONOUS,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.TEXT_TO_SPEECH_REQUEST),
            ),
            response = WireValue.Proto(TierASymbols.ProtoKids.TEXT_TO_SPEECH_RESPONSE),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_STREAMING_TEXT_TO_SPEECH,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAMING_TEXT_TO_SPEECH,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.TEXT_TO_SPEECH_REQUEST),
                observer("responseObserver", TierASymbols.ProtoKids.TEXT_TO_SPEECH_RESPONSE),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_EXECUTE_FUNCTION_CALL,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_EXECUTE_FUNCTION_CALL,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.FUNCTION_CALL),
                observer("responseObserver", TierASymbols.ProtoKids.FUNCTION_RESPONSE),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_SERVER_STATEFUL_UNDERSTAND,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_SERVER_STATEFUL_UNDERSTAND,
            CallStyle.SERVER_STREAM,
            arguments = listOf(
                proto("request", TierASymbols.ProtoKids.SERVER_STATEFUL_UNDERSTAND_REQUEST),
                observer(
                    "responseObserver",
                    TierASymbols.ProtoKids.SERVER_STATEFUL_UNDERSTAND_RESPONSE,
                ),
            ),
        ),
        transaction(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_BIDIRECTIONAL_STREAMING_UNDERSTAND,
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_BIDIRECTIONAL_STREAMING_UNDERSTAND,
            CallStyle.BIDIRECTIONAL_STREAM,
            arguments = listOf(
                observer(
                    "responseObserver",
                    TierASymbols.ProtoKids.STREAMING_UNDERSTAND_RESPONSE,
                ),
            ),
            response = WireValue.StreamObserver(
                TierASymbols.ProtoKids.STREAMING_UNDERSTAND_REQUEST,
            ),
        ),
    )

    private val transactionsByCode = transactions.associateBy(Transaction::code)

    fun transaction(code: Int): Transaction? = transactionsByCode[code]

    fun isValidProtoClassName(value: String): Boolean {
        if (value.isEmpty() || value.length > StockParcelableMessageCodec.MAX_CLASS_NAME_BYTES) {
            return false
        }
        return value.split('.').all { segment ->
            segment.isNotEmpty() &&
                (segment.first().isLetter() || segment.first() == '_') &&
                segment.all { character ->
                    character.isLetterOrDigit() || character == '_' || character == '$'
                }
        }
    }

    private fun transaction(
        code: Int,
        name: String,
        style: CallStyle,
        arguments: List<Argument>,
        response: WireValue = WireValue.None,
    ) = Transaction(code, name, style, arguments, response)

    private fun proto(name: String, className: String) =
        Argument(name, WireValue.Proto(className))

    private fun observer(name: String, valueClassName: String) =
        Argument(name, WireValue.StreamObserver(valueClassName))

    private fun string(name: String) = Argument(name, WireValue.StringValue)
    private fun bool(name: String) = Argument(name, WireValue.BooleanValue)
    private fun location(name: String) = Argument(name, WireValue.AndroidLocation)
    private fun sharedMemory(name: String) = Argument(name, WireValue.SharedMemory)
}

enum class CallStyle {
    SYNCHRONOUS,
    SERVER_STREAM,
    BIDIRECTIONAL_STREAM,
}

data class Transaction(
    val code: Int,
    val name: String,
    val style: CallStyle,
    val arguments: List<Argument>,
    val response: WireValue,
)

data class Argument(val name: String, val value: WireValue)

sealed interface WireValue {
    data object None : WireValue
    data object StringValue : WireValue
    data object BooleanValue : WireValue
    data object AndroidLocation : WireValue
    data object SharedMemory : WireValue
    data class Proto(val className: String) : WireValue
    data class StreamObserver(val valueClassName: String) : WireValue
    data class ByteArray(val valueClassName: String) : WireValue
}
