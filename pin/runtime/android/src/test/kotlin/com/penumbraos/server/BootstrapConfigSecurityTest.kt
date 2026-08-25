package com.penumbraos.server

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BootstrapConfigSecurityTest {
    @Test
    fun legacySharedDatabasePathIsRetargetedNarrowly() {
        val legacy = "/storage/emulated/0/PenumbraOS/penumbra.db"
        val alias = "/sdcard/PenumbraOS/penumbra.db"
        val current = "/data/user/0/com.penumbraos.server/databases/penumbra.db"
        val config = "[storage]\ndb_path = \"$legacy\"\nmedia_dir = \"/sdcard/PenumbraOS/media\"\n"

        val (migrated, changed) = BootstrapConfig.retargetLegacyDatabasePath(
            config,
            listOf(legacy, alias),
            current,
        )

        assertTrue(changed)
        assertTrue(migrated.contains("db_path = \"$current\""))
        assertTrue(migrated.contains("media_dir = \"/sdcard/PenumbraOS/media\""))

        val custom = "[storage]\ndb_path = \"/mnt/operator/custom.db\"\n"
        assertEquals(
            custom to false,
            BootstrapConfig.retargetLegacyDatabasePath(custom, listOf(legacy, alias), current),
        )
    }

    @Test
    fun legacySharedLogPathIsRetargetedNarrowly() {
        val legacy = "/storage/emulated/0/PenumbraOS/logs"
        val alias = "/sdcard/PenumbraOS/logs"
        val current = "/data/user/0/com.penumbraos.server/files/logs"
        val config = "[logging]\nlog_dir = \"$alias\"\nfile_prefix = \"humane-server\"\n"

        val (migrated, changed) = BootstrapConfig.retargetLegacyLogPath(
            config,
            listOf(legacy, alias),
            current,
        )

        assertTrue(changed)
        assertTrue(migrated.contains("log_dir = \"$current\""))
        assertTrue(migrated.contains("file_prefix = \"humane-server\""))

        val custom = "[logging]\nlog_dir = \"/mnt/operator/logs\"\n"
        assertEquals(
            custom to false,
            BootstrapConfig.retargetLegacyLogPath(custom, listOf(legacy, alias), current),
        )
    }

    @Test
    fun recreatedLegacyDirectoryCannotBlockPrivateConfigStartup() {
        val directory = Files.createTempDirectory("penumbra-legacy-directory").toFile()
        val legacy = directory.resolve("config.toml").apply {
            mkdirs()
            resolve("attacker-entry").writeText("not a config")
        }
        try {
            BootstrapConfig.removeLegacyConfigArtifacts(legacy)
            assertTrue(legacy.isDirectory)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun unmarkedPrivateConfigFromVulnerableBuildIsResetExactlyOnce() {
        val directory = Files.createTempDirectory("penumbra-private-provenance").toFile()
        val config = directory.resolve("config.toml")
        val local = directory.resolve("config.local.toml")
        val marker = directory.resolve(".config-security-schema")
        val attackerToken = "x".repeat(64)
        val freshToken = "f".repeat(64)
        try {
            config.writeText(
                """
                    [llm]
                    provider = "openai-compatible"
                    base_url = "https://attacker.example"
                    api_key = "${"c".repeat(64)}"
                    [server]
                    admin_token = "$attackerToken"
                    http_bind_addr = "0.0.0.0:8080"
                    lan_dashboard_enabled = true
                """.trimIndent() + "\n",
            )
            local.writeText("[llm]\nmodel = \"attacker-model\"\n")
            directory.resolve("config.toml.bak").writeText("api_key = \"old-secret\"\n")
            directory.resolve("config.local.toml.bak").writeText("api_key = \"local-secret\"\n")

            assertTrue(
                BootstrapConfig.resetUnprovenPrivateConfigIfNeeded(
                    config,
                    local,
                    marker,
                ) { freshToken },
            )
            val reset = config.readText()
            assertEquals(freshToken, ConfigSecurity.readAdminToken(reset))
            assertTrue(reset.contains("provider = \"echo\""))
            assertTrue(reset.contains("lan_dashboard_enabled = false"))
            for (untrusted in listOf(
                attackerToken,
                "attacker.example",
                "attacker-model",
                "old-secret",
                "local-secret",
            )) {
                assertFalse(reset.contains(untrusted))
            }
            assertFalse(local.exists())
            assertFalse(directory.resolve("config.toml.bak").exists())
            assertFalse(directory.resolve("config.local.toml.bak").exists())

            BootstrapConfig.writePrivateConfigSecuritySchema(marker)
            assertTrue(BootstrapConfig.hasCurrentPrivateConfigSecuritySchema(marker))
            config.appendText("# trusted customization\n")
            assertFalse(
                BootstrapConfig.resetUnprovenPrivateConfigIfNeeded(
                    config,
                    local,
                    marker,
                ) { error("trusted config must not be reset") },
            )
            assertTrue(config.readText().contains("trusted customization"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun releasedHeadStateWithoutPrivateArtifactsUsesNormalLegacyMigration() {
        val root = Files.createTempDirectory("penumbra-released-head-provenance").toFile()
        val private = root.resolve("private").apply { mkdirs() }
        val external = root.resolve("external").apply { mkdirs() }
        val config = private.resolve("config.toml")
        val local = private.resolve("config.local.toml")
        val marker = private.resolve(".config-security-schema")
        val legacy = external.resolve("config.toml").apply {
            writeText("[llm]\nprovider = \"openai-compatible\"\n")
        }
        try {
            assertFalse(
                BootstrapConfig.resetUnprovenPrivateConfigIfNeeded(config, local, marker),
            )
            assertTrue(
                BootstrapConfig.importUntrustedLegacyBaseConfig(config, legacy) { "f".repeat(64) },
            )
            assertTrue(config.readText().contains("provider = \"echo\""))
            BootstrapConfig.writePrivateConfigSecuritySchema(marker)
            assertTrue(BootstrapConfig.hasCurrentPrivateConfigSecuritySchema(marker))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun usbBridgePortTracksThePrivateLocalOverlay() {
        val directory = Files.createTempDirectory("penumbra-private-config").toFile()
        try {
            val config = directory.resolve("config.toml")
            config.writeText(
                """
                    [server]
                    admin_token = "${"a".repeat(64)}"
                    http_bind_addr = "127.0.0.1:9191"
                    grpc_bind_addr = "127.0.0.1:9192"
                    lan_dashboard_enabled = false
                    display_name = "Test Pin"
                """.trimIndent() + "\n",
            )
            directory.resolve("config.local.toml").writeText(
                """
                    [server]
                    http_bind_addr = "127.0.0.1:9292"
                    grpc_bind_addr = "127.0.0.1:9293"
                    lan_dashboard_enabled = true
                """.trimIndent() + "\n",
            )

            assertEquals(9292, BootstrapConfig.readEffectiveHttpPort(config.absolutePath))
            assertEquals(9293, BootstrapConfig.readEffectiveGrpcPort(config.absolutePath))
            assertTrue(BootstrapConfig.readEffectiveLanDashboardEnabled(config.absolutePath))
            val advertised = BootstrapConfig.readAdvertisedConfig(config.absolutePath)
            assertEquals(9292, advertised.httpPort)
            assertEquals("Test Pin", advertised.displayName)
            assertTrue(advertised.lanDashboardEnabled)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun legacyBaseAndOverlayAreReplacedBeforeExternalSecretsAreRemoved() {
        val root = Files.createTempDirectory("penumbra-legacy-migration").toFile()
        val external = root.resolve("external").apply { mkdirs() }
        val private = root.resolve("private").apply { mkdirs() }
        val attackerToken = "x".repeat(64)
        val freshToken = "f".repeat(64)
        val legacyBase = external.resolve("config.toml").apply {
            writeText(
                """
                    [server]
                    admin_token = "$attackerToken"
                    http_bind_addr = "0.0.0.0:8080"
                    [llm]
                    provider = "openai-compatible"
                    base_url = "https://attacker.example"
                    api_key = "${"c".repeat(64)}"
                """.trimIndent() + "\n",
            )
        }
        val legacyLocal = external.resolve("config.local.toml").apply {
            writeText(
                """
                    [server]
                    admin_token = "$attackerToken"
                    [llm]
                    model = "local-model"
                """.trimIndent() + "\n",
            )
        }
        val legacyBackup = external.resolve("config.toml.bak").apply {
            writeText("admin_token = \"$attackerToken\"\n")
        }
        val legacyLocalBackup = external.resolve("config.local.toml.bak").apply {
            writeText("api_key = \"external-secret\"\n")
        }
        val privateBase = private.resolve("config.toml")
        val privateLocal = private.resolve("config.local.toml")

        try {
            assertTrue(
                BootstrapConfig.importUntrustedLegacyBaseConfig(
                    privateBase,
                    legacyBase,
                ) { freshToken },
            )
            assertEquals(freshToken, ConfigSecurity.readAdminToken(privateBase.readText()))
            assertEquals(
                "127.0.0.1:8080",
                ConfigSecurity.readOptionalString(privateBase.readText(), "server.http_bind_addr"),
            )
            assertFalse(privateBase.readText().contains(attackerToken))
            assertFalse(privateBase.readText().contains("attacker.example"))
            assertFalse(privateBase.readText().contains("openai-compatible"))
            assertTrue(privateBase.readText().contains("provider = \"echo\""))
            assertFalse(privateLocal.exists())

            BootstrapConfig.removeLegacyConfigArtifacts(legacyBase, legacyLocal)
            for (externalArtifact in listOf(
                legacyBase,
                legacyLocal,
                legacyBackup,
                legacyLocalBackup,
            )) {
                if (externalArtifact.exists()) {
                    val tombstone = externalArtifact.readText()
                    assertFalse(tombstone.contains(attackerToken))
                    assertFalse(tombstone.contains("external-secret"))
                }
            }
        } finally {
            root.deleteRecursively()
        }
    }

}
