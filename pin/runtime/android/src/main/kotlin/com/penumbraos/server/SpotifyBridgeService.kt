package com.penumbraos.server

import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.security.NetworkSecurityPolicy
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import org.json.JSONObject
import org.json.JSONTokener
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * UID-authenticated Binder facade for the stock music process.
 *
 * The stock process never receives the private loopback credential. It can only
 * invoke the three catalog/playback operations needed by the provider hook.
 */
class SpotifyBridgeService : Service() {
    private val binder = SpotifyBridgeBinder()

    override fun onBind(intent: Intent?): IBinder = binder

    private inner class SpotifyBridgeBinder : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            enforceMusicCaller()

            if (code == INTERFACE_TRANSACTION) {
                requireNotNull(reply) { "Spotify bridge requires a reply Parcel" }
                reply.writeString(SpotifyBridgeProtocol.DESCRIPTOR)
                return true
            }

            val operation = SpotifyBridgeProtocol.operationForCode(code)
                ?: throw SecurityException("Unsupported Spotify bridge transaction")
            if (flags and FLAG_ONEWAY != 0 || reply == null) {
                throw SecurityException("Spotify bridge requires synchronous transactions")
            }

            data.enforceInterface(SpotifyBridgeProtocol.DESCRIPTOR)
            val requestBody = SpotifyBridgeProtocol.requireValidRequestBody(data.readString())
            if (data.dataAvail() != 0) {
                throw SecurityException("Unexpected Spotify bridge request data")
            }

            val response = SpotifyBridgeRuntime.proxy(operation, requestBody)
            reply.writeNoException()
            reply.writeInt(response.status)
            reply.writeString(response.body)
            return true
        }
    }

    private fun enforceMusicCaller() {
        val callingUid = Binder.getCallingUid()
        val expectedUid = try {
            packageManager.getPackageUid(SpotifyBridgeProtocol.MUSIC_PACKAGE, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            throw SecurityException("Authorized Spotify bridge caller is unavailable")
        }
        if (callingUid != expectedUid) {
            throw SecurityException("Caller is not authorized for Spotify bridge access")
        }
    }
}

internal object SpotifyBridgeProtocol {
    const val DESCRIPTOR = TierASymbols.Binder.PenumbraSpotify.DESCRIPTOR
    const val MUSIC_PACKAGE = TierASymbols.Packages.MUSIC
    const val TRANSACTION_QUERY = TierASymbols.Binder.PenumbraSpotify.TRANSACTION_QUERY
    const val TRANSACTION_PLAYBACK = TierASymbols.Binder.PenumbraSpotify.TRANSACTION_PLAYBACK
    const val TRANSACTION_SAVE = TierASymbols.Binder.PenumbraSpotify.TRANSACTION_SAVE

    const val MAX_REQUEST_BYTES = 32 * 1024
    const val MAX_RESPONSE_BYTES = 256 * 1024

    fun operationForCode(code: Int): String? = when (code) {
        TRANSACTION_QUERY -> TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_QUERY
        TRANSACTION_PLAYBACK -> TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_PLAYBACK
        TRANSACTION_SAVE -> TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_SAVE
        else -> null
    }

    fun requireValidRequestBody(body: String?): String {
        require(body != null) { "Spotify bridge request body is required" }
        require(body.toByteArray(StandardCharsets.UTF_8).size <= MAX_REQUEST_BYTES) {
            "Spotify bridge request body is too large"
        }
        require(isSingleJsonObject(body)) {
            "Spotify bridge request body must be one JSON object"
        }
        return body
    }

    fun isSingleJsonObject(body: String): Boolean = try {
        val tokener = JSONTokener(body)
        tokener.nextValue() is JSONObject && tokener.nextClean() == 0.toChar()
    } catch (_: Exception) {
        false
    }
}

internal object SpotifyBridgeRuntime {
    private const val TAG = "PenumbraServer"
    private const val LOOPBACK_HOST = "127.0.0.1"
    private const val INTERNAL_PATH = "/internal/spotify/"
    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val READ_TIMEOUT_MS = 30_000
    private const val MAX_ERROR_MESSAGE_CHARS = 4 * 1024

    @Volatile
    private var configuration: Configuration? = null

    @Synchronized
    fun configure(esimBridgeToken: String, httpPort: Int) {
        val next = try {
            Configuration(
                bridgeToken = SpotifyBridgeAuthentication.deriveToken(esimBridgeToken),
                loopbackBaseUrl = loopbackBaseUrl(httpPort),
            )
        } catch (t: Throwable) {
            // Never retain a previously valid endpoint after a failed
            // reconfiguration. The service must explicitly configure the bridge
            // again from a freshly validated canonical config.
            configuration = null
            throw t
        }
        configuration = next
    }

    @Synchronized
    fun clear() {
        configuration = null
    }

    internal fun isConfigured(): Boolean = configuration != null

    fun proxy(operation: String, requestBody: String): SpotifyBridgeResponse {
        val current = configuration
            ?: return errorResponse(503, "Spotify bridge is unavailable")
        val safeOperation = operation.takeIf {
            it == TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_QUERY ||
                it == TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_PLAYBACK ||
                it == TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_SAVE
        }
            ?: return errorResponse(400, "Unsupported Spotify bridge operation")
        return try {
            proxyHttp(safeOperation, requestBody, current)
        } catch (_: ResponseTooLargeException) {
            errorResponse(502, "Spotify bridge response is too large")
        } catch (error: Exception) {
            val loopbackCleartextPermitted = runCatching {
                NetworkSecurityPolicy.getInstance()
                    .isCleartextTrafficPermitted(LOOPBACK_HOST)
            }.getOrNull()
            Log.w(
                TAG,
                "Spotify bridge $safeOperation failed: ${error.javaClass.simpleName}; " +
                    "loopbackCleartextPermitted=$loopbackCleartextPermitted",
            )
            errorResponse(502, "Spotify bridge upstream is unavailable")
        }
    }

    private fun proxyHttp(
        operation: String,
        requestBody: String,
        configuration: Configuration,
    ): SpotifyBridgeResponse {
        val validatedToken = SpotifyBridgeAuthentication.requireValidDerivedToken(
            configuration.bridgeToken,
        )
        val connection = URL(
            configuration.loopbackBaseUrl + operation,
        ).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty(
                SpotifyBridgeAuthentication.TOKEN_HEADER,
                validatedToken,
            )
            val requestBytes = requestBody.toByteArray(StandardCharsets.UTF_8)
            connection.setFixedLengthStreamingMode(requestBytes.size)
            connection.outputStream.use { output -> output.write(requestBytes) }

            val status = connection.responseCode
            Log.w(TAG, "Spotify bridge upstream $operation -> HTTP $status")
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.use(::readBoundedBody).orEmpty()
            normalizeResponse(status, responseBody)
        } finally {
            connection.disconnect()
        }
    }

    private fun readBoundedBody(input: InputStream): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (output.size() + read > SpotifyBridgeProtocol.MAX_RESPONSE_BYTES) {
                throw ResponseTooLargeException()
            }
            output.write(buffer, 0, read)
        }
        return output.toByteArray().toString(StandardCharsets.UTF_8)
    }

    private fun normalizeResponse(status: Int, body: String): SpotifyBridgeResponse {
        if (SpotifyBridgeProtocol.isSingleJsonObject(body)) {
            return SpotifyBridgeResponse(status, body)
        }
        if (status in 200..299) {
            return errorResponse(502, "Spotify bridge upstream returned an invalid response")
        }
        val safeMessage = body.trim().take(MAX_ERROR_MESSAGE_CHARS).takeIf { it.isNotEmpty() }
            ?: "Spotify request failed"
        return errorResponse(status, safeMessage)
    }

    private fun errorResponse(status: Int, message: String): SpotifyBridgeResponse =
        SpotifyBridgeResponse(status, JSONObject().put("error", message).toString())

    internal fun loopbackBaseUrl(httpPort: Int): String {
        require(httpPort in 1..65535) { "Invalid Spotify bridge HTTP port" }
        return "http://$LOOPBACK_HOST:$httpPort$INTERNAL_PATH"
    }

    private class Configuration(
        val bridgeToken: String,
        val loopbackBaseUrl: String,
    )

    private class ResponseTooLargeException : Exception()
}

internal data class SpotifyBridgeResponse(
    val status: Int,
    val body: String,
)
