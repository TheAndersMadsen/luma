package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards Penumbra's integration boundary for the installed firmware's mixed
 * CMU Ultra lifecycle: event-live Settings onboarding plus Ironman's
 * construction-latched Bluetooth notification producer.
 *
 * Audited artifacts are the installed `/system/priv-app/ironman/ironman.apk`
 * (SHA-256 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e)
 * and `/system/priv-app/humane_settings/humane_settings.apk`
 * (SHA-256 82adcaed56bab130d6a35cd2f54e15303807c4ac0da463d5747f0d391ce88661).
 */
class CmuUltraMasterParityContractTest {
    @Test
    fun `stock ancs producer lifecycle remains unmodified by production hooks`() {
        val hookSources = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

        listOf(
            "CMU_ULTRA_ENABLED_FLAG",
            "cmu_ultra_enabled",
            "BluetoothNotificationParser",
            "ANCSNotificationManager",
        ).forEach { stockContract ->
            assertFalse(
                "Production Hook must leave the stock ANCS lifecycle untouched: $stockContract",
                hookSources.any { it.readText().contains(stockContract) },
            )
        }
    }

    @Test
    fun `activation metadata distinguishes live onboarding from latched parser state`() {
        assertEquals(
            "cmu_ultra_enabled",
            TierASymbols.FeatureFlags.Cloud.CMU_ULTRA_ENABLED,
        )
        assertEquals(
            "cmu_ultra_chime_enabled",
            TierASymbols.FeatureFlags.Cloud.CMU_ULTRA_CHIME_ENABLED,
        )

        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val masterSpec = catalog
            .substringAfter("key: cloud_keys::CMU_ULTRA_ENABLED", "")
            .substringBefore("key: cloud_keys::CMU_ULTRA_CHIME_ENABLED", "")

        assertTrue(masterSpec.contains("ANCS notification parser"))
        assertTrue(masterSpec.contains("onboarding eligibility"))
        assertTrue(masterSpec.contains("Settings reads this live"))
        assertTrue(masterSpec.contains("bonded-device state check"))
        assertTrue(masterSpec.contains("static ANCS client"))
        assertTrue(masterSpec.contains("Restart Ironman after either change"))
        assertTrue(masterSpec.contains("disabling cannot tear down an existing client in-process"))
        assertTrue(masterSpec.contains("restart_recommended: true"))
        assertTrue(masterSpec.contains("local notification summaries do not depend on it"))
    }

    @Test
    fun `stock cache apply is acknowledged before the restart activation boundary`() {
        val ironman = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        val acknowledgement = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/FeatureFlagApplyAckHooks.kt",
        ).readText()

        assertTrue(ironman.contains("FeatureFlagApplyAckHooks.install(cl)"))
        assertTrue(acknowledgement.contains("\"setServerFlags\""))
        assertTrue(acknowledgement.contains("\"getFlagAssignment\""))
        assertTrue(acknowledgement.contains("exactReadBack"))
        assertTrue(acknowledgement.contains("applyLock.lock()"))
        assertFalse(acknowledgement.contains("updateServerFlag"))
    }

    @Test
    fun `local categorization and summaries stay independent of the master producer`() {
        val ironman = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()
        val channel = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/ChannelFactoryBypass.kt",
        ).readText()
        val composition = repoFile(
            "runtime/core/src/services/aibus/capabilities/composition.rs",
        ).readText()
        val server = repoFile("runtime/core/src/boot/mod.rs").readText()

        assertTrue(ironman.contains("ChannelFactoryBypass.install(cl)"))
        assertTrue(channel.contains("const val MOCK_SERVER_URI = \"127.0.0.1:9090\""))
        assertTrue(composition.contains("async fn categorize_notifications("))
        assertTrue(composition.contains(".map(deterministic_category)"))
        assertTrue(composition.contains(".unwrap_or(fallback)"))
        assertFalse(composition.contains("cmu_ultra"))
        assertTrue(server.contains("add_service(CompositionServiceServer::new("))
    }

    @Test
    fun `chime cannot be enabled without its bluetooth producer prerequisite`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()

        assertTrue(
            catalog.contains(
                "\"feature flag `{}` requires `{}=true`\"",
            ),
        )
        assertTrue(
            catalog.contains(
                "cloud_keys::CMU_ULTRA_CHIME_ENABLED,\n            cloud_keys::CMU_ULTRA_ENABLED,",
            ),
        )
    }

    private fun repoFile(relativePath: String): File {
        val candidates = listOf(
            File(relativePath),
            File("..", relativePath),
            File("../..", relativePath),
        )
        return candidates.firstOrNull { it.exists() }
            ?: throw AssertionError("Missing repository contract path: $relativePath")
    }
}
