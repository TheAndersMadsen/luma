package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectivityCheckBypassTest {
    @Test
    fun cloneModeStillUsesAndroidsValidatedNetworkVerdict() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/ConnectivityCheckBypass.kt",
        ).readText()
        val remoteModeDelegation = Regex(
            """if\s*\(\s*CarryRemoteTransport\.isEnabled\(\)\s*\)\s*""" +
                """return@hookMethod(?:Before|After)""",
        )

        assertFalse(
            "clone mode must not fall back to Humane's dead HTTP connectivity probe",
            remoteModeDelegation.containsMatchIn(source),
        )
        assertTrue(source.contains("NetworkCapabilities.NET_CAPABILITY_VALIDATED"))
        assertTrue(source.contains("NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL"))
        assertTrue(source.contains("hookValidateNetworkConnection(networkUtilsClass"))
        assertTrue(source.contains("hookNetworkMonitor(cl, connectedEnumValue)"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull(File::isFile)
            ?: throw AssertionError("Missing connectivity source contract: $relativePath")
    }
}
