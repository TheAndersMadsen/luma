package com.penumbraos.hook.injector

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerRuntimePolicyRepairTest {
    @Test
    fun `only the exact live system UID Server is eligible`() {
        assertTrue(
            ServerRuntimePolicyRepair.isEligible(
                ServerRuntimePolicyRepair.EligibilitySnapshot(
                    packageName = "com.penumbraos.server",
                    live = true,
                    sharedUserId = 1000,
                    appUid = 1000,
                )
            )
        )

        listOf(
            ServerRuntimePolicyRepair.EligibilitySnapshot(
                "com.penumbraos.server.helper", true, 1000, 1000
            ),
            ServerRuntimePolicyRepair.EligibilitySnapshot(
                "com.penumbraos.server", false, 1000, 1000
            ),
            ServerRuntimePolicyRepair.EligibilitySnapshot(
                "com.penumbraos.server", true, 1001, 1000
            ),
            ServerRuntimePolicyRepair.EligibilitySnapshot(
                "com.penumbraos.server", true, 1000, 1001
            ),
            ServerRuntimePolicyRepair.EligibilitySnapshot(
                "com.penumbraos.server", true, 1000, null
            ),
        ).forEach { snapshot ->
            assertFalse(ServerRuntimePolicyRepair.isEligible(snapshot))
        }
    }

    @Test
    fun `provisioning policy is fully pinned`() {
        assertTrue(ServerRuntimePolicyRepair.TARGET_PACKAGE == "com.penumbraos.server")
        assertTrue(ServerRuntimePolicyRepair.SYSTEM_APP_ID == 1000)
        assertTrue(ServerRuntimePolicyRepair.TARGET_USER_ID == 0)
        assertTrue(ServerRuntimePolicyRepair.TARGET_SEINFO == "platform")
        assertTrue(ServerRuntimePolicyRepair.PROVISION_SEINFO == "platform:complete")
        assertTrue(ServerRuntimePolicyRepair.DEVICE_ENCRYPTED_FLAG == 0x1)
        assertTrue(ServerRuntimePolicyRepair.CREDENTIAL_ENCRYPTED_FLAG == 0x2)
        assertTrue(
            ServerRuntimePolicyRepair.StoragePhase.DEVICE_ENCRYPTED.appDataFlags == 0x1
        )
        assertTrue(
            ServerRuntimePolicyRepair.StoragePhase.CREDENTIAL_ENCRYPTED.appDataFlags == 0x2
        )
    }

    @Test
    fun `boot repair executes before target compatibility application`() {
        val source = File(
            "src/main/kotlin/com/penumbraos/hook/injector/BootCompatibilityReceiver.kt"
        ).readText()
        val async = source.indexOf("goAsync()")
        val worker = source.indexOf("\"LumaBootCompatibility\"")
        val repair = source.indexOf("ServerRuntimePolicyRepair.repair(context, storagePhase)")
        val targets = source.indexOf("loadTargetPackages(context)")
        assertTrue("goAsync call missing", async >= 0)
        assertTrue("worker thread missing", worker > async)
        assertTrue("repair call missing", repair >= 0)
        assertTrue("repair must run on the async worker", repair > worker)
        assertTrue("target compatibility must follow server policy repair", targets > repair)
        assertTrue("PendingResult must always finish", source.contains("pendingResult.finish()"))
    }
}
