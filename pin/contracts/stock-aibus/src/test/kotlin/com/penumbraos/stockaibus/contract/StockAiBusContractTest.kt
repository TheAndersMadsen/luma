package com.penumbraos.stockaibus.contract

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StockAiBusContractTest {
    @Test
    fun auditedStockArtifactDigestsAreCanonicalSha256Values() {
        assertEquals(64, StockAiBusContract.IRONMAN_SHA256.length)
        assertEquals(64, StockAiBusContract.FOOD_SHA256.length)
        assertTrue(StockAiBusContract.IRONMAN_SHA256.matches(Regex("[0-9a-f]{64}")))
        assertTrue(StockAiBusContract.FOOD_SHA256.matches(Regex("[0-9a-f]{64}")))
    }

    @Test
    fun transactionNumbersAndNamesMatchTheStockBinderSurface() {
        val transactions = StockAiBusContract.transactions
        val expected = listOf(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ANALYZE_IMAGE to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_ANALYZE_IMAGE,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_SYNAPSE_UNDERSTANDING to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_SYNAPSE_UNDERSTANDING,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_SMART_PLAYLIST to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_ENCRYPTED_SMART_PLAYLIST,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_CAN_TRANSLATE to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_CAN_TRANSLATE,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_TRANSLATE_TEXT to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_TRANSLATE_TEXT,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_TRANSLATE_CONVERSATION to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_TRANSLATE_CONVERSATION,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_STREAM_AI_BUS to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAM_AI_BUS,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_FETCH_HOME_SCREEN_WEATHER to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_FETCH_HOME_SCREEN_WEATHER,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_NEARBY_SEARCH to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_ENCRYPTED_NEARBY_SEARCH,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_GEO_LOCATE_REQUEST to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_ENCRYPTED_GEO_LOCATE_REQUEST,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_CHAT_COMPLETION to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_CHAT_COMPLETION,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_GENERATE_INTERSTITIAL to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_GENERATE_INTERSTITIAL,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_NAVIGATION_DIRECTIONS to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_NAVIGATION_DIRECTIONS,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_TEXT_TO_SPEECH to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_TEXT_TO_SPEECH,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_STREAMING_TEXT_TO_SPEECH to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAMING_TEXT_TO_SPEECH,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_EXECUTE_FUNCTION_CALL to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_EXECUTE_FUNCTION_CALL,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_SERVER_STATEFUL_UNDERSTAND to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_SERVER_STATEFUL_UNDERSTAND,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_BIDIRECTIONAL_STREAMING_UNDERSTAND to
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_BIDIRECTIONAL_STREAMING_UNDERSTAND,
        )
        assertEquals(
            expected,
            transactions.map { transaction -> transaction.code to transaction.name },
        )
        assertEquals(18, transactions.map(Transaction::name).toSet().size)
        assertEquals(
            null,
            StockAiBusContract.transaction(
                TierASymbols.Binder.AiBusBridge.TRANSACTION_BIDIRECTIONAL_STREAMING_UNDERSTAND + 1,
            ),
        )
    }

    @Test
    fun everyDeclaredProtoTypeIsCanonicalAndBounded() {
        val classNames = StockAiBusContract.transactions.flatMap { transaction ->
            transaction.arguments.mapNotNull { argument -> argument.value.protoClassName() } +
                listOfNotNull(transaction.response.protoClassName())
        }
        assertTrue(classNames.isNotEmpty())
        classNames.forEach { className ->
            assertTrue(className, StockAiBusContract.isValidProtoClassName(className))
        }

        assertFalse(StockAiBusContract.isValidProtoClassName(""))
        assertFalse(StockAiBusContract.isValidProtoClassName("humane/aibus/Request"))
        assertFalse(StockAiBusContract.isValidProtoClassName("1humane.aibus.Request"))
    }

    @Test
    fun streamingMethodsDeclareBothDirectionsExplicitly() {
        val streamingTransactionCodes = listOf(
            TierASymbols.Binder.AiBusBridge.TRANSACTION_TRANSLATE_CONVERSATION,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_STREAM_AI_BUS,
            TierASymbols.Binder.AiBusBridge.TRANSACTION_BIDIRECTIONAL_STREAMING_UNDERSTAND,
        )
        for (code in streamingTransactionCodes) {
            val transaction = assertNotNull(StockAiBusContract.transaction(code)).let {
                StockAiBusContract.transaction(code)!!
            }
            assertEquals(CallStyle.BIDIRECTIONAL_STREAM, transaction.style)
            assertTrue(transaction.arguments.any { it.value is WireValue.StreamObserver })
            assertTrue(transaction.response is WireValue.StreamObserver)
        }
    }

    @Test
    fun protoEnvelopeCopiesBytesAndRejectsInvalidContracts() {
        val source = byteArrayOf(1, 2, 3)
        val envelope = StockProtoEnvelope.create(
            TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_REQUEST,
            source,
        )
        source[0] = 9
        assertEquals(1, envelope.payload[0].toInt())

        assertFails<IllegalArgumentException> {
            StockProtoEnvelope.create("not/a/class", byteArrayOf())
        }
        assertFails<IllegalArgumentException> {
            StockProtoEnvelope.create(
                TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_REQUEST,
                ByteArray(StockParcelableMessageCodec.MAX_PAYLOAD_BYTES + 1),
            )
        }
    }

    private fun WireValue.protoClassName(): String? = when (this) {
        is WireValue.Proto -> className
        is WireValue.StreamObserver -> valueClassName
        is WireValue.ByteArray -> valueClassName
        else -> null
    }

    private inline fun <reified T : Throwable> assertFails(block: () -> Unit) {
        val error = runCatching(block).exceptionOrNull()
        assertTrue("Expected ${T::class.java.simpleName}", error is T)
    }

    @Test
    fun transactionCodesMatchTheTable() {
        // The named constants are what consumers compile against; the table is
        // the transcription of the stock AIDL. If they ever disagree, a hook
        // would intercept the wrong transaction silently.
        val analyzeImage = StockAiBusContract.transaction(
            StockAiBusContract.TRANSACTION_ANALYZE_IMAGE,
        )
        assertEquals(
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_ANALYZE_IMAGE,
            analyzeImage?.name,
        )

        val synapse = StockAiBusContract.transaction(
            StockAiBusContract.TRANSACTION_SYNAPSE_UNDERSTANDING,
        )
        assertEquals(
            TierASymbols.Binder.AiBusBridge.WIRE_NAME_SYNAPSE_UNDERSTANDING,
            synapse?.name,
        )

        // VisionTraceHooks selects the stock overload by argument count.
        assertEquals(
            analyzeImage?.arguments?.size,
            StockAiBusContract.argumentCount(StockAiBusContract.TRANSACTION_ANALYZE_IMAGE),
        )
        assertEquals(
            7,
            StockAiBusContract.argumentCount(StockAiBusContract.TRANSACTION_ANALYZE_IMAGE),
        )
    }
}
