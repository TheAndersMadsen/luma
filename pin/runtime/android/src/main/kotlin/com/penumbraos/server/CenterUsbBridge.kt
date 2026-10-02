package com.penumbraos.server

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.util.Log
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.util.concurrent.Semaphore

private const val ROOT_UID = 0
private const val SYSTEM_UID = 1000
private const val ADB_SHELL_UID = 2000

internal fun isTrustedUsbPeerUid(uid: Int): Boolean =
    uid == ROOT_UID || uid == SYSTEM_UID || uid == ADB_SHELL_UID

/**
 * One listener generation at a time, and the accept loop that serves it.
 *
 * ServerService restarts the bridge with stop() then start(), so a stopped
 * generation's accept thread can still be unwinding while its replacement
 * listens. Each loop runs only while its own listener is the current one: a
 * stale loop exits instead of spinning on its closed socket, and its exit
 * never releases the replacement. A loop that ends while its listener is still
 * current (an unexpected failure) releases that generation, so the next
 * start() binds again instead of answering "already running" forever.
 *
 * Android-free so the lifecycle runs in JVM unit tests; [close] must be quiet.
 */
internal class BridgeListener<L : Any, C : Any>(
    private val accept: (L) -> C,
    private val close: (Any) -> Unit,
    private val onAcceptFailure: (Throwable) -> Unit,
    private val serve: (C) -> Unit,
) {
    private val lock = Any()

    @Volatile
    private var current: L? = null

    /**
     * Binds a new generation with [open] and hands its accept loop to [spawn].
     * Returns false, binding nothing, while a generation is current.
     */
    fun start(open: () -> L, spawn: (Runnable) -> Unit): Boolean {
        synchronized(lock) {
            if (current != null) return false
            val listener = open()
            current = listener
            try {
                spawn(Runnable { acceptLoop(listener) })
            } catch (t: Throwable) {
                current = null
                close(listener)
                throw t
            }
            return true
        }
    }

    fun stop() {
        val listener = synchronized(lock) { current.also { current = null } }
        if (listener != null) close(listener)
    }

    private fun acceptLoop(listener: L) {
        try {
            while (current === listener) {
                val connection = try {
                    accept(listener)
                } catch (t: Throwable) {
                    if (current !== listener) return
                    onAcceptFailure(t)
                    continue
                }
                if (current !== listener) {
                    close(connection)
                    return
                }
                serve(connection)
            }
        } finally {
            synchronized(lock) {
                if (current === listener) current = null
            }
            close(listener)
        }
    }
}

/**
 * Bridges one bounded browser/WebUSB HTTP request per ADB localabstract socket
 * to the local Penumbra server. The bridge owns the administration credential:
 * caller-provided Authorization headers are discarded before a fresh bearer
 * header is injected from the app-private canonical config.
 */
object CenterUsbBridge {
    private const val TAG = "PenumbraUsbBridge"
    private const val ABSTRACT_SOCKET_NAME = "penumbra_http"
    private const val HTTP_HOST = "127.0.0.1"
    private const val COPY_BUFFER_SIZE = 8192
    private const val MAX_CONCURRENT_CONNECTIONS = 16
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val REQUEST_READ_TIMEOUT_MS = 30_000

    /**
     * How long the RESPONSE relay may sit idle between chunks.
     *
     * This must NOT be REQUEST_READ_TIMEOUT_MS. `copyStream` is a blocking
     * `read()` loop, so SO_TIMEOUT applies to every gap between chunks, and the
     * server's NDJSON event streams (`/api/events`, `/api/esim/events`) only
     * emit a heartbeat every 30 s, see the `tokio::time::interval` in
     * pin/runtime/core/src/api.rs `event_stream`. Two equal deadlines meant the
     * heartbeat and the read timeout raced on every quiet interval, and a tokio
     * interval may fire late but never early: the timeout won, the bridge tore
     * the socket down about every 30 s, and Center reconnected and logged a
     * stream failure each time.
     *
     * Three heartbeat periods gives the producer room to be late without
     * letting a genuinely dead peer hold a worker slot indefinitely.
     */
    private const val SERVER_HEARTBEAT_PERIOD_MS = 30_000
    private const val RESPONSE_IDLE_TIMEOUT_MS = SERVER_HEARTBEAT_PERIOD_MS * 3

    private val workerSlots = Semaphore(MAX_CONCURRENT_CONNECTIONS)

    private val listener = BridgeListener<LocalServerSocket, LocalSocket>(
        accept = { it.accept() },
        close = ::closeQuietly,
        onAcceptFailure = { Log.w(TAG, "USB bridge accept failed", it) },
        serve = ::admit,
    )

    @Volatile
    private var canonicalConfigPath: String? = null

    fun start(configPath: String) {
        // Validate availability without retaining or logging the token. The
        // config is read again for every connection so write-only rotation via
        // the USB API takes effect on the next request.
        BootstrapConfig.readEffectiveAdminToken(configPath)
        BootstrapConfig.readEffectiveHttpPort(configPath)
        canonicalConfigPath = configPath

        val started = try {
            listener.start(
                open = { LocalServerSocket(ABSTRACT_SOCKET_NAME) },
                spawn = { acceptLoop ->
                    val thread = Thread(acceptLoop, "penumbra-usb-bridge-accept")
                    thread.isDaemon = true
                    thread.uncaughtExceptionHandler = safeHandler()
                    thread.start()
                },
            )
        } catch (t: Throwable) {
            canonicalConfigPath = null
            Log.e(TAG, "Failed to start USB bridge", t)
            return
        }
        if (started) {
            Log.w(TAG, "USB bridge listening on localabstract:$ABSTRACT_SOCKET_NAME")
        } else {
            Log.w(TAG, "USB bridge already running")
        }
    }

    fun stop() {
        listener.stop()
        canonicalConfigPath = null
    }

    /** Hands one accepted connection to a worker, or rejects it before parsing. */
    private fun admit(localSocket: LocalSocket) {
        val trustedPeer = try {
            isTrustedUsbPeerUid(localSocket.peerCredentials.uid)
        } catch (_: Throwable) {
            false
        }
        if (!trustedPeer || !workerSlots.tryAcquire()) {
            Log.w(TAG, "Rejected USB connection before request parsing")
            try {
                writeRejectedResponse(localSocket.outputStream)
            } catch (_: Throwable) {
            }
            closeQuietly(localSocket)
            return
        }

        try {
            val worker = Thread(
                {
                    try {
                        bridgeConnection(localSocket)
                    } finally {
                        workerSlots.release()
                    }
                },
                "penumbra-usb-bridge",
            )
            worker.isDaemon = true
            worker.uncaughtExceptionHandler = safeHandler()
            worker.start()
        } catch (_: Throwable) {
            workerSlots.release()
            closeQuietly(localSocket)
            Log.w(TAG, "Failed to start USB bridge worker")
        }
    }

    private fun bridgeConnection(localSocket: LocalSocket) {
        var httpSocket: Socket? = null
        var relayStartedAt = 0L
        try {
            val peerUid = try {
                localSocket.peerCredentials.uid
            } catch (_: Throwable) {
                throw UsbHttpRequestSecurity.RejectedRequest()
            }
            if (!isTrustedUsbPeerUid(peerUid)) {
                throw UsbHttpRequestSecurity.RejectedRequest()
            }

            localSocket.soTimeout = REQUEST_READ_TIMEOUT_MS
            val configPath = canonicalConfigPath ?: throw UsbHttpRequestSecurity.RejectedRequest()
            val adminToken = try {
                BootstrapConfig.readEffectiveAdminToken(configPath)
            } catch (_: Throwable) {
                Log.w(TAG, "USB bridge credential configuration unavailable")
                throw UsbHttpRequestSecurity.RejectedRequest()
            }
            val httpPort = try {
                BootstrapConfig.readEffectiveHttpPort(configPath)
            } catch (_: Throwable) {
                Log.w(TAG, "USB bridge HTTP configuration unavailable")
                throw UsbHttpRequestSecurity.RejectedRequest()
            }
            val prepared = try {
                UsbHttpRequestSecurity.readAndPrepare(localSocket.inputStream, adminToken)
            } catch (rejected: UsbHttpRequestSecurity.RejectedRequest) {
                Log.w(TAG, "USB bridge request framing rejected")
                throw rejected
            }

            httpSocket = Socket().apply {
                tcpNoDelay = true
                soTimeout = REQUEST_READ_TIMEOUT_MS
                connect(InetSocketAddress(HTTP_HOST, httpPort), CONNECT_TIMEOUT_MS)
            }
            val httpOut = httpSocket.getOutputStream()
            httpOut.write(prepared.headers)
            copyExactly(localSocket.inputStream, httpOut, prepared.contentLength)
            httpOut.flush()

            // Deliberately NOT shutdownOutput() on the loopback socket.
            //
            // hyper's HTTP/1 server defaults to `half_close = false`, and
            // `axum::serve` exposes no way to change it. With that default a
            // read EOF that arrives while a request is still in flight is
            // treated as a broken connection, not as a polite "I'm done
            // sending": hyper's `mid_message_detect_eof` errors the connection
            // and drops the response that the handler was still producing.
            //
            // Half-closing here therefore raced every handler. Anything that
            // answered from memory (`/api/health`, `/api/settings`, the
            // `api_not_found` catch-all) usually beat the FIN, while anything
            // that touched the database, the Binder/AIBUS bridges, or the log
            // files usually lost it, so Center's gallery, conversations,
            // activity, and contacts panes saw a socket that closed with zero
            // response bytes while `/api/health` kept answering 200. A response
            // counts as mid-message until its last byte is written, so the same
            // race reaches the NDJSON streams, not just short JSON replies.
            //
            // Nothing needs the half-close: `UsbHttpRequestSecurity` already
            // rejects any request without an exact Content-Length, so the
            // server never has to infer request framing from EOF, and the
            // injected `Connection: close` still makes the server close the
            // socket once the response is complete, which is what ends the
            // relay below. The host-side recovery bridge
            // (platform/deploy/acceptance/pin/center-adb-http-bridge.mjs) keeps
            // its upstream write side open for exactly the same reason.

            // The request is fully written. From here on the deadline that
            // matters is the gap between RESPONSE chunks, which for a streaming
            // endpoint is the server's heartbeat period, not a request timeout.
            httpSocket.soTimeout = RESPONSE_IDLE_TIMEOUT_MS
            relayStartedAt = System.currentTimeMillis()
            copyStream(httpSocket.getInputStream(), localSocket.outputStream)
            shutdownOutputQuietly(localSocket)
        } catch (_: UsbHttpRequestSecurity.RejectedRequest) {
            // A generic response avoids reflecting parser, header, config, or
            // credential details to an untrusted USB caller.
            try {
                writeRejectedResponse(localSocket.outputStream)
            } catch (_: Throwable) {
            }
            Log.w(TAG, "Rejected malformed or unauthenticated USB HTTP request")
        } catch (_: SocketTimeoutException) {
            // A deadline of OURS, not a failure of the peer. Logging it as
            // "connection failed" is what made the bridge's own timeout read as
            // a flaky Center. The elapsed value is the diagnostic: an idle
            // relay that hits RESPONSE_IDLE_TIMEOUT_MS means the server stopped
            // heartbeating, while a short one means the request phase stalled.
            val elapsed = if (relayStartedAt == 0L) {
                -1L
            } else {
                System.currentTimeMillis() - relayStartedAt
            }
            Log.w(TAG, "USB bridge timed out (relay idle ${elapsed}ms)")
        } catch (t: Throwable) {
            if (!isExpectedSocketClose(t)) {
                Log.w(TAG, "USB bridge connection failed")
            }
        } finally {
            closeQuietly(httpSocket)
            closeQuietly(localSocket)
        }
    }

    private fun copyExactly(input: InputStream, output: OutputStream, length: Long) {
        val buffer = ByteArray(COPY_BUFFER_SIZE)
        var remaining = length
        while (remaining > 0) {
            val requested = minOf(buffer.size.toLong(), remaining).toInt()
            val bytesRead = input.read(buffer, 0, requested)
            if (bytesRead == -1) throw UsbHttpRequestSecurity.RejectedRequest()
            output.write(buffer, 0, bytesRead)
            remaining -= bytesRead
        }
    }

    private fun copyStream(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(COPY_BUFFER_SIZE)
        while (true) {
            val bytesRead = input.read(buffer)
            if (bytesRead == -1) break
            output.write(buffer, 0, bytesRead)
            output.flush()
        }
    }

    private fun writeRejectedResponse(output: OutputStream) {
        try {
            output.write(
                "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                    .toByteArray(StandardCharsets.US_ASCII),
            )
            output.flush()
        } catch (_: Throwable) {
        }
    }

    private fun isExpectedSocketClose(t: Throwable): Boolean =
        t is SocketException && t.message?.contains("Socket closed", ignoreCase = true) == true

    /**
     * Half-close the ADB side only. This is the response terminator Center's
     * USB transport reads when a response carries neither Content-Length nor
     * chunked framing (`makeEofStream`), so it must stay. There is deliberately
     * no loopback-socket counterpart. See the note in `bridgeConnection`.
     */
    private fun shutdownOutputQuietly(socket: LocalSocket) {
        try {
            socket.shutdownOutput()
        } catch (_: Throwable) {
        }
    }

    private fun safeHandler() = Thread.UncaughtExceptionHandler { thread, error ->
        if (isExpectedSocketClose(error)) {
            Log.w(TAG, "Socket closed on ${thread.name}")
        } else {
            // Never include request/config exception detail in this handler;
            // parser failures may have occurred while credentials were live.
            Log.e(TAG, "Uncaught USB bridge worker failure")
        }
    }

    private fun closeQuietly(closeable: Any?) {
        try {
            when (closeable) {
                is LocalServerSocket -> closeable.close()
                is LocalSocket -> closeable.close()
                is Socket -> closeable.close()
                is Closeable -> closeable.close()
            }
        } catch (_: Throwable) {
        }
    }
}
