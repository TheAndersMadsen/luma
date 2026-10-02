package com.penumbraos.server

import java.io.File
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decision core of the USB-debugging approval repair.
 *
 * The stock confirmation act itself (`IAdbManager.allowDebugging` on the "adb"
 * binder, the same call AOSP 12's `com.android.systemui.usb.UsbDebuggingActivity`
 * makes from its Allow button) needs a live framework and is exercised on the
 * Pin. What must hold everywhere is the gate and the shape: without the Cosmos
 * remote flag nothing is confirmed, and only a genuine ADB public-key line is
 * ever handed to the framework.
 */
class AdbAuthorizationTest {
    private fun adbKeyLine(bytes: Int = 524, comment: String = "operator@luma"): String {
        val blob = ByteArray(bytes) { index -> ((index * 31 + 7) and 0xFF).toByte() }
        val encoded = Base64.getEncoder().encodeToString(blob)
        return "$encoded $comment"
    }

    @Test
    fun acceptsARealShapedAdbPublicKeyLine() {
        val line = adbKeyLine()
        assertEquals(line, validAdbPublicKeyLine(line))
        assertEquals(line, validAdbPublicKeyLine("$line\n"))
    }

    @Test
    fun acceptsAKeyLineWithoutAComment() {
        val encoded = adbKeyLine().substringBefore(' ')
        assertEquals(encoded, validAdbPublicKeyLine(encoded))
    }

    @Test
    fun refusesLinesThatAreNotOneAdbPublicKey() {
        assertNull(validAdbPublicKeyLine(""))
        assertNull(validAdbPublicKeyLine("   "))
        assertNull(validAdbPublicKeyLine("not base64! owner@host"))
        assertNull(validAdbPublicKeyLine("AAAA owner@host extra"))
        assertNull(validAdbPublicKeyLine("${adbKeyLine()}\n${adbKeyLine()}"))
        assertNull(validAdbPublicKeyLine("AAAA\u0000 owner@host"))
        assertNull(validAdbPublicKeyLine(adbKeyLine(comment = "two words")))
        // Standard base64 only: adbd fingerprints this exact string.
        assertNull(validAdbPublicKeyLine("-_-_- owner@host"))
        // A short blob is not an ADB RSA public key.
        assertNull(validAdbPublicKeyLine("${Base64.getEncoder().encodeToString(ByteArray(64))} user"))
        // An oversized blob is not, either.
        assertNull(
            validAdbPublicKeyLine(
                "${Base64.getEncoder().encodeToString(ByteArray(2048))} user",
            ),
        )
        // Anything longer than the bound is refused before decoding.
        assertNull(validAdbPublicKeyLine("A".repeat(MAX_ADB_PUBLIC_KEY_LINE_CHARS + 1)))
    }

    @Test
    fun refusesToConfirmWithoutTheRemoteGate() {
        val calls = mutableListOf<String>()
        val outcome = confirmAdbPublicKey(
            remoteGateEnabled = false,
            stagedKey = adbKeyLine(),
            authorizer = { key ->
                calls += key
                AdbAuthorizationOutcome(true, "allowed")
            },
        )
        assertFalse(outcome.ok)
        assertEquals("Cosmos activation is required", outcome.message)
        assertTrue("the framework must not be touched without the gate", calls.isEmpty())
    }

    @Test
    fun refusesToConfirmWithoutAStagedKey() {
        val outcome = confirmAdbPublicKey(
            remoteGateEnabled = true,
            stagedKey = null,
            authorizer = {
                AdbAuthorizationOutcome(true, "allowed")
            },
        )
        assertFalse(outcome.ok)
        assertEquals("No staged ADB public key", outcome.message)
    }

    @Test
    fun confirmsAStagedKeyThroughTheAuthorizer() {
        val key = adbKeyLine()
        val outcome = confirmAdbPublicKey(
            remoteGateEnabled = true,
            stagedKey = key,
            authorizer = AdbAuthorizerPort { staged ->
                assertEquals(key, staged)
                AdbAuthorizationOutcome(true, "allowed")
            },
        )
        assertTrue(outcome.ok)
    }

    @Test
    fun anAuthorizerFailureIsAReadableRefusalNotACrash() {
        val outcome = confirmAdbPublicKey(
            remoteGateEnabled = true,
            stagedKey = adbKeyLine(),
            authorizer = {
                throw SecurityException("MANAGE_DEBUGGING denied")
            },
        )
        assertFalse(outcome.ok)
        assertNotEquals("", outcome.message)
    }

    @Test
    fun theMaintenanceSurfaceNamesTheNewPathAndMethod() {
        assertEquals("adb-public-key", CosmosIdentityProvider.ADB_PUBLIC_KEY_PATH)
        assertEquals("ALLOW_ADB", CosmosIdentityProvider.METHOD_ALLOW_ADB)
    }

    @Test
    fun theProviderStagesAndConfirmsTheKeyWithoutEverLoggingIt() {
        val source = providerSource()
        val pipePath = source
            .substringAfter("private fun openAdbPublicKeyPipe(")
            .substringBefore("override fun call(")
        assertTrue(pipePath.contains("listOf(ADB_PUBLIC_KEY_PATH)") || pipePath.isEmpty() ||
            source.contains("listOf(ADB_PUBLIC_KEY_PATH) -> openAdbPublicKeyPipe()"))
        assertTrue(pipePath.contains("REMOTE_MODE_SETTING"))
        assertTrue(pipePath.contains("validAdbPublicKeyLine"))
        assertTrue(pipePath.contains("check(stagedAdbKey == null)"))

        val allowPath = source
            .substringAfter("private fun allowAdb(")
            .substringBefore("private fun identityStatus(")
        assertTrue("the staged key is one-shot", allowPath.contains("stagedAdbKey = null"))
        assertTrue(allowPath.contains("Binder.clearCallingIdentity()"))
        assertTrue(allowPath.contains("confirmAdbPublicKey"))
        // The key line itself is never a log argument anywhere in the provider.
        source.split("\n").forEach { line ->
            if (line.contains("Log.") || line.contains("println")) {
                assertFalse(line.trim(), line.contains("staged"))
            }
        }
    }

    private fun providerSource(): String =
        File("src/main/kotlin/com/penumbraos/server/CosmosIdentityProvider.kt").readText()
}
