package com.penumbraos.hook.injector

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneDockCpuBrokerPolicyTest {
    @Test
    fun `only the shell uid can request its own fixed promotion`() {
        assertTrue(StandaloneDockCpuBrokerPolicy.mayPromote(callingUid = 2000, callingPid = 321))
        assertFalse(StandaloneDockCpuBrokerPolicy.mayPromote(callingUid = 1000, callingPid = 321))
        assertFalse(StandaloneDockCpuBrokerPolicy.mayPromote(callingUid = 2000, callingPid = 0))
    }

    @Test
    fun `cpu seven must be present in the kernel allowed list`() {
        assertTrue(StandaloneDockCpuBrokerPolicy.allowsRequiredCpu("0-7", requiredCpu = 7))
        assertTrue(StandaloneDockCpuBrokerPolicy.allowsRequiredCpu("0-3,6-7", requiredCpu = 7))
        assertFalse(StandaloneDockCpuBrokerPolicy.allowsRequiredCpu("0-6", requiredCpu = 7))
        assertFalse(StandaloneDockCpuBrokerPolicy.allowsRequiredCpu("", requiredCpu = 7))
        assertFalse(StandaloneDockCpuBrokerPolicy.allowsRequiredCpu("0-6,broken", requiredCpu = 7))
    }
}
