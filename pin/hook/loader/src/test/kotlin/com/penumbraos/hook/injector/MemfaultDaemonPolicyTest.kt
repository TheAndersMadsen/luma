package com.penumbraos.hook.injector

import com.penumbraos.stockaibus.contract.TierASymbols
import org.junit.Assert.assertEquals
import org.junit.Test

class MemfaultDaemonPolicyTest {
    @Test
    fun `the local structured logger runs when every Memfault uploader is off`() {
        // Stock wlc-service asks for memfault_structured on every photo and
        // waits about five seconds, twice, when the logger is stopped.
        assertEquals(
            "1",
            memfaultDaemonGate(MEMFAULT_UPLOADER_PACKAGES.associateWith { UploaderState.DISABLED }),
        )
        assertEquals(
            "1",
            memfaultDaemonGate(MEMFAULT_UPLOADER_PACKAGES.associateWith { UploaderState.ABSENT }),
        )
    }

    @Test
    fun `the native daemons stay stopped beside any uploader that may run`() {
        for (uploader in MEMFAULT_UPLOADER_PACKAGES) {
            for (state in listOf(UploaderState.ENABLED, UploaderState.UNKNOWN)) {
                val states = MEMFAULT_UPLOADER_PACKAGES.associateWith { UploaderState.DISABLED } +
                    (uploader to state)
                assertEquals("$uploader $state", "0", memfaultDaemonGate(states))
            }
        }
        assertEquals("0", memfaultDaemonGate(emptyMap()))
    }

    @Test
    fun `the uploaders checked are the ones Luma's installer turns off`() {
        assertEquals(
            setOf(
                TierASymbols.Packages.BORT,
                TierASymbols.Packages.BORT_OTA,
                TierASymbols.Packages.MEMFAULT_USAGE_REPORTER,
                TierASymbols.Packages.METRIC_REPORTER,
            ),
            MEMFAULT_UPLOADER_PACKAGES.toSet(),
        )
    }
}
