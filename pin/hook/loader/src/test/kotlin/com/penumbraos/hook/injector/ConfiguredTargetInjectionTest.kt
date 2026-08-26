package com.penumbraos.hook.injector

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfiguredTargetInjectionTest {
    @Test
    fun `configured target action delegates to the generated target list`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val receiver = File(
            "src/main/kotlin/com/penumbraos/hook/injector/InjectReceiver.kt",
        ).readText()

        assertTrue(
            manifest.contains("com.penumbraos.hook.INJECT_CONFIGURED_TARGETS")
        )
        assertTrue(
            receiver.contains("BootInjectionReceiver().injectConfiguredTargets(")
        )
        assertTrue(receiver.contains("pendingResult.finish()"))
        val configuredTargets = receiver
            .substringAfter("private fun injectConfiguredTargets")
            .substringBefore("private fun isBootCompleted")
        assertTrue(!configuredTargets.contains("hu.ma.ne.ironman"))
        assertTrue(!configuredTargets.contains("hu.ma.ne.krypto"))
    }

    @Test
    fun `early package manager failure does not latch initialization forever`() {
        val injector = File(
            "src/main/kotlin/com/penumbraos/hook/injector/PackageInjector.kt",
        ).readText()

        assertTrue(injector.contains("if (isInitialized) return"))
        assertFalse(injector.contains("initAttempted"))
    }
}
