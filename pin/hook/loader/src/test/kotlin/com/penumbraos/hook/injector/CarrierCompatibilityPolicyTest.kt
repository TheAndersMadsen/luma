package com.penumbraos.hook.injector

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CarrierCompatibilityPolicyTest {
    @Test
    fun `replacement carrier preset matches the supplied override`() {
        assertTrue(
            CarrierCompatibilityPolicy.requiredOverrides == linkedMapOf(
                "carrier_volte_available_bool" to true,
                "carrier_volte_provisioned_bool" to true,
                "carrier_volte_provisioning_required_bool" to false,
                "carrier_vt_available_bool" to true,
                "hide_carrier_network_settings_bool" to false,
            )
        )
    }

    @Test
    fun `matching effective carrier config is not rewritten`() {
        assertFalse(
            CarrierCompatibilityPolicy.needsRepair(
                CarrierCompatibilityPolicy.requiredOverrides,
            )
        )
    }

    @Test
    fun `missing or different effective carrier values are repaired`() {
        assertTrue(CarrierCompatibilityPolicy.needsRepair(emptyMap()))
        assertTrue(
            CarrierCompatibilityPolicy.needsRepair(
                CarrierCompatibilityPolicy.requiredOverrides +
                    ("carrier_volte_available_bool" to false),
            )
        )
    }
}
