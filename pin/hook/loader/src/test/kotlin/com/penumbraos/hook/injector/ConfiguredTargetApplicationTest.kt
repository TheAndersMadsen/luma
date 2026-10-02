package com.penumbraos.hook.injector

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfiguredTargetApplicationTest {
    @Test
    fun `configured target action delegates to the generated target list`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val receiver = File(
            "src/main/kotlin/com/penumbraos/hook/injector/CompatibilityRefreshReceiver.kt",
        ).readText()

        assertTrue(
            manifest.contains("com.penumbraos.hook.INJECT_CONFIGURED_TARGETS")
        )
        assertTrue(
            receiver.contains("BootCompatibilityReceiver().applyConfiguredTargets(")
        )
        val refreshReceiver = manifest
            .substringAfter("android:name=\".CompatibilityRefreshReceiver\"")
            .substringBefore("</receiver>")
        assertTrue(refreshReceiver.split("<action").size == 2)
        assertTrue(receiver.contains("pendingResult.finish()"))
        val configuredTargets = receiver
            .substringAfter("private fun refreshConfiguredTargets")
            .substringBefore("private fun isBootCompleted")
        assertTrue(!configuredTargets.contains("hu.ma.ne.ironman"))
        assertTrue(!configuredTargets.contains("hu.ma.ne.krypto"))
    }

    @Test
    fun `early package manager failure does not latch initialization forever`() {
        val applier = File(
            "src/main/kotlin/com/penumbraos/hook/injector/RuntimeCompatibilityApplier.kt",
        ).readText()

        assertTrue(applier.contains("if (isInitialized) return"))
        assertFalse(applier.contains("initAttempted"))
    }

    @Test
    fun `an explicit refresh restarts a target already configured this boot`() {
        val receiver = File(
            "src/main/kotlin/com/penumbraos/hook/injector/BootCompatibilityReceiver.kt",
        ).readText()
        assertEquals(
            ConfiguredTargetPlan(applyCompatibility = false, restart = true),
            configuredTargetPlan(alreadyConfigured = true, forceRestart = true),
        )
        assertEquals(
            ConfiguredTargetPlan(applyCompatibility = true, restart = false),
            configuredTargetPlan(alreadyConfigured = false, forceRestart = false),
        )
        assertTrue(receiver.contains("if (plan.restart)"))
        assertTrue(receiver.contains("forceStopAndRelaunch(context, packageName)"))
    }
}
