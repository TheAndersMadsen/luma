package com.penumbraos.server

import android.os.IBinder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageStatusBridgeSecurityTest {
    @Test
    fun binderContractRequiresTheExactMessagesProcess() {
        assertEquals(
            "com.penumbraos.server.message-status.bridge.v1",
            MessageStatusBridgeProtocol.DESCRIPTOR,
        )
        assertEquals(
            IBinder.FIRST_CALL_TRANSACTION,
            MessageStatusBridgeProtocol.TRANSACTION_RECORD_DELIVERED,
        )
        assertTrue(
            MessageStatusCallerAdmission.isAuthorized(
                1_000,
                1_000,
                setOf("humane.experience.messages", "shared.uid.peer"),
                "humane.experience.messages",
            ),
        )
        assertFalse(
            MessageStatusCallerAdmission.isAuthorized(
                1_000,
                1_000,
                setOf("humane.experience.messages", "shared.uid.peer"),
                "shared.uid.peer",
            ),
        )
        assertFalse(
            MessageStatusCallerAdmission.isAuthorized(
                2_000,
                1_000,
                setOf("humane.experience.messages"),
                "humane.experience.messages",
            ),
        )
    }

    @Test
    fun protocolAcceptsOnlyBoundedDeliveredReceipts() {
        val valid = record()
        assertEquals(valid, MessageStatusBridgeProtocol.validate(valid))
        assertFails { MessageStatusBridgeProtocol.validate(valid.copy(state = 1)) }
        assertFails { MessageStatusBridgeProtocol.validate(valid.copy(body = "")) }
        assertFails {
            MessageStatusBridgeProtocol.validate(
                valid.copy(body = "x".repeat(MessageStatusBridgeProtocol.MAX_BODY_CHARS + 1)),
            )
        }
        assertFails { MessageStatusBridgeProtocol.validate(valid.copy(recipients = emptyList())) }
        assertFails {
            MessageStatusBridgeProtocol.validate(valid.copy(recipients = listOf("bad\nrecipient")))
        }
    }

    @Test
    fun repositoryCorrelatesBodyRecipientAndRequestBoundary() {
        MessageStatusRepository.clearForTest()
        val now = 1_000_000L
        val older = record(messageId = 1, timestampMs = now - 1_000, recipients = listOf("+4511111111"))
        val newer = record(messageId = 2, timestampMs = now, recipients = listOf("+4522222222"))
        MessageStatusRepository.record(older)
        MessageStatusRepository.record(newer)

        val result = MessageStatusRepository.status("test body", "+4522222222", now - 500, now)
        assertEquals(2L, result?.messageId)
        assertTrue(MessageStatusRepository.recipientMatches(checkNotNull(result), "+4522222222"))
        assertNull(MessageStatusRepository.status("test body", "+4511111111", now - 500, now))
        assertNull(MessageStatusRepository.status("test body", "+4522222222", now + 1, now))
        assertNull(MessageStatusRepository.status("missing", "+4522222222", now - 500, now))
        assertNull(
            MessageStatusRepository.status(
                "test body",
                "+4522222222",
                now - 500,
                now + 60 * 60 * 1_000L + 1,
            ),
        )
        MessageStatusRepository.clearForTest()
    }

    private fun record(
        messageId: Long = 7,
        timestampMs: Long = 1_000_000L,
        recipients: List<String> = listOf("+4542493591"),
    ) = MessageStatusRecord(
        messageId = messageId,
        timestampMs = timestampMs,
        state = MessageStatusBridgeProtocol.DELIVERED_STATE,
        body = "test body",
        recipients = recipients,
    )

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected validation failure")
        } catch (_: IllegalArgumentException) {
        }
    }
}
