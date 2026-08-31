package com.penumbraos.hook

import humane.aibus.GetFoodItemResponse
import humane.common.food.FoodItem
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FoodRoundTripEvidenceHooksTest {
    private val exactTrack = FoodRoundTripEvidenceHooks.MethodShape(
        name = "trackFoodItemConsumption",
        returnType = "java.lang.Object",
        parameterTypes = listOf(
            FoodRoundTripEvidenceHooks.FOOD_ITEM_CLASS,
            "float",
            FoodRoundTripEvidenceHooks.CONTINUATION_CLASS,
        ),
        isPublic = true,
        isStatic = false,
    )
    private val exactCompletion = FoodRoundTripEvidenceHooks.MethodShape(
        name = "invokeSuspend",
        returnType = "java.lang.Object",
        parameterTypes = listOf("java.lang.Object"),
        isPublic = true,
        isStatic = false,
    )

    @Test
    fun `only exact audited Food coroutine shapes are observed`() {
        assertTrue(FoodRoundTripEvidenceHooks.exactTrackShape(exactTrack))
        assertFalse(
            FoodRoundTripEvidenceHooks.exactTrackShape(
                exactTrack.copy(parameterTypes = exactTrack.parameterTypes.dropLast(1)),
            ),
        )
        assertFalse(FoodRoundTripEvidenceHooks.exactTrackShape(exactTrack.copy(isStatic = true)))
        assertTrue(FoodRoundTripEvidenceHooks.exactCompletionShape(exactCompletion))
        assertFalse(
            FoodRoundTripEvidenceHooks.exactCompletionShape(
                exactCompletion.copy(returnType = "kotlin.Unit"),
            ),
        )
    }

    @Test
    fun `nonce keyed memory tokens are deterministic lowercase and content free`() {
        assertEquals(
            "83fc340cbf22ea819c545838c81d20c2eaea20d4ad56bb2f89ea2ef6e72704f7",
            FoodRoundTripEvidenceHooks.memoryToken(
                "0123456789abcdef0123456789abcdef",
                "323e4567-e89b-42d3-a456-426614174000",
            ),
        )
        assertEquals(null, FoodRoundTripEvidenceHooks.memoryToken("bad", "not-a-uuid"))
    }

    @Test
    fun `lookup token comes from the exact best item response field`() {
        val nonce = "0123456789abcdef0123456789abcdef"
        val selectedUuid = "323e4567-e89b-42d3-a456-426614174000"
        val alternateUuid = "423e4567-e89b-42d3-a456-426614174000"
        val response = GetFoodItemResponse(
            bestFoodItem = FoodItem(selectedUuid),
            alternateFoodItems = listOf(FoodItem(alternateUuid)),
        )

        assertEquals(
            FoodRoundTripEvidenceHooks.memoryToken(nonce, selectedUuid),
            FoodRoundTripEvidenceHooks.lookupItemToken(nonce, response),
        )
        assertFalse(
            FoodRoundTripEvidenceHooks.lookupItemToken(nonce, response) ==
                FoodRoundTripEvidenceHooks.memoryToken(nonce, alternateUuid),
        )
        assertEquals(
            null,
            FoodRoundTripEvidenceHooks.lookupItemToken(
                nonce,
                GetFoodItemResponse(null, listOf(FoodItem(alternateUuid))),
            ),
        )
        assertEquals(
            null,
            FoodRoundTripEvidenceHooks.lookupItemToken(nonce, FoodItem(selectedUuid)),
        )
    }

    @Test
    fun `readback requires one more exact item than the armed baseline`() {
        assertTrue(FoodRoundTripEvidenceHooks.exactReadbackCount(0, 1))
        assertTrue(FoodRoundTripEvidenceHooks.exactReadbackCount(3, 4))
        assertFalse(FoodRoundTripEvidenceHooks.exactReadbackCount(1, 1))
        assertFalse(FoodRoundTripEvidenceHooks.exactReadbackCount(1, 3))
    }

    @Test
    fun `refresh preserves state while stale expiry replacement and disarm purge it`() {
        val window = FoodRoundTripEvidenceHooks.EvidenceWindow()
        val arm = FoodRoundTripEvidenceHooks.ActiveArm(
            "0123456789abcdef0123456789abcdef",
            1_710_000_180L,
        )
        val refreshedArm = arm.copy(expiresAtSeconds = arm.expiresAtSeconds + 120L)
        val create = FoodRoundTripEvidenceHooks.CreateEvidence(
            fingerprint = "food-fingerprint",
            itemToken = "a".repeat(64),
            memoryToken = "b".repeat(64),
            nonce = arm.nonce,
            baselineCount = 1,
        )

        assertTrue(window.synchronize(arm))
        assertTrue(window.recordBaseline(arm.nonce, mapOf(create.fingerprint to 1)))
        window.recordLookup(arm.nonce, create.itemToken)
        window.remember(create)
        assertTrue(window.hasBaseline())
        assertEquals(1, window.retainedCreateCount())
        assertFalse(window.synchronize(refreshedArm))
        assertEquals(1, window.retainedCreateCount())
        assertFalse(window.expire(arm))
        assertTrue(window.hasBaseline())
        assertEquals(1, window.retainedCreateCount())
        assertTrue(window.consumeLookup(arm.nonce, create.itemToken))

        assertTrue(window.expire(refreshedArm))
        assertFalse(window.hasBaseline())
        assertEquals(0, window.retainedCreateCount())

        assertTrue(window.synchronize(arm))
        assertTrue(window.recordBaseline(arm.nonce, mapOf(create.fingerprint to 1)))
        window.remember(create)

        val replacementArm = FoodRoundTripEvidenceHooks.ActiveArm(
            "fedcba9876543210fedcba9876543210",
            arm.expiresAtSeconds,
        )
        assertTrue(window.synchronize(replacementArm))
        assertFalse(window.hasBaseline())
        assertEquals(0, window.retainedCreateCount())

        assertTrue(window.synchronize(arm))
        assertTrue(window.recordBaseline(arm.nonce, mapOf(create.fingerprint to 1)))
        window.remember(create)

        assertTrue(window.synchronize(null))
        assertFalse(window.hasBaseline())
        assertEquals(0, window.retainedCreateCount())

        assertEquals(
            arm,
            FoodRoundTripEvidenceHooks.parseActiveArm(
                "${arm.nonce}:${arm.expiresAtSeconds}",
                arm.expiresAtSeconds - 1,
            ),
        )
        assertEquals(
            null,
            FoodRoundTripEvidenceHooks.parseActiveArm(
                "${arm.nonce}:${arm.expiresAtSeconds}",
                arm.expiresAtSeconds,
            ),
        )
    }

    @Test
    fun `evidence hook never replaces stock Food results`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/FoodRoundTripEvidenceHooks.kt",
        ).readText()
        assertTrue(source.contains("FoodRoundTrip create status=success"))
        assertTrue(source.contains("FoodRoundTrip baseline status=success"))
        assertTrue(source.contains("FoodRoundTrip lookup item_token="))
        assertTrue(source.contains("FoodRoundTrip read item_token="))
        assertTrue(source.contains("activeArm()"))
        assertTrue(source.contains("scheduleArmExpiry(arm)"))
        assertTrue(source.contains("evidenceWindow.expire(arm)"))
        assertTrue(source.contains("MAX_ARM_WINDOW_SECONDS = 180L"))
        assertTrue(source.contains("if (matched) evidenceWindow.forget(evidence)"))
        assertTrue(source.contains("sourceApk: FoodTaoDeadlineHooks.AuditedFoodApk"))
        assertTrue(source.contains("getDeclaredMethod(\"addChangeCallback\""))
        assertFalse(source.contains("food_sha256="))
        assertFalse(source.contains("param.result ="))
        assertFalse(source.contains("setResult("))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
