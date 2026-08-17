package com.penumbraos.server

import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import java.nio.file.Files

internal object GrpcAuthTokenContract {
    const val AUTHORITY = "com.penumbraos.server.grpcauth"
    const val METHOD_GET_TOKEN = "GET_TOKEN"
    const val METHOD_GET_AIBUS_BRIDGE = "GET_AIBUS_BRIDGE"
    const val RESULT_TOKEN = "token"
    const val RESULT_BINDER = "binder"
    const val STOCK_SIGNATURE_ANCHOR = TierASymbols.Packages.IRONMAN

    // SHA-256 of the Penumbra server's own signing certificate (the same digest
    // `apksigner --print-certs` reports for the release APK).
    //
    // The credential bridge confirms the RUNNING server carries this exact build
    // identity before issuing a token. The previous check demanded the server be
    // co-signed with the stock experiences (`checkSignatures(ironman, self)`),
    // which was impossible and rejected every stock caller on hardware: the stock
    // platform and its experiences are all signed with Humane's key, while our
    // server is signed with THIS key (we do not have Humane's private key, and the
    // server runs privileged via injection, not via a matching signature). The
    // caller boundary — `checkSignatures(caller, ironman)`, i.e. only genuine
    // stock experiences may request the token — is unchanged.
    const val PENUMBRA_SERVER_CERT_SHA256 =
        "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb"

    val authorizedPackages = setOf(
        TierASymbols.Packages.IRONMAN,
        TierASymbols.Packages.PHOTOGRAPHY,
        TierASymbols.Packages.KRYPTO,
        TierASymbols.Packages.FOOD,
    )

    /** Lowercase hex SHA-256 of a DER-encoded signing certificate. Pure so the
     *  digest math is unit-testable without a `PackageManager`. */
    fun certSha256Hex(certDer: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(certDer)
            .joinToString("") { "%02x".format(it) }

    /** True only when the running server presents exactly the expected Penumbra
     *  build certificate. A missing/mismatched digest fails closed. */
    fun serverBuildIsTrusted(serverCertSha256: String?): Boolean =
        serverCertSha256 != null &&
            serverCertSha256.equals(PENUMBRA_SERVER_CERT_SHA256, ignoreCase = true)

    fun isAuthorized(
        callingUid: Int,
        callingPackage: String?,
        expectedUid: Int?,
        packagesForUid: Set<String>,
        callerIsStockSigned: Boolean,
        serverCertSha256: String?,
    ): Boolean =
        callingPackage in authorizedPackages &&
            expectedUid != null &&
            callingUid == expectedUid &&
            packagesForUid == setOf(callingPackage) &&
            callerIsStockSigned &&
            serverBuildIsTrusted(serverCertSha256)
}

internal object GrpcAuthTokenResolver {
    fun resolve(
        baseConfig: String,
        localConfig: String?,
        grpcEnvironment: String?,
        adminEnvironment: String?,
    ): String {
        val configuredGrpcToken = localConfig
            ?.let { ConfigSecurity.readOptionalString(it, "server.grpc_auth_token") }
            ?: ConfigSecurity.readOptionalString(baseConfig, "server.grpc_auth_token")
        return ConfigSecurity.requireValidAdminToken(
            grpcEnvironment
                ?: configuredGrpcToken
                ?: adminEnvironment
                ?: ConfigSecurity.readAdminToken(baseConfig),
        )
    }
}

/**
 * Narrow credential bridge for stock processes redirected to local gRPC.
 *
 * The token remains app-private at rest and is returned only after the Binder
 * caller is matched to one exact stock package, its current UID, and the stock
 * signing lineage. No mutation methods are exposed.
 */
class GrpcAuthTokenProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    /** SHA-256 of the running package's single signing certificate, or null if it
     *  has zero or multiple signers (fail closed). Used to confirm this is the
     *  expected Penumbra server build before issuing a credential. */
    @Suppress("DEPRECATION")
    private fun serverSigningCertSha256(pm: PackageManager, packageName: String): String? =
        try {
            val info = pm.getPackageInfo(
                packageName,
                PackageManager.GET_SIGNING_CERTIFICATES,
            )
            val signers = info.signingInfo?.apkContentsSigners
            if (signers != null && signers.size == 1) {
                GrpcAuthTokenContract.certSha256Hex(signers[0].toByteArray())
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        if (
            method !in setOf(
                GrpcAuthTokenContract.METHOD_GET_TOKEN,
                GrpcAuthTokenContract.METHOD_GET_AIBUS_BRIDGE,
            ) || arg != null || extras != null
        ) {
            throw SecurityException("Unsupported gRPC credential request")
        }

        val appContext = context?.applicationContext
            ?: throw IllegalStateException("gRPC credential provider unavailable")
        val packageManager = appContext.packageManager
        val callingUid = Binder.getCallingUid()
        val callerPackage = callingPackage
        val expectedUid = callerPackage?.let { packageName ->
            try {
                packageManager.getPackageUid(packageName, 0)
            } catch (_: PackageManager.NameNotFoundException) {
                null
            }
        }
        val packagesForUid = packageManager.getPackagesForUid(callingUid).orEmpty().toSet()
        // Caller boundary (unchanged): only a genuine stock experience, co-signed
        // with the stock anchor, may request the token.
        val callerIsStockSigned = callerPackage != null &&
            packageManager.checkSignatures(
                callerPackage,
                GrpcAuthTokenContract.STOCK_SIGNATURE_ANCHOR,
            ) == PackageManager.SIGNATURE_MATCH
        // Server-integrity check: the RUNNING server must present this exact
        // Penumbra build certificate. This replaces the old
        // `checkSignatures(anchor, self)` that could never pass, because our
        // server is signed with our own key, not Humane's stock key.
        val serverCertSha256 = serverSigningCertSha256(packageManager, appContext.packageName)

        if (!GrpcAuthTokenContract.isAuthorized(
                callingUid,
                callerPackage,
                expectedUid,
                packagesForUid,
                callerIsStockSigned,
                serverCertSha256,
            )
        ) {
            // Denials only (no spam once a caller is authorized). The cert digest
            // is a public fingerprint, safe to log, and pinpoints a bad pin.
            android.util.Log.w(
                "PenumbraGrpcAuth",
                "gRPC credential denied: caller=$callerPackage " +
                    "callerStockSigned=$callerIsStockSigned serverCert=$serverCertSha256",
            )
            throw SecurityException("Caller is not authorized for local gRPC credentials")
        }

        if (method == GrpcAuthTokenContract.METHOD_GET_AIBUS_BRIDGE) {
            if (callerPackage != GrpcAuthTokenContract.STOCK_SIGNATURE_ANCHOR) {
                throw SecurityException("Caller is not authorized for the local AI Bus bridge")
            }
            check(com.penumbraos.server.stockaibus.StockAiBusBridgeRuntime.isReady()) {
                "Local AI Bus bridge is not ready"
            }
            return Bundle().apply {
                putBinder(
                    GrpcAuthTokenContract.RESULT_BINDER,
                    com.penumbraos.server.stockaibus.StockAiBusBridgeRuntime.binder(appContext),
                )
            }
        }

        val filesDir = appContext.filesDir
        val baseConfigFile = File(filesDir, PersistentConfigVaultFormat.CONFIG_FILE_NAME)
        check(baseConfigFile.isFile && !Files.isSymbolicLink(baseConfigFile.toPath())) {
            "Canonical configuration is unavailable"
        }
        val localConfigFile = File(filesDir, PersistentConfigVaultFormat.LOCAL_CONFIG_FILE_NAME)
        val localConfig = if (localConfigFile.exists()) {
            check(localConfigFile.isFile && !Files.isSymbolicLink(localConfigFile.toPath())) {
                "Local configuration is invalid"
            }
            localConfigFile.readText()
        } else {
            null
        }
        val token = GrpcAuthTokenResolver.resolve(
            baseConfig = baseConfigFile.readText(),
            localConfig = localConfig,
            grpcEnvironment = System.getenv("PENUMBRA_GRPC_AUTH_TOKEN"),
            adminEnvironment = System.getenv("PENUMBRA_ADMIN_TOKEN"),
        )
        return Bundle().apply { putString(GrpcAuthTokenContract.RESULT_TOKEN, token) }
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = throw UnsupportedOperationException()

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? =
        throw UnsupportedOperationException()

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = throw UnsupportedOperationException()
}
