package com.penumbraos.hook.injector

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerRuntimePolicyRepairReceiverTest {
    @Test
    fun `implicit package replacement is never claimed as a repair trigger`() {
        assertNull(
            ServerRuntimePolicyRepairTrigger.classify(
                "android.intent.action.PACKAGE_REPLACED",
                "com.penumbraos.server",
            )
        )
        assertNull(
            ServerRuntimePolicyRepairTrigger.classify(
                "android.intent.action.PACKAGE_REPLACED",
                null,
            )
        )
    }

    @Test
    fun `manual repair action accepts no caller supplied package`() {
        assertEquals(
            ServerRuntimePolicyRepairTrigger.Trigger.MANUAL_DUMP,
            ServerRuntimePolicyRepairTrigger.classify(
                "com.penumbraos.hook.REPAIR_SERVER_RUNTIME_POLICY",
                null,
            ),
        )
        assertNull(
            ServerRuntimePolicyRepairTrigger.classify(
                "com.penumbraos.hook.REPAIR_SERVER_RUNTIME_POLICY",
                "com.penumbraos.server",
            )
        )
        assertNull(
            ServerRuntimePolicyRepairTrigger.classify("com.example.REPAIR", null)
        )
    }

    @Test
    fun `manifest keeps only the explicit DUMP protected repair action`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val receiverStart = manifest.indexOf(
            "android:name=\".ServerRuntimePolicyRepairReceiver\""
        )
        val receiverEnd = manifest.indexOf("</receiver>", receiverStart)
        assertTrue("repair receiver missing", receiverStart >= 0)
        assertTrue("repair receiver closing tag missing", receiverEnd > receiverStart)

        val receiver = manifest.substring(receiverStart, receiverEnd)
        assertTrue(receiver.contains("android:permission=\"android.permission.DUMP\""))
        assertTrue(receiver.contains("com.penumbraos.hook.REPAIR_SERVER_RUNTIME_POLICY"))
        assertTrue(!receiver.contains("android.intent.action.PACKAGE_REPLACED"))
        assertTrue(!receiver.contains("android:ssp="))
    }

    @Test
    fun `receiver repairs DE first and gates CE on unlocked state`() {
        val source = File(
            "src/main/kotlin/com/penumbraos/hook/injector/" +
                "ServerRuntimePolicyRepairReceiver.kt"
        ).readText()
        val deRepair = source.indexOf(
            "repairPhase(context, ServerRuntimePolicyRepair.StoragePhase.DEVICE_ENCRYPTED)"
        )
        val unlockedCheck = source.indexOf("isUserUnlocked == true")
        val ceRepair = source.indexOf(
            "repairPhase(context, ServerRuntimePolicyRepair.StoragePhase.CREDENTIAL_ENCRYPTED)"
        )
        assertTrue("DE repair missing", deRepair >= 0)
        assertTrue("unlock gate must follow DE repair", unlockedCheck > deRepair)
        assertTrue("CE repair must follow unlock gate", ceRepair > unlockedCheck)
        assertTrue("async broadcast result must always finish", source.contains("pendingResult.finish()"))
    }
}
