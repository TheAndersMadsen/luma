package com.penumbraos.server

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

// Server for pushing data from hooks injected into the Humane LPA into our world
object EsimBridgeServer {

    private const val TAG = "PenumbraEsimBridge"
    const val TCP_PORT = 16790
    private const val AUTH_TIMEOUT_MS = 5_000
    private const val MAX_BRIDGE_LINE_CHARS = 256 * 1024
    private const val ADMISSION_WARNING_INTERVAL_NANOS = 5_000_000_000L

    private val running = AtomicBoolean(false)
    private val clients = CopyOnWriteArraySet<ClientConnection>()
    private val activeSockets = ConcurrentHashMap.newKeySet<Socket>()
    private val lastAdmissionWarningNanos = AtomicLong(0)
    internal val operationGate = EsimOperationGate()

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var acceptThread: Thread? = null

    private val typedEventListener: (JSONObject) -> Unit = { event ->
        broadcast(event)
    }

    fun start(context: Context, authToken: String) {
        val validatedToken = EsimBridgeAuthentication.requireValidToken(authToken)
        appContext = context.applicationContext
        if (!running.compareAndSet(false, true)) {
            return
        }

        EsimEventStore.addTypedEventListener(typedEventListener)

        try {
            val socket = ServerSocket(TCP_PORT, 50, InetAddress.getByName("127.0.0.1"))
            serverSocket = socket
            acceptThread = Thread({
                acceptLoop(socket, validatedToken)
            }, "penumbra-esim-bridge").apply {
                isDaemon = true
                uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, error ->
                    Log.e(TAG, "Uncaught on ${thread.name}", error)
                }
                start()
            }
            Log.w(TAG, "Started eSIM bridge server on 127.0.0.1:$TCP_PORT")
        } catch (t: Throwable) {
            running.set(false)
            serverSocket = null
            acceptThread = null
            EsimEventStore.removeTypedEventListener(typedEventListener)
            Log.e(TAG, "Failed to start eSIM bridge server", t)
        }
    }

    fun stop() {
        running.set(false)
        EsimEventStore.removeTypedEventListener(typedEventListener)
        try {
            serverSocket?.close()
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to close eSIM bridge server", t)
        }
        serverSocket = null
        acceptThread = null
        activeSockets.forEach(::closeSocket)
        activeSockets.clear()
        clients.forEach { it.close() }
        clients.clear()
    }

    private fun acceptLoop(socket: ServerSocket, authToken: String) {
        while (running.get()) {
            val client = try {
                socket.accept()
            } catch (t: Throwable) {
                if (running.get()) {
                    Log.w(TAG, "Accept loop failed", t)
                }
                break
            }

            if (!running.get()) {
                closeSocket(client)
                break
            }

            val admission = EsimConnectionAdmissions.control.tryAcquire()
            if (admission == null) {
                closeSocket(client)
                logAdmissionRejected()
                continue
            }

            activeSockets.add(client)
            if (!running.get()) {
                activeSockets.remove(client)
                closeSocket(client)
                admission.close()
                break
            }
            handleClient(client, authToken, admission)
        }
    }

    private fun handleClient(
        socket: Socket,
        authToken: String,
        admission: EsimConnectionAdmission.Lease,
    ) {
        val connection = try {
            ClientConnection(socket)
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to wrap bridge client", t)
            activeSockets.remove(socket)
            closeSocket(socket)
            admission.close()
            return
        }

        try {
            Thread({
                var authenticated = false
                try {
                    socket.soTimeout = AUTH_TIMEOUT_MS
                    BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8)).use { reader ->
                        if (!connection.authenticate(reader, authToken)) {
                            Log.w(TAG, "Rejected unauthenticated eSIM bridge client")
                            return@use
                        }
                        authenticated = true
                        clients.add(connection)
                        socket.soTimeout = 0
                        while (running.get()) {
                            val line = EsimBridgeAuthentication.readBoundedLine(
                                reader,
                                MAX_BRIDGE_LINE_CHARS,
                            ) ?: break
                            if (line.isBlank()) continue
                            handleMessage(connection, line, authToken)
                        }
                    }
                } catch (t: Throwable) {
                    if (running.get()) {
                        Log.w(TAG, "eSIM bridge client ended (${t.javaClass.simpleName})")
                    }
                } finally {
                    if (authenticated) clients.remove(connection)
                    activeSockets.remove(socket)
                    connection.close()
                    admission.close()
                }
            }, "penumbra-esim-bridge-client").apply {
                isDaemon = true
                uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, error ->
                    Log.e(TAG, "Uncaught on ${thread.name} (${error.javaClass.simpleName})")
                }
                start()
            }
        } catch (t: Throwable) {
            activeSockets.remove(socket)
            connection.close()
            admission.close()
            Log.w(TAG, "Failed to start eSIM bridge worker (${t.javaClass.simpleName})")
        }
    }

    private fun closeSocket(socket: Socket) {
        try {
            socket.close()
        } catch (_: Throwable) {
        }
    }

    private fun logAdmissionRejected() {
        val now = System.nanoTime()
        val previous = lastAdmissionWarningNanos.get()
        if (previous != 0L && now - previous < ADMISSION_WARNING_INTERVAL_NANOS) return
        if (lastAdmissionWarningNanos.compareAndSet(previous, now)) {
            Log.w(TAG, "Rejected eSIM bridge client at connection limit")
        }
    }

    private fun handleMessage(
        connection: ClientConnection,
        line: String,
        authToken: String,
    ) {
        try {
            val message = JSONObject(line)
            when (message.optString("type")) {
                "esim.request" -> handleRequestMessage(connection, message, authToken)
                "esim.cancel_request" -> handleCancellationMessage(message)
                "cellular.status_request" -> handleCellularStatusRequest(connection, message)
                "wifi.set_enabled_request" -> handleWifiSetEnabledRequest(connection, message)
                "cellular.set_enabled_request" -> handleCellularSetEnabledRequest(connection, message)
                "config.snapshot_request" -> handleConfigSnapshotRequest(connection, message)
                "device.stock_action_request" -> handleStockActionRequest(connection, message)
                "device.stock_message_status_request" ->
                    handleStockMessageStatusRequest(connection, message)
                else -> {
                    connection.send(
                        JSONObject()
                            .put("type", "esim.bridge_error")
                            .put("message", "Unsupported message type")
                            .put("raw_type", message.optString("type"))
                    )
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Rejected invalid eSIM bridge message (${t.javaClass.simpleName})")
            connection.send(
                JSONObject()
                    .put("type", "esim.bridge_error")
                    .put("message", "Invalid JSON request")
            )
        }
    }

    private fun handleStockActionRequest(connection: ClientConnection, message: JSONObject) {
        val context = appContext
        val requestId = message.optString("request_id").ifEmpty { null }
        val payload = message.optJSONObject("payload")
        val action = payload?.optString("action")?.takeIf { it.isNotEmpty() }
        if (context == null || requestId == null || payload == null || action == null) {
            connection.send(
                JSONObject()
                    .put("type", "device.stock_action_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject().put("message", "Stock action request unavailable")),
            )
            return
        }

        try {
            val result = DeviceActionDispatcher.dispatch(context, action, payload)
            connection.send(
                JSONObject()
                    .put("type", "device.stock_action_result")
                    .put("request_id", requestId)
                    .put("payload", result),
            )
        } catch (failure: Throwable) {
            Log.w(TAG, "Stock action failed (${failure.javaClass.simpleName})")
            connection.send(
                JSONObject()
                    .put("type", "device.stock_action_error")
                    .put("request_id", requestId)
                    .put("payload", JSONObject().put("message", "Stock action failed")),
            )
        }
    }

    private fun handleStockMessageStatusRequest(
        connection: ClientConnection,
        message: JSONObject,
    ) {
        val context = appContext
        val requestId = message.optString("request_id").ifEmpty { null }
        val payload = message.optJSONObject("payload")
        val recipient = payload?.optString("recipient")?.takeIf { it.isNotEmpty() }
        val body = payload?.optString("message")?.takeIf { it.isNotEmpty() }
        val afterMs = payload?.optLong("after_ms", 0L) ?: 0L
        if (context == null || requestId == null || recipient == null || body == null || afterMs <= 0L) {
            connection.send(
                JSONObject()
                    .put("type", "device.stock_message_status_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject().put("message", "Message status request unavailable")),
            )
            return
        }

        try {
            val result = DeviceActionDispatcher.stockMessageStatus(context, recipient, body, afterMs)
            connection.send(
                JSONObject()
                    .put("type", "device.stock_message_status_result")
                    .put("request_id", requestId)
                    .put("payload", result),
            )
        } catch (failure: Throwable) {
            Log.w(TAG, "Stock message status failed (${failure.javaClass.simpleName})")
            connection.send(
                JSONObject()
                    .put("type", "device.stock_message_status_error")
                    .put("request_id", requestId)
                    .put("payload", JSONObject().put("message", "Message status check failed")),
            )
        }
    }

    private fun handleRequestMessage(
        connection: ClientConnection,
        message: JSONObject,
        authToken: String,
    ) {
        val context = appContext
        if (context == null) {
            connection.send(
                JSONObject()
                    .put("type", "esim.bridge_error")
                    .put("message", "Server app context unavailable")
                    .put("request_id", message.optString("request_id"))
            )
            return
        }

        val request = EsimRequestProtocol.parse(message).getOrElse { failure ->
            val requestId = message.optString("request_id").takeIf { it.isNotEmpty() }
            Log.w(TAG, "Rejected invalid eSIM request (${failure.javaClass.simpleName})")
            connection.send(
                JSONObject()
                    .put("type", "esim.bridge_error")
                    .put("message", "Invalid or unsupported eSIM request")
                    .put("request_id", requestId ?: JSONObject.NULL)
            )
            return
        }

        when (val admission = operationGate.admit(request)) {
            is EsimAdmission.Rejected -> {
                connection.send(
                    JSONObject()
                        .put("type", "esim.bridge_error")
                        .put("request_id", request.requestId)
                        .put("action", request.action)
                        .put("operation_token", request.operationToken)
                        .put("payload", JSONObject().put("message", admission.reason)),
                )
                return
            }
            is EsimAdmission.Accepted -> Unit
        }

        try {
            EsimController.dispatch(
                context = context,
                requestId = request.requestId,
                operationToken = request.operationToken,
                lpaAction = request.action,
                iccid = request.iccid,
                activationCode = request.activationCode,
                nickname = request.nickname,
                source = "rust",
                bridgeAuthToken = authToken,
            )
        } catch (failure: Throwable) {
            operationGate.releaseAfterDispatchFailure(request.binding)
            Log.w(TAG, "Stock LPA dispatch failed (${failure.javaClass.simpleName})")
            connection.send(
                JSONObject()
                    .put("type", "esim.bridge_error")
                    .put("request_id", request.requestId)
                    .put("action", request.action)
                    .put("operation_token", request.operationToken)
                    .put("payload", JSONObject().put("message", "Stock LPA dispatch failed")),
            )
            return
        }

        connection.send(
            JSONObject()
                .put("type", "esim.request_accepted")
                .put("request_id", request.requestId)
                .put("action", request.action)
                .put("operation_token", request.operationToken)
        )
    }

    private fun handleCancellationMessage(message: JSONObject) {
        val cancellation = EsimRequestProtocol.parseCancellation(message).getOrElse { failure ->
            Log.w(TAG, "Rejected invalid eSIM cancellation (${failure.javaClass.simpleName})")
            return
        }
        if (!operationGate.cancel(cancellation)) {
            Log.w(TAG, "Ignored stale or mismatched eSIM cancellation")
        }
    }

    private fun handleCellularStatusRequest(connection: ClientConnection, message: JSONObject) {
        val context = appContext
        if (context == null) {
            connection.send(
                JSONObject()
                    .put("type", "cellular.status_error")
                    .put("message", "Server app context unavailable")
                    .put("request_id", message.optString("request_id").ifEmpty { JSONObject.NULL })
            )
            return
        }

        connection.send(
            JSONObject()
                .put("type", "cellular.status_result")
                .put("request_id", message.optString("request_id").ifEmpty { JSONObject.NULL })
                .put("payload", CellularStatusProvider.snapshot(context))
        )
    }

    private fun handleConfigSnapshotRequest(connection: ClientConnection, message: JSONObject) {
        val context = appContext
        val requestId = message.optString("request_id").ifEmpty { null }
        if (context == null || requestId == null) {
            connection.send(
                JSONObject()
                    .put("type", "config.snapshot_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject().put("message", "Snapshot request unavailable")),
            )
            return
        }

        try {
            val commit = PersistentConfigVaultClient.commit(context)
            connection.send(
                JSONObject()
                    .put("type", "config.snapshot_result")
                    .put("request_id", requestId)
                    .put(
                        "payload",
                        JSONObject()
                            .put("status", "committed")
                            .put("generation", commit.generation)
                            .put("config_digest", commit.configDigest),
                    ),
            )
        } catch (failure: Throwable) {
            Log.w(TAG, "Failed to commit persistent config (${failure.javaClass.simpleName})")
            connection.send(
                JSONObject()
                    .put("type", "config.snapshot_error")
                    .put("request_id", requestId)
                    .put("payload", JSONObject().put("message", "Snapshot commit failed")),
            )
        }
    }

    private fun handleWifiSetEnabledRequest(connection: ClientConnection, message: JSONObject) {
        val context = appContext
        val requestId = message.optString("request_id").ifEmpty { null }
        if (context == null) {
            connection.send(
                JSONObject()
                    .put("type", "wifi.set_enabled_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject().put("message", "Server app context unavailable"))
            )
            return
        }

        val enabled = message.optJSONObject("payload")?.optBoolean("enabled")
        if (enabled == null) {
            connection.send(
                JSONObject()
                    .put("type", "wifi.set_enabled_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject().put("message", "enabled is required"))
            )
            return
        }

        try {
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                ?: throw IllegalStateException("WifiManager unavailable")
            val success = wifiManager.setWifiEnabled(enabled)
            if (!success) {
                throw IllegalStateException("WifiManager rejected toggle request")
            }
            connection.send(
                JSONObject()
                    .put("type", "wifi.set_enabled_result")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject()
                        .put("result", "success")
                        .put("enabled", enabled)
                    )
            )
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to toggle Wi-Fi", t)
            connection.send(
                JSONObject()
                    .put("type", "wifi.set_enabled_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject()
                        .put("message", t.message ?: "Failed to toggle Wi-Fi")
                    )
            )
        }
    }

    private fun handleCellularSetEnabledRequest(connection: ClientConnection, message: JSONObject) {
        val context = appContext
        val requestId = message.optString("request_id").ifEmpty { null }
        if (context == null) {
            connection.send(
                JSONObject()
                    .put("type", "cellular.set_enabled_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject().put("message", "Server app context unavailable"))
            )
            return
        }

        val enabled = message.optJSONObject("payload")?.optBoolean("enabled")
        if (enabled == null) {
            connection.send(
                JSONObject()
                    .put("type", "cellular.set_enabled_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject().put("message", "enabled is required"))
            )
            return
        }

        try {
            val command = listOf("cmd", "phone", "data", if (enabled) "enable" else "disable")
            val process = ProcessBuilder(command)
                .redirectErrorStream(false)
                .start()
            val stdout = process.inputStream.bufferedReader().use { it.readText() }.trim()
            val stderr = process.errorStream.bufferedReader().use { it.readText() }.trim()
            val exitCode = process.waitFor()
            if (exitCode != 0) {
                val suffix = listOf(stdout, stderr)
                    .filter { it.isNotEmpty() }
                    .joinToString(" | ")
                    .takeIf { it.isNotEmpty() }
                    ?.let { ": $it" }
                    .orEmpty()
                throw IllegalStateException("cmd phone data ${if (enabled) "enable" else "disable"} failed (exit $exitCode)$suffix")
            }
            connection.send(
                JSONObject()
                    .put("type", "cellular.set_enabled_result")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject()
                        .put("result", "success")
                        .put("enabled", enabled)
                    )
            )
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to toggle cellular data", t)
            connection.send(
                JSONObject()
                    .put("type", "cellular.set_enabled_error")
                    .put("request_id", requestId ?: JSONObject.NULL)
                    .put("payload", JSONObject()
                        .put("message", t.message ?: "Failed to toggle cellular data")
                    )
            )
        }
    }

    private fun broadcast(event: JSONObject) {
        val dead = mutableListOf<ClientConnection>()
        for (client in clients) {
            if (!client.send(event)) {
                dead += client
            }
        }
        dead.forEach {
            clients.remove(it)
            it.close()
        }
    }

    private class ClientConnection(private val socket: Socket) {
        private val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)

        @Synchronized
        fun authenticate(reader: BufferedReader, authToken: String): Boolean =
            EsimBridgeAuthentication.authenticateClient(
                reader,
                writer,
                authToken,
                EsimBridgeAuthentication.Channel.CONTROL,
            )

        @Synchronized
        fun send(message: JSONObject): Boolean {
            return try {
                writer.write(message.toString())
                writer.write('\n'.code)
                writer.flush()
                true
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to send bridge message", t)
                false
            }
        }

        fun close() {
            try {
                writer.close()
            } catch (_: Throwable) {
            }
            try {
                socket.close()
            } catch (_: Throwable) {
            }
        }
    }
}
