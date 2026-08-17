package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MessagingCompatibilityHooksTest {
    @Test
    fun `injected hooks use the loopback-only internal routes`() {
        assertEquals(
            "http://127.0.0.1:8080/_penumbra/hooks/v1/inbound-settings",
            InboundFilteringHooks.SETTINGS_URL,
        )
        assertEquals(
            "http://127.0.0.1:8080/_penumbra/hooks/v1/contact-reset-claim",
            ContactsHooks.RESET_CLAIM_URL,
        )
        assertFalse(InboundFilteringHooks.SETTINGS_URL.contains("/api/"))
        assertFalse(ContactsHooks.RESET_CLAIM_URL.contains("/api/"))
    }

    @Test
    fun `inbound settings parser accepts the minimal internal payload`() {
        val parsed = InboundFilteringHooks.parseInboundSettings(
            """{"trust_all_contacts":true,"allow_all_inbound":false}""",
        )

        assertNotNull(parsed)
        assertTrue(parsed!!.trustAllContacts)
        assertFalse(parsed.allowAllInbound)
    }

    @Test
    fun `contact plaintext bypass is limited to the explicit local envelope`() {
        assertTrue(ContactsHooks.isPlaintextContactKid("plaintext"))
        assertTrue(
            ContactsHooks.isPlaintextContactKid(
                "plaintext:humane.contacts.Contact",
            ),
        )
        assertFalse(ContactsHooks.isPlaintextContactKid("cloud-key-id"))
        assertFalse(ContactsHooks.isPlaintextContactKid("plaintext:humane.aibus.FunctionCall"))
    }
}
