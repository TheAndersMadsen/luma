package com.penumbraos.server

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

// Server for external communication of eSIM operations
// Rust connects to this server
object EsimSocketServer {

    private const val TAG = "PenumbraEsimEvents"
    const val TCP_PORT = 16789
    private const val AUTH_TIMEOUT_MS = 5_000
    private const val EVENT_READ_TIMEOUT_MS = 10_000
    private const val MAX_EVENT_LINE_CHARS = 256 * 1024
    private const val ADMISSION_WARNING_INTERVAL_NANOS = 5_000_000_000L

    private val running = AtomicBoolean(false)
    private val activeClients = ConcurrentHashMap.newKeySet<Socket>()
    private val lastAdmissionWarningNanos = AtomicLong(0)

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var acceptThread: Thread? = null

    fun start(authToken: String) {
        val validatedToken = EsimBridgeAuthentication.requireValidToken(authToken)
        if (!running.compareAndSet(false, true)) {
            return
        }

        try {
            val socket = ServerSocket(TCP_PORT, 50, InetAddress.getByName("127.0.0.1"))
            serverSocket = socket
            acceptThread = Thread({
                acceptLoop(socket, validatedToken)
            }, "penumbra-esim-socket").apply {
                isDaemon = true
                uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, error ->
                    Log.e(TAG, "Uncaught on ${thread.name}", error)
                }
                start()
            }
            Log.w(TAG, "Started eSIM TCP server on 127.0.0.1:$TCP_PORT")
        } catch (t: Throwable) {
            running.set(false)
            serverSocket = null
            acceptThread = null
            Log.e(TAG, "Failed to start eSIM TCP server", t)
        }
    }

    fun stop() {
        running.set(false)
        try {
            serverSocket?.close()
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to close eSIM TCP server", t)
        }
        serverSocket = null
        acceptThread = null
        activeClients.forEach(::closeClient)
        activeClients.clear()
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
                closeClient(client)
                break
            }

            val admission = EsimConnectionAdmissions.events.tryAcquire()
            if (admission == null) {
                closeClient(client)
                logAdmissionRejected()
                continue
            }

            activeClients.add(client)
            if (!running.get()) {
                activeClients.remove(client)
                closeClient(client)
                admission.close()
                break
            }
            try {
                Thread({
                    handleClient(client, authToken, admission)
                }, "penumbra-esim-event-client").apply {
                    isDaemon = true
                    uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, error ->
                        Log.e(TAG, "Uncaught on ${thread.name} (${error.javaClass.simpleName})")
                    }
                    start()
                }
            } catch (t: Throwable) {
                activeClients.remove(client)
                closeClient(client)
                admission.close()
                Log.w(TAG, "Failed to start eSIM event worker (${t.javaClass.simpleName})")
            }
        }
    }

    private fun handleClient(
        client: Socket,
        authToken: String,
        admission: EsimConnectionAdmission.Lease,
    ) {
        try {
            client.soTimeout = AUTH_TIMEOUT_MS
            BufferedReader(InputStreamReader(client.getInputStream(), Charsets.UTF_8)).use { reader ->
                val writer = OutputStreamWriter(client.getOutputStream(), Charsets.UTF_8)
                if (!EsimBridgeAuthentication.authenticateClient(
                        reader,
                        writer,
                        authToken,
                        EsimBridgeAuthentication.Channel.EVENTS,
                    )
                ) {
                    Log.w(TAG, "Rejected unauthenticated eSIM event client")
                    return@use
                }
                client.soTimeout = EVENT_READ_TIMEOUT_MS
                while (running.get()) {
                    val line = EsimBridgeAuthentication.readBoundedLine(
                        reader,
                        MAX_EVENT_LINE_CHARS,
                    ) ?: break
                    if (line.isBlank()) continue
                    try {
                        EsimEventStore.onEvent(JSONObject(line))
                    } catch (t: Throwable) {
                        Log.w(TAG, "Rejected invalid eSIM event (${t.javaClass.simpleName})")
                    }
                }
            }
        } catch (t: Throwable) {
            if (running.get()) {
                Log.w(TAG, "eSIM event client ended (${t.javaClass.simpleName})")
            }
        } finally {
            activeClients.remove(client)
            closeClient(client)
            admission.close()
        }
    }

    private fun closeClient(client: Socket) {
        try {
            client.close()
        } catch (_: Throwable) {
        }
    }

    private fun logAdmissionRejected() {
        val now = System.nanoTime()
        val previous = lastAdmissionWarningNanos.get()
        if (previous != 0L && now - previous < ADMISSION_WARNING_INTERVAL_NANOS) return
        if (lastAdmissionWarningNanos.compareAndSet(previous, now)) {
            Log.w(TAG, "Rejected eSIM event client at connection limit")
        }
    }
}
