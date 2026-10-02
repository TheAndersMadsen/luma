package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ContextHistorySafetyHooksTest {
    private data class Turn(
        val id: String,
        var parent: Turn? = null,
    )

    private class FirmwareTurn

    private class FirmwareImmutableList

    private open class ErasedBuilder

    private open class GenericGeneratedMessage<BuilderType : ErasedBuilder> {
        @Suppress("UNUSED")
        fun toBuilder(): BuilderType = error("reflection fixture only")
    }

    private class FirmwareGeneratedMessage(
        val identifier: String,
    ) : GenericGeneratedMessage<FirmwareGeneratedMessage.Builder>() {
        class Builder(
            private var identifier: String,
        ) : ErasedBuilder() {
            fun setIdentifier(value: String): Builder = apply { identifier = value }

            fun build(): FirmwareGeneratedMessage = FirmwareGeneratedMessage(identifier)
        }

        companion object {
            @JvmStatic
            fun newBuilder(message: FirmwareGeneratedMessage): Builder =
                Builder(message.identifier)
        }
    }

    /**
     * Stock Ironman contains both methods. The synthetic lambda bridge delegates
     * to runFromHead, but has the same parameter and return types.
     */
    private class FirmwareEventsSnapshotShape {
        @Suppress("UNUSED_PARAMETER")
        fun runFromHead(head: FirmwareTurn): FirmwareImmutableList =
            error("reflection fixture only")

        @Suppress("UNUSED_PARAMETER")
        fun syntheticLinearizeBridge(head: FirmwareTurn): FirmwareImmutableList =
            error("reflection fixture only")
    }

    @Test
    fun `firmware locator selects runFromHead instead of same-signature bridge`() {
        val signatureMatches = FirmwareEventsSnapshotShape::class.java.declaredMethods.filter {
            it.parameterTypes.contentEquals(arrayOf(FirmwareTurn::class.java)) &&
                it.returnType == FirmwareImmutableList::class.java
        }
        assertEquals(2, signatureMatches.size)

        val selected = ContextHistorySafetyHooks.findParentChainMethod(
            snapshotClass = FirmwareEventsSnapshotShape::class.java,
            turnClass = FirmwareTurn::class.java,
            immutableListClass = FirmwareImmutableList::class.java,
        )

        assertEquals("runFromHead", selected?.name)
    }

    @Test
    fun `copy builder locator handles erased inherited toBuilder return type`() {
        val inheritedToBuilder = FirmwareGeneratedMessage::class.java.getMethod("toBuilder")
        assertEquals(ErasedBuilder::class.java, inheritedToBuilder.returnType)
        try {
            inheritedToBuilder.returnType.getMethod("setIdentifier", String::class.java)
            fail("erased generic builder must not expose the generated setter")
        } catch (_: NoSuchMethodException) {
            // This is the exact failure shape observed on stock protobuf-javalite.
        }

        val copyBuilder = ContextHistorySafetyHooks.findGeneratedCopyBuilderMethod(
            FirmwareGeneratedMessage::class.java,
        )
        assertEquals(FirmwareGeneratedMessage.Builder::class.java, copyBuilder?.returnType)

        val builder = copyBuilder?.invoke(null, FirmwareGeneratedMessage("original"))
        copyBuilder?.returnType
            ?.getMethod("setIdentifier", String::class.java)
            ?.invoke(builder, "repaired")
        val repaired = copyBuilder?.returnType
            ?.getMethod("build")
            ?.invoke(builder) as FirmwareGeneratedMessage
        assertEquals("repaired", repaired.identifier)
    }

    @Test
    fun `healthy chain retains exact head to root order`() {
        val root = Turn("root")
        val action = Turn("action", root)
        val observation = Turn("observation", action)

        val result = inspect(observation, historySize = 2)

        assertFalse(result.truncated)
        assertEquals(listOf(observation, action, root), result.values)
    }

    @Test
    fun `self cycle is bounded to the head`() {
        val head = Turn("self")
        head.parent = head

        val result = inspect(head, historySize = 1)

        assertTrue(result.truncated)
        assertEquals(listOf(head), result.values)
    }

    @Test
    fun `multi turn cycle is bounded to the head`() {
        val first = Turn("first")
        val second = Turn("second", first)
        first.parent = second

        val result = inspect(second, historySize = 2)

        assertTrue(result.truncated)
        assertEquals(listOf(second), result.values)
    }

    @Test
    fun `identity tracking catches cycles with blank identifiers`() {
        val first = Turn("")
        val second = Turn("", first)
        first.parent = second

        val result = inspect(second, historySize = 2)

        assertTrue(result.truncated)
        assertEquals(listOf(second), result.values)
    }

    @Test
    fun `depth bound contains a malformed chain even when identifiers are unique`() {
        val root = Turn("root")
        val middle = Turn("middle", root)
        val head = Turn("head", middle)

        val result = ContextHistorySafetyHooks.inspectParentChain(
            head = head,
            historySize = 3,
            absoluteMaxDepth = 2,
            identifierOf = Turn::id,
            parentOf = Turn::parent,
        )

        assertTrue(result.truncated)
        assertEquals(listOf(head), result.values)
    }

    @Test
    fun `identifier-less device action is repaired for streaming dispatch`() {
        assertTrue(
            ContextHistorySafetyHooks.shouldRepairLocalAction(
                hasAction = true,
                actionSourceValue = 0,
                identifier = "",
                requiresResponse = false,
            ),
        )
    }

    @Test
    fun `server unknown and malformed action sources remain untouched`() {
        for (sourceValue in listOf<Int?>(1, null, -1, 2, Int.MAX_VALUE)) {
            assertFalse(
                ContextHistorySafetyHooks.shouldRepairLocalAction(
                    hasAction = true,
                    actionSourceValue = sourceValue,
                    identifier = "",
                    requiresResponse = false,
                ),
            )
        }
    }

    @Test
    fun `non-action valid identifier and response-required events remain untouched`() {
        assertFalse(
            ContextHistorySafetyHooks.shouldRepairLocalAction(
                hasAction = true,
                actionSourceValue = 0,
                identifier = "server-turn-id",
                requiresResponse = false,
            ),
        )
        assertFalse(
            ContextHistorySafetyHooks.shouldRepairLocalAction(
                hasAction = true,
                actionSourceValue = 0,
                identifier = "",
                requiresResponse = true,
            ),
        )
        assertFalse(
            ContextHistorySafetyHooks.shouldRepairLocalAction(
                hasAction = false,
                actionSourceValue = 0,
                identifier = "",
                requiresResponse = false,
            ),
        )
    }

    @Test
    fun `exact local reset alone authorizes context clear under minimal normalization`() {
        for (utterance in listOf(
            "reset session",
            "RESET SESSION",
            "  Reset   Session  ",
            "\treset\tsession\t",
        )) {
            assertEquals(
                true,
                ContextHistorySafetyHooks.localClearAuthorization(
                    actionName = "ClearUnderstandingContext",
                    actionSourceValue = 0,
                    currentUtterances = listOf(utterance),
                ),
            )
        }
    }

    @Test
    fun `polite plural extra punctuation and quoted local reset near misses fail closed`() {
        for (utterance in listOf(
            "please reset session",
            "reset sessions",
            "reset session now",
            "reset session.",
            "\"reset session\"",
            "say reset session",
            "the phrase reset session appears here",
        )) {
            assertEquals(
                false,
                ContextHistorySafetyHooks.localClearAuthorization(
                    actionName = "ClearUnderstandingContext",
                    actionSourceValue = 0,
                    currentUtterances = listOf(utterance),
                ),
            )
        }
    }

    @Test
    fun `newline substring and translated local reset near misses fail closed`() {
        for (utterance in listOf(
            "reset\nsession",
            "reset session\n",
            "reset\r\nsession",
            "preset session",
            "reset sessionized",
            "nulstil session",
            "réinitialiser la session",
        )) {
            assertFalse(ContextHistorySafetyHooks.isExactResetUtterance(utterance))
        }
    }

    @Test
    fun `missing multiple and malformed current utterance results fail closed`() {
        for (utterances in listOf<List<*>?>(
            null,
            emptyList<Any>(),
            listOf("reset session", "reset session"),
            listOf(7),
            listOf(null),
            listOf(""),
        )) {
            assertEquals(
                false,
                ContextHistorySafetyHooks.localClearAuthorization(
                    actionName = "ClearUnderstandingContext",
                    actionSourceValue = 0,
                    currentUtterances = utterances,
                ),
            )
        }
    }

    @Test
    fun `server sourced synapse clear and unrelated local actions remain outside the guard`() {
        assertNull(
            ContextHistorySafetyHooks.localClearAuthorization(
                actionName = "ClearUnderstandingContext",
                actionSourceValue = 1,
                currentUtterances = listOf("please reset every session"),
            ),
        )
        assertNull(
            ContextHistorySafetyHooks.localClearAuthorization(
                actionName = "GetCurrentTime",
                actionSourceValue = null,
                currentUtterances = null,
            ),
        )
    }

    @Test
    fun `malformed local clear source fails closed`() {
        assertEquals(
            false,
            ContextHistorySafetyHooks.localClearAuthorization(
                actionName = "ClearUnderstandingContext",
                actionSourceValue = null,
                currentUtterances = listOf("reset session"),
            ),
        )
    }

    @Test
    fun `physical verification exposes only exact content-free action names`() {
        for (actionName in listOf(
            "GetCurrentTime",
            "GetBatteryLevel",
            "GetCurrentLocation",
            "WorldClock",
            "PlayMusic",
            "Tickle",
        )) {
            assertEquals(
                actionName,
                ContextHistorySafetyHooks.physicalVerificationActionName(
                    hasAction = true,
                    actionName = actionName,
                ),
            )
        }

        for (actionName in listOf(
            null,
            "",
            "getcurrenttime",
            "Tickle | prompt=private",
            "Tickle\nprivate",
        )) {
            assertEquals(
                null,
                ContextHistorySafetyHooks.physicalVerificationActionName(
                    hasAction = true,
                    actionName = actionName,
                ),
            )
        }
        assertEquals(
            null,
            ContextHistorySafetyHooks.physicalVerificationActionName(
                hasAction = false,
                actionName = "Tickle",
            ),
        )
    }

    @Test
    fun `physical verification covers both legacy and streaming stock dispatch`() {
        val source = File(
            "src/main/kotlin/com/penumbraos/hook/ContextHistorySafetyHooks.kt",
        ).readText()

        assertTrue(source.contains("installLegacyPhysicalActionVerification"))
        assertTrue(source.contains("installLocalIntermediateRepair"))
        assertTrue(source.contains("\"onContent\""))
        assertTrue(
            source.contains(
                "Log.w(TAG, \"\$PHYSICAL_ACTION_MARKER | action=\$verifiedAction\")",
            ),
        )
    }

    @Test
    fun `session retention locates either stock constructor ordering`() {
        assertEquals(
            2,
            ContextHistorySafetyHooks.sessionRetentionArgumentIndex(
                arrayOf(Int::class.javaPrimitiveType!!, String::class.java, Int::class.javaPrimitiveType!!),
            ),
        )
        assertEquals(
            1,
            ContextHistorySafetyHooks.sessionRetentionArgumentIndex(
                arrayOf(Int::class.javaPrimitiveType!!, Int::class.javaPrimitiveType!!, String::class.java),
            ),
        )
    }

    @Test
    fun `session retention leaves unrelated constructors alone and removes time expiry`() {
        assertEquals(
            null,
            ContextHistorySafetyHooks.sessionRetentionArgumentIndex(
                arrayOf(Int::class.javaPrimitiveType!!, String::class.java),
            ),
        )
        assertEquals(Int.MAX_VALUE, ContextHistorySafetyHooks.retainedSessionSeconds())
    }

    private fun inspect(
        head: Turn,
        historySize: Int,
    ): ContextHistorySafetyHooks.ParentChain<Turn> =
        ContextHistorySafetyHooks.inspectParentChain(
            head = head,
            historySize = historySize,
            identifierOf = Turn::id,
            parentOf = Turn::parent,
        )
}
