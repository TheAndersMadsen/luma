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
import android.os.UserManager
import android.provider.Settings
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
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

internal fun compatibleOnboardingPincode(bytes: ByteArray): String? =
    bytes.takeIf { value ->
        value.size == 4 && value.all { byte -> byte.toInt() in 0x30..0x39 }
    }?.let { value -> String(value, Charsets.US_ASCII) }

/**
 * Privileged-maintenance import of one clone DeviceAttestation credential.
 *
 * The private key is piped into this UID-1000 process, validated against the
 * exact Pin hardware id and the pinned clone root, and imported into this
 * process's AndroidKeyStore namespace. Activation publishes the same validated
 * envelope through a bounded one-shot Settings handoff because Ironman's stock
 * provisioning process has a separate AndroidKeyStore namespace. That process
 * deletes the handoff only after its import is readable. No method exports key bytes.
 */
class CosmosIdentityProvider : ContentProvider() {
    companion object {
        // Content URIs survive APK replacement in maintenance tooling. Keep
        // the deployed authority even though the implementation is Cosmos.
        const val AUTHORITY = "com.penumbraos.server.cosmosidentity"
        const val STAGING_NAME = "attestation.json"
        const val ONBOARDING_PINCODE_PATH = "onboarding-pincode"
        const val ADB_PUBLIC_KEY_PATH = "adb-public-key"
        const val METHOD_IMPORT = "IMPORT"
        const val METHOD_STATUS = "STATUS"
        const val METHOD_CLEAR = "CLEAR"
        const val METHOD_ACTIVATE = "ACTIVATE"
        const val METHOD_DEACTIVATE = "DEACTIVATE"
        const val METHOD_ACTIVATION_STATUS = "ACTIVATION_STATUS"
        const val METHOD_ALLOW_ADB = "ALLOW_ADB"
        const val RESULT_OK = "ok"
        const val RESULT_PRESENT = "present"
        const val RESULT_SUBJECT = "subject"
        const val RESULT_FINGERPRINT = "fingerprint_sha256"

        /** Shared by UID 1000. Consumed by the injected clone key manager. */
        const val KEY_ALIAS = CosmosActivationContract.ATTESTATION_KEY_ALIAS

        private const val TAG = "CosmosIdentity"
        private const val MAX_BUNDLE_BYTES = 64 * 1024L
        private const val WRITE_TIMEOUT_SECONDS = 15L
    }

    private val writeLock = Any()
    private val operationLock = Any()
    private var activeWrite: CountDownLatch? = null
    private var writeFailure: String? = null
    private var operationInProgress = false

    /**
     * The validated ADB public key staged by [ADB_PUBLIC_KEY_PATH], consumed
     * one-shot by [METHOD_ALLOW_ADB]. Held in memory only: a process restart
     * discards it and the confirmation fails closed. The line is public
     * material, but it is never logged.
     */
    @Volatile
    private var stagedAdbKey: String? = null

    override fun onCreate(): Boolean {
        stagedAdbKey = null
        runCatching { incomingFile().delete() }
        // Published staging contains one-time private key material. A process
        // restart invalidates the matching maintenance call, so fail closed.
        runCatching { stagingFile().delete() }
        return true
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        enforceCaller()
        if (uri.authority != AUTHORITY) {
            throw FileNotFoundException("Unknown Cosmos maintenance authority")
        }
        if (!mode.contains('w') || mode.contains('r')) {
            throw FileNotFoundException("Cosmos maintenance staging is write-only")
        }

        return when (uri.pathSegments) {
            listOf(STAGING_NAME) -> openIdentityStagingPipe()
            listOf(ONBOARDING_PINCODE_PATH) -> openOnboardingPincodePipe()
            listOf(ADB_PUBLIC_KEY_PATH) -> openAdbPublicKeyPipe()
            else -> throw FileNotFoundException("Unknown Cosmos maintenance path")
        }
    }

    private fun beginStagingWrite(): CountDownLatch = synchronized(writeLock) {
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

    private fun openIdentityStagingPipe(): ParcelFileDescriptor {
        val completion = beginStagingWrite()
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

    private fun openOnboardingPincodePipe(): ParcelFileDescriptor {
        val completion = beginStagingWrite()
        val pipe = ParcelFileDescriptor.createReliablePipe()
        val readEnd = pipe[0]
        val writeEnd = pipe[1]

        Thread({
            var closeWithError = false
            try {
                val bytes = FileInputStream(readEnd.fileDescriptor).use(::readBoundedPincode)
                try {
                    val pincode = compatibleOnboardingPincode(bytes)
                        ?: error("Onboarding pincode has an invalid shape")
                    val resolver = requireNotNull(context).contentResolver
                    check(Settings.Global.getInt(
                        resolver,
                        CosmosActivationContract.REMOTE_MODE_SETTING,
                        0,
                    ) == 1) { "Cosmos activation is required" }
                    check(Settings.Global.getInt(
                        resolver,
                        CosmosActivationContract.DUC_PROVISIONED_SETTING,
                        0,
                    ) != 1) { "Stock onboarding is already complete" }

                    val previous = Settings.Global.getString(
                        resolver,
                        CosmosActivationContract.ONBOARDING_PINCODE_SETTING,
                    )
                    val written = Settings.Global.putString(
                        resolver,
                        CosmosActivationContract.ONBOARDING_PINCODE_SETTING,
                        pincode,
                    ) && Settings.Global.getString(
                        resolver,
                        CosmosActivationContract.ONBOARDING_PINCODE_SETTING,
                    ) == pincode
                    if (!written) {
                        if (previous == null) {
                            resolver.delete(
                                Settings.Global.getUriFor(
                                    CosmosActivationContract.ONBOARDING_PINCODE_SETTING,
                                ),
                                null,
                                null,
                            )
                        } else {
                            Settings.Global.putString(
                                resolver,
                                CosmosActivationContract.ONBOARDING_PINCODE_SETTING,
                                previous,
                            )
                        }
                        error("Onboarding pincode staging failed")
                    }
                } finally {
                    bytes.fill(0)
                }
            } catch (error: Throwable) {
                synchronized(writeLock) {
                    writeFailure = error.javaClass.simpleName
                }
                runCatching {
                    readEnd.closeWithError("Onboarding pincode staging failed")
                    closeWithError = true
                }
                Log.e(TAG, "Onboarding pincode staging failed (${error.javaClass.simpleName})")
            } finally {
                if (!closeWithError) runCatching { readEnd.close() }
                completion.countDown()
            }
        }, "cosmos-onboarding-pincode-stage").start()
        return writeEnd
    }

    /**
     * Stages the operator's ADB public-key line for one [METHOD_ALLOW_ADB]
     * call. Same shape as the onboarding pincode handoff, a write-only pipe,
     * validated at write time, gated on the Cosmos remote flag, because this
     * is the exact value the framework expects on its confirmation path.
     * Guards cited for that flow: the pincode staging gate checks
     * `REMOTE_MODE_SETTING` before touching state, and the write is accepted
     * only when stock onboarding has not completed. The ADB key has no
     * onboarding bound because a lost USB authorization is repaired the same
     * way after activation.
     */
    private fun openAdbPublicKeyPipe(): ParcelFileDescriptor {
        val completion = beginStagingWrite()
        val pipe = ParcelFileDescriptor.createReliablePipe()
        val readEnd = pipe[0]
        val writeEnd = pipe[1]

        Thread({
            var closeWithError = false
            try {
                val bytes = FileInputStream(readEnd.fileDescriptor).use(::readBoundedAdbKey)
                val line = validAdbPublicKeyLine(String(bytes, Charsets.US_ASCII))
                    ?: error("ADB public key has an invalid shape")
                val resolver = requireNotNull(context).contentResolver
                check(Settings.Global.getInt(
                    resolver,
                    CosmosActivationContract.REMOTE_MODE_SETTING,
                    0,
                ) == 1) { "Cosmos activation is required" }
                synchronized(writeLock) {
                    check(stagedAdbKey == null) { "An ADB public key is already staged" }
                    stagedAdbKey = line
                }
            } catch (error: Throwable) {
                synchronized(writeLock) {
                    writeFailure = error.javaClass.simpleName
                }
                runCatching {
                    readEnd.closeWithError("ADB public key staging failed")
                    closeWithError = true
                }
                Log.e(TAG, "ADB public key staging failed (${error.javaClass.simpleName})")
            } finally {
                if (!closeWithError) runCatching { readEnd.close() }
                completion.countDown()
            }
        }, "cosmos-adb-key-stage").start()
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
                    METHOD_ALLOW_ADB -> allowAdb()
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
            requireUserUnlocked()
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
            requireUserUnlocked()
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

                val settings = AndroidCosmosSettingsPort(requireNotNull(context).contentResolver)
                val attestationHandoff = Base64.getEncoder().encodeToString(bytes)
                val transaction = CosmosActivationTransaction(
                    settings = settings,
                    records = activationRecordPort(),
                )
                activationResultBundle(
                    transaction.activate(
                        apiEndpoint = envelope.apiEndpoint,
                        onboardingEndpoint = envelope.onboardingEndpoint,
                        deviceStatusEndpoint = envelope.deviceStatusEndpoint,
                        edgeIpv4 = envelope.edgeIpv4,
                        root = envelope.identity.rootDescriptor,
                        identity = AndroidCosmosIdentityPort(envelope.identity, settings),
                        attestationHandoff = attestationHandoff,
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
            val settings = AndroidCosmosSettingsPort(requireNotNull(context).contentResolver)
            val transaction = CosmosActivationTransaction(
                settings = settings,
                records = activationRecordPort(),
            )
            activationResultBundle(
                transaction.deactivate(
                    AndroidCosmosIdentityPort(
                        candidateBundle = null,
                        settings = settings,
                    ),
                ),
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
            val record = activationRecordPort().load()
            val remoteMode = settings.read(CosmosActivationContract.REMOTE_MODE_SETTING)
            val edgeIpv4 = settings.read(CosmosActivationContract.EDGE_IPV4_SETTING)
            val deviceStatusEndpoint = settings.read(
                CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
            )
            val encodedRoot = settings.read(CosmosActivationContract.ROOT_CERTIFICATE_SETTING)
            val identity = AndroidCosmosIdentityPort(candidateBundle = null, settings = settings).current()
            val rootFingerprint = parseProvisionedCosmosRoot(encodedRoot)?.let {
                sha256Hex(it.encoded)
            }
            val status = reconcileCosmosActivationStatus(
                record = record,
                observed = CosmosActivationObservedState(
                    remoteMode = remoteMode,
                    edgeIpv4 = edgeIpv4,
                    deviceStatusEndpoint = deviceStatusEndpoint,
                    rootCertificatePresent = encodedRoot != null,
                    rootCertificateFingerprintSha256 = rootFingerprint,
                    identityPresent = identity != null,
                    identityUsable = identity?.usableForTls == true,
                    identityFingerprintSha256 = identity?.fingerprintSha256,
                ),
            )
            Bundle().apply {
                putBoolean(RESULT_OK, true)
                putString("state", status.state.wireValue)
                putBoolean("consistent", status.consistent)
                putBoolean("managed", status.managed)
                status.phase?.let { putString("journal_phase", it.name) }
                putBoolean("rollback_failed", status.rollbackFailed)
                putBoolean("rollback_complete", status.rollbackComplete)
                putBoolean("remote_gate_enabled", status.remoteGateEnabled)
                putBoolean("target_matches", status.targetMatches)
                putString("edge_ipv4", edgeIpv4)
                putString("device_status_endpoint", deviceStatusEndpoint)
                putBoolean(RESULT_PRESENT, identity != null)
                putBoolean("identity_usable", identity?.usableForTls == true)
                putString(RESULT_FINGERPRINT, identity?.fingerprintSha256)
                putString("root_certificate_sha256", rootFingerprint)
                putString("api_endpoint", record?.apiEndpoint ?: CosmosActivationContract.API_ENDPOINT)
                putString(
                    "onboarding_endpoint",
                    record?.onboardingEndpoint ?: CosmosActivationContract.ONBOARDING_ENDPOINT,
                )
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Cosmos activation status failed (${error.javaClass.simpleName})")
            Bundle().apply {
                putBoolean(RESULT_OK, false)
                putString("state", CosmosActivationStatusState.INCONSISTENT.wireValue)
                putBoolean("consistent", false)
                putBoolean("managed", false)
                putBoolean("rollback_failed", false)
                putBoolean("rollback_complete", false)
                putBoolean("remote_gate_enabled", false)
                putBoolean("target_matches", false)
                putString("message", "Cosmos activation status is unavailable")
            }
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
        result.deviceStatusEndpoint?.let { putString("device_status_endpoint", it) }
        result.edgeIpv4?.let { putString("edge_ipv4", it) }
        result.identityFingerprintSha256?.let { putString(RESULT_FINGERPRINT, it) }
        result.rootCertificateFingerprintSha256?.let {
            putString("root_certificate_sha256", it)
        }
    }

    /**
     * One-shot confirmation of the staged ADB public key. The stock framework
     * path and its evidence live on [FrameworkAdbAuthorizer]. The gate is
     * re-checked here so a key staged before a deactivation cannot confirm
     * afterwards. The staged value is consumed before anything runs, so a
     * failed confirmation cannot be retried with a stale key silently.
     */
    private fun allowAdb(): Bundle {
        val staged = synchronized(writeLock) {
            val key = stagedAdbKey
            stagedAdbKey = null
            key
        } ?: return result(false, "No staged ADB public key")

        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val remoteGateEnabled = Settings.Global.getInt(
                requireNotNull(context).contentResolver,
                CosmosActivationContract.REMOTE_MODE_SETTING,
                0,
            ) == 1
            val outcome = confirmAdbPublicKey(
                remoteGateEnabled = remoteGateEnabled,
                stagedKey = staged,
                authorizer = FrameworkAdbAuthorizer(),
            )
            if (outcome.ok) {
                Log.w(TAG, "ADB approval confirmed through the stock framework path")
            } else {
                Log.e(TAG, "ADB approval was not confirmed: ${outcome.message}")
            }
            result(outcome.ok, outcome.message)
        } finally {
            Binder.restoreCallingIdentity(callingIdentity)
        }
    }

    private fun identityStatus(): Bundle {
        val callingIdentity = Binder.clearCallingIdentity()
        return try {
            val settings = AndroidCosmosSettingsPort(requireNotNull(context).contentResolver)
            val identity = AndroidCosmosIdentityPort(candidateBundle = null, settings = settings).current()
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
            check(AndroidCosmosSettingsPort(resolver).write(
                CosmosActivationContract.ROOT_CERTIFICATE_SETTING,
                null,
            ))
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
        File(
            requireNotNull(context).filesDir,
            PersistentConfigVaultFormat.ACTIVATION_RECORD_FILE_NAME,
        )

    private fun activationRecordPort(): CosmosActivationRecordPort =
        FileCosmosActivationRecordPort(activationRecordFile()) {
            PersistentConfigVaultClient.commit(requireNotNull(context))
            true
        }

    private fun readSystemProperty(name: String): String = readAndroidSystemProperty(name)

    private fun requireUserUnlocked() {
        val userManager = requireNotNull(context).getSystemService(UserManager::class.java)
        check(userManager?.isUserUnlocked == true) { "Unlock the Pin before Cosmos activation" }
    }

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

    private fun readBoundedPincode(input: FileInputStream): ByteArray {
        val scratch = ByteArray(5)
        var total = 0
        while (total < scratch.size) {
            val read = input.read(scratch, total, scratch.size - total)
            if (read < 0) break
            if (read == 0) continue
            total += read
        }
        return scratch.copyOf(total).also { scratch.fill(0) }
    }

    /** One bound read. The shape check rejects anything that is not one key line. */
    private fun readBoundedAdbKey(input: FileInputStream): ByteArray {
        val scratch = ByteArray(MAX_ADB_PUBLIC_KEY_LINE_CHARS + 1)
        var total = 0
        while (total < scratch.size) {
            val read = input.read(scratch, total, scratch.size - total)
            if (read < 0) break
            if (read == 0) continue
            total += read
        }
        return scratch.copyOf(total)
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
    val root: X509Certificate,
) {
    val descriptor: CosmosIdentityDescriptor
        get() = CosmosIdentityDescriptor(
            fingerprintSha256 = sha256Hex(leaf.encoded),
            subject = leaf.subjectX500Principal.name,
            usableForTls = true,
        )

    val rootDescriptor: CosmosRootDescriptor
        get() = CosmosRootDescriptor(
            certificateDerBase64 = Base64.getEncoder().encodeToString(root.encoded),
            fingerprintSha256 = sha256Hex(root.encoded),
        )

    fun importIntoAndroidKeyStore(alias: String) {
        validate()
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(alias)) {
            val existing = store.getCertificate(alias) as? X509Certificate
            check(existing != null && MessageDigest.isEqual(existing.encoded, leaf.encoded)) {
                "A different clone identity already exists"
            }
            check(androidKeyStoreIdentity(store, alias, root)?.usableForTls == true) {
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
            val installed = androidKeyStoreIdentity(store, alias, root)
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
        validateCosmosRoot(root)
        check(issuer.issuerX500Principal == root.subjectX500Principal)
        issuer.verify(root.publicKey)
        check(leaf.issuerX500Principal == issuer.subjectX500Principal)
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
                root = checkNotNull(
                    parseProvisionedCosmosRoot(objectValue.getString("root_certificate_der_b64")),
                ) { "Cosmos root certificate is invalid" },
            )
        }
    }
}

private data class CosmosActivationEnvelope(
    val apiEndpoint: String,
    val onboardingEndpoint: String,
    val deviceStatusEndpoint: String,
    val edgeIpv4: String,
    val identity: CosmosAttestationBundle,
) {
    companion object {
        fun parse(json: String): CosmosActivationEnvelope {
            val value = JSONObject(json)
            return CosmosActivationEnvelope(
                apiEndpoint = value.getString("api_endpoint"),
                onboardingEndpoint = value.getString("onboarding_endpoint"),
                deviceStatusEndpoint = value.getString("device_status_endpoint"),
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
    private val settings: CosmosSettingsPort,
) : CosmosIdentityPort {
    override fun candidate(): CosmosIdentityDescriptor =
        candidateBundle?.descriptor ?: error("No candidate identity was supplied")

    override fun current(): CosmosIdentityDescriptor? {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val root = parseProvisionedCosmosRoot(
            settings.read(CosmosActivationContract.ROOT_CERTIFICATE_SETTING),
        )
        return androidKeyStoreIdentity(store, CosmosActivationContract.ATTESTATION_KEY_ALIAS, root)
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
    root: X509Certificate?,
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
        validateStoredCosmosIdentity(key, leaf, issuer, checkNotNull(root))
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
    root: X509Certificate,
) {
    check(privateKey.algorithm.equals("EC", ignoreCase = true))
    validateCosmosRoot(root)
    check(issuer.issuerX500Principal == root.subjectX500Principal)
    issuer.verify(root.publicKey)
    check(leaf.issuerX500Principal == issuer.subjectX500Principal)
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

internal object CosmosActivationRecordCodec {
    private const val VERSION = 3
    internal const val MAX_RECORD_BYTES = 24 * 1024
    private const val MAX_SETTING_CHARS = 128
    private const val MAX_ROOT_SETTING_CHARS = 16 * 1024
    private val REQUIRED_KEYS = setOf(
        "version",
        "phase",
        "previous_remote_mode",
        "previous_edge_ipv4",
        "previous_root_certificate_der_b64",
        "previous_device_status_endpoint",
        "identity_was_present",
        "target_fingerprint_sha256",
        "target_root_fingerprint_sha256",
        "api_endpoint",
        "onboarding_endpoint",
        "device_status_endpoint",
        "target_edge_ipv4",
    )
    private const val ROLLBACK_FAILED_KEY = "rollback_failed"

    fun encode(record: CosmosActivationRecord): ByteArray {
        val bytes = JSONObject()
            .put("version", VERSION)
            .put("phase", record.phase.name)
            .put("previous_remote_mode", record.previousRemoteMode ?: JSONObject.NULL)
            .put("previous_edge_ipv4", record.previousEdgeIpv4 ?: JSONObject.NULL)
            .put(
                "previous_root_certificate_der_b64",
                record.previousRootCertificateDerBase64 ?: JSONObject.NULL,
            )
            .put(
                "previous_device_status_endpoint",
                record.previousDeviceStatusEndpoint ?: JSONObject.NULL,
            )
            .put("identity_was_present", record.identityWasPresent)
            .put("target_fingerprint_sha256", record.targetFingerprintSha256)
            .put("target_root_fingerprint_sha256", record.targetRootFingerprintSha256)
            .put("api_endpoint", record.apiEndpoint)
            .put("onboarding_endpoint", record.onboardingEndpoint)
            .put("device_status_endpoint", record.deviceStatusEndpoint)
            .put("target_edge_ipv4", record.targetEdgeIpv4)
            .put(ROLLBACK_FAILED_KEY, record.rollbackFailed)
            .toString()
            .toByteArray(Charsets.UTF_8)
        check(bytes.size in 1..MAX_RECORD_BYTES)
        return bytes
    }

    fun decode(bytes: ByteArray): CosmosActivationRecord {
        check(bytes.size in 1..MAX_RECORD_BYTES) { "Cosmos activation record is invalid" }
        val value = JSONObject(strictUtf8(bytes))
        val keys = mutableSetOf<String>()
        val iterator = value.keys()
        while (iterator.hasNext()) keys += iterator.next()
        check(keys == REQUIRED_KEYS || keys == REQUIRED_KEYS + ROLLBACK_FAILED_KEY) {
            "Cosmos activation record fields are invalid"
        }
        check(value.getInt("version") == VERSION)
        val phase = CosmosActivationPhase.valueOf(value.getString("phase"))
        val previousRemote = nullableBoundedString(value, "previous_remote_mode")
        val previousEdge = nullableBoundedString(value, "previous_edge_ipv4")
        val previousRoot = nullableBoundedString(
            value,
            "previous_root_certificate_der_b64",
            MAX_ROOT_SETTING_CHARS,
        )
        val previousDeviceStatus = nullableBoundedString(
            value,
            "previous_device_status_endpoint",
            2048,
        )
        val fingerprint = value.getString("target_fingerprint_sha256")
            .lowercase(Locale.US)
        check(fingerprint.length == 64 && fingerprint.all(Char::isHexDigit))
        val rootFingerprint = value.getString("target_root_fingerprint_sha256")
            .lowercase(Locale.US)
        check(rootFingerprint.length == 64 && rootFingerprint.all(Char::isHexDigit))
        val plan = CosmosActivationContract.plan(
            apiEndpoint = value.getString("api_endpoint"),
            onboardingEndpoint = value.getString("onboarding_endpoint"),
            deviceStatusEndpoint = value.getString("device_status_endpoint"),
            edgeIpv4 = value.getString("target_edge_ipv4"),
        )
        return CosmosActivationRecord(
            phase = phase,
            previousRemoteMode = previousRemote,
            previousEdgeIpv4 = previousEdge,
            previousRootCertificateDerBase64 = previousRoot,
            previousDeviceStatusEndpoint = previousDeviceStatus,
            identityWasPresent = value.getBoolean("identity_was_present"),
            targetFingerprintSha256 = fingerprint,
            targetRootFingerprintSha256 = rootFingerprint,
            apiEndpoint = plan.apiEndpoint,
            onboardingEndpoint = plan.onboardingEndpoint,
            deviceStatusEndpoint = plan.deviceStatusEndpoint,
            targetEdgeIpv4 = plan.edgeIpv4,
            rollbackFailed = value.optBoolean(ROLLBACK_FAILED_KEY, false),
        )
    }

    private fun strictUtf8(bytes: ByteArray): String = Charsets.UTF_8
        .newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()

    private fun nullableBoundedString(
        value: JSONObject,
        key: String,
        maximumChars: Int = MAX_SETTING_CHARS,
    ): String? {
        if (value.isNull(key)) return null
        return value.getString(key).also { text ->
            check(text.length <= maximumChars)
        }
    }
}

internal class FileCosmosActivationRecordPort(
    private val file: File,
    private val commitVault: () -> Boolean = { true },
) : CosmosActivationRecordPort {
    override fun load(): CosmosActivationRecord? {
        if (!file.isFile) return null
        check(file.length() in 1..CosmosActivationRecordCodec.MAX_RECORD_BYTES.toLong()) {
            "Cosmos activation record is invalid"
        }
        val buffer = ByteArray(CosmosActivationRecordCodec.MAX_RECORD_BYTES + 1)
        val size = FileInputStream(file).use { input ->
            var offset = 0
            while (offset < buffer.size) {
                val read = input.read(buffer, offset, buffer.size - offset)
                if (read <= 0) break
                offset += read
            }
            offset
        }
        check(size in 1..CosmosActivationRecordCodec.MAX_RECORD_BYTES) {
            buffer.fill(0)
            "Cosmos activation record is invalid"
        }
        val bytes = buffer.copyOf(size)
        buffer.fill(0)
        return try {
            CosmosActivationRecordCodec.decode(bytes)
        } finally {
            bytes.fill(0)
        }
    }

    override fun save(record: CosmosActivationRecord): Boolean {
        val bytes = CosmosActivationRecordCodec.encode(record)
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
            load() == record && runCatching(commitVault).getOrDefault(false)
        } finally {
            bytes.fill(0)
            temporary.delete()
        }
    }

    override fun clear(): Boolean {
        if (file.exists() && !file.delete()) return false
        return !file.exists() && runCatching(commitVault).getOrDefault(false)
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

internal fun parseProvisionedCosmosRoot(encoded: String?): X509Certificate? = runCatching {
    require(!encoded.isNullOrEmpty() && encoded.length <= 16_384)
    val der = Base64.getDecoder().decode(encoded)
    require(der.size in 1..8192)
    require(Base64.getEncoder().encodeToString(der) == encoded)
    val certificate = CertificateFactory.getInstance("X.509")
        .generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    require(MessageDigest.isEqual(certificate.encoded, der))
    validateCosmosRoot(certificate)
    certificate
}.getOrNull()

private fun validateCosmosRoot(root: X509Certificate) {
    check(root.basicConstraints >= 0) { "Cosmos root is not a CA" }
    check(root.subjectX500Principal == root.issuerX500Principal) {
        "Cosmos root is not self-issued"
    }
    root.verify(root.publicKey)
    root.checkValidity()
}
