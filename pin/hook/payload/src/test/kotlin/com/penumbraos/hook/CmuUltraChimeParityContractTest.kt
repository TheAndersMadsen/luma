package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards Penumbra's dependencies for the stock CMU Ultra chime without
 * replacing NotificationManager's installed-firmware decision or alert path.
 */
class CmuUltraChimeParityContractTest {
    @Test
    fun `stock live chime decision remains unmodified by production hooks`() {
        val hookSources = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

        listOf(
            "CMU_ULTA_CHIME_ENABLED_FLAG",
            "cmu_ultra_chime_enabled",
            "chimeRelevantUltraNotifications",
        ).forEach { stockContract ->
            assertFalse(
                "Production Hook must leave stock CMU chime behavior untouched: $stockContract",
                hookSources.any { it.readText().contains(stockContract) },
            )
        }
    }

    @Test
    fun `live flag delivery is acknowledged through the stock binder cache`() {
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
        assertFalse(acknowledgement.contains("updateServerFlag"))
    }

    @Test
    fun `notification categorization route is registered and fails over safely`() {
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
        assertTrue(composition.contains("parse_category_output(&text, request.notifications.len())"))
        assertTrue(composition.contains(".unwrap_or(fallback)"))
        assertTrue(composition.contains("debug_assert_eq!(categories.len(), request.notifications.len())"))
        assertTrue(composition.contains("Category::TimeSensitive as i32"))
        assertTrue(server.contains("add_service(CompositionServiceServer::new("))
    }

    @Test
    fun `messages compatibility cannot rewrite the ironman chime alert`() {
        val inbound = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/InboundFilteringHooks.kt",
        ).readText()
        val messageHook = inbound
            .substringAfter("private fun hookMessageNotifications")
            .substringBefore("private fun isMessagesExperience")
        val messageProbe = inbound
            .substringAfter("private fun isMessagesExperience")
            .substringBefore("private fun hookNotificationAccess")

        assertTrue(messageHook.contains("if (!isMessagesExperience(cl))"))
        assertTrue(messageHook.contains("return"))
        assertTrue(messageProbe.contains("humane.experience.messages.BuildConfig"))
        assertFalse(messageHook.contains("NotificationManager"))
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
