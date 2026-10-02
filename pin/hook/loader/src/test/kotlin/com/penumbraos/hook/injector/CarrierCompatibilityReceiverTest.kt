package com.penumbraos.hook.injector

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class CarrierCompatibilityReceiverTest {
    @Test
    fun `proven boot path repairs carrier before the compatibility kill switch`() {
        val source = File(
            "src/main/kotlin/com/penumbraos/hook/injector/BootCompatibilityReceiver.kt"
        ).readText()
        val bootHandler = source
            .substringAfter("private fun handleBoot(context: Context, action: String)")
            .substringBefore("internal fun applyConfiguredTargets(")

        val carrierRepair = bootHandler.indexOf("repairCarrierCompatibility(context)")
        val compatibilityKillSwitch = bootHandler.indexOf("if (isDisabled())")
        assertTrue("carrier repair missing from proven boot path", carrierRepair >= 0)
        assertTrue(
            "carrier repair must not depend on the compatibility kill switch",
            carrierRepair < compatibilityKillSwitch,
        )
    }

    @Test
    fun `carrier compatibility reruns at boot and on carrier changes`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val start = manifest.indexOf("android:name=\".CarrierCompatibilityReceiver\"")
        val end = manifest.indexOf("</receiver>", start)
        assertTrue("carrier receiver missing", start >= 0)
        assertTrue("carrier receiver closing tag missing", end > start)

        val receiver = manifest.substring(start, end)
        listOf(
            "android.intent.action.LOCKED_BOOT_COMPLETED",
            "android.intent.action.BOOT_COMPLETED",
            "android.telephony.action.CARRIER_CONFIG_CHANGED",
            "android.intent.action.SIM_STATE_CHANGED",
        ).forEach { action -> assertTrue("missing $action", receiver.contains(action)) }
        assertTrue(receiver.contains("android:directBootAware=\"true\""))
        assertTrue(receiver.contains("android:exported=\"true\""))
        assertTrue(receiver.contains("android:process=\"system\""))
        assertTrue(
            receiver.contains(
                "android:permission=\"android.permission.MODIFY_PHONE_STATE\""
            )
        )
        assertTrue(
            "loader must gate senders without requesting a privileged permission",
            !manifest.contains(
                "<uses-permission android:name=\"android.permission.MODIFY_PHONE_STATE\""
            ),
        )
    }

    @Test
    fun `receiver owns asynchronous work through completion`() {
        val source = File(
            "src/main/kotlin/com/penumbraos/hook/injector/CarrierCompatibilityReceiver.kt"
        ).readText()
        assertTrue(source.contains("goAsync()"))
        assertTrue(source.contains("CarrierCompatibility.repair(context)"))
        assertTrue(source.contains("pendingResult.finish()"))
    }

    @Test
    fun `repair uses the supplied persistent binder override route`() {
        val source = File(
            "src/main/kotlin/com/penumbraos/hook/injector/CarrierCompatibility.kt"
        ).readText()
        assertTrue(source.contains("getDefaultSubId"))
        assertTrue(source.contains("overrideConfig"))
        assertTrue(source.contains("notifyConfigChangedForSubId"))
        assertTrue(source.contains("persistent = true"))
        assertTrue(!source.contains("com.android.shell"))
    }
}
