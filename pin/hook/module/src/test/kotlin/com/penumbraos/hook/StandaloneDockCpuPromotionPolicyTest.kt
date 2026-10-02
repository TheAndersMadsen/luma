package com.penumbraos.hook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StandaloneDockCpuPromotionPolicyTest {
    @Test
    fun `the runner launches only after broker and local cpu evidence agree`() {
        assertTrue(StandaloneDockCpuPromotionPolicy.mayLaunch(brokerApproved = true, allowedCpuList = "0-7"))
        assertFalse(StandaloneDockCpuPromotionPolicy.mayLaunch(brokerApproved = false, allowedCpuList = "0-7"))
        assertFalse(StandaloneDockCpuPromotionPolicy.mayLaunch(brokerApproved = true, allowedCpuList = "0-6"))
    }
}
