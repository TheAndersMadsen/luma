package com.penumbraos.hook

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceLocalUploadPolicyTest {
    @Test
    fun `ordinary local capture keeps ordinary tag query and relaxes constraints`() {
        val policy = DeviceLocalUploadPolicy.schedulingPolicy(
            requestedForceUpload = false,
            configuredUploadOnWifiAndPower = true,
            uploadsToDeviceLocalServer = true,
        )

        assertFalse(policy.forceUpload)
        assertFalse(policy.uploadOnWifiAndPower)
    }

    @Test
    fun `explicit force flag remains enabled`() {
        val policy = DeviceLocalUploadPolicy.schedulingPolicy(
            requestedForceUpload = true,
            configuredUploadOnWifiAndPower = true,
            uploadsToDeviceLocalServer = true,
        )

        assertTrue(policy.forceUpload)
        assertFalse(policy.uploadOnWifiAndPower)
    }

    @Test
    fun `non local destination keeps configured stock policy`() {
        val policy = DeviceLocalUploadPolicy.schedulingPolicy(
            requestedForceUpload = false,
            configuredUploadOnWifiAndPower = true,
            uploadsToDeviceLocalServer = false,
        )

        assertFalse(policy.forceUpload)
        assertTrue(policy.uploadOnWifiAndPower)
    }
}
