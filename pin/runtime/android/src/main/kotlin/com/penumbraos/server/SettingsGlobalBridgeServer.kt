package com.penumbraos.server

import android.content.ContentResolver
import android.content.Context
import android.provider.Settings
import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * App-attributed Settings.Global access for the native server.
 *
 * `/system/bin/settings` is a shell-command API. A native child of this app
 * runs as UID 1000 rather than UID 2000, so that API cannot resolve a calling
 * package for writes. Keeping the ContentResolver call in this Android process
 * preserves `com.penumbraos.server` attribution and its platform permission.
 *
 * Loopback is not an Android security boundary. Every one-shot request must
 * prove possession of a domain-separated per-install capability, and both the
 * request size and concurrent unauthenticated sockets are bounded.
 */
internal object SettingsGlobalBridgeServer {
    private const val TAG = "PenumbraSettingsBridge"
    const val TCP_PORT = 16791
    private const val SOCKET_TIMEOUT_MS = 2_000
    private const val MAX_ACTIVE_CONNECTIONS = 4

    private val running = AtomicBoolean(false)
    private val admission = Semaphore(MAX_ACTIVE_CONNECTIONS)
    private val activeSockets = ConcurrentHashMap.newKeySet<Socket>()

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var acceptThread: Thread? = null

    fun start(context: Context, installSecret: String): Boolean {
        val authToken = SettingsGlobalBridgeAuthentication.deriveToken(installSecret)
        if (!running.compareAndSet(false, true)) return isReady()

        return try {
            val socket = ServerSocket(TCP_PORT, MAX_ACTIVE_CONNECTIONS, InetAddress.getByName("127.0.0.1"))
            serverSocket = socket
            val store = AndroidSettingsGlobalStore(context.applicationContext.contentResolver)
            acceptThread = Thread({ acceptLoop(socket, authToken, store) }, "penumbra-settings-global").apply {
                isDaemon = true
                uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, error ->
                    Log.e(TAG, "Uncaught on ${thread.name} (${error.javaClass.simpleName})")
                }
                start()
            }
            Log.w(TAG, "Started authenticated Settings.Global bridge on IPv4 loopback")
            isReady()
        } catch (error: Throwable) {
            running.set(false)
            serverSocket = null
            acceptThread = null
            Log.e(TAG, "Failed to start Settings.Global bridge (${error.javaClass.simpleName})")
            false
        }
    }

    fun isReady(): Boolean {
        val socket = serverSocket
        return running.get() && socket != null && socket.isBound && !socket.isClosed
    }

    fun stop() {
        running.set(false)
        runCatching { serverSocket?.close() }
        serverSocket = null
        acceptThread = null
        activeSockets.forEach(::closeSocket)
        activeSockets.clear()
    }

    private fun acceptLoop(
        listener: ServerSocket,
        authToken: String,
        store: SettingsGlobalStore,
    ) {
        // A stopped listener can overlap briefly with a replacement listener
        // during an Android service restart. Tie this loop to the exact socket
        // it owns so the old thread cannot spin after start() sets `running`
        // true for the replacement.
        while (running.get() && serverSocket === listener) {
            val socket = try {
                listener.accept()
            } catch (_: Throwable) {
                if (!running.get() || serverSocket !== listener) return
                continue
            }
            if (!running.get() || serverSocket !== listener) {
                closeSocket(socket)
                return
            }
            if (!admission.tryAcquire()) {
                closeSocket(socket)
                continue
            }
            activeSockets.add(socket)
            try {
                Thread(
                    { handleClient(socket, authToken, store) },
                    "penumbra-settings-global-client",
                ).apply {
                    isDaemon = true
                    uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, _ ->
                        activeSockets.remove(socket)
                        closeSocket(socket)
                        admission.release()
                    }
                    start()
                }
            } catch (_: Throwable) {
                activeSockets.remove(socket)
                closeSocket(socket)
                admission.release()
            }
        }
    }

    private fun handleClient(
        socket: Socket,
        authToken: String,
        store: SettingsGlobalStore,
    ) {
        try {
            socket.soTimeout = SOCKET_TIMEOUT_MS
            BufferedReader(socket.getInputStream().reader(Charsets.UTF_8)).use { reader ->
                OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8).use { writer ->
                    val line = SettingsGlobalBridgeProtocol.readBoundedLine(reader)
                    val response = if (line == null) {
                        SettingsGlobalBridgeProtocol.error("invalid_request")
                    } else {
                        SettingsGlobalBridgeProtocol.process(line, authToken, store)
                    }
                    writer.write(response.toString())
                    writer.write('\n'.code)
                    writer.flush()
                }
            }
        } catch (_: Throwable) {
            // Authentication failures, malformed input, and socket errors are
            // intentionally indistinguishable in logs. Never log request data.
        } finally {
            activeSockets.remove(socket)
            closeSocket(socket)
            admission.release()
        }
    }

    private fun closeSocket(socket: Socket) {
        runCatching { socket.close() }
    }
}

internal interface SettingsGlobalStore {
    fun get(key: String): String?
    fun put(key: String, value: Boolean): Boolean
    fun delete(key: String)
}

private class AndroidSettingsGlobalStore(
    private val resolver: ContentResolver,
) : SettingsGlobalStore {
    override fun get(key: String): String? = Settings.Global.getString(resolver, key)

    override fun put(key: String, value: Boolean): Boolean =
        Settings.Global.putInt(resolver, key, if (value) 1 else 0)

    override fun delete(key: String) {
        // putString(null) is not a deletion on every Android release. Use the
        // provider's exact item URI so rollback restores an actually absent row.
        resolver.delete(Settings.Global.getUriFor(key), null, null)
    }
}

internal object SettingsGlobalBridgeProtocol {
    const val VERSION = 1
    const val MAX_REQUEST_LINE_CHARS = 2 * 1024

    val STOCK_FEATURE_GATE_KEYS = setOf(
        TierASymbols.FeatureFlags.SettingsGlobal.PHOTO_SHARING_ENABLED,
        TierASymbols.FeatureFlags.SettingsGlobal.PHOTOGRAPHY_JPG_ENABLED,
        TierASymbols.FeatureFlags.SettingsGlobal.FOOD_ENABLED,
        TierASymbols.FeatureFlags.SettingsGlobal.CLOCK_ENABLED,
        TierASymbols.FeatureFlags.SettingsGlobal.HEALTH_TRACKER_ENABLED,
        TierASymbols.FeatureFlags.SettingsGlobal.CMU_ULTRA_ENABLED,
    )

    val PRIVATE_PREFERENCE_KEYS = setOf(
        TierASymbols.FeatureFlags.PenumbraSettingsGlobal.WEATHER_CELSIUS,
    )

    val LUMA_FEATURE_GATE_KEYS = setOf(
        TierASymbols.FeatureFlags.LumaSettingsGlobal.ROOT_ACCESS_ENABLED,
    )

    val ALLOWED_KEYS =
        STOCK_FEATURE_GATE_KEYS + PRIVATE_PREFERENCE_KEYS + LUMA_FEATURE_GATE_KEYS

    fun process(line: String, authToken: String, store: SettingsGlobalStore): JSONObject {
        val request = try {
            parse(line, authToken)
        } catch (_: UnauthorizedRequest) {
            return error("unauthorized")
        } catch (_: Throwable) {
            return error("invalid_request")
        }

        return try {
            when (request.operation) {
                Operation.GET -> success().put("value", store.get(request.key) ?: JSONObject.NULL)
                Operation.PUT -> {
                    val value = checkNotNull(request.value)
                    val expected = if (value) "1" else "0"
                    if (!store.put(request.key, value) || store.get(request.key) != expected) {
                        error("operation_failed")
                    } else {
                        success()
                    }
                }
                Operation.DELETE -> {
                    store.delete(request.key)
                    if (store.get(request.key) == null) success() else error("operation_failed")
                }
                Operation.FEATURE_FLAG_ACK -> success().put(
                    "receipt",
                    FeatureFlagApplyAckRepository.latest()?.let { receipt ->
                        JSONObject()
                            .put("sequence", receipt.sequence)
                            .put("assignment_set_hash", receipt.assignmentSetHash)
                            .put("assignment_count", receipt.assignmentCount)
                            .put("applied_at_unix_ms", receipt.appliedAtUnixMs)
                    } ?: JSONObject.NULL,
                )
            }
        } catch (_: Throwable) {
            error("operation_failed")
        }
    }

    fun readBoundedLine(reader: BufferedReader): String? {
        val line = StringBuilder(minOf(MAX_REQUEST_LINE_CHARS, 256))
        while (true) {
            val next = reader.read()
            if (next == -1) return line.takeIf { it.isNotEmpty() }?.toString()
            if (next == '\n'.code) return line.toString().removeSuffix("\r")
            if (line.length >= MAX_REQUEST_LINE_CHARS) {
                throw IllegalArgumentException("Settings.Global bridge request exceeds limit")
            }
            line.append(next.toChar())
        }
    }

    fun error(code: String): JSONObject = JSONObject()
        .put("version", VERSION)
        .put("ok", false)
        .put("error", code)

    private fun success(): JSONObject = JSONObject()
        .put("version", VERSION)
        .put("ok", true)

    private fun parse(line: String, authToken: String): Request {
        require(line.toByteArray(Charsets.UTF_8).size <= MAX_REQUEST_LINE_CHARS)
        val message = JSONObject(line)
        val operation = when (message.optString("op")) {
            "get" -> Operation.GET
            "put" -> Operation.PUT
            "delete" -> Operation.DELETE
            "feature_flag_ack" -> Operation.FEATURE_FLAG_ACK
            else -> throw IllegalArgumentException("unsupported operation")
        }
        val expectedKeys = when (operation) {
            Operation.PUT -> setOf("version", "token", "op", "key", "value")
            Operation.GET, Operation.DELETE -> setOf("version", "token", "op", "key")
            Operation.FEATURE_FLAG_ACK -> setOf("version", "token", "op")
        }
        require(message.keys().asSequence().toSet() == expectedKeys)
        require(message.get("version") is Int && message.getInt("version") == VERSION)

        val presentedToken = message.get("token") as? String
            ?: throw UnauthorizedRequest()
        if (!SettingsGlobalBridgeAuthentication.tokensMatch(authToken, presentedToken)) {
            throw UnauthorizedRequest()
        }

        if (operation == Operation.FEATURE_FLAG_ACK) {
            return Request(operation, "", null)
        }

        val key = message.get("key") as? String
            ?: throw IllegalArgumentException("key must be a string")
        require(key in ALLOWED_KEYS)
        val value = if (operation == Operation.PUT) {
            message.get("value") as? Boolean
                ?: throw IllegalArgumentException("value must be a boolean")
        } else null
        return Request(operation, key, value)
    }

    private enum class Operation { GET, PUT, DELETE, FEATURE_FLAG_ACK }

    private data class Request(
        val operation: Operation,
        val key: String,
        val value: Boolean?,
    )

    private class UnauthorizedRequest : Exception()
}
