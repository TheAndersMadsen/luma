package com.penumbraos.server

import android.Manifest
import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

internal const val COSMOS_IDENTITY_ROOT_UID = 0
internal const val COSMOS_IDENTITY_SYSTEM_UID = 1000
internal const val COSMOS_IDENTITY_SHELL_UID = 2000

internal fun isTrustedCosmosIdentityUid(uid: Int): Boolean =
    uid == COSMOS_IDENTITY_ROOT_UID ||
        uid == COSMOS_IDENTITY_SYSTEM_UID ||
        uid == COSMOS_IDENTITY_SHELL_UID

/**
 * Privileged-maintenance import of one clone DeviceAttestation credential.
 *
 * The private key is piped into this UID-1000 process, validated against the
 * exact Pin hardware id and the pinned clone root, imported into AndroidKeyStore,
 * and then deleted from staging. No method exports key bytes.
 */
class CosmosIdentityProvider : ContentProvider() {
    companion object {
        // Content URIs survive APK replacement in maintenance tooling. Keep
        // the deployed authority even though the implementation is Cosmos.
        const val AUTHORITY = "com.penumbraos.server.cosmosidentity"
        const val STAGING_NAME = "attestation.json"
        const val METHOD_IMPORT = "IMPORT"
        const val METHOD_STATUS = "STATUS"
        const val METHOD_CLEAR = "CLEAR"
        const val METHOD_ACTIVATE = "ACTIVATE"
        const val METHOD_DEACTIVATE = "DEACTIVATE"
        const val METHOD_ACTIVATION_STATUS = "ACTIVATION_STATUS"
        const val RESULT_OK = "ok"
        const val RESULT_PRESENT = "present"
        const val RESULT_SUBJECT = "subject"
        const val RESULT_FINGERPRINT = "fingerprint_sha256"

        /** Shared by UID 1000; consumed by the injected clone key manager. */
        const val KEY_ALIAS = CosmosActivationContract.ATTESTATION_KEY_ALIAS

        private const val TAG = "CosmosIdentity"
        private const val MAX_BUNDLE_BYTES = 64 * 1024L
        private const val WRITE_TIMEOUT_SECONDS = 15L
        private const val ACTIVATION_RECORD_NAME = "cosmos-activation-v1.json"
    }

    private val writeLock = Any()
    private val operationLock = Any()
    private var activeWrite: CountDownLatch? = null
    private var writeFailure: String? = null
    private var operationInProgress = false

    override fun onCreate(): Boolean {
        runCatching { incomingFile().delete() }
        // Published staging contains one-time private key material. A process
        // restart invalidates the matching maintenance call, so fail closed.
        runCatching { stagingFile().delete() }
        return true
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        enforceCaller()
        if (uri.authority != AUTHORITY || uri.pathSegments != listOf(STAGING_NAME)) {
            throw FileNotFoundException("Only the fixed Cosmos identity staging path is writable")
        }
        if (!mode.contains('w')) {
            throw FileNotFoundException("Cosmos identity staging is write-only")
        }

        val completion = synchronized(writeLock) {
            if (operationInProgress) {
                throw IllegalStateException("Cosmos identity maintenance is already in progress")
            }
            if (activeWrite?.count == 1L) {
                throw IllegalStateException("A Cosmos identity write is already in progress")
            }
            CountDownLatch(1).also {
                activeWrite = it
                writeFailure = null
            }
        }
        val pipe = ParcelFileDescriptor.createReliablePipe()
        val readEnd = pipe[0]
        val writeEnd = pipe[1]
        val temporary = incomingFile()
        val published = stagingFile()

        Thread({
            var closeWithError = false
            try {
                FileInputStream(readEnd.fileDescriptor).use { input ->
                    FileOutputStream(temporary).use { output ->
                        copyBounded(input, output, MAX_BUNDLE_BYTES)
                        readEnd.checkError()
                        output.fd.sync()
                    }
                }
                Files.move(
                    temporary.toPath(),
                    published.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (error: Throwable) {
                synchronized(writeLock) {
                    writeFailure = error.javaClass.simpleName
                }
                runCatching {
                    readEnd.closeWithError("Cosmos identity staging failed")
                    closeWithError = true
                }
                Log.e(TAG, "Cosmos identity staging failed (${error.javaClass.simpleName})")
            } finally {
                temporary.delete()
                if (!closeWithError) runCatching { readEnd.close() }
                completion.countDown()
            }
        }, "cosmos-identity-stage").start()
        return writeEnd
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        enforceCaller()
        if (arg != null || (extras != null && !extras.isEmpty)) {
            return result(false, "Arguments are not accepted")
        }
        return synchronized(operationLock) {
            val beginError = beginExclusiveOperation()
            if (beginError != null) return@synchronized result(false, beginError)
            try {
                when (method) {
                    METHOD_IMPORT -> importIdentity()
                    METHOD_STATUS -> identityStatus()
                    METHOD_CLEAR -> clearIdentity()
                    METHOD_ACTIVATE -> activateCosmos()
                    METHOD_DEACTIVATE -> deactivateCosmos()
                    METHOD_ACTIVATION_STATUS -> activationStatus()
                    else -> result(false, "Unsupported method")
                }
            } finally {
                synchronized(writeLock) {
                    operationInProgress = false
                }
            }
        }
    }

    private fun beginExclusiveOperation(): String? {
        while (true) {
            val pending = synchronized(writeLock) {
                val write = activeWrite
                if (write == null || write.count == 0L) {
                    operationInProgress = true
                    return null
                }
                write
            }
            if (!pending.await(WRITE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                return "Staging write did not finish"
            }
            synchronized(writeLock) {
                writeFailure?.let { return "Staging write failed" }
            }
        }
    }

    private fun importIdentity(): Bundle {
        synchronized(writeLock) {
            writeFailure?.let { return result(false, "Staging write failed") }
        }
        val staged = stagingFile()
        if (!staged.isFile || staged.length() !in 1..MAX_BUNDLE_BYTES) {
            staged.delete()
            return result(false, "No valid staged identity bundle")
        }

        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val bundle = CosmosAttestationBundle.parse(staged.readText(Charsets.UTF_8))
            val hardwareId = readSystemProperty("ro.boot.deviceid")
            check(hardwareId.isNotBlank()) { "Pin hardware id is unavailable" }
            check(bundle.deviceId.equals(hardwareId, ignoreCase = true)) {
                "Credential does not name this Pin"
            }
            bundle.validate()
            bundle.importIntoAndroidKeyStore(KEY_ALIAS)
            identityStatus()
        } catch (error: Throwable) {
            Log.e(TAG, "Cosmos identity import rejected (${error.javaClass.simpleName})")
            result(false, "Identity import was rejected")
        } finally {
            staged.delete()
            Binder.restoreCallingIdentity(callingIdentity)
        }
    }

    private fun activateCosmos(): Bundle {
        val staged = stagingFile()
        if (!staged.isFile || staged.length() !in 1..MAX_BUNDLE_BYTES) {
            staged.delete()
            return activationResultBundle(
                CosmosActivationResult(
                    ok = false,
                    code = CosmosActivationCode.INVALID_REQUEST,
                    changed = false,
                    managed = false,
                    rollbackComplete = true,
                ),
            )
        }

        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val bytes = staged.readBytes()
            try {
                check(bytes.size.toLong() in 1..MAX_BUNDLE_BYTES)
                val envelope = CosmosActivationEnvelope.parse(String(bytes, Charsets.UTF_8))
                val hardwareId = readSystemProperty("ro.boot.deviceid")
                check(hardwareId.isNotBlank()) { "Pin hardware id is unavailable" }
                check(envelope.identity.deviceId.equals(hardwareId, ignoreCase = true)) {
                    "Credential does not name this Pin"
                }
                // Trust, subject, key/certificate match, and validity are all
                // checked before the transaction journal or Settings.Global is touched.
                envelope.identity.validate()

                val transaction = CosmosActivationTransaction(
                    settings = AndroidCosmosSettingsPort(requireNotNull(context).contentResolver),
                    records = FileCosmosActivationRecordPort(activationRecordFile()),
                )
                activationResultBundle(
                    transaction.activate(
                        apiEndpoint = envelope.apiEndpoint,
                        onboardingEndpoint = envelope.onboardingEndpoint,
                        edgeIpv4 = envelope.edgeIpv4,
                        identity = AndroidCosmosIdentityPort(envelope.identity),
                    ),
                )
            } finally {
                bytes.fill(0)
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Cosmos activation rejected (${error.javaClass.simpleName})")
            activationResultBundle(
                CosmosActivationResult(
                    ok = false,
                    code = CosmosActivationCode.INVALID_REQUEST,
                    changed = false,
                    managed = false,
                    rollbackComplete = true,
                ),
            )
        } finally {
            staged.delete()
            Binder.restoreCallingIdentity(callingIdentity)
        }
    }

    private fun deactivateCosmos(): Bundle {
        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val transaction = CosmosActivationTransaction(
                settings = AndroidCosmosSettingsPort(requireNotNull(context).contentResolver),
                records = FileCosmosActivationRecordPort(activationRecordFile()),
            )
            activationResultBundle(
                transaction.deactivate(AndroidCosmosIdentityPort(candidateBundle = null)),
            )
        } catch (error: Throwable) {
            Log.e(TAG, "Cosmos deactivation failed (${error.javaClass.simpleName})")
            activationResultBundle(
                CosmosActivationResult(
                    ok = false,
                    code = CosmosActivationCode.TRANSACTION_FAILED,
                    changed = false,
                    managed = false,
                    rollbackComplete = true,
                ),
            )
        } finally {
            Binder.restoreCallingIdentity(callingIdentity)
        }
    }

    private fun activationStatus(): Bundle {
        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val resolver = requireNotNull(context).contentResolver
            val settings = AndroidCosmosSettingsPort(resolver)
            val record = FileCosmosActivationRecordPort(activationRecordFile()).load()
            val identity = AndroidCosmosIdentityPort(candidateBundle = null).current()
            Bundle().apply {
                putBoolean(RESULT_OK, true)
                putString(
                    "state",
                    if (settings.read(CosmosActivationContract.REMOTE_MODE_SETTING) == "1") {
                        "active"
                    } else {
                        "inactive"
                    },
                )
                putBoolean("managed", record?.phase == CosmosActivationPhase.ACTIVE)
                putString("edge_ipv4", settings.read(CosmosActivationContract.EDGE_IPV4_SETTING))
                putBoolean(RESULT_PRESENT, identity != null)
                putBoolean("identity_usable", identity?.usableForTls == true)
                putString(RESULT_FINGERPRINT, identity?.fingerprintSha256)
                putString("api_endpoint", record?.apiEndpoint ?: CosmosActivationContract.API_ENDPOINT)
                putString(
                    "onboarding_endpoint",
                    record?.onboardingEndpoint ?: CosmosActivationContract.ONBOARDING_ENDPOINT,
                )
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Cosmos activation status failed (${error.javaClass.simpleName})")
            result(false, "Cosmos activation status is unavailable")
        } finally {
            Binder.restoreCallingIdentity(callingIdentity)
        }
    }

    private fun activationResultBundle(result: CosmosActivationResult): Bundle = Bundle().apply {
        putBoolean(RESULT_OK, result.ok)
        putString("state", result.code.wireValue)
        putString("message", result.message)
        putBoolean("changed", result.changed)
        putBoolean("managed", result.managed)
        putBoolean("rollback_complete", result.rollbackComplete)
        result.apiEndpoint?.let { putString("api_endpoint", it) }
        result.onboardingEndpoint?.let { putString("onboarding_endpoint", it) }
        result.edgeIpv4?.let { putString("edge_ipv4", it) }
        result.identityFingerprintSha256?.let { putString(RESULT_FINGERPRINT, it) }
    }

    private fun identityStatus(): Bundle {
        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val identity = AndroidCosmosIdentityPort(candidateBundle = null).current()
            if (identity == null) {
                Bundle().apply {
                    putBoolean(RESULT_OK, true)
                    putBoolean(RESULT_PRESENT, false)
                }
            } else {
                Bundle().apply {
                    putBoolean(RESULT_OK, true)
                    putBoolean(RESULT_PRESENT, true)
                    putBoolean("usable", identity.usableForTls)
                    putString(RESULT_SUBJECT, identity.subject)
                    putString(RESULT_FINGERPRINT, identity.fingerprintSha256)
                }
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Cosmos identity status failed (${error.javaClass.simpleName})")
            result(false, "Identity status is unavailable")
        } finally {
            Binder.restoreCallingIdentity(callingIdentity)
        }
    }

    private fun clearIdentity(): Bundle {
        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val resolver = requireNotNull(context).contentResolver
            if (Settings.Global.getString(
                    resolver,
                    CosmosActivationContract.REMOTE_MODE_SETTING,
                ) == "1"
            ) {
                return result(false, "Deactivate Cosmos before clearing its identity")
            }
            if (activationRecordFile().exists()) {
                return result(false, "Deactivate Cosmos before clearing its identity")
            }
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
            stagingFile().delete()
            incomingFile().delete()
            Bundle().apply {
                putBoolean(RESULT_OK, true)
                putBoolean(RESULT_PRESENT, false)
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Cosmos identity clear failed (${error.javaClass.simpleName})")
            result(false, "Identity clear failed")
        } finally {
            Binder.restoreCallingIdentity(callingIdentity)
        }
    }

    private fun enforceCaller() {
        val providerContext = context ?: throw SecurityException("Cosmos identity provider unavailable")
        providerContext.enforceCallingPermission(
            Manifest.permission.DUMP,
            "Cosmos identity import requires privileged maintenance permission",
        )
        if (!isTrustedCosmosIdentityUid(Binder.getCallingUid())) {
            throw SecurityException("Caller is not authorized for Cosmos identity maintenance")
        }
    }

    private fun stagingFile(): File = File(requireNotNull(context).filesDir, STAGING_NAME)

    private fun incomingFile(): File = File(requireNotNull(context).filesDir, ".$STAGING_NAME.incoming")

    private fun activationRecordFile(): File =
        File(requireNotNull(context).filesDir, ACTIVATION_RECORD_NAME)

    private fun readSystemProperty(name: String): String = readAndroidSystemProperty(name)

    private fun result(ok: Boolean, message: String): Bundle = Bundle().apply {
        putBoolean(RESULT_OK, ok)
        putString("message", message)
    }

    private fun copyBounded(input: FileInputStream, output: FileOutputStream, maximum: Long) {
        val buffer = ByteArray(8192)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            check(total <= maximum) { "Cosmos identity bundle exceeds the size limit" }
            output.write(buffer, 0, read)
        }
        check(total > 0) { "Cosmos identity bundle is empty" }
    }

    override fun getType(uri: Uri): String = "application/json"
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()
    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = throw UnsupportedOperationException()
}

internal data class CosmosAttestationBundle(
    val deviceId: String,
    val privateKey: java.security.PrivateKey,
    val leaf: X509Certificate,
    val issuer: X509Certificate,
) {
    val descriptor: CosmosIdentityDescriptor
        get() = CosmosIdentityDescriptor(
            fingerprintSha256 = sha256Hex(leaf.encoded),
            subject = leaf.subjectX500Principal.name,
            usableForTls = true,
        )

    fun importIntoAndroidKeyStore(alias: String) {
        validate()
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(alias)) {
            val existing = store.getCertificate(alias) as? X509Certificate
            check(existing != null && MessageDigest.isEqual(existing.encoded, leaf.encoded)) {
                "A different clone identity already exists"
            }
            check(androidKeyStoreIdentity(store, alias)?.usableForTls == true) {
                "The existing clone identity is not usable for TLS"
            }
            return
        }
        val protection = KeyProtection.Builder(KeyProperties.PURPOSE_SIGN)
            .setDigests(
                // Conscrypt signs a pre-hashed TLS transcript with NONEwithECDSA.
                KeyProperties.DIGEST_NONE,
                KeyProperties.DIGEST_SHA256,
                KeyProperties.DIGEST_SHA384,
                KeyProperties.DIGEST_SHA512,
            )
            .setUserAuthenticationRequired(false)
            .build()
        try {
            store.setEntry(
                alias,
                KeyStore.PrivateKeyEntry(privateKey, arrayOf(leaf, issuer)),
                protection,
            )
            val installed = androidKeyStoreIdentity(store, alias)
            check(installed?.fingerprintSha256 == descriptor.fingerprintSha256) {
                "Imported clone certificate is unavailable"
            }
            check(installed.usableForTls) {
                "Imported clone private key is not usable for TLS"
            }
        } catch (error: Throwable) {
            // This path only creates a previously absent alias. A failed
            // read-back must not leave a partial credential behind.
            runCatching { if (store.containsAlias(alias)) store.deleteEntry(alias) }
            throw error
        }
    }

    fun validate() {
        check(deviceId.isNotEmpty() && deviceId.all(Char::isHexDigit)) { "Invalid device id" }
        check(privateKey.algorithm.equals("EC", ignoreCase = true)) { "Clone key must be EC" }
        val root = parseCertificate(CLONE_ROOT_PEM)
        root.verify(root.publicKey)
        issuer.verify(root.publicKey)
        leaf.verify(issuer.publicKey)
        root.checkValidity()
        issuer.checkValidity()
        leaf.checkValidity()
        check(issuer.basicConstraints >= 0) { "Clone issuer is not a CA" }
        check(leaf.basicConstraints < 0) { "Clone device certificate is not a leaf" }
        check(leaf.keyUsage?.getOrNull(0) != false) { "Clone device certificate cannot sign" }
        val expectedCn = CosmosActivationContract.expectedAttestationSubject(deviceId)
        check(subjectCommonName(leaf).equals(expectedCn, ignoreCase = true)) {
            "Clone device certificate subject does not match the bundle"
        }
        val challenge = "penumbra-cosmos-identity-check".toByteArray(Charsets.US_ASCII)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(challenge)
            sign()
        }
        check(Signature.getInstance("SHA256withECDSA").run {
            initVerify(leaf.publicKey)
            update(challenge)
            verify(signature)
        }) { "Clone private key does not match the certificate" }
    }

    companion object {
        fun parse(json: String): CosmosAttestationBundle {
            val objectValue = JSONObject(json)
            val deviceId = objectValue.getString("device_id").trim().lowercase(Locale.US)
            val keyBytes = parsePem(objectValue.getString("private_key_pem"), "PRIVATE KEY")
            val privateKey = try {
                KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(keyBytes))
            } finally {
                keyBytes.fill(0)
            }
            return CosmosAttestationBundle(
                deviceId = deviceId,
                privateKey = privateKey,
                leaf = parseCertificate(objectValue.getString("certificate_pem")),
                issuer = parseCertificate(objectValue.getString("ca_certificate_pem")),
            )
        }
    }
}

private data class CosmosActivationEnvelope(
    val apiEndpoint: String,
    val onboardingEndpoint: String,
    val edgeIpv4: String,
    val identity: CosmosAttestationBundle,
) {
    companion object {
        fun parse(json: String): CosmosActivationEnvelope {
            val value = JSONObject(json)
            return CosmosActivationEnvelope(
                apiEndpoint = value.getString("api_endpoint"),
                onboardingEndpoint = value.getString("onboarding_endpoint"),
                edgeIpv4 = value.getString("edge_ipv4"),
                identity = CosmosAttestationBundle.parse(json),
            )
        }
    }
}

private class AndroidCosmosSettingsPort(
    private val resolver: ContentResolver,
) : CosmosSettingsPort {
    override fun read(key: String): String? = Settings.Global.getString(resolver, key)

    override fun write(key: String, value: String?): Boolean {
        if (value == null) {
            // putString(null) is not a deletion on every Android release.
            resolver.delete(Settings.Global.getUriFor(key), null, null)
            return read(key) == null
        }
        return Settings.Global.putString(resolver, key, value)
    }
}

private class AndroidCosmosIdentityPort(
    private val candidateBundle: CosmosAttestationBundle?,
) : CosmosIdentityPort {
    override fun candidate(): CosmosIdentityDescriptor =
        candidateBundle?.descriptor ?: error("No candidate identity was supplied")

    override fun current(): CosmosIdentityDescriptor? {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return androidKeyStoreIdentity(store, CosmosActivationContract.ATTESTATION_KEY_ALIAS)
    }

    override fun installCandidate(): CosmosIdentityDescriptor {
        val bundle = candidateBundle ?: error("No candidate identity was supplied")
        bundle.importIntoAndroidKeyStore(CosmosActivationContract.ATTESTATION_KEY_ALIAS)
        return checkNotNull(current()) { "Imported Cosmos identity is unavailable" }
    }

    override fun removeIfMatches(fingerprintSha256: String): Boolean {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(CosmosActivationContract.ATTESTATION_KEY_ALIAS)) return true
        val leaf = store.getCertificate(CosmosActivationContract.ATTESTATION_KEY_ALIAS)
            as? X509Certificate ?: return false
        if (!sha256Hex(leaf.encoded).equals(fingerprintSha256, ignoreCase = true)) return false
        store.deleteEntry(CosmosActivationContract.ATTESTATION_KEY_ALIAS)
        return !store.containsAlias(CosmosActivationContract.ATTESTATION_KEY_ALIAS)
    }
}

private fun androidKeyStoreIdentity(
    store: KeyStore,
    alias: String,
): CosmosIdentityDescriptor? {
    if (!store.containsAlias(alias)) return null
    val leaf = store.getCertificate(alias) as? X509Certificate
        ?: error("Cosmos identity certificate is missing")
    val fingerprint = sha256Hex(leaf.encoded)
    val usable = runCatching {
        val key = store.getKey(alias, null) as? java.security.PrivateKey
            ?: error("Cosmos identity private key is missing")
        val chain = store.getCertificateChain(alias)
            ?.map { it as X509Certificate }
            ?: error("Cosmos identity certificate chain is missing")
        check(chain.size >= 2) { "Cosmos identity certificate chain is incomplete" }
        val issuer = chain[1]
        validateStoredCosmosIdentity(key, leaf, issuer)
    }.isSuccess
    return CosmosIdentityDescriptor(
        fingerprintSha256 = fingerprint,
        subject = leaf.subjectX500Principal.name,
        usableForTls = usable,
    )
}

private fun validateStoredCosmosIdentity(
    privateKey: java.security.PrivateKey,
    leaf: X509Certificate,
    issuer: X509Certificate,
) {
    check(privateKey.algorithm.equals("EC", ignoreCase = true))
    val root = parseCertificate(CLONE_ROOT_PEM)
    root.verify(root.publicKey)
    issuer.verify(root.publicKey)
    leaf.verify(issuer.publicKey)
    root.checkValidity()
    issuer.checkValidity()
    leaf.checkValidity()
    check(issuer.basicConstraints >= 0)
    check(leaf.basicConstraints < 0)
    check(leaf.keyUsage?.getOrNull(0) != false)
    val hardwareId = readAndroidSystemProperty("ro.boot.deviceid")
    check(hardwareId.isNotBlank())
    check(
        subjectCommonName(leaf).equals(
            CosmosActivationContract.expectedAttestationSubject(hardwareId),
            ignoreCase = true,
        ),
    )

    // This is the operation Conscrypt needs during mTLS. A mere key lookup is
    // insufficient because KeyProtection can expose an EC key while rejecting
    // NONEwithECDSA at signing time.
    val transcriptDigest = MessageDigest.getInstance("SHA-256")
        .digest("cosmos-tls-key-check".toByteArray(Charsets.US_ASCII))
    val signature = Signature.getInstance("NONEwithECDSA").run {
        initSign(privateKey)
        update(transcriptDigest)
        sign()
    }
    check(Signature.getInstance("NONEwithECDSA").run {
        initVerify(leaf.publicKey)
        update(transcriptDigest)
        verify(signature)
    })
}

private class FileCosmosActivationRecordPort(
    private val file: File,
) : CosmosActivationRecordPort {
    companion object {
        private const val VERSION = 1
        private const val MAX_RECORD_BYTES = 8 * 1024L
        private const val MAX_SETTING_CHARS = 128
    }

    override fun load(): CosmosActivationRecord? {
        if (!file.isFile) return null
        check(file.length() in 1..MAX_RECORD_BYTES) { "Cosmos activation record is invalid" }
        val bytes = file.readBytes()
        return try {
            check(bytes.size.toLong() in 1..MAX_RECORD_BYTES)
            decode(JSONObject(String(bytes, Charsets.UTF_8)))
        } finally {
            bytes.fill(0)
        }
    }

    override fun save(record: CosmosActivationRecord): Boolean {
        val bytes = encode(record).toString().toByteArray(Charsets.UTF_8)
        check(bytes.size.toLong() in 1..MAX_RECORD_BYTES)
        val temporary = File(file.parentFile, ".${file.name}.${UUID.randomUUID()}.incoming")
        return try {
            FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            Files.move(
                temporary.toPath(),
                file.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            load() == record
        } finally {
            bytes.fill(0)
            temporary.delete()
        }
    }

    override fun clear(): Boolean {
        if (file.exists() && !file.delete()) return false
        return !file.exists()
    }

    private fun encode(record: CosmosActivationRecord): JSONObject = JSONObject()
        .put("version", VERSION)
        .put("phase", record.phase.name)
        .put("previous_remote_mode", record.previousRemoteMode ?: JSONObject.NULL)
        .put("previous_edge_ipv4", record.previousEdgeIpv4 ?: JSONObject.NULL)
        .put("identity_was_present", record.identityWasPresent)
        .put("target_fingerprint_sha256", record.targetFingerprintSha256)
        .put("api_endpoint", record.apiEndpoint)
        .put("onboarding_endpoint", record.onboardingEndpoint)
        .put("target_edge_ipv4", record.targetEdgeIpv4)

    private fun decode(value: JSONObject): CosmosActivationRecord {
        check(value.getInt("version") == VERSION)
        val phase = CosmosActivationPhase.valueOf(value.getString("phase"))
        val previousRemote = nullableBoundedString(value, "previous_remote_mode")
        val previousEdge = nullableBoundedString(value, "previous_edge_ipv4")
        val fingerprint = value.getString("target_fingerprint_sha256")
            .lowercase(Locale.US)
        check(fingerprint.length == 64 && fingerprint.all(Char::isHexDigit))
        val plan = CosmosActivationContract.plan(
            apiEndpoint = value.getString("api_endpoint"),
            onboardingEndpoint = value.getString("onboarding_endpoint"),
            edgeIpv4 = value.getString("target_edge_ipv4"),
        )
        return CosmosActivationRecord(
            phase = phase,
            previousRemoteMode = previousRemote,
            previousEdgeIpv4 = previousEdge,
            identityWasPresent = value.getBoolean("identity_was_present"),
            targetFingerprintSha256 = fingerprint,
            apiEndpoint = plan.apiEndpoint,
            onboardingEndpoint = plan.onboardingEndpoint,
            targetEdgeIpv4 = plan.edgeIpv4,
        )
    }

    private fun nullableBoundedString(value: JSONObject, key: String): String? {
        if (value.isNull(key)) return null
        return value.getString(key).also { text ->
            check(text.length <= MAX_SETTING_CHARS)
        }
    }
}

private fun readAndroidSystemProperty(name: String): String =
    Class.forName("android.os.SystemProperties")
        .getMethod("get", String::class.java)
        .invoke(null, name) as? String ?: ""

private fun Char.isHexDigit(): Boolean =
    this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

private fun parseCertificate(pem: String): X509Certificate =
    CertificateFactory.getInstance("X.509")
        .generateCertificate(ByteArrayInputStream(pem.toByteArray(Charsets.US_ASCII))) as X509Certificate

private fun parsePem(pem: String, label: String): ByteArray {
    val prefix = "-----BEGIN $label-----"
    val suffix = "-----END $label-----"
    check(pem.trim().startsWith(prefix) && pem.trim().endsWith(suffix)) { "Invalid PEM block" }
    val encoded = pem.trim().removePrefix(prefix).removeSuffix(suffix).filterNot(Char::isWhitespace)
    val decoded = Base64.getDecoder().decode(encoded)
    check(decoded.size in 1..8192) { "PEM block is outside the size limit" }
    return decoded
}

private fun subjectCommonName(certificate: X509Certificate): String? =
    certificate.subjectX500Principal.name
        .split(',')
        .firstOrNull { it.startsWith("CN=", ignoreCase = true) }
        ?.substringAfter('=')

private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { byte ->
        "%02x".format(byte.toInt() and 0xff)
    }

private const val CLONE_ROOT_PEM = """-----BEGIN CERTIFICATE-----
MIIBzzCCAXWgAwIBAgIUG0G9aHsMfyhLhDfspkqgDopmdXwwCgYIKoZIzj0EAwIw
PTEbMBkGA1UECgwSaHVtYW5lLWNhcnJ5LWNsb25lMR4wHAYDVQQDDBVDYXJyeSBD
bG9uZSBSb290IEVDIDEwHhcNMjYwODAxMTEzMTQ5WhcNMzYwNzI5MTEzMTQ5WjA9
MRswGQYDVQQKDBJodW1hbmUtY2FycnktY2xvbmUxHjAcBgNVBAMMFUNhcnJ5IENs
b25lIFJvb3QgRUMgMTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABM7QiKCUWid8
QLtJVzmr+bLLEvyRIrel6v+gpdY59d2DgmCo3Qv1f0eNPTHYvIw08Wr+gz7wI1pt
nRGPzfZZv4ujUzBRMB0GA1UdDgQWBBRk8MPuXmmegN70uNHAAz3ewVE5BzAfBgNV
HSMEGDAWgBRk8MPuXmmegN70uNHAAz3ewVE5BzAPBgNVHRMBAf8EBTADAQH/MAoG
CCqGSM49BAMCA0gAMEUCIHWX228mwwn7IACG3gFPYKpVMjlCh1z9cME+aMmIoFUI
AiEArCIbto59wRwtioqqBalsCroF8W5OjMCzqE3jlvN4w18=
-----END CERTIFICATE-----"""
