package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneDockPolicyTest {
    private val profile = StandaloneDockProfile.parse(
        """
        {
          "schema_version": 2,
          "profile_id": "humane-aipin-45.20-nov4",
          "fingerprint": "expected/fingerprint",
          "kernel_release": "4.14.190-perf",
          "kernel_build_marker": "#1 SMP PREEMPT Mon Nov 4 18:37:23 PST 2024",
          "kernel_machine": "aarch64",
          "accepted_slots": ["_b"],
          "accepted_abis": ["arm64-v8a"],
          "symbols_sha256": "${"a".repeat(64)}",
          "allocator_geometry": {
            "object_size": 880,
            "slab_size": 896,
            "order": 3,
            "objects_per_slab": 36,
            "cpu_partial": 13
          }
        }
        """.trimIndent(),
    )

    /*
     * The exploit must fail before execution for every identity, privilege,
     * power, and packaged-payload mismatch. The runner never weakens one
     * failed dimension because another one happens to match.
     */
    @Test
    fun `the exact clean powered shell boundary passes preflight`() {
        assertTrue(
            StandaloneDockPreflight.failures(
                exactSnapshot(),
                profile,
                observedPayloadSha256 = "b".repeat(64),
                expectedPayloadSha256 = "b".repeat(64),
            ).isEmpty(),
        )
    }

    @Test
    fun `identity privilege power and payload drift all fail closed`() {
        val failures = StandaloneDockPreflight.failures(
            exactSnapshot().copy(
                fingerprint = "nearby/fingerprint",
                slot = "_a",
                uid = "0",
                context = "u:r:kernel:s0",
                selinux = "Permissive",
                batteryLevel = 19,
                powered = false,
            ),
            profile,
            observedPayloadSha256 = "c".repeat(64),
            expectedPayloadSha256 = "b".repeat(64),
        )

        assertEquals(
            setOf("fingerprint", "slot", "uid", "context", "selinux", "battery", "power", "payload"),
            failures.toSet(),
        )
    }

    @Test
    fun `exploit environment is derived only from the pinned profile and KASLR result`() {
        val environment = StandaloneDockExploit.environment(
            profile,
            runtimeTextBase = 0xffffff9f85880000UL,
            payloadPath = "/data/app/luma/lib/arm64/libghostlock_aipin.so",
        )

        assertEquals("880", environment["AI_PIN_MM_OBJECT_SIZE"])
        assertEquals("896", environment["AI_PIN_MM_SLAB_SIZE"])
        assertEquals("3", environment["AI_PIN_MM_ORDER"])
        assertEquals("36", environment["AI_PIN_MM_OBJS_PER_SLAB"])
        assertEquals("13", environment["AI_PIN_MM_CPU_PARTIAL"])
        assertEquals("1", environment["AI_PIN_PERF_RECLAIM_GATE"])
        assertEquals("2", environment["AI_PIN_SLIDE_LEAK"])
        assertEquals("0xffffff9f85880000", environment["AI_PIN_KASLR_BASE"])
        assertEquals("bugreport-v1", environment["AI_PIN_KASLR_PROOF"])
        assertEquals("1", environment["AI_PIN_INSTALL_SU"])
        assertEquals(
            "/data/app/luma/lib/arm64/libghostlock_aipin.so",
            environment["LD_PRELOAD"],
        )
    }

    @Test
    fun `detached runner puts the app process command directory before runtime options`() {
        assertEquals(
            listOf(
                "/system/bin/app_process64",
                "/system/bin",
                "--nice-name=luma-standalone-dock",
                "com.penumbraos.hook.StandaloneDockMain",
                "/data/app/com.penumbraos.hook-injected/base.apk",
                "/data/app/com.penumbraos.hook-injected/lib/arm64/libghostlock_aipin.so",
            ),
            standaloneDockLaunchCommand(
                apkPath = "/data/app/com.penumbraos.hook-injected/base.apk",
                payloadPath = "/data/app/com.penumbraos.hook-injected/lib/arm64/libghostlock_aipin.so",
            ),
        )
    }

    private fun exactSnapshot() = StandaloneDockDeviceSnapshot(
        fingerprint = "expected/fingerprint",
        kernelRelease = "4.14.190-perf",
        kernelVersion = "#1 SMP PREEMPT Mon Nov 4 18:37:23 PST 2024",
        kernelMachine = "aarch64",
        slot = "_b",
        abi = "arm64-v8a",
        uid = "2000",
        context = "u:r:shell:s0",
        selinux = "Enforcing",
        batteryLevel = 64,
        powered = true,
    )
}
