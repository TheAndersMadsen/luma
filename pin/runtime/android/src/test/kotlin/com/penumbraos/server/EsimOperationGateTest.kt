package com.penumbraos.server

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EsimOperationGateTest {
    private val requestIdA = "req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private val requestIdB = "req_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    private val tokenA = "op_11111111111111111111111111111111"
    private val tokenB = "op_22222222222222222222222222222222"
    private val enableAction = "humane.connectivity.esimlpa.enableProfile"

    @Test
    fun canonicalParserRejectsUnknownActionsFieldsAndMalformedOperands() {
        assertTrue(
            EsimRequestProtocol.parse(request(requestIdA, tokenA, enableAction, JSONObject().put("iccid", " 12345-67890 ")))
                .isSuccess,
        )
        assertEquals(
            "1234567890",
            EsimRequestProtocol.parse(request(requestIdA, tokenA, enableAction, JSONObject().put("iccid", " 12345-67890 ")))
                .getOrThrow().iccid,
        )
        assertTrue(
            EsimRequestProtocol.parse(
                request(requestIdA, tokenA, "humane.connectivity.esimlpa.unsupported", JSONObject()),
            ).isFailure,
        )
        assertTrue(
            EsimRequestProtocol.parse(
                request(requestIdA, tokenA, enableAction, JSONObject().put("iccid", "1234567890").put("extra", true)),
            ).isFailure,
        )
        assertTrue(
            EsimRequestProtocol.parse(
                request(requestIdA, tokenA, enableAction, JSONObject().put("iccid", "not-an-iccid")),
            ).isFailure,
        )
    }

    @Test
    fun oneInflightRequestRejectsConcurrencyAndReplay() {
        val gate = EsimOperationGate()
        val first = parsed(requestIdA, tokenA, "1234567890")
        val second = parsed(requestIdB, tokenB, "2222222222")

        assertTrue(gate.admit(first) is EsimAdmission.Accepted)
        assertTrue(gate.admit(second) is EsimAdmission.Rejected)
        assertTrue(gate.admit(first) is EsimAdmission.Rejected)
        assertEquals(first.binding, gate.activeBindingForTest())
    }

    @Test
    fun mismatchedAndLateCallbacksCannotCompleteAnotherRequest() {
        val gate = EsimOperationGate()
        val first = parsed(requestIdA, tokenA, "1234567890")
        val second = parsed(requestIdB, tokenB, "2222222222")
        assertTrue(gate.admit(first) is EsimAdmission.Accepted)

        val wrongTarget = mutationEvent(first.binding, "9999999999")
        assertFalse(gate.acceptsEvent(wrongTarget))
        gate.markDelivered(wrongTarget)
        assertEquals(first.binding, gate.activeBindingForTest())

        val malformed = mutationEvent(first.binding, first.iccid!!)
        malformed.getJSONObject("payload").remove("result")
        assertFalse(gate.acceptsEvent(malformed))
        gate.markDelivered(malformed)
        assertEquals(first.binding, gate.activeBindingForTest())

        val terminalA = mutationEvent(first.binding, first.iccid!!)
        assertTrue(gate.acceptsEvent(terminalA))
        gate.markDelivered(terminalA)
        assertNull(gate.activeBindingForTest())

        // B was consumed by its busy rejection, so use a fresh canonical ID.
        val third = parsed(
            "req_cccccccccccccccccccccccccccccccc",
            "op_33333333333333333333333333333333",
            "3333333333",
        )
        assertTrue(gate.admit(third) is EsimAdmission.Accepted)
        assertFalse(gate.acceptsEvent(terminalA))
        gate.markDelivered(terminalA)
        assertEquals(third.binding, gate.activeBindingForTest())
    }

    @Test
    fun cancellationReleasesOnlyItsExactBoundOperation() {
        val gate = EsimOperationGate()
        val first = parsed(requestIdA, tokenA, "1234567890")
        assertTrue(gate.admit(first) is EsimAdmission.Accepted)

        assertFalse(gate.cancel(EsimCancellation(requestIdA, first.action, tokenB)))
        assertEquals(first.binding, gate.activeBindingForTest())
        assertTrue(gate.cancel(EsimCancellation(requestIdA, first.action, tokenA)))
        assertNull(gate.activeBindingForTest())
        assertTrue(gate.admit(first) is EsimAdmission.Rejected)
    }

    private fun parsed(requestId: String, token: String, iccid: String): CanonicalEsimRequest =
        EsimRequestProtocol.parse(request(requestId, token, enableAction, JSONObject().put("iccid", iccid)))
            .getOrThrow()

    private fun request(
        requestId: String,
        token: String,
        action: String,
        payload: JSONObject,
    ): JSONObject = JSONObject()
        .put("type", "esim.request")
        .put("request_id", requestId)
        .put("action", action)
        .put("operation_token", token)
        .put("payload", payload)

    private fun mutationEvent(binding: EsimOperationBinding, target: String): JSONObject = JSONObject()
        .put("type", "esim.profile_mutation_result")
        .put("request_id", binding.requestId)
        .put("action", binding.action)
        .put("operation_token", binding.operationToken)
        .put(
            "payload",
            JSONObject()
                .put("operation", "enable")
                .put("target_iccid", target)
                .put("nickname", JSONObject.NULL)
                .put("result", "success"),
        )
}
