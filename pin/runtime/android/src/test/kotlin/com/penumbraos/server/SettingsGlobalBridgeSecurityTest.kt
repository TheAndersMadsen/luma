package com.penumbraos.server

import java.io.BufferedReader
import java.io.File
import java.io.StringReader
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsGlobalBridgeSecurityTest {
    private val installSecret = "0123456789abcdef".repeat(4)
    private val token = SettingsGlobalBridgeAuthentication.deriveToken(installSecret)

    @Test
    fun credentialIsStableDomainSeparatedAndStrictlyValidated() {
        assertEquals(
            "616a45fa4ec16a58ad1ca33afe9f6d050c06bb483e9b89298c324608ecfb18e8",
            token,
        )
        assertFalse(token == SpotifyBridgeAuthentication.deriveToken(installSecret))
        assertTrue(SettingsGlobalBridgeAuthentication.tokensMatch(token, token))
        assertFalse(SettingsGlobalBridgeAuthentication.tokensMatch(token, "0".repeat(64)))
        assertFalse(SettingsGlobalBridgeAuthentication.tokensMatch(token, "A".repeat(64)))
        assertEquals(
            "PENUMBRA_SETTINGS_GLOBAL_BRIDGE_TOKEN",
            SettingsGlobalBridgeAuthentication.TOKEN_ENVIRONMENT_VARIABLE,
        )
    }

    @Test
    fun exactAllowlistAndOperationsReachOnlyTheRequestedKey() {
        val store = FakeStore()

        val put = process(
            JSONObject()
                .put("version", 1)
                .put("token", token)
                .put("op", "put")
                .put("key", "humane_clock_enabled")
                .put("value", true),
            store,
        )
        assertTrue(put.getBoolean("ok"))
        assertEquals("1", store.values["humane_clock_enabled"])

        val get = process(request("get", "humane_clock_enabled"), store)
        assertTrue(get.getBoolean("ok"))
        assertEquals("1", get.getString("value"))

        val delete = process(request("delete", "humane_clock_enabled"), store)
        assertTrue(delete.getBoolean("ok"))
        assertNull(store.values["humane_clock_enabled"])
        assertEquals(
            setOf(
                "humane_photo_sharing_enabled",
                "humane_photography_jpg_enabled",
                "humane_food_enabled",
                "humane_clock_enabled",
                "humane_health_tracker_enabled",
                "humane_cmu_ultra_enabled",
            ),
            SettingsGlobalBridgeProtocol.STOCK_FEATURE_GATE_KEYS,
        )
        assertEquals(
            setOf(
                "penumbra_weather_celsius",
            ),
            SettingsGlobalBridgeProtocol.PRIVATE_PREFERENCE_KEYS,
        )
        assertEquals(
            setOf("luma_root_access_enabled"),
            SettingsGlobalBridgeProtocol.LUMA_FEATURE_GATE_KEYS,
        )
        assertEquals(
            SettingsGlobalBridgeProtocol.STOCK_FEATURE_GATE_KEYS +
                SettingsGlobalBridgeProtocol.PRIVATE_PREFERENCE_KEYS +
                SettingsGlobalBridgeProtocol.LUMA_FEATURE_GATE_KEYS,
            SettingsGlobalBridgeProtocol.ALLOWED_KEYS,
        )
        assertEquals(6, SettingsGlobalBridgeProtocol.STOCK_FEATURE_GATE_KEYS.size)
    }

    @Test
    fun tokenUnknownFieldsTypesAndNonAllowlistedKeysAreRejectedBeforeStoreAccess() {
        val store = FakeStore()
        val requests = listOf(
            request("put", "humane_clock_enabled").put("value", true).put("token", "0".repeat(64)),
            request("get", "not_allowlisted"),
            request("get", "humane_clock_enabled").put("extra", true),
            request("put", "humane_clock_enabled").put("value", 1),
            request("reboot", "humane_clock_enabled"),
        )

        requests.forEach { request ->
            assertFalse(process(request, store).getBoolean("ok"))
        }
        assertEquals(0, store.calls)
    }

    @Test
    fun successfulMutationResponseRequiresCanonicalReadBack() {
        val noOpPut = NoOpStore(null)
        val put = process(
            request("put", "humane_clock_enabled").put("value", true),
            noOpPut,
        )
        assertFalse(put.getBoolean("ok"))
        assertEquals("operation_failed", put.getString("error"))

        val noOpDelete = NoOpStore("1")
        val delete = process(request("delete", "humane_clock_enabled"), noOpDelete)
        assertFalse(delete.getBoolean("ok"))
        assertEquals("operation_failed", delete.getString("error"))
    }

    @Test
    fun requestReaderIsBounded() {
        val exact = "x".repeat(SettingsGlobalBridgeProtocol.MAX_REQUEST_LINE_CHARS)
        assertEquals(
            exact,
            SettingsGlobalBridgeProtocol.readBoundedLine(BufferedReader(StringReader("$exact\n"))),
        )
        assertFails {
            SettingsGlobalBridgeProtocol.readBoundedLine(
                BufferedReader(StringReader("${exact}x\n")),
            )
        }
    }

    @Test
    fun serviceLifecycleAndNativeEnvironmentAlwaysWireTheBridgeTogether() {
        val nativeBridge = sourceFile(
            "src/main/kotlin/com/penumbraos/server/NativeBridge.kt",
        ).readText()
        assertTrue(
            nativeBridge.contains(
                "processBuilder.environment()[SettingsGlobalBridgeAuthentication.TOKEN_ENVIRONMENT_VARIABLE]",
            ),
        )
        assertTrue(
            nativeBridge.contains(
                "SettingsGlobalBridgeAuthentication.deriveToken(validatedEsimBridgeToken)",
            ),
        )

        val service = sourceFile(
            "src/main/kotlin/com/penumbraos/server/ServerService.kt",
        ).readText()
        assertTrue(
            service.contains(
                "SettingsGlobalBridgeServer.start(applicationContext, esimBridgeToken)",
            ),
        )
        assertTrue(service.contains("SettingsGlobalBridgeServer.stop()"))
    }

    @Test
    fun acceptLoopIsBoundToTheExactListenerGeneration() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/server/SettingsGlobalBridgeServer.kt",
        ).readText()
        assertTrue(source.contains("running.get() && serverSocket === listener"))
        assertTrue(source.contains("!running.get() || serverSocket !== listener"))
    }

    @Test
    fun nativeRuntimeRequiresTheGenuineLoopbackListenerToOwnItsPort() {
        val bridge = sourceFile(
            "src/main/kotlin/com/penumbraos/server/SettingsGlobalBridgeServer.kt",
        ).readText()
        assertTrue(bridge.contains("fun start(context: Context, installSecret: String): Boolean"))
        assertTrue(bridge.contains("fun isReady(): Boolean"))
        assertTrue(bridge.contains("socket.isBound && !socket.isClosed"))

        val service = sourceFile(
            "src/main/kotlin/com/penumbraos/server/ServerService.kt",
        ).readText()
        val readinessGuard = service.indexOf(
            "check(settingsGlobalBridgeReady && SettingsGlobalBridgeServer.isReady())",
        )
        val nativeStart = service.indexOf("ServerRuntime.start(applicationContext")
        assertTrue(readinessGuard >= 0)
        assertTrue(nativeStart > readinessGuard)
    }

    private fun request(operation: String, key: String): JSONObject = JSONObject()
        .put("version", 1)
        .put("token", token)
        .put("op", operation)
        .put("key", key)

    private fun process(request: JSONObject, store: SettingsGlobalStore): JSONObject =
        SettingsGlobalBridgeProtocol.process(request.toString(), token, store)

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected failure")
        } catch (_: IllegalArgumentException) {
        }
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("runtime/android", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }

    private class FakeStore : SettingsGlobalStore {
        val values = mutableMapOf<String, String?>()
        var calls = 0

        override fun get(key: String): String? {
            calls++
            return values[key]
        }

        override fun put(key: String, value: Boolean): Boolean {
            calls++
            values[key] = if (value) "1" else "0"
            return true
        }

        override fun delete(key: String) {
            calls++
            values.remove(key)
        }
    }

    private class NoOpStore(private val current: String?) : SettingsGlobalStore {
        override fun get(key: String): String? = current

        override fun put(key: String, value: Boolean): Boolean = true

        override fun delete(key: String) = Unit
    }

}
