package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.StockSymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class MessageStatusHooksContractTest {
    private class StateFixture(private val value: Long) {
        fun value(): Long = value
    }

    private class SenderFixture(private val mine: Boolean) {
        fun isMe(): Boolean = mine
    }

    private class MessageFixture(
        private val id: Long = 41,
        private val conversationId: Long = 7,
        private val mine: Boolean = true,
        private val state: Long = 2,
        private val body: String? = "synthetic message",
        private val timestampMs: Long = 1_000,
    ) {
        fun id(): Long = id
        fun conversationId(): Long = conversationId
        fun sender(): SenderFixture = SenderFixture(mine)
        fun state(): StateFixture = StateFixture(state)
        fun body(): String? = body
        fun timestampMillis(): Long = timestampMs
    }

    private class ConversationFixture(
        private val id: Long = 7,
        private val recipients: List<Any?> = listOf("recipient-placeholder"),
    ) {
        fun id(): Long = id
        fun participantAddressesWithoutHost(): List<Any?> = recipients
    }

    private class StoreFixture(
        private val message: Any? = MessageFixture(),
        private val conversation: Any? = ConversationFixture(),
    ) {
        var messageReads = 0
        var conversationReads = 0

        fun getMessageForID(id: Long): Any? {
            messageReads++
            return message.takeIf { id == 41L }
        }

        fun getConversationById(id: Long): Any? {
            conversationReads++
            return conversation.takeIf { id == 7L }
        }
    }

    private class ThrowingStoreFixture {
        fun getMessageForID(@Suppress("UNUSED_PARAMETER") id: Long): Any? =
            throw IllegalStateException("synthetic read failure")

        fun getConversationById(@Suppress("UNUSED_PARAMETER") id: Long): Any? =
            throw IllegalStateException("must not be reached")
    }

    @Test
    fun verifierObservesTheStockDeliveredCommitWithoutReplacingSend() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/MessageStatusHooks.kt",
        ).readText()
        // The FQCN now lives in the shared stock contract; StockSymbolsTest pins
        // its value byte-for-byte, so this only has to prove the hook still
        // targets that exact symbol.
        assertEquals(
            "humane.experience.messages.store.PersistentMessageStore",
            StockSymbols.Messages.PERSISTENT_MESSAGE_STORE_CLASS,
        )
        assertTrue(source.contains("StockSymbols.Messages.PERSISTENT_MESSAGE_STORE_CLASS"))
        assertTrue(source.contains("getDeclaredMethod(\n                \"addMessage\""))
        assertTrue(source.contains("\"getMessageForID\""))
        assertTrue(source.contains("\"getConversationById\""))
        assertTrue(source.contains("addMessage.returnType == Long::class.javaPrimitiveType"))
        assertTrue(source.contains("getMessageForId.returnType == messageClass"))
        assertTrue(source.contains("getConversationById.returnType == conversationClass"))
        assertTrue(source.contains("param.throwable != null"))
        assertTrue(source.contains("stateValue != DELIVERED_STATE"))
        assertTrue(source.contains("sender, \"isMe\""))
        assertTrue(source.contains("ArrayBlockingQueue(32)"))
        assertTrue(source.contains("PublishedDeliveries(MAX_PUBLISHED_DELIVERIES)"))
        assertTrue(source.contains("publishOnce(record.identity())"))
        assertFalse(source.contains("contains(messageId)"))
        assertTrue(source.indexOf("val candidate = deliveredInsertCandidate(") < source.indexOf("exporter.execute"))
        assertTrue(source.contains("if (!candidate.matches(record)) return@execute"))
        assertTrue(source.contains("com.penumbraos.server.MessageStatusBridgeService"))
        assertFalse(source.contains("getDeclaredMethod(\n                \"updateMessageState\""))
        assertTrue(!source.contains("SmsManager"))
        assertTrue(!source.contains("sendTextMessage"))
    }

    @Test
    fun deliveredTransitionRereadsCommittedMessageAndConversation() {
        val store = StoreFixture()
        val record = MessageStatusHooks.resolveCommittedRecord(
            store = store,
            messageId = 41,
            getMessageForId = StoreFixture::class.java.getDeclaredMethod(
                "getMessageForID",
                Long::class.javaPrimitiveType!!,
            ),
            getConversationById = StoreFixture::class.java.getDeclaredMethod(
                "getConversationById",
                Long::class.javaPrimitiveType!!,
            ),
        )

        assertEquals(1, store.messageReads)
        assertEquals(1, store.conversationReads)
        assertEquals(41L, record?.messageId)
        assertEquals(7L, record?.conversationId)
        assertEquals(2L, record?.state)
        assertEquals(listOf("recipient-placeholder"), record?.recipients)
    }

    @Test
    fun onlySuccessfulOutgoingDeliveredInsertQualifies() {
        val conversation = ConversationFixture()
        assertEquals(
            41L,
            MessageStatusHooks.deliveredInsertCandidate(41L, MessageFixture(), conversation)
                ?.identity
                ?.messageId,
        )
        for (state in listOf(0L, 1L, 3L, 4L, 5L)) {
            assertNull(
                MessageStatusHooks.deliveredInsertCandidate(
                    41L,
                    MessageFixture(state = state),
                    conversation,
                ),
            )
        }
        assertNull(MessageStatusHooks.deliveredInsertCandidate(null, MessageFixture(), conversation))
        assertNull(MessageStatusHooks.deliveredInsertCandidate("41", MessageFixture(), conversation))
        assertNull(MessageStatusHooks.deliveredInsertCandidate(41.0, MessageFixture(), conversation))
        assertNull(MessageStatusHooks.deliveredInsertCandidate(-1L, MessageFixture(), conversation))
        assertNull(MessageStatusHooks.deliveredInsertCandidate(41L, null, conversation))
        assertNull(MessageStatusHooks.deliveredInsertCandidate(41L, MessageFixture(), null))
        assertNull(
            MessageStatusHooks.deliveredInsertCandidate(
                41L,
                MessageFixture(mine = false),
                conversation,
            ),
        )
    }

    @Test
    fun queuedInsertCannotPublishADeletedAndReusedRowId() {
        val original = MessageStatusHooks.deliveredInsertCandidate(
            41L,
            MessageFixture(body = "original synthetic", timestampMs = 1_000),
            ConversationFixture(),
        )!!
        val exactCommitted = MessageStatusHooks.extractRecord(
            41L,
            MessageFixture(body = "original synthetic", timestampMs = 1_000),
            ConversationFixture(),
        )!!
        assertTrue(original.matches(exactCommitted))

        val reusedRow = MessageStatusHooks.extractRecord(
            41L,
            MessageFixture(body = "replacement synthetic", timestampMs = 2_000),
            ConversationFixture(),
        )!!
        assertFalse(original.matches(reusedRow))

        val sameTimestampReplacement = MessageStatusHooks.extractRecord(
            41L,
            MessageFixture(body = "different payload", timestampMs = 1_000),
            ConversationFixture(),
        )!!
        assertFalse(original.matches(sameTimestampReplacement))
    }

    @Test
    fun pinnedStockCallGraphCommitsDeliveredSendsThroughAddMessageOnly() {
        val service = repositoryFile(
            "decompile-workspace/decompiled/humane_messages/sources/" +
                "humane/experience/messages/service/MessageService.java",
        ).readText()
        val sendSuccess = service
            .substringAfter("m3692xe04817f9")
            .substringBefore("public void recordMessageSentEvent")
        assertTrue(sendSuccess.contains("setState(Message.State.DELIVERED)"))
        assertTrue(sendSuccess.contains("this.mStore.addMessage(message, conversation)"))
        assertFalse(sendSuccess.contains("updateMessageState"))

        val messagesRoot = repositoryFile(
            "decompile-workspace/decompiled/humane_messages/sources/" +
                "humane/experience/messages",
        )
        val stateUpdateCallers = messagesRoot.walkTopDown()
            .filter { it.isFile && it.extension == "java" }
            .filter { it.readText().contains(".updateMessageState(") }
            .toList()
        assertEquals(
            setOf("MessageNarrator.java", "MessageBrowserInteractor.java"),
            stateUpdateCallers.map { it.name }.toSet(),
        )
        stateUpdateCallers.forEach { caller ->
            val source = caller.readText()
            assertTrue(source.contains("Message.State.READ"))
            assertFalse(source.contains("Message.State.DELIVERED"))
        }
    }

    @Test
    fun missingStoredRowsFailClosedWithoutInventingAReceipt() {
        val getMessage = StoreFixture::class.java.getDeclaredMethod(
            "getMessageForID",
            Long::class.javaPrimitiveType!!,
        )
        val getConversation = StoreFixture::class.java.getDeclaredMethod(
            "getConversationById",
            Long::class.javaPrimitiveType!!,
        )
        val missingMessage = StoreFixture(message = null)
        assertNull(
            MessageStatusHooks.resolveCommittedRecord(
                missingMessage,
                41,
                getMessage,
                getConversation,
            ),
        )
        assertEquals(1, missingMessage.messageReads)
        assertEquals(0, missingMessage.conversationReads)

        val missingConversation = StoreFixture(conversation = null)
        assertNull(
            MessageStatusHooks.resolveCommittedRecord(
                missingConversation,
                41,
                getMessage,
                getConversation,
            ),
        )
        assertEquals(1, missingConversation.messageReads)
        assertEquals(1, missingConversation.conversationReads)
    }

    @Test
    fun storedRowReadFailureFailsOpenToStockAndEmitsNoReceipt() {
        val store = ThrowingStoreFixture()
        assertNull(
            MessageStatusHooks.resolveCommittedRecord(
                store,
                41,
                ThrowingStoreFixture::class.java.getDeclaredMethod(
                    "getMessageForID",
                    Long::class.javaPrimitiveType!!,
                ),
                ThrowingStoreFixture::class.java.getDeclaredMethod(
                    "getConversationById",
                    Long::class.javaPrimitiveType!!,
                ),
            ),
        )
    }

    @Test
    fun malformedCommittedRowsAreRejected() {
        val validConversation = ConversationFixture()
        val invalidMessages = listOf(
            MessageFixture(id = 42),
            MessageFixture(conversationId = -1),
            MessageFixture(mine = false),
            MessageFixture(state = 1),
            MessageFixture(body = null),
            MessageFixture(body = ""),
            MessageFixture(body = "x".repeat(MessageStatusHooks.MAX_BODY_CHARS + 1)),
            MessageFixture(timestampMs = 0),
        )
        invalidMessages.forEach { message ->
            assertNull(MessageStatusHooks.extractRecord(41, message, validConversation))
        }

        val invalidConversations = listOf(
            ConversationFixture(id = 8),
            ConversationFixture(recipients = emptyList()),
            ConversationFixture(recipients = listOf("")),
            ConversationFixture(recipients = listOf("bad\nrecipient")),
            ConversationFixture(
                recipients = listOf("x".repeat(MessageStatusHooks.MAX_RECIPIENT_CHARS + 1)),
            ),
            ConversationFixture(
                recipients = List(MessageStatusHooks.MAX_RECIPIENTS + 1) { "recipient-$it" },
            ),
            ConversationFixture(
                recipients = List(MessageStatusHooks.MAX_RECIPIENTS + 1) {
                    "recipient-placeholder"
                },
            ),
            ConversationFixture(recipients = listOf(Any())),
            ConversationFixture(recipients = listOf("recipient-placeholder", Any())),
        )
        invalidConversations.forEach { conversation ->
            assertNull(MessageStatusHooks.extractRecord(41, MessageFixture(), conversation))
        }
    }

    @Test
    fun successfulCommittedIdentitiesAreDeduplicatedWithinABoundedWindow() {
        val deliveries = MessageStatusHooks.PublishedDeliveries(capacity = 2)
        val first = MessageStatusHooks.DeliveredIdentity(1, 7, 1_000, 2, "payload-a")
        val second = MessageStatusHooks.DeliveredIdentity(2, 7, 2_000, 2, "payload-b")
        val reusedId = MessageStatusHooks.DeliveredIdentity(1, 7, 3_000, 2, "payload-c")
        var publications = 0
        fun publish(): Boolean {
            publications++
            return true
        }

        assertFalse(deliveries.contains(first))
        assertTrue(deliveries.publishOnce(first, ::publish))
        assertFalse(deliveries.publishOnce(first, ::publish))
        assertTrue(deliveries.publishOnce(second, ::publish))
        assertTrue(deliveries.contains(first))
        assertTrue(deliveries.contains(second))
        assertEquals(2, publications)

        assertTrue(deliveries.publishOnce(reusedId, ::publish))
        assertFalse(deliveries.contains(first))
        assertTrue(deliveries.contains(second))
        assertTrue(deliveries.contains(reusedId))

        val restartedProcessWindow = MessageStatusHooks.PublishedDeliveries(capacity = 2)
        assertTrue(restartedProcessWindow.publishOnce(second, ::publish))
    }

    @Test
    fun failedPublicationIsNotRecordedAsAConfirmedSuccess() {
        val deliveries = MessageStatusHooks.PublishedDeliveries(capacity = 2)
        val identity = MessageStatusHooks.DeliveredIdentity(9, 7, 1_000, 2, "payload")
        var attempts = 0

        assertFalse(
            deliveries.publishOnce(identity) {
                attempts++
                false
            },
        )
        assertFalse(deliveries.contains(identity))
        assertTrue(
            deliveries.publishOnce(identity) {
                attempts++
                true
            },
        )
        assertTrue(deliveries.contains(identity))
        assertEquals(2, attempts)
    }

    @Test
    fun hookIsRegisteredOnlyInTheAlreadyAllowlistedMessagesTarget() {
        val factory = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HookComponentFactory.kt",
        ).readText()
        val manifest = TierAManifestTestPlaceholders.resolve(
            sourceFile("src/main/AndroidManifest.xml").readText(),
        )
        // Registration is a structured module(id, package, class, classification,
        // installer) entry. Match the whole block so the target class stays bound
        // to this installer, rather than matching a formatting detail.
        assertTrue(
            Regex(
                """module\(\s*"[^"]*",\s*StockSymbols\.Messages\.PACKAGE,\s*""" +
                    """StockSymbols\.Messages\.PERSISTENT_MESSAGE_STORE_CLASS,\s*""" +
                    """HookClassification\.\w+,\s*MessageStatusHooks::install,""",
            ).containsMatchIn(factory),
        )
        assertEquals("humane.experience.messages", StockSymbols.Messages.PACKAGE)
        assertEquals(
            "humane.experience.messages.store.PersistentMessageStore",
            StockSymbols.Messages.PERSISTENT_MESSAGE_STORE_CLASS,
        )
        assertTrue(manifest.contains("humane.experience.messages"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }

    private fun repositoryFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("..", relativePath))
        val resolved = candidates.firstOrNull { it.exists() }
        // The decompiled stock workspace is a local, gitignored artifact. Skip
        // rather than fail where it is absent (fresh clone, CI).
        assumeTrue("Decompiled stock workspace absent: $relativePath", resolved != null)
        return resolved!!
    }
}
