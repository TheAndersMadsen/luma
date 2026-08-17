package com.penumbraos.systeminjector.common

import java.io.ByteArrayInputStream
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.xpath.XPathConstants
import javax.xml.xpath.XPathFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.w3c.dom.Element
import org.w3c.dom.NodeList

class PackagesXmlPatcherUpdateTest {
    @Test
    fun `existing package remains a hard error by default`() {
        val document = fixtureDocument()

        assertThrows(IllegalStateException::class.java) {
            PackagesXmlPatcher.insertPackage(
                document = document,
                packageName = PACKAGE_NAME,
                codePath = "/data/app/new",
                sharedUserId = 1000,
            )
        }
    }

    @Test
    fun `retained package entry can be replaced explicitly`() {
        val document = fixtureDocument()

        PackagesXmlPatcher.insertPackage(
            document = document,
            packageName = PACKAGE_NAME,
            codePath = "/data/app/new",
            sharedUserId = 1000,
            primaryCpuAbi = "arm64-v8a",
            replaceExisting = true,
        )

        val xPath = XPathFactory.newInstance().newXPath()
        val packages = xPath.compile("/packages/package[@name='$PACKAGE_NAME']")
            .evaluate(document, XPathConstants.NODESET) as NodeList
        assertEquals(1, packages.length)

        val replacement = packages.item(0) as Element
        assertEquals("/data/app/new", replacement.getAttribute("codePath"))
        assertEquals("1000", replacement.getAttribute("sharedUserId"))
        assertEquals("arm64-v8a", replacement.getAttribute("primaryCpuAbi"))
        assertEquals("", replacement.getAttribute("oldMarker"))

        val replacementCert = xPath.compile("/packages/package[@name='$PACKAGE_NAME']/sigs/cert")
            .evaluate(document, XPathConstants.NODE) as Element
        val platformCert = xPath.compile("/packages/shared-user[@userId='1000']/sigs/cert")
            .evaluate(document, XPathConstants.NODE) as Element
        assertEquals("1", replacementCert.getAttribute("index"))
        assertEquals(SigningConstants.TARGET_CERT_HEX, replacementCert.getAttribute("key"))
        assertEquals("0", platformCert.getAttribute("index"))
        assertFalse(platformCert.hasAttribute("key"))
        assertEquals("/data/app/new", PackagesXmlPatcher.findPackageCodePath(document, PACKAGE_NAME))
        PackagesXmlPatcher.serializeAndValidate(document)
    }

    @Test
    fun `replacing certificate owner preserves retained sibling reference`() {
        val document = fixtureDocument()
        val oldPackage = document.getElementsByTagName("package").item(1)
        val retainedSibling = document.createElement("package").apply {
            setAttribute("name", "com.example.retained")
            setAttribute("codePath", "/data/app/retained")
            setAttribute("sharedUserId", "1000")
            appendChild(
                document.createElement("sigs").apply {
                    setAttribute("count", "1")
                    appendChild(
                        document.createElement("cert").apply {
                            setAttribute("index", "1")
                        }
                    )
                }
            )
        }
        oldPackage.parentNode.insertBefore(retainedSibling, oldPackage.nextSibling)

        PackagesXmlPatcher.insertPackage(
            document = document,
            packageName = PACKAGE_NAME,
            codePath = "/data/app/new",
            sharedUserId = 1000,
            replaceExisting = true,
        )

        val xPath = XPathFactory.newInstance().newXPath()
        val retainedCert = xPath
            .compile("/packages/package[@name='com.example.retained']/sigs/cert")
            .evaluate(document, XPathConstants.NODE) as Element
        val replacementCert = xPath
            .compile("/packages/package[@name='$PACKAGE_NAME']/sigs/cert")
            .evaluate(document, XPathConstants.NODE) as Element
        assertEquals("1", retainedCert.getAttribute("index"))
        assertEquals("old", retainedCert.getAttribute("key"))
        assertEquals("2", replacementCert.getAttribute("index"))
        assertEquals(SigningConstants.TARGET_CERT_HEX, replacementCert.getAttribute("key"))
        PackagesXmlPatcher.serializeAndValidate(document)
    }

    @Test
    fun `serialization rejects a certificate reference without a definition`() {
        val document = fixtureDocument()
        val xPath = XPathFactory.newInstance().newXPath()
        val oldDefinition = xPath.compile("/packages/package[@name='$PACKAGE_NAME']")
            .evaluate(document, XPathConstants.NODE) as Element
        oldDefinition.parentNode.removeChild(oldDefinition)
        val danglingPackage = document.createElement("package").apply {
            setAttribute("name", "com.example.dangling")
            appendChild(
                document.createElement("sigs").apply {
                    appendChild(
                        document.createElement("cert").apply {
                            setAttribute("index", "1")
                        }
                    )
                }
            )
        }
        val firstSharedUser = xPath.compile("/packages/shared-user")
            .evaluate(document, XPathConstants.NODE) as Element
        firstSharedUser.parentNode.insertBefore(danglingPackage, firstSharedUser)

        assertThrows(IllegalStateException::class.java) {
            PackagesXmlPatcher.serializeAndValidate(document)
        }
    }

    @Test
    fun `duplicate persisted package entries are rejected before replacement`() {
        val document = fixtureDocument()
        val duplicate = document.createElement("package").apply {
            setAttribute("name", PACKAGE_NAME)
            setAttribute("codePath", "/data/app/duplicate")
        }
        document.documentElement.insertBefore(duplicate, document.documentElement.firstChild)

        assertThrows(IllegalStateException::class.java) {
            PackagesXmlPatcher.insertPackage(
                document = document,
                packageName = PACKAGE_NAME,
                codePath = "/data/app/new",
                sharedUserId = 1000,
                replaceExisting = true,
            )
        }
    }

    private fun fixtureDocument() = DocumentBuilderFactory.newInstance()
        .newDocumentBuilder()
        .parse(
            ByteArrayInputStream(
                """
                <packages>
                    <package name="android" codePath="/system/framework/framework-res.apk" sharedUserId="1000">
                        <sigs count="1"><cert index="0" key="platform" /></sigs>
                    </package>
                    <package name="$PACKAGE_NAME" codePath="/data/app/old" sharedUserId="1000" oldMarker="true">
                        <sigs count="1"><cert index="1" key="old" /></sigs>
                    </package>
                    <keyset-settings>
                        <keys />
                        <keysets />
                        <lastIssuedKeySetId value="1" />
                        <lastIssuedKeyId value="1" />
                    </keyset-settings>
                    <shared-user name="android.uid.system" userId="1000">
                        <sigs count="1">
                            <cert index="0" />
                            <pastSigs count="1"><cert index="0" flags="2" /></pastSigs>
                        </sigs>
                    </shared-user>
                </packages>
                """.trimIndent().toByteArray()
            )
        )

    private companion object {
        const val PACKAGE_NAME = "com.example.updated"
    }
}
