package com.penumbraos.server

import android.os.IBinder
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element

class SpotifyBridgeSecurityTest {
    @Test
    fun controlTokenDerivationIsStableAndDomainSeparated() {
        val installSecret = "0123456789abcdef".repeat(4)

        assertEquals(
            "3c580d1e9040ce669db614591f4d263b97db5c14c9c63b19d45bd15d7e0ab7e2",
            SpotifyBridgeAuthentication.deriveToken(installSecret),
        )
        assertFails { SpotifyBridgeAuthentication.deriveToken("not-an-install-secret") }
        assertFails {
            SpotifyBridgeAuthentication.requireValidDerivedToken("A".repeat(64))
        }
    }

    @Test
    fun binderContractAndHttpCredentialNamesArePinned() {
        assertEquals("com.penumbraos.server.spotify.bridge.v1", SpotifyBridgeProtocol.DESCRIPTOR)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION, SpotifyBridgeProtocol.TRANSACTION_QUERY)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION + 1, SpotifyBridgeProtocol.TRANSACTION_PLAYBACK)
        assertEquals(IBinder.FIRST_CALL_TRANSACTION + 2, SpotifyBridgeProtocol.TRANSACTION_SAVE)
        assertEquals(
            "X-Penumbra-Spotify-Bridge-Token",
            SpotifyBridgeAuthentication.TOKEN_HEADER,
        )
        assertEquals(
            "PENUMBRA_SPOTIFY_BRIDGE_TOKEN",
            SpotifyBridgeAuthentication.TOKEN_ENVIRONMENT_VARIABLE,
        )
    }

    @Test
    fun binderRejectsMissingAndOversizedBodiesBeforeJsonParsing() {
        assertFails { SpotifyBridgeProtocol.requireValidRequestBody(null) }
        assertFails {
            SpotifyBridgeProtocol.requireValidRequestBody(
                "{\"value\":\"${"x".repeat(SpotifyBridgeProtocol.MAX_REQUEST_BYTES)}\"}",
            )
        }
    }

    @Test
    fun loopbackEndpointUsesValidatedEffectivePort() {
        assertEquals(
            "http://127.0.0.1:4242/internal/spotify/",
            SpotifyBridgeRuntime.loopbackBaseUrl(4242),
        )
        assertEquals(
            "http://127.0.0.1:65535/internal/spotify/",
            SpotifyBridgeRuntime.loopbackBaseUrl(65535),
        )
        assertFails { SpotifyBridgeRuntime.loopbackBaseUrl(0) }
        assertFails { SpotifyBridgeRuntime.loopbackBaseUrl(65536) }
    }

    @Test
    fun manifestPermitsCleartextOnlyForExactIpv4Loopback() {
        val manifest = parseXml(sourceFile("src/main/AndroidManifest.xml"))
        val application = manifest.getElementsByTagName("application").item(0) as Element
        assertEquals(
            "@xml/network_security_config",
            application.getAttributeNS(ANDROID_NAMESPACE, "networkSecurityConfig"),
        )
        assertEquals(
            "false",
            application.getAttributeNS(ANDROID_NAMESPACE, "usesCleartextTraffic"),
        )

        val networkConfig = parseXml(
            sourceFile("src/main/res/xml/network_security_config.xml"),
        )
        val root = networkConfig.documentElement
        assertEquals("network-security-config", root.tagName)
        val rootChildren = directChildren(root)
        assertEquals(listOf("base-config", "domain-config"), rootChildren.map { it.tagName })

        val baseConfig = rootChildren[0]
        assertEquals("false", baseConfig.getAttribute("cleartextTrafficPermitted"))
        assertEquals(emptyList<Element>(), directChildren(baseConfig))

        val domainConfig = rootChildren[1]
        assertEquals("true", domainConfig.getAttribute("cleartextTrafficPermitted"))
        val domains = directChildren(domainConfig)
        assertEquals(1, domains.size)
        assertEquals("domain", domains.single().tagName)
        assertEquals("false", domains.single().getAttribute("includeSubdomains"))
        assertEquals("127.0.0.1", domains.single().textContent.trim())
    }

    @Test
    fun clearAndFailedReconfigurationLeaveBridgeUnavailable() {
        val installSecret = "0123456789abcdef".repeat(4)
        try {
            SpotifyBridgeRuntime.configure(installSecret, 4242)
            SpotifyBridgeRuntime.clear()
            assertEquals(false, SpotifyBridgeRuntime.isConfigured())

            SpotifyBridgeRuntime.configure(installSecret, 4242)
            assertFails { SpotifyBridgeRuntime.configure(installSecret, 0) }
            assertEquals(false, SpotifyBridgeRuntime.isConfigured())
        } finally {
            SpotifyBridgeRuntime.clear()
        }
    }

    private fun assertFails(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected failure")
        } catch (_: IllegalArgumentException) {
        } catch (_: IllegalStateException) {
        }
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("runtime/android", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }

    private fun parseXml(file: File): Document =
        DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
        }.newDocumentBuilder().parse(file)

    private fun directChildren(parent: Element): List<Element> {
        val elements = mutableListOf<Element>()
        var child = parent.firstChild
        while (child != null) {
            if (child is Element) elements += child
            child = child.nextSibling
        }
        return elements
    }

    private companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}
