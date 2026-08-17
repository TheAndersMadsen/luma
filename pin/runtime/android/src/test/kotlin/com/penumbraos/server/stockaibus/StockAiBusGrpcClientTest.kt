package com.penumbraos.server.stockaibus

import io.grpc.Contexts
import io.grpc.Metadata
import io.grpc.ServerCall
import io.grpc.ServerCallHandler
import io.grpc.ServerInterceptor
import io.grpc.ServerInterceptors
import io.grpc.ServerServiceDefinition
import io.grpc.inprocess.InProcessChannelBuilder
import io.grpc.inprocess.InProcessServerBuilder
import io.grpc.stub.ServerCalls
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StockAiBusGrpcClientTest {
    @Test
    fun encryptedUnderstandCarriesAuthRunIdAndStreamsPlainStockResponses() {
        val serverName = InProcessServerBuilder.generateName()
        val request = byteArrayOf(1, 2, 3)
        val location = byteArrayOf(4, 5)
        val response = byteArrayOf(6, 7, 8)
        val runId = UUID.randomUUID().toString()
        val seen = mutableMapOf<String, String>()
        val service = ServerServiceDefinition.builder("humane.aibus.AIBusService")
            .addMethod(
                StockAiBusGrpcClient.ENCRYPTED_UNDERSTAND_METHOD,
                ServerCalls.asyncServerStreamingCall { encoded, observer ->
                    val decoded = StockAiBusProtoCodec.decodeEncryptedUnderstandRequest(encoded)
                    assertArrayEquals(request, decoded.request)
                    assertArrayEquals(location, decoded.location)
                    observer.onNext(StockAiBusProtoCodec.encodeEncryptedUnderstandResponse(response))
                    observer.onCompleted()
                },
            )
            .build()
        val interceptor = object : ServerInterceptor {
            override fun <ReqT : Any?, RespT : Any?> interceptCall(
                call: ServerCall<ReqT, RespT>,
                headers: Metadata,
                next: ServerCallHandler<ReqT, RespT>,
            ) = Contexts.interceptCall(io.grpc.Context.current(), call, headers, next).also {
                seen["authorization"] = headers.get(AUTHORIZATION_KEY).orEmpty()
                seen["runId"] = headers.get(RUN_ID_KEY).orEmpty()
            }
        }
        val server = InProcessServerBuilder.forName(serverName)
            .directExecutor()
            .addService(ServerInterceptors.intercept(service, interceptor))
            .build()
            .start()
        val channel = InProcessChannelBuilder.forName(serverName).directExecutor().build()
        val client = StockAiBusGrpcClient(channel, TOKEN)
        val values = mutableListOf<ByteArray>()
        val terminal = CountDownLatch(1)
        var error: String? = null
        try {
            client.requestConnection()
            assertTrue(client.isReady())
            client.synapseUnderstanding(request, location, runId, object : StockAiBusGrpcClient.Observer {
                override fun onNext(value: ByteArray) {
                    values += value
                }

                override fun onError(code: String) {
                    error = code
                    terminal.countDown()
                }

                override fun onCompleted() {
                    terminal.countDown()
                }
            })

            assertTrue(terminal.await(2, TimeUnit.SECONDS))
            assertEquals(null, error)
            assertEquals(1, values.size)
            assertArrayEquals(response, values.single())
            assertEquals("Bearer $TOKEN", seen["authorization"])
            assertEquals(runId, seen["runId"])
        } finally {
            client.close()
            channel.shutdownNow()
            server.shutdownNow()
        }
    }

    @Test
    fun encryptedNearbyCarriesAuthAndReturnsPlainStockResponse() {
        val serverName = InProcessServerBuilder.generateName()
        val request = byteArrayOf(9, 8, 7)
        val response = byteArrayOf(6, 5, 4)
        var authorization = ""
        val service = ServerServiceDefinition.builder("humane.aibus.AIBusService")
            .addMethod(
                StockAiBusGrpcClient.ENCRYPTED_NEARBY_SEARCH_METHOD,
                ServerCalls.asyncUnaryCall { encoded, observer ->
                    assertArrayEquals(
                        request,
                        StockAiBusProtoCodec.decodeEncryptedNearbyRequest(encoded),
                    )
                    observer.onNext(StockAiBusProtoCodec.encodeEncryptedNearbyResponse(response))
                    observer.onCompleted()
                },
            )
            .build()
        val interceptor = object : ServerInterceptor {
            override fun <ReqT : Any?, RespT : Any?> interceptCall(
                call: ServerCall<ReqT, RespT>,
                headers: Metadata,
                next: ServerCallHandler<ReqT, RespT>,
            ) = Contexts.interceptCall(io.grpc.Context.current(), call, headers, next).also {
                authorization = headers.get(AUTHORIZATION_KEY).orEmpty()
            }
        }
        val server = InProcessServerBuilder.forName(serverName)
            .directExecutor()
            .addService(ServerInterceptors.intercept(service, interceptor))
            .build()
            .start()
        val channel = InProcessChannelBuilder.forName(serverName).directExecutor().build()
        try {
            val client = StockAiBusGrpcClient(channel, TOKEN)
            assertArrayEquals(response, client.encryptedNearbySearch(request))
            assertEquals("Bearer $TOKEN", authorization)
        } finally {
            channel.shutdownNow()
            server.shutdownNow()
        }
    }

    @Test
    fun wrapperCodecRejectsWrongKidDuplicateFieldsAndOversize() {
        val encoded = StockAiBusProtoCodec.encodeEncryptedUnderstandRequest(byteArrayOf(1), null)
        assertArrayEquals(
            byteArrayOf(1),
            StockAiBusProtoCodec.decodeEncryptedUnderstandRequest(encoded).request,
        )
        assertFails<IllegalArgumentException> {
            StockAiBusProtoCodec.decodeEncryptedUnderstandRequest(encoded + encoded)
        }
        val response = StockAiBusProtoCodec.encodeEncryptedUnderstandResponse(byteArrayOf(2))
        val kid = StockAiBusProtoCodec.UNDERSTAND_RESPONSE_KID.toByteArray()
        val kidOffset = response.indexOfSubsequence(kid)
        assertTrue(kidOffset >= 0)
        val wrongKid = response.copyOf().also { it[kidOffset] = 'x'.code.toByte() }
        assertFails<IllegalArgumentException> {
            StockAiBusProtoCodec.decodeEncryptedUnderstandResponse(wrongKid)
        }
        assertFails<IllegalArgumentException> {
            StockAiBusProtoCodec.encodeEncryptedUnderstandRequest(
                ByteArray(StockAiBusProtoCodec.MAX_MESSAGE_BYTES + 1),
                null,
            )
        }
        assertFails<IllegalArgumentException> {
            StockAiBusGrpcClient.requireCanonicalRunId("not-a-run-id")
        }

        val nearby = StockAiBusProtoCodec.encodeEncryptedNearbyRequest(byteArrayOf(3))
        assertArrayEquals(byteArrayOf(3), StockAiBusProtoCodec.decodeEncryptedNearbyRequest(nearby))
        val nearbyResponse = StockAiBusProtoCodec.encodeEncryptedNearbyResponse(byteArrayOf(4))
        assertArrayEquals(
            byteArrayOf(4),
            StockAiBusProtoCodec.decodeEncryptedNearbyResponse(nearbyResponse),
        )
    }

    private inline fun <reified T : Throwable> assertFails(block: () -> Unit) {
        assertTrue(runCatching(block).exceptionOrNull() is T)
    }

    private fun ByteArray.indexOfSubsequence(needle: ByteArray): Int {
        if (needle.isEmpty() || needle.size > size) return -1
        return indices.firstOrNull { start ->
            start + needle.size <= size &&
                needle.indices.all { offset -> this[start + offset] == needle[offset] }
        } ?: -1
    }

    private companion object {
        const val TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        val AUTHORIZATION_KEY: Metadata.Key<String> = Metadata.Key.of(
            "authorization",
            Metadata.ASCII_STRING_MARSHALLER,
        )
        val RUN_ID_KEY: Metadata.Key<String> = Metadata.Key.of(
            "x-ai-mic-run-id",
            Metadata.ASCII_STRING_MARSHALLER,
        )
    }
}
