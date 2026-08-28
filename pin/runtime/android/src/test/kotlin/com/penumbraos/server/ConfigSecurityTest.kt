package com.penumbraos.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ConfigSecurityTest {
    @Test
    fun cosmosAuthorityRemovesDeviceProvidersAndKeepsLocalSettings() {
        val input = """
            [server]
            display_name = "Kitchen Pin"

            [llm]
            provider = "openai-compatible"
            api_key = "secret"

            [weather]
            pirate_weather_api_key = "secret"
            measurement_system = "metric"

            [google_maps]
            api_key = "secret"

            [open_food_facts]
            enabled = true
            attribution_acknowledged = true

            [contacts]
            trust_all_contacts = true
        """.trimIndent() + "\n"

        val migrated = ConfigSecurity.enforceCosmosProviderAuthority(input, true)

        assertTrue(migrated.changed)
        assertTrue(migrated.text.contains("display_name = \"Kitchen Pin\""))
        assertTrue(migrated.text.contains("measurement_system = \"metric\""))
        assertTrue(migrated.text.contains("trust_all_contacts = true"))
        assertTrue(migrated.text.contains("provider = \"echo\""))
        assertTrue(migrated.text.contains("model = \"cosmos-remote\""))
        assertTrue(migrated.text.contains("enabled = false"))
        assertFalse(migrated.text.contains("api_key"))
        assertFalse(migrated.text.contains("[google_maps]"))
        assertTrue(migrated.text.contains("[open_food_facts]"))
        assertTrue(migrated.text.contains("attribution_acknowledged = true"))
        assertFalse(migrated.text.contains("provider = \"openai-compatible\""))
        assertFalse(
            ConfigSecurity.enforceCosmosProviderAuthority(migrated.text, true).changed,
        )
    }

    @Test
    fun localOverlayDropsProvidersWithoutAddingAnLlmSection() {
        val migrated = ConfigSecurity.enforceCosmosProviderAuthority(
            "[llm]\nprovider = \"openai\"\n\n[server]\ndisplay_name = \"Kept\"\n",
            false,
        )

        assertEquals("[server]\ndisplay_name = \"Kept\"\n", migrated.text)
    }

    @Test
    fun generatedTokenIsA32ByteVisibleAsciiSecret() {
        val token = ConfigSecurity.generateAdminToken()
        assertEquals(64, token.length)
        assertTrue(token.all { it in '0'..'9' || it in 'a'..'f' })
        assertEquals(token, ConfigSecurity.requireValidAdminToken(token))
    }

    @Test
    fun migrationAddsTokenOnceAndPreservesExistingToken() {
        val token = "a".repeat(64)
        val initial = """
            [server]
            http_bind_addr = "127.0.0.1:8080"
        """.trimIndent() + "\n"

        val first = ConfigSecurity.ensureAdminToken(initial) { token }
        assertTrue(first.changed)
        assertEquals(token, first.token)
        assertEquals(1, Regex("(?m)^admin_token\\s*=").findAll(first.text).count())

        val second = ConfigSecurity.ensureAdminToken(first.text) {
            fail("existing token must not be regenerated")
            ""
        }
        assertFalse(second.changed)
        assertEquals(token, second.token)
        assertEquals(first.text, second.text)
    }

    @Test
    fun dashboardBooleanReaderIsStrictAndRejectsDuplicates() {
        val config = """
            [server]
            lan_dashboard_enabled = true
        """.trimIndent() + "\n"
        assertEquals(
            true,
            ConfigSecurity.readOptionalBoolean(config, "server.lan_dashboard_enabled"),
        )
        assertNull(ConfigSecurity.readOptionalBoolean(config, "server.missing"))

        assertFails {
            ConfigSecurity.readOptionalBoolean(
                "[server]\nlan_dashboard_enabled = \"true\"\n",
                "server.lan_dashboard_enabled",
            )
        }
        assertFails {
            ConfigSecurity.readOptionalBoolean(
                "[server]\nlan_dashboard_enabled = true\nlan_dashboard_enabled = false\n",
                "server.lan_dashboard_enabled",
            )
        }
    }

    @Test
    fun untrustedLegacyReplacementCarriesNoLegacyValuesAcrossTheTrustBoundary() {
        val attackerChosen = "x".repeat(64)
        val fresh = "f".repeat(64)
        val imported = ConfigSecurity.createSafeLegacyReplacement { fresh }

        assertEquals(fresh, ConfigSecurity.readAdminToken(imported))
        assertEquals(
            "127.0.0.1:8080",
            ConfigSecurity.readOptionalString(imported, "server.http_bind_addr"),
        )
        assertFalse(imported.contains(attackerChosen))
        assertFalse(imported.contains("api_key"))
        assertTrue(imported.contains("provider = \"echo\""))
        assertTrue(imported.contains("lan_dashboard_enabled = false"))
    }

    @Test
    fun configLookingLinesInsideMultilinePromptAreNeverTreatedAsFields() {
        val promptToken = "p".repeat(64)
        val generated = "g".repeat(64)
        val multilineDelimiter = "\"\"\""
        val config = """
            [server]
            system_prompt = $multilineDelimiter
            [server]
            admin_token = "$promptToken"
            [llm]
            api_key = "prompt text, not a credential"
            $multilineDelimiter
            http_bind_addr = "127.0.0.1:8080"
        """.trimIndent() + "\n"

        val migrated = ConfigSecurity.ensureAdminToken(config) { generated }
        assertEquals(generated, ConfigSecurity.readAdminToken(migrated.text))

        val backup = ConfigSecurity.scrubWriteOnlySecretsForBackup(migrated.text)
        assertNull(ConfigSecurity.readOptionalString(backup, "server.admin_token"))
        assertTrue(backup.contains(promptToken))
        assertTrue(backup.contains("api_key = \"prompt text, not a credential\""))
    }

    @Test
    fun androidLocalOverlayCannotOverrideAuthAndMigratesLegacyWildcardOnly() {
        val token = "l".repeat(64)
        val overlay = """
            [server]
            admin_token = "$token"
            http_bind_addr = "0.0.0.0:8080"
            [llm]
            provider = "echo"
        """.trimIndent() + "\n"

        val migrated = ConfigSecurity.prepareAndroidLocalOverlay(overlay)
        assertTrue(migrated.changed)
        assertNull(ConfigSecurity.readOptionalString(migrated.text, "server.admin_token"))
        assertEquals(
            "127.0.0.1:8080",
            ConfigSecurity.readOptionalString(migrated.text, "server.http_bind_addr"),
        )
        assertFalse(migrated.text.contains(token))
        assertTrue(migrated.text.contains("provider = \"echo\""))
    }

    @Test
    fun migrationBackupScrubsEveryWriteOnlySecret() {
        val config = """
            [server]
            admin_token = "${"a".repeat(64)}"
            [llm]
            api_key = "llm-secret"
            [weather]
            pirate_weather_api_key = "weather-secret"
            [google_maps]
            api_key = "maps-secret"
            [brave_search]
            api_key = "brave-secret"
            [azure_speech]
            subscription_key = "speech-secret"
            region = "northeurope"
        """.trimIndent() + "\n"

        val scrubbed = ConfigSecurity.scrubWriteOnlySecretsForBackup(config)
        for (secret in listOf(
            "a".repeat(64),
            "llm-secret",
            "weather-secret",
            "maps-secret",
            "brave-secret",
            "speech-secret",
        )) {
            assertFalse(scrubbed.contains(secret))
        }
        assertTrue(scrubbed.contains("region = \"northeurope\""))
    }

    @Test
    fun ambiguousInlineOrMultilineSecretShapesFailClosed() {
        assertFails {
            ConfigSecurity.ensureAdminToken(
                "server = { admin_token = \"${"a".repeat(64)}\" }\n",
            )
        }
        assertFails {
            ConfigSecurity.scrubWriteOnlySecretsForBackup(
                "[llm]\napi_key = \"\"\"\nsecret\n\"\"\"\n",
            )
        }
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            fail("expected security validation failure")
        } catch (_: IllegalStateException) {
        }
    }
}
