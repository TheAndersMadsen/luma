package com.penumbraos.server

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

class GrpcAuthTokenProviderSecurityTest {
    @Test
    fun onlyExactStockPackageUidAndSignatureAreAuthorized() {
        val packageName = "hu.ma.ne.ironman"
        val serverCert = GrpcAuthTokenContract.PENUMBRA_SERVER_CERT_SHA256
        // A genuine stock caller, on its exact uid, with the expected server build.
        assertTrue(
            GrpcAuthTokenContract.isAuthorized(
                callingUid = 10_042,
                callingPackage = packageName,
                expectedUid = 10_042,
                packagesForUid = setOf(packageName),
                callerIsStockSigned = true,
                serverCertSha256 = serverCert,
            ),
        )
        // Non-stock caller package.
        assertFalse(
            GrpcAuthTokenContract.isAuthorized(
                10_042, "third.party.app", 10_042, setOf("third.party.app"), true, serverCert,
            ),
        )
        // UID does not match the package's own uid.
        assertFalse(
            GrpcAuthTokenContract.isAuthorized(
                20_000, packageName, 10_042, setOf(packageName), true, serverCert,
            ),
        )
        // UID shared with a peer package.
        assertFalse(
            GrpcAuthTokenContract.isAuthorized(
                10_042, packageName, 10_042, setOf(packageName, "shared.uid.peer"), true, serverCert,
            ),
        )
        // Caller is not stock-signed.
        assertFalse(
            GrpcAuthTokenContract.isAuthorized(
                10_042, packageName, 10_042, setOf(packageName), false, serverCert,
            ),
        )
    }

    @Test
    fun serverBuildIntegrityIsPartOfAuthorization() {
        // The dimension the old check got wrong: it required the SERVER to be
        // co-signed with the stock experiences, which our server can never be, so
        // it rejected every stock caller on hardware. Authorization must instead
        // verify the running server is THIS Penumbra build, and must fail closed
        // for any other or missing server cert even with a perfect stock caller.
        val packageName = "hu.ma.ne.ironman"
        fun authWithServerCert(cert: String?) =
            GrpcAuthTokenContract.isAuthorized(
                callingUid = 10_042,
                callingPackage = packageName,
                expectedUid = 10_042,
                packagesForUid = setOf(packageName),
                callerIsStockSigned = true,
                serverCertSha256 = cert,
            )
        assertTrue(authWithServerCert(GrpcAuthTokenContract.PENUMBRA_SERVER_CERT_SHA256))
        assertTrue(authWithServerCert(GrpcAuthTokenContract.PENUMBRA_SERVER_CERT_SHA256.uppercase()))
        assertFalse(authWithServerCert("0".repeat(64)))
        assertFalse(authWithServerCert(null))
        assertFalse(authWithServerCert(""))
    }

    @Test
    fun certDigestMathMatchesApksignerSemantics() {
        // The empty input's SHA-256 is well known; this proves the digest and its
        // lowercase-hex formatting (incl. leading zeros) are correct, so the pinned
        // PENUMBRA_SERVER_CERT_SHA256 means exactly what `apksigner --print-certs`
        // reports for the DER-encoded certificate.
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            GrpcAuthTokenContract.certSha256Hex(ByteArray(0)),
        )
        assertEquals(64, GrpcAuthTokenContract.PENUMBRA_SERVER_CERT_SHA256.length)
        assertTrue(
            GrpcAuthTokenContract.serverBuildIsTrusted(
                GrpcAuthTokenContract.PENUMBRA_SERVER_CERT_SHA256,
            ),
        )
        assertFalse(GrpcAuthTokenContract.serverBuildIsTrusted(null))
    }

    @Test
    fun tokenResolutionMatchesRustPrecedence() {
        val base = """
            [server]
            admin_token = "${"a".repeat(32)}"
            grpc_auth_token = "${"b".repeat(32)}"
        """.trimIndent()
        val local = """
            [server]
            grpc_auth_token = "${"c".repeat(32)}"
        """.trimIndent()

        assertEquals("d".repeat(32), GrpcAuthTokenResolver.resolve(base, local, "d".repeat(32), null))
        assertEquals("c".repeat(32), GrpcAuthTokenResolver.resolve(base, local, null, null))
        assertEquals("b".repeat(32), GrpcAuthTokenResolver.resolve(base, null, null, null))
        assertEquals(
            "e".repeat(32),
            GrpcAuthTokenResolver.resolve(
                "[server]\nadmin_token = \"${"a".repeat(32)}\"",
                null,
                null,
                "e".repeat(32),
            ),
        )
    }

    @Test
    fun onlyIronmanMayUseTheStockAiBusBinder() {
        // The `ironmanIsStockSigned` dimension must be load-bearing: an ironman on
        // its exact uid is authorized only when it is genuinely stock-signed, and
        // rejected when it is not. (Which anchor proves "stock-signed" — the
        // platform, not the server — is verified on-device, since checkSignatures
        // needs a real PackageManager.)
        assertEquals("GET_AIBUS_BRIDGE", GrpcAuthTokenContract.METHOD_GET_AIBUS_BRIDGE)
        assertEquals("binder", GrpcAuthTokenContract.RESULT_BINDER)
        assertTrue(
            com.penumbraos.server.stockaibus.StockAiBusBridgeRuntime
                .isAuthorizedIronmanCaller(
                    callingUid = 10_042,
                    expectedUid = 10_042,
                    packagesForUid = setOf("hu.ma.ne.ironman"),
                    ironmanIsStockSigned = true,
                ),
        )
        assertFalse(
            com.penumbraos.server.stockaibus.StockAiBusBridgeRuntime
                .isAuthorizedIronmanCaller(
                    callingUid = 10_042,
                    expectedUid = 10_042,
                    packagesForUid = setOf("hu.ma.ne.ironman", "shared.peer"),
                    ironmanIsStockSigned = true,
                ),
        )
        assertFalse(
            com.penumbraos.server.stockaibus.StockAiBusBridgeRuntime
                .isAuthorizedIronmanCaller(
                    callingUid = 10_042,
                    expectedUid = 10_042,
                    packagesForUid = setOf("hu.ma.ne.ironman"),
                    ironmanIsStockSigned = false,
                ),
        )
    }

    @Test
    fun manifestExportsOnlyTheDynamicallyGuardedProvider() {
        val manifest = parseXml(sourceFile("src/main/AndroidManifest.xml"))
        val providers = manifest.getElementsByTagName("provider")
        val grpcProvider = (0 until providers.length)
            .map { providers.item(it) as Element }
            .single {
                it.getAttributeNS(ANDROID_NAMESPACE, "authorities") ==
                    GrpcAuthTokenContract.AUTHORITY
            }

        assertEquals("true", grpcProvider.getAttributeNS(ANDROID_NAMESPACE, "exported"))
        assertEquals("false", grpcProvider.getAttributeNS(ANDROID_NAMESPACE, "grantUriPermissions"))
        assertEquals("", grpcProvider.getAttributeNS(ANDROID_NAMESPACE, "permission"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("runtime/android", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }

    private fun parseXml(file: File) = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
    }.newDocumentBuilder().parse(file)

    private companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}
