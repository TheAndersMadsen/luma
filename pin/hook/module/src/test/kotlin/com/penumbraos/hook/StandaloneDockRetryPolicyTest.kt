package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneDockRetryPolicyTest {
    @Test
    fun `transient read-only failures are retryable`() {
        for (code in listOf(
                "battery_read",
                "bugreport_capture",
                "bugreport_result",
                "bugreport_path",
                "command",
                "kaslr",
                "crash_latch_arm",
                "work_directory",
            )
        ) {
            assertTrue("expected $code to be retryable", StandaloneDockRetryPolicy.retryableFailure(code))
        }
    }

    @Test
    fun `power and battery preflight refusals are retryable`() {
        assertTrue(StandaloneDockRetryPolicy.retryableFailure("preflight_battery"))
        assertTrue(StandaloneDockRetryPolicy.retryableFailure("preflight_power"))
        assertTrue(StandaloneDockRetryPolicy.retryableFailure("preflight_battery_power"))
        assertTrue(StandaloneDockRetryPolicy.retryableFailure("preflight_power_battery"))
    }

    @Test
    fun `a preflight refusal with a deterministic part settles the boot`() {
        assertFalse(StandaloneDockRetryPolicy.retryableFailure("preflight_fingerprint"))
        assertFalse(StandaloneDockRetryPolicy.retryableFailure("preflight_battery_fingerprint"))
        assertFalse(StandaloneDockRetryPolicy.retryableFailure("preflight_fingerprint_battery_power"))
    }

    @Test
    fun `a cleanly lost race is retryable`() {
        for (code in listOf(
                "exploit_exit",
                "exploit_proof",
                "selinux_result",
                "root_verification",
            )
        ) {
            assertTrue("expected $code to be retryable", StandaloneDockRetryPolicy.retryableFailure(code))
        }
    }

    @Test
    fun `deterministic mismatches settle the boot`() {
        for (code in listOf(
                "arguments",
                "artifacts",
                "asset",
                "profile",
                "symbols",
                "preflight_kernel_release",
                "preflight_kernel_build",
                "preflight_kernel_machine",
                "preflight_slot",
                "preflight_abi",
                "preflight_uid",
                "preflight_context",
                "preflight_selinux",
                "preflight_payload",
            )
        ) {
            assertFalse("expected $code to settle the boot", StandaloneDockRetryPolicy.retryableFailure(code))
        }
    }

    @Test
    fun `dangerous and lifecycle failures never retry`() {
        for (code in listOf(
                "",
                "exploit_timeout",
                "boot_changed",
                "boot_id",
                "boot_epoch",
                "uptime",
                "serial",
                "disabled",
                "attempt_in_progress",
                "previous_attempt_rebooted",
                "crash_latch_invalid",
                "crash_latch_clear",
                "crash_guard_disable",
                "boot_already_settled",
                "a_code_this_policy_has_never_seen",
            )
        ) {
            assertFalse("expected $code to never retry", StandaloneDockRetryPolicy.retryableFailure(code))
        }
    }

    @Test
    fun `the budget and cooldown match the guarded two-execution design`() {
        assertEquals(2, StandaloneDockRetryPolicy.MAX_EXECUTIONS_PER_BOOT)
        assertEquals(900L, StandaloneDockRetryPolicy.RETRY_COOLDOWN_SECONDS)
    }
}
