package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EsimLpaHooksTest {
    private val bridgeToken = "0123456789abcdef".repeat(4)

    private fun downloadOperation(
        source: String? = "rust",
        action: String = "humane.connectivity.esimlpa.downloadVerifyAndEnableProfile",
        activationCodeProvided: Boolean = true,
        operationToken: String = "op_0123456789abcdef0123456789abcdef",
    ): EsimOperationSnapshot = EsimOperationSnapshot(
        action = action,
        requestId = "req_0123456789abcdef0123456789abcdef",
        operationToken = operationToken,
        iccid = null,
        nickname = null,
        source = source,
        bridgeAuthToken = bridgeToken,
        activationCodeProvided = activationCodeProvided,
    ).also { it.downloadIccid = "8901234567890123456" }

    @Test
    fun `missing delete target identity is never usable`() {
        assertEquals(false, EsimLpaHooks.deleteRequestIdentityIsUsable(null))
        assertEquals(false, EsimLpaHooks.deleteRequestIdentityIsUsable(""))
        assertEquals(false, EsimLpaHooks.deleteRequestIdentityIsUsable("   "))
        assertEquals(true, EsimLpaHooks.deleteRequestIdentityIsUsable("profile-identifier"))
    }

    @Test
    fun `redacts stock activation code logs without changing unrelated messages`() {
        assertEquals(
            "[downloadVerifyAndEnableProfile] activationCode: [REDACTED]",
            EsimLpaHooks.redactSensitiveLpaLogMessage(
                "[downloadVerifyAndEnableProfile] activationCode: sensitive-provisioning-value",
            ),
        )
        assertEquals(
            "download progress: 50",
            EsimLpaHooks.redactSensitiveLpaLogMessage("download progress: 50"),
        )
        assertEquals(
            "profile ICCID: [REDACTED]",
            EsimLpaHooks.redactSensitiveLpaLogMessage(
                "profile ICCID: 12345678901234567890",
            ),
        )
    }

    @Test
    fun `only a verified disabled non-protected profile can be deleted`() {
        assertNull(EsimLpaHooks.deletionBlockReason("User carrier", "Disabled"))
        assertEquals(
            EsimLpaHooks.DeleteBlockReason.ACTIVE_PROFILE,
            EsimLpaHooks.deletionBlockReason("User carrier", "Enabled"),
        )
        assertEquals(
            EsimLpaHooks.DeleteBlockReason.UNVERIFIED_PROFILE_STATE,
            EsimLpaHooks.deletionBlockReason("User carrier", null),
        )
        assertEquals(
            EsimLpaHooks.DeleteBlockReason.UNVERIFIED_PROFILE_STATE,
            EsimLpaHooks.deletionBlockReason("User carrier", "Unknown"),
        )
    }

    @Test
    fun `factory and test profiles stay protected even when disabled`() {
        assertEquals(
            EsimLpaHooks.DeleteBlockReason.PROTECTED_PROFILE,
            EsimLpaHooks.deletionBlockReason("T-Mobile - US", "Disabled"),
        )
        assertEquals(
            EsimLpaHooks.DeleteBlockReason.PROTECTED_PROFILE,
            EsimLpaHooks.deletionBlockReason("GSMA TEST PROFILE TS48 V4.0", "Disabled"),
        )
    }

    @Test
    fun `carrier profile acceptance requires authenticated bound Penumbra download`() {
        val state = EsimCarrierProfileAcceptanceState()
        val operation = downloadOperation()

        assertFalse(state.authorize(operation, bridgeAuthenticated = false))
        assertFalse(
            state.authorize(
                downloadOperation(source = "settings"),
                bridgeAuthenticated = true,
            ),
        )
        assertFalse(
            state.authorize(
                downloadOperation(action = "humane.connectivity.esimlpa.getProfiles"),
                bridgeAuthenticated = true,
            ),
        )
        assertFalse(
            state.authorize(
                downloadOperation(activationCodeProvided = false),
                bridgeAuthenticated = true,
            ),
        )
        assertTrue(state.authorize(operation, bridgeAuthenticated = true))
    }

    @Test
    fun `only matching downloaded profile gets temporary Humane name`() {
        val state = EsimCarrierProfileAcceptanceState()
        val operation = downloadOperation()
        val originalName = "4553494D5F444B"

        assertTrue(state.authorize(operation, bridgeAuthenticated = true))
        assertEquals(
            originalName,
            state.profileNameHex(originalName, operation, "8900000000000000000"),
        )
        assertEquals(
            EsimCarrierProfileAcceptanceState.HUMANE_PROFILE_NAME_HEX,
            state.profileNameHex(originalName, operation, operation.downloadIccid),
        )
        assertTrue(state.clearIfActiveFor(operation))
        assertEquals(
            originalName,
            state.profileNameHex(originalName, operation, operation.downloadIccid),
        )
    }

    @Test
    fun `unrelated terminal operation cannot clear active download acceptance`() {
        val state = EsimCarrierProfileAcceptanceState()
        val operation = downloadOperation()
        val unrelated = downloadOperation(
            operationToken = "op_fedcba9876543210fedcba9876543210",
        )

        assertTrue(state.authorize(operation, bridgeAuthenticated = true))
        assertFalse(state.clearIfActiveFor(unrelated))
        assertEquals(
            EsimCarrierProfileAcceptanceState.HUMANE_PROFILE_NAME_HEX,
            state.profileNameHex("4553494D", operation, operation.downloadIccid),
        )
    }
}
