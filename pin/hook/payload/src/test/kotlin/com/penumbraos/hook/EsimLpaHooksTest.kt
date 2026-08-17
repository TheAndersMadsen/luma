package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EsimLpaHooksTest {
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
}
