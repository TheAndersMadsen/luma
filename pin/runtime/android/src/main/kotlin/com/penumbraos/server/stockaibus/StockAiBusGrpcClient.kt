package com.penumbraos.server.stockaibus

import com.penumbraos.server.ConfigSecurity
import com.penumbraos.stockaibus.contract.TierASymbols
import io.grpc.CallOptions
import io.grpc.Channel
import io.grpc.ClientCall
import io.grpc.ClientInterceptors
import io.grpc.ConnectivityState
import io.grpc.ManagedChannel
import io.grpc.Metadata
import io.grpc.MethodDescriptor
import io.grpc.Status
import io.grpc.okhttp.OkHttpChannelBuilder
import io.grpc.stub.ClientCalls
import io.grpc.stub.MetadataUtils
import io.grpc.stub.StreamObserver
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Authenticated raw-byte client for stock IAiBusBridge transaction 2. */
internal class StockAiBusGrpcClient(
    private val channel: Channel,
    authToken: String,
    private val ownedChannel: ManagedChannel? = null,
) : AutoCloseable {
    private val authenticatedChannel: Channel
    private val managedChannel: ManagedChannel? = ownedChannel ?: channel as? ManagedChannel

    init {
        val token = ConfigSecurity.requireValidAdminToken(authToken)
        val headers = Metadata().apply {
            put(AUTHORIZATION_KEY, "Bearer $token")
        }
        authenticatedChannel = ClientInterceptors.intercept(
            channel,
            MetadataUtils.newAttachHeadersInterceptor(headers),
        )
    }

    fun synapseUnderstanding(
        request: ByteArray,
        location: ByteArray?,
        runId: String,
        observer: Observer,
    ): Cancellation {
        val canonicalRunId = requireCanonicalRunId(runId)
        val payload = StockAiBusProtoCodec.encodeEncryptedUnderstandRequest(request, location)
        val callOptions = CallOptions.DEFAULT
            .withDeadlineAfter(UNDERSTAND_DEADLINE_SECONDS, TimeUnit.SECONDS)
            .withOption(RUN_ID_OPTION, canonicalRunId)
        val runChannel = ClientInterceptors.intercept(
            authenticatedChannel,
            RunIdInterceptor(canonicalRunId),
        )
        val call = runChannel.newCall(ENCRYPTED_UNDERSTAND_METHOD, callOptions)
        val terminated = AtomicBoolean(false)
        ClientCalls.asyncServerStreamingCall(call, payload, object : StreamObserver<ByteArray> {
            override fun onNext(value: ByteArray) {
                if (terminated.get()) return
                try {
                    observer.onNext(StockAiBusProtoCodec.decodeEncryptedUnderstandResponse(value))
                } catch (_: Throwable) {
                    call.cancel("invalid stock understand response", null)
                    if (terminated.compareAndSet(false, true)) {
                        observer.onError("INVALID_RESPONSE")
                    }
                }
            }

            override fun onError(error: Throwable) {
                if (terminated.compareAndSet(false, true)) {
                    observer.onError(Status.fromThrowable(error).code.name)
                }
            }

            override fun onCompleted() {
                if (terminated.compareAndSet(false, true)) {
                    observer.onCompleted()
                }
            }
        })
        return Cancellation {
            terminated.set(true)
            call.cancel("stock bridge request cancelled", null)
        }
    }

    fun encryptedNearbySearch(request: ByteArray): ByteArray {
        val payload = StockAiBusProtoCodec.encodeEncryptedNearbyRequest(request)
        val response = ClientCalls.blockingUnaryCall(
            authenticatedChannel,
            ENCRYPTED_NEARBY_SEARCH_METHOD,
            CallOptions.DEFAULT.withDeadlineAfter(NEARBY_DEADLINE_SECONDS, TimeUnit.SECONDS),
            payload,
        )
        return StockAiBusProtoCodec.decodeEncryptedNearbyResponse(response)
    }

    /** Requests connection establishment and reports only the real READY state. */
    fun isReady(): Boolean = managedChannel?.getState(true) == ConnectivityState.READY

    fun requestConnection() {
        managedChannel?.getState(true)
    }

    override fun close() {
        ownedChannel?.shutdownNow()
    }

    fun interface Cancellation {
        fun cancel()
    }

    interface Observer {
        fun onNext(value: ByteArray)
        fun onError(code: String)
        fun onCompleted()
    }

    private class RunIdInterceptor(private val runId: String) : io.grpc.ClientInterceptor {
        override fun <ReqT : Any?, RespT : Any?> interceptCall(
            method: MethodDescriptor<ReqT, RespT>,
            callOptions: CallOptions,
            next: Channel,
        ): ClientCall<ReqT, RespT> {
            val headers = Metadata().apply { put(RUN_ID_KEY, runId) }
            return ClientInterceptors.intercept(
                next,
                MetadataUtils.newAttachHeadersInterceptor(headers),
            ).newCall(method, callOptions)
        }
    }

    companion object {
        private const val UNDERSTAND_DEADLINE_SECONDS = 80L
        private const val NEARBY_DEADLINE_SECONDS = 12L
        private val AUTHORIZATION_KEY = Metadata.Key.of(
            "authorization",
            Metadata.ASCII_STRING_MARSHALLER,
        )
        private val RUN_ID_KEY = Metadata.Key.of(
            "x-ai-mic-run-id",
            Metadata.ASCII_STRING_MARSHALLER,
        )
        private val RUN_ID_OPTION = CallOptions.Key.create<String>("x-ai-mic-run-id")

        internal val ENCRYPTED_UNDERSTAND_METHOD: MethodDescriptor<ByteArray, ByteArray> =
            MethodDescriptor.newBuilder<ByteArray, ByteArray>()
                .setType(MethodDescriptor.MethodType.SERVER_STREAMING)
                .setFullMethodName(
                    // gRPC's MethodDescriptor stores the canonical path without
                    // the leading transport slash used by the Tier-A registry.
                    TierASymbols.RpcPaths.AIBUS_ENCRYPTED_UNDERSTAND.removePrefix("/"),
                )
                .setRequestMarshaller(BoundedByteArrayMarshaller)
                .setResponseMarshaller(BoundedByteArrayMarshaller)
                .build()

        internal val ENCRYPTED_NEARBY_SEARCH_METHOD: MethodDescriptor<ByteArray, ByteArray> =
            MethodDescriptor.newBuilder<ByteArray, ByteArray>()
                .setType(MethodDescriptor.MethodType.UNARY)
                .setFullMethodName("humane.aibus.AIBusService/EncryptedNearbySearch")
                .setRequestMarshaller(BoundedByteArrayMarshaller)
                .setResponseMarshaller(BoundedByteArrayMarshaller)
                .build()

        fun connect(port: Int, authToken: String): StockAiBusGrpcClient {
            require(port in 1..65535) { "Invalid local gRPC port" }
            val channel = OkHttpChannelBuilder
                .forAddress("127.0.0.1", port)
                .usePlaintext()
                .build()
            return StockAiBusGrpcClient(channel, authToken, channel)
        }

        internal fun requireCanonicalRunId(value: String): String {
            val uuid = runCatching { UUID.fromString(value) }.getOrNull()
                ?: throw IllegalArgumentException("Invalid stock run ID")
            require(uuid.version() == 4 && uuid.toString() == value.lowercase()) {
                "Invalid stock run ID"
            }
            return uuid.toString()
        }
    }
}

private object BoundedByteArrayMarshaller : MethodDescriptor.Marshaller<ByteArray> {
    override fun stream(value: ByteArray): InputStream {
        require(value.size <= StockAiBusProtoCodec.MAX_MESSAGE_BYTES) {
            "gRPC stock payload is too large"
        }
        return ByteArrayInputStream(value)
    }

    override fun parse(stream: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            require(output.size() + read <= StockAiBusProtoCodec.MAX_MESSAGE_BYTES) {
                "gRPC stock payload is too large"
            }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }
}
