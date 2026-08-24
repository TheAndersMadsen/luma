package com.penumbraos.hook

import android.app.Application
import android.net.Network
import android.provider.Settings
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import android.util.Log
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.Socket
import java.security.KeyFactory
import java.security.Principal
import java.security.PrivateKey
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.security.Signature
import java.util.Base64
import java.util.Collections
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.KeyManager
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509KeyManager
import org.json.JSONObject

/** Exact-host, exact-root transport for the operator-owned Cosmos service. */
internal object CosmosRemoteTransport {
    private const val TAG = "PenumbraHook"

    internal const val ENABLED_SETTING = "penumbra_cosmos_remote_mode"
    internal const val EDGE_IPV4_SETTING = "penumbra_cosmos_edge_ipv4"
    internal const val ROOT_CERTIFICATE_SETTING = "penumbra_cosmos_root_certificate_der_b64"
    internal const val ATTESTATION_KEY_ALIAS = "penumbra_cosmos_device_attestation_v1"
    internal const val ATTESTATION_BUNDLE_SETTING = "penumbra_cosmos_attestation_bundle_b64"
    internal const val ATTESTATION_PRODUCT_ID = "00000001"

    internal const val PROVISIONING_PROCESS = "hu.ma.ne.ironman:provisioning"
    private const val DIRECT_ATTESTATION_KEY_MANAGER =
        "humaneinternal.system.credentials.DeviceAttestationCredentialKeyManager"
    private const val ONBOARDING_GATEWAY = "onboarding.cosmos.humane.cloud:443"
    private const val MAX_ATTESTATION_BUNDLE_BYTES = 64 * 1024

    private val credentialFactoryClasses = listOf(
        "humaneinternal.system.credentials.DeviceCredentialKeyManagersFactory",
        "humane.security.credentials.credentials.DeviceCredentialKeyManagersFactory",
    )

    private val allowedHosts = setOf(
        "api.cosmos.humane.cloud",
        "onboarding.cosmos.humane.cloud",
    )

    /** Exact cleartext connectivity authorities retained across stock firmware shapes. */
    private val connectivityHosts = setOf(
        "connectivity-check.cosmos.humane.cloud",
        "n.cosmos.humane.cloud",
    )

    private val allowedNetworkHosts = allowedHosts + connectivityHosts

    private val remoteGateways = mapOf(
        "api.prod.humane.cloud" to "api.cosmos.humane.cloud:443",
        "api.cosmos.humane.cloud" to "api.cosmos.humane.cloud:443",
        "onboarding.prod.humane.cloud" to "onboarding.cosmos.humane.cloud:443",
        "onboarding.cosmos.humane.cloud" to "onboarding.cosmos.humane.cloud:443",
    )

    private val networkDnsInstalled = AtomicBoolean(false)

    fun isEnabled(): Boolean {
        val application = currentApplication() ?: return false
        return runCatching {
            Settings.Global.getInt(application.contentResolver, ENABLED_SETTING, 0) == 1
        }.getOrDefault(false)
    }

    internal fun isAllowedGateway(gateway: String?): Boolean =
        gatewayHost(gateway)?.let(allowedHosts::contains) == true

    internal fun isAllowedNetworkHost(host: String?): Boolean =
        host?.trim()?.lowercase()?.let(allowedNetworkHosts::contains) == true

    internal fun resolvedNetworkAddress(host: String?, configuredAddress: ByteArray): InetAddress? {
        val normalized = host?.trim()?.lowercase() ?: return null
        if (normalized !in allowedNetworkHosts) return null
        return InetAddress.getByAddress(normalized, configuredAddress)
    }

    internal fun redirectedGateway(gateway: String?): String? =
        redirectedGatewayForProcess(gateway, null)

    internal fun redirectedGatewayForCurrentProcess(gateway: String?): String? =
        redirectedGatewayForProcess(gateway, currentProcessName())

    internal fun redirectedGatewayForProcess(gateway: String?, processName: String?): String? {
        val mapped = gatewayHost(gateway)?.let(remoteGateways::get) ?: return null
        // The stock provisioning service asks ChannelFactory for the API
        // authority even though it then selects DeviceAttestation credentials.
        // Keep that bootstrap traffic on the independently trusted onboarding
        // plane. Other Ironman processes retain the normal API mapping.
        return if (processName == PROVISIONING_PROCESS) ONBOARDING_GATEWAY else mapped
    }

    internal fun shouldBridgeDirectAttestation(
        className: String?,
        processName: String?,
        cloneEnabled: Boolean,
    ): Boolean = cloneEnabled &&
        processName == PROVISIONING_PROCESS &&
        className == DIRECT_ATTESTATION_KEY_MANAGER

    internal fun directAttestationKeyManager(): X509KeyManager =
        AndroidKeyStoreAttestationKeyManager()

    internal fun gatewayHost(gateway: String?): String? {
        val value = gateway?.trim()?.lowercase()?.removePrefix("https://") ?: return null
        if (value.isEmpty() || value.contains('/') || value.contains('@')) return null
        val host = value.substringBefore(':')
        val port = value.substringAfter(':', "443")
        return host.takeIf { port == "443" }
    }

    internal fun parseIpv4(value: String?): ByteArray? {
        val parts = value?.trim()?.split('.') ?: return null
        if (parts.size != 4) return null
        val octets = parts.map { part ->
            if (part.isEmpty() || part.length > 3 || !part.all(Char::isDigit)) return null
            part.toIntOrNull()?.takeIf { it in 0..255 } ?: return null
        }
        return ByteArray(4) { index -> octets[index].toByte() }
    }

    fun installDnsResolver(cl: ClassLoader) {
        val resolver = try {
            cl.loadClass("io.grpc.internal.DnsNameResolver\$JdkAddressResolver")
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  gRPC DNS resolver unavailable; remote Cosmos transport not installed")
            return
        }
        HookUtils.hookMethodBefore(
            resolver,
            "resolveAddress",
            arrayOf(String::class.java),
        ) { param ->
            if (!isEnabled()) return@hookMethodBefore
            val host = (param.args.getOrNull(0) as? String)?.lowercase()
                ?: return@hookMethodBefore
            if (host !in allowedHosts) return@hookMethodBefore
            param.result = Collections.unmodifiableList(
                listOf(InetAddress.getByAddress(host, configuredAddress())),
            )
            Log.w(TAG, "  Remote Cosmos DNS override applied for an allowlisted host")
        }
    }

    /** Exact per-Network DNS used by stock cleartext connectivity checks. */
    fun installNetworkDnsResolver() {
        if (!networkDnsInstalled.compareAndSet(false, true)) return
        try {
            HookUtils.hookMethodBefore(
                Network::class.java,
                "getAllByName",
                arrayOf(String::class.java),
            ) { param ->
                if (!isEnabled()) return@hookMethodBefore
                val address = resolvedNetworkAddress(
                    param.args.getOrNull(0) as? String,
                    configuredAddress(),
                ) ?: return@hookMethodBefore
                param.result = arrayOf(address)
                Log.w(
                    TAG,
                    "  Remote Cosmos per-network DNS override applied for an allowlisted host",
                )
            }
        } catch (error: Throwable) {
            networkDnsInstalled.set(false)
            throw error
        }
    }

    /**
     * Replace only the DeviceAttestation manager used by the onboarding gateway.
     * The DeviceUser manager remains stock so the real OPAQUE ceremony can write
     * and subsequently use the clone-issued DeviceUser credential normally.
     */
    fun installCloneAttestationIdentity(cl: ClassLoader) {
        var hooked = 0
        for (className in credentialFactoryClasses) {
            val factory = try {
                cl.loadClass(className)
            } catch (_: ClassNotFoundException) {
                continue
            }
            HookUtils.hookMethodAfter(
                factory,
                "newDeviceAttestationCredKeyManager",
                emptyArray(),
            ) { param ->
                if (!isEnabled() || param.throwable != null) return@hookMethodAfter
                try {
                    param.result = AndroidKeyStoreAttestationKeyManager()
                    Log.w(TAG, "  Cosmos attestation identity selected")
                } catch (error: Throwable) {
                    // Clone mode must never fall back to a stock Humane identity.
                    param.throwable = SecurityException(
                        "Cosmos attestation identity is unavailable",
                        error,
                    )
                }
            }
            hooked++
        }
        if (hooked == 0) {
            Log.w(TAG, "  No DeviceAttestation credential factory found")
        }
    }

    /**
     * Whether the clone-trust hook is in place on this exact ChannelFactory.
     *
     * The redirect below is gated on this: dialing the clone :443 without clone
     * trust installed is precisely the handshake failure this transport exists to
     * avoid, so a false result must stop the redirect, not proceed into it.
     */
    fun installCloneTrust(channelFactory: Class<*>): Boolean =
        HookUtils.hookMethodBefore(
            channelFactory,
            "getSslContext",
            arrayOf(X509KeyManager::class.java),
        ) { param ->
            if (!isEnabled()) return@hookMethodBefore
            val keyManager = param.args.getOrNull(0) as? X509KeyManager
            if (keyManager == null) {
                param.throwable = SecurityException("Remote Cosmos client identity is unavailable")
                return@hookMethodBefore
            }
            try {
                param.result = cloneSslContext(keyManager)
                Log.w(TAG, "  Cosmos trust root installed")
            } catch (error: Throwable) {
                // Fail closed: never fall through to Humane trust while clone
                // mode is selected.
                param.throwable = SecurityException(
                    "Cosmos trust root could not be installed",
                    error,
                )
            }
        }

    /**
     * The clone :443 listener presents a chain signed by the operator's private
     * CA — a root no OS platform trust store and no stock Humane BKS bundle
     * contains. So the redirect to the clone gateway is only safe once
     * [installCloneTrust] has swapped this ChannelFactory's TLS trust to the
     * clone root. If that hook could not be installed (the `getSslContext` seam
     * is absent or unhookable on this firmware), redirecting anyway sends every
     * clone-bound channel — the push relay's persistent `Subscribe` stream above
     * all — into a TLS handshake that dies against the private CA, and on the
     * device that surfaces only as an endless reconnect-with-backoff storm.
     *
     * Returns true when a clone redirect MUST be refused because clone trust is
     * not in place. Pure so both arms are unit-tested without a live process;
     * `cloneEnabled` is the caller's `isEnabled()` and `cloneTrustInstalled` is
     * the per-ChannelFactory result of [installCloneTrust].
     */
    internal fun cloneRedirectRefusedForMissingTrust(
        cloneEnabled: Boolean,
        cloneTrustInstalled: Boolean,
    ): Boolean = cloneEnabled && !cloneTrustInstalled

    private fun configuredAddress(): ByteArray {
        val application = currentApplication()
            ?: throw SecurityException("Remote Cosmos application context is unavailable")
        val configured = Settings.Global.getString(
            application.contentResolver,
            EDGE_IPV4_SETTING,
        )
        return parseIpv4(configured)
            ?: throw SecurityException("Remote Cosmos edge IPv4 is missing or invalid")
    }

    private fun cloneSslContext(keyManager: X509KeyManager): SSLContext {
        val certificate = configuredRootCertificate()
        val store = KeyStore.getInstance(KeyStore.getDefaultType())
        store.load(null, null)
        store.setCertificateEntry("cosmos_clone_root_ec_1", certificate)
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        trust.init(store)
        return SSLContext.getInstance("TLS").apply {
            init(
                arrayOf<KeyManager>(ReorderedX509KeyManager(keyManager)),
                trust.trustManagers,
                null,
            )
        }
    }

    private class ReorderedX509KeyManager(
        private val delegate: X509KeyManager,
    ) : X509KeyManager {
        override fun chooseClientAlias(
            keyType: Array<out String>?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String? = delegate.chooseClientAlias(keyType, issuers, socket)

        override fun chooseServerAlias(
            keyType: String?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String? = delegate.chooseServerAlias(keyType, issuers, socket)

        override fun getClientAliases(
            keyType: String?,
            issuers: Array<out Principal>?,
        ): Array<String>? = delegate.getClientAliases(keyType, issuers)

        override fun getServerAliases(
            keyType: String?,
            issuers: Array<out Principal>?,
        ): Array<String>? = delegate.getServerAliases(keyType, issuers)

        override fun getPrivateKey(alias: String?): PrivateKey? = delegate.getPrivateKey(alias)

        override fun getCertificateChain(alias: String?): Array<X509Certificate>? {
            val chain = delegate.getCertificateChain(alias) ?: return null
            if (chain.size < 3) return chain
            val ordered = mutableListOf(chain.first())
            val remaining = chain.drop(1).toMutableList()
            while (remaining.isNotEmpty()) {
                val issuer = ordered.last().issuerX500Principal
                val index = remaining.indexOfFirst { certificate ->
                    certificate.subjectX500Principal == issuer
                }
                if (index < 0) {
                    throw SecurityException("Remote Cosmos client certificate chain is not linkable")
                }
                ordered += remaining.removeAt(index)
            }
            return ordered.toTypedArray()
        }
    }

    private class AndroidKeyStoreAttestationKeyManager : X509KeyManager {
        private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

        init {
            if (isProvisioningProcess() && hasPendingAttestation()) {
                importPendingAttestation(store)
            }
            check(store.containsAlias(ATTESTATION_KEY_ALIAS)) {
                "Clone DeviceAttestation alias is missing"
            }
            check(store.getKey(ATTESTATION_KEY_ALIAS, null) is PrivateKey) {
                "Clone DeviceAttestation private key is missing"
            }
            check(store.getCertificateChain(ATTESTATION_KEY_ALIAS)?.isNotEmpty() == true) {
                "Clone DeviceAttestation certificate chain is missing"
            }
        }

        override fun chooseClientAlias(
            keyType: Array<out String>?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String = ATTESTATION_KEY_ALIAS

        override fun chooseServerAlias(
            keyType: String?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String? = null

        override fun getClientAliases(
            keyType: String?,
            issuers: Array<out Principal>?,
        ): Array<String> = arrayOf(ATTESTATION_KEY_ALIAS)

        override fun getServerAliases(
            keyType: String?,
            issuers: Array<out Principal>?,
        ): Array<String> = emptyArray()

        override fun getPrivateKey(alias: String?): PrivateKey? =
            store.getKey(ATTESTATION_KEY_ALIAS, null) as? PrivateKey

        override fun getCertificateChain(alias: String?): Array<X509Certificate> =
            store.getCertificateChain(ATTESTATION_KEY_ALIAS)
                .map { certificate -> certificate as X509Certificate }
                .toTypedArray()
    }

    internal fun isCompatibleAttestationDeviceId(value: String?): Boolean =
        !value.isNullOrEmpty() && value.all { character ->
            character in '0'..'9' || character in 'a'..'f' || character in 'A'..'F'
        }

    internal fun isCompatibleAttestationSubject(deviceId: String, commonName: String?): Boolean =
        commonName.equals(
            "V:01:D:${deviceId.lowercase(Locale.US)}:P:$ATTESTATION_PRODUCT_ID",
            ignoreCase = true,
        )

    private fun isProvisioningProcess(): Boolean =
        currentProcessName() == PROVISIONING_PROCESS

    private fun hasPendingAttestation(): Boolean {
        val application = currentApplication() ?: return false
        return Settings.Global.getString(
            application.contentResolver,
            ATTESTATION_BUNDLE_SETTING,
        ) != null
    }

    private fun currentProcessName(): String? =
        runCatching { Application.getProcessName() }.getOrNull()

    private fun importPendingAttestation(store: KeyStore) {
        val application = currentApplication()
            ?: throw SecurityException("Remote Cosmos application context is unavailable")
        val resolver = application.contentResolver
        val encoded = Settings.Global.getString(resolver, ATTESTATION_BUNDLE_SETTING)
            ?: return
        check(encoded.length <= MAX_ATTESTATION_BUNDLE_BYTES * 2) {
            "Clone DeviceAttestation staging value is too large"
        }
        check(Settings.Global.putString(resolver, ATTESTATION_BUNDLE_SETTING, null)) {
            "Clone DeviceAttestation staging value could not be removed"
        }

        val decoded = Base64.getDecoder().decode(encoded)
        try {
            check(decoded.size in 1..MAX_ATTESTATION_BUNDLE_BYTES) {
                "Clone DeviceAttestation bundle is outside the size limit"
            }
            val bundle = JSONObject(String(decoded, Charsets.UTF_8))
            val deviceId = bundle.getString("device_id").trim().lowercase(Locale.US)
            check(isCompatibleAttestationDeviceId(deviceId)) { "Invalid clone device id" }
            val hardwareId = readSystemProperty("ro.boot.deviceid")
            check(deviceId.equals(hardwareId, ignoreCase = true)) {
                "Clone credential does not name this Pin"
            }

            val privateKeyBytes = parsePem(bundle.getString("private_key_pem"), "PRIVATE KEY")
            val privateKey = try {
                KeyFactory.getInstance("EC").generatePrivate(
                    PKCS8EncodedKeySpec(privateKeyBytes),
                )
            } finally {
                privateKeyBytes.fill(0)
            }
            val leaf = parseCertificate(bundle.getString("certificate_pem"))
            val issuer = parseCertificate(bundle.getString("ca_certificate_pem"))
            validateAttestation(deviceId, privateKey, leaf, issuer)

            val protection = KeyProtection.Builder(KeyProperties.PURPOSE_SIGN)
                .setDigests(
                    // Conscrypt pre-hashes the ECDSA TLS transcript and asks
                    // AndroidKeyStore for NONEwithECDSA.
                    KeyProperties.DIGEST_NONE,
                    KeyProperties.DIGEST_SHA256,
                    KeyProperties.DIGEST_SHA384,
                    KeyProperties.DIGEST_SHA512,
                )
                .setUserAuthenticationRequired(false)
                .build()
            store.setEntry(
                ATTESTATION_KEY_ALIAS,
                KeyStore.PrivateKeyEntry(privateKey, arrayOf(leaf, issuer)),
                protection,
            )
            check(store.getKey(ATTESTATION_KEY_ALIAS, null) is PrivateKey)
            check(store.getCertificateChain(ATTESTATION_KEY_ALIAS)?.isNotEmpty() == true)
            Log.w(TAG, "  Cosmos attestation identity imported in provisioning namespace")
        } finally {
            decoded.fill(0)
        }
    }

    private fun validateAttestation(
        deviceId: String,
        privateKey: PrivateKey,
        leaf: X509Certificate,
        issuer: X509Certificate,
    ) {
        check(privateKey.algorithm.equals("EC", ignoreCase = true))
        val root = configuredRootCertificate()
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
        check(isCompatibleAttestationSubject(deviceId, subjectCommonName(leaf)))
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
        })
    }

    private fun parseCertificate(pem: String): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(
            ByteArrayInputStream(pem.toByteArray(Charsets.US_ASCII)),
        ) as X509Certificate

    private fun configuredRootCertificate(): X509Certificate {
        val application = currentApplication()
            ?: throw SecurityException("Remote Cosmos application context is unavailable")
        return parseProvisionedRootCertificate(
            Settings.Global.getString(application.contentResolver, ROOT_CERTIFICATE_SETTING),
        ) ?: throw SecurityException("Remote Cosmos root certificate is missing or invalid")
    }

    internal fun parseProvisionedRootCertificate(encoded: String?): X509Certificate? = runCatching {
        require(!encoded.isNullOrEmpty() && encoded.length <= 16_384)
        val der = Base64.getDecoder().decode(encoded)
        require(der.size in 1..8192)
        require(Base64.getEncoder().encodeToString(der) == encoded)
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(der)) as X509Certificate
        require(MessageDigest.isEqual(certificate.encoded, der))
        require(certificate.basicConstraints >= 0)
        require(certificate.subjectX500Principal == certificate.issuerX500Principal)
        certificate.verify(certificate.publicKey)
        certificate.checkValidity()
        certificate
    }.getOrNull()

    private fun parsePem(pem: String, label: String): ByteArray {
        val prefix = "-----BEGIN $label-----"
        val suffix = "-----END $label-----"
        val trimmed = pem.trim()
        check(trimmed.startsWith(prefix) && trimmed.endsWith(suffix))
        val decoded = Base64.getDecoder().decode(
            trimmed.removePrefix(prefix).removeSuffix(suffix).filterNot(Char::isWhitespace),
        )
        check(decoded.size in 1..8192)
        return decoded
    }

    private fun subjectCommonName(certificate: X509Certificate): String? =
        certificate.subjectX500Principal.name
            .split(',')
            .firstOrNull { it.startsWith("CN=", ignoreCase = true) }
            ?.substringAfter('=')

    private fun readSystemProperty(name: String): String =
        Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java)
            .invoke(null, name) as? String ?: ""

    internal fun currentApplication(): Application? = runCatching {
        val activityThread = Class.forName("android.app.ActivityThread")
        val method = activityThread.getDeclaredMethod("currentApplication")
        method.isAccessible = true
        method.invoke(null) as? Application
    }.getOrNull()
}
