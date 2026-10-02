package com.penumbraos.hook.injector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneDockTargetPolicyTest {
    @Test
    fun `shell is a conditional target only when the standalone dock gate is enabled`() {
        val configured = listOf("hu.ma.ne.ironman", "humane.experience.systemnavigation")

        assertEquals(configured, compatibilityTargets(configured, standaloneDockEnabled = false))
        assertEquals(
            configured + STANDALONE_DOCK_SHELL_PACKAGE,
            compatibilityTargets(configured, standaloneDockEnabled = true),
        )
        assertEquals(
            configured + STANDALONE_DOCK_SHELL_PACKAGE,
            compatibilityTargets(
                configured + STANDALONE_DOCK_SHELL_PACKAGE,
                standaloneDockEnabled = true,
            ),
        )
    }

    @Test
    fun `shell is never force stopped after its boot receiver starts the runner`() {
        assertFalse(shouldRestartCompatibilityTarget(STANDALONE_DOCK_SHELL_PACKAGE, true))
        assertFalse(shouldRestartCompatibilityTarget(STANDALONE_DOCK_SHELL_PACKAGE, false))
        assertTrue(shouldRestartCompatibilityTarget("hu.ma.ne.ironman", true))
        assertFalse(shouldRestartCompatibilityTarget("hu.ma.ne.ironman", false))
    }

    @Test
    fun `shell is explicitly woken during locked boot only`() {
        assertTrue(
            shouldWakeStandaloneDockShell(
                STANDALONE_DOCK_SHELL_PACKAGE,
                "android.intent.action.LOCKED_BOOT_COMPLETED",
            ),
        )
        assertFalse(
            shouldWakeStandaloneDockShell(
                STANDALONE_DOCK_SHELL_PACKAGE,
                "android.intent.action.BOOT_COMPLETED",
            ),
        )
        assertFalse(
            shouldWakeStandaloneDockShell(
                "hu.ma.ne.ironman",
                "android.intent.action.LOCKED_BOOT_COMPLETED",
            ),
        )
    }
}
