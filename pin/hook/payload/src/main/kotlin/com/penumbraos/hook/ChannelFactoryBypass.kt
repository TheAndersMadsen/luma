package com.penumbraos.hook

import android.app.Application
import android.net.Uri
import android.util.Log
import java.lang.reflect.Array
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.util.Collections
import java.util.WeakHashMap

/**
 * Redirect all gRPC traffic to the local mock server by hooking
 * ChannelFactory.getGatewayUri() in every process that has it on classpath.
 *
 * Two ChannelFactory class names exist across Humane APKs:
 * - humaneinternal.system.network.ChannelFactory (ironman, photography, krypto)
 * - humane.grandcentral.network.ChannelFactory   (grandcentral)
 *
 * Both have the same getGatewayUri() method that returns the gRPC endpoint.
 * By returning our mock server address with a non-443 port, ChannelFactory's
 * own newChannel() logic triggers usePlaintext() — no TLS/mTLS needed.
 */
object ChannelFactoryBypass {

    private const val TAG = "PenumbraHook"

    /** Mock server address. Non-443 port triggers usePlaintext() in ChannelFactory. */
    const val MOCK_SERVER_URI = "127.0.0.1:9090"

    internal const val AUTH_PROVIDER_URI = "content://com.penumbraos.server.grpcauth"
    internal const val AUTH_PROVIDER_METHOD = "GET_TOKEN"
    internal const val AUTH_PROVIDER_RESULT = "token"
    private const val AUTHORIZATION_HEADER = "authorization"
    private const val MIN_TOKEN_BYTES = 32
    private const val MAX_TOKEN_BYTES = 512

    private val installedClassLoaders = Collections.synchronizedSet(
        Collections.newSetFromMap(WeakHashMap<ClassLoader, Boolean>()),
    )

    private val CHANNEL_FACTORY_CLASSES = listOf(
        "humaneinternal.system.network.ChannelFactory",
        "humane.grandcentral.network.ChannelFactory",
    )

    fun install(cl: ClassLoader) = install(cl, localTransport = true)

    /** Onboarding must remain stock unless the explicit clone setting is enabled. */
    fun installRemoteOnly(cl: ClassLoader) = install(cl, localTransport = false)

    private fun install(cl: ClassLoader, localTransport: Boolean) {
        if (!installedClassLoaders.add(cl)) {
            Log.w(TAG, "  ChannelFactory local transport already installed")
            return
        }

        if (localTransport) {
            val auth = try {
                GrpcAuthReflection.resolve(cl)
            } catch (error: Throwable) {
                installedClassLoaders.remove(cl)
                Log.e(TAG, "  Local gRPC credential seam unavailable; redirect not installed", error)
                return
            }
            if (!installCredentialInterceptor(cl, auth)) {
                installedClassLoaders.remove(cl)
                Log.e(TAG, "  Local gRPC credential hook failed; redirect not installed")
                return
            }
        }

        // Remote Carry mode keeps the stock authority and real enrollment
        // ceremony. It overrides resolution only for an exact allowlist and
        // selects only clone trust/identity material. Clearing the setting
        // restores the existing local behavior.
        CarryRemoteTransport.installDnsResolver(cl)
        CarryRemoteTransport.installNetworkDnsResolver()
        CarryRemoteTransport.installCloneAttestationIdentity(cl)

        var hooked = 0
        for (className in CHANNEL_FACTORY_CLASSES) {
            val clazz = try {
                cl.loadClass(className)
            } catch (_: ClassNotFoundException) {
                continue
            }

            val method = try {
                clazz.getDeclaredMethod("getGatewayUri").also { it.isAccessible = true }
            } catch (_: NoSuchMethodException) {
                Log.w(TAG, "  $className found but getGatewayUri() missing, skipping")
                continue
            }

            // Capture whether clone trust actually installed on THIS factory so
            // the redirect below can refuse to send it to the clone :443 without
            // clone trust. Per-class (not a process-wide flag): a second
            // ChannelFactory succeeding must not vouch for one that failed.
            val cloneTrustInstalled = CarryRemoteTransport.installCloneTrust(clazz)

            HookUtils.hookMethodAfter(clazz, "getGatewayUri", emptyArray()) { param ->
                if (param.throwable == null) {
                    val cloneEnabled = CarryRemoteTransport.isEnabled()
                    if (
                        CarryRemoteTransport.cloneRedirectRefusedForMissingTrust(
                            cloneEnabled,
                            cloneTrustInstalled,
                        )
                    ) {
                        // Clone mode is on but this factory has no clone trust:
                        // redirecting to the clone would fail the TLS handshake
                        // against the private CA. Refuse loudly instead of
                        // dialing into a silent, retrying handshake failure.
                        param.throwable = SecurityException(
                            "Remote Carry mode refused to redirect ${clazz.name} to the clone " +
                                "gateway: clone trust is not installed, so the handshake against " +
                                "the clone's private CA would fail",
                        )
                    } else if (cloneEnabled) {
                        val redirected = CarryRemoteTransport.redirectedGatewayForCurrentProcess(
                            param.result as? String,
                        )
                        if (redirected == null) {
                            param.throwable = SecurityException(
                                "Remote Carry mode refused a non-allowlisted gateway",
                            )
                        } else {
                            param.result = redirected
                            Log.w(TAG, "  ChannelFactory remote Carry transport selected")
                        }
                    } else if (localTransport) {
                        param.result = MOCK_SERVER_URI
                        // §19.2 Transport: never log the original gateway URI — the stock
                        // production endpoint is sensitive. Confirm only the redirect.
                        Log.w(TAG, "  ChannelFactory.getGatewayUri() redirected to mock server")
                    }
                }
            }
            hooked++
        }

        if (hooked > 0) {
            Log.w(TAG, "  ChannelFactory bypass installed ($hooked class(es) hooked)")
        } else {
            Log.w(TAG, "  No ChannelFactory classes found on classpath")
        }
    }

    private fun installCredentialInterceptor(cl: ClassLoader, auth: GrpcAuthReflection): Boolean =
        HookUtils.hookMethodAfter(
            auth.okHttpChannelBuilderClass,
            "forTarget",
            arrayOf(String::class.java),
        ) { param ->
            if (
                param.throwable != null ||
                !shouldAttachAuthorization(param.args.getOrNull(0) as? String)
            ) {
                return@hookMethodAfter
            }
            val builder = param.result ?: return@hookMethodAfter
            try {
                auth.attachBearerTokenProvider(builder) {
                    fetchToken(currentApplication())
                }
                Log.w(TAG, "  Local gRPC authorization interceptor attached")
            } catch (error: Throwable) {
                Log.e(TAG, "  Local gRPC authorization unavailable", error)
            }
        }

    private fun currentApplication(): Application {
        val activityThread = Class.forName("android.app.ActivityThread")
        val method = activityThread.getDeclaredMethod("currentApplication")
        method.isAccessible = true
        return method.invoke(null) as? Application
            ?: throw IllegalStateException("Application context is not attached")
    }

    private fun fetchToken(application: Application): String {
        val result = application.contentResolver.call(
            Uri.parse(AUTH_PROVIDER_URI),
            AUTH_PROVIDER_METHOD,
            null,
            null,
        ) ?: throw SecurityException("Credential provider returned no result")
        val token = result.getString(AUTH_PROVIDER_RESULT)
            ?: throw SecurityException("Credential provider returned no token")
        requireValidToken(token)
        return token
    }

    internal fun shouldAttachAuthorization(target: String?): Boolean = target == MOCK_SERVER_URI

    internal fun requireValidToken(token: String): String {
        require(token.length in MIN_TOKEN_BYTES..MAX_TOKEN_BYTES) {
            "Invalid local gRPC credential length"
        }
        require(token.all { character -> character.code in 0x21..0x7e }) {
            "Invalid local gRPC credential characters"
        }
        return token
    }

    private class GrpcAuthReflection(
        val okHttpChannelBuilderClass: Class<*>,
        private val metadataConstructor: java.lang.reflect.Constructor<*>,
        private val metadataKey: Any,
        private val metadataPut: Method,
        private val newAttachHeadersInterceptor: Method,
        private val clientInterceptorClass: Class<*>,
        private val builderIntercept: Method,
    ) {
        fun attachBearerTokenProvider(builder: Any, tokenProvider: () -> String) {
            val interceptor = Proxy.newProxyInstance(
                clientInterceptorClass.classLoader,
                arrayOf(clientInterceptorClass),
            ) { proxy, method, args ->
                when (method.name) {
                    "interceptCall" -> method.invoke(
                        createBearerInterceptor(tokenProvider()),
                        *(args ?: emptyArray()),
                    )
                    "toString" -> "PenumbraLocalGrpcAuthInterceptor"
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === args?.getOrNull(0)
                    else -> throw UnsupportedOperationException(
                        "Unsupported ClientInterceptor method: ${method.name}",
                    )
                }
            }
            val interceptors = Array.newInstance(clientInterceptorClass, 1)
            Array.set(interceptors, 0, interceptor)
            builderIntercept.invoke(builder, interceptors)
        }

        private fun createBearerInterceptor(token: String): Any {
            val metadata = metadataConstructor.newInstance()
            metadataPut.invoke(metadata, metadataKey, "Bearer $token")
            return checkNotNull(
                newAttachHeadersInterceptor.invoke(null, metadata),
            ) { "gRPC metadata interceptor was not created" }
        }

        companion object {
            fun resolve(cl: ClassLoader): GrpcAuthReflection {
                val okHttpChannelBuilder = cl.loadClass("io.grpc.okhttp.OkHttpChannelBuilder")
                okHttpChannelBuilder.getDeclaredMethod("forTarget", String::class.java)

                val metadata = cl.loadClass("io.grpc.Metadata")
                val metadataKey = cl.loadClass("io.grpc.Metadata\$Key")
                val asciiMarshaller = cl.loadClass("io.grpc.Metadata\$AsciiMarshaller")
                val marshaller = metadata.getField("ASCII_STRING_MARSHALLER").get(null)
                val authorizationKey = checkNotNull(
                    metadataKey
                        .getMethod("of", String::class.java, asciiMarshaller)
                        .invoke(null, AUTHORIZATION_HEADER, marshaller),
                ) { "gRPC authorization metadata key was not created" }
                val metadataUtils = cl.loadClass("io.grpc.stub.MetadataUtils")
                val clientInterceptor = cl.loadClass("io.grpc.ClientInterceptor")
                val interceptorArray = Array.newInstance(clientInterceptor, 0).javaClass
                val managedChannelBuilder = cl.loadClass("io.grpc.ManagedChannelBuilder")

                return GrpcAuthReflection(
                    okHttpChannelBuilderClass = okHttpChannelBuilder,
                    metadataConstructor = metadata.getDeclaredConstructor(),
                    metadataKey = authorizationKey,
                    metadataPut = metadata.getMethod("put", metadataKey, Object::class.java),
                    newAttachHeadersInterceptor = metadataUtils.getMethod(
                        "newAttachHeadersInterceptor",
                        metadata,
                    ),
                    clientInterceptorClass = clientInterceptor,
                    builderIntercept = managedChannelBuilder.getMethod("intercept", interceptorArray),
                )
            }
        }
    }
}
