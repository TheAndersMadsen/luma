package com.penumbraos.hook.injector

import android.annotation.SuppressLint
import android.content.Context
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.PowerManager
import android.util.Log
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * TCP-to-Unix-domain-socket bridge for wireless ADB.
 *
 * Runs inside system_server (UID 1000). On start():
 *   1. Sets service.adb.listen_addrs=localabstract:adb_bridge
 *   2. Cycles sys.usb.config (none -> original) to restart adbd
 *   3. Waits for adbd to come back (15s timeout, reboots on failure)
 *   4. Accepts TCP connections on port 5555 and proxies them to
 *      adbd's abstract unix domain socket
 */
object AdbWifiBridge {

    private const val TAG = "AdbWifiBridge"
    private const val BRIDGE_PORT = 5555
    private const val ABSTRACT_SOCKET_NAME = "adb_bridge"
    private const val LISTEN_ADDRS_PROP = "service.adb.listen_addrs"
    private const val USB_CONFIG_PROP = "sys.usb.config"
    private const val ADBD_SERVICE_PROP = "init.svc.adbd"
    private const val ADBD_RESTART_TIMEOUT_MS = 15_000L
    private const val ADBD_POLL_INTERVAL_MS = 200L
    private const val ADBD_STOP_DELAY_MS = 2_000L
    private const val ADBD_SOCKET_SETTLE_MS = 500L
    private const val COPY_BUFFER_SIZE = 8192

    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null

    // Cached reflection handles for SystemProperties
    private val sysPropClass: Class<*> by lazy {
        Class.forName("android.os.SystemProperties")
    }
    private val sysPropGet: java.lang.reflect.Method by lazy {
        sysPropClass.getDeclaredMethod("get", String::class.java, String::class.java)
    }
    private val sysPropSet: java.lang.reflect.Method by lazy {
        sysPropClass.getDeclaredMethod("set", String::class.java, String::class.java)
    }

    /**
     * Start the bridge. Idempotent -- no-op if already running.
     * Must be called on a background thread (blocks during adbd restart).
     */
    fun start(context: Context) {
        if (!running.compareAndSet(false, true)) {
            log("Bridge already running, ignoring start request")
            return
        }

        try {
            log("=== ADB WiFi Bridge start requested ===")
            configureAdbd(context)
            startBridgeLoop()
        } catch (t: Throwable) {
            running.set(false)
            log("Bridge start failed: ${t.javaClass.simpleName}: ${t.message}")
            Log.e(TAG, "Bridge start failed", t)
        }
    }

    // ------------------------------------------------------------------
    // Phase 1: Configure adbd to listen on an abstract unix socket
    // ------------------------------------------------------------------

    private fun configureAdbd(context: Context) {
        // Step 1: Set the listen address property FIRST (safe, no side effects)
        val listenAddr = "localabstract:$ABSTRACT_SOCKET_NAME"
        log("Setting $LISTEN_ADDRS_PROP=$listenAddr")
        setProp(LISTEN_ADDRS_PROP, listenAddr)

        // Step 2: Read and validate current USB config
        val originalConfig = getProp(USB_CONFIG_PROP, "")
        log("Current $USB_CONFIG_PROP=$originalConfig")

        if (!originalConfig.contains("adb")) {
            log("ERROR: sys.usb.config does not contain 'adb' -- aborting (value: '$originalConfig')")
            running.set(false)
            return
        }

        // Step 3: Cycle sys.usb.config to restart adbd
        log("Setting $USB_CONFIG_PROP=none (stopping adbd)")
        setProp(USB_CONFIG_PROP, "none")

        log("Waiting ${ADBD_STOP_DELAY_MS}ms for adbd to stop")
        Thread.sleep(ADBD_STOP_DELAY_MS)

        log("Setting $USB_CONFIG_PROP=$originalConfig (restarting adbd)")
        setProp(USB_CONFIG_PROP, originalConfig)

        // Step 4: Wait for adbd to come back
        log("Polling for adbd to start (timeout: ${ADBD_RESTART_TIMEOUT_MS}ms)")
        val deadline = System.currentTimeMillis() + ADBD_RESTART_TIMEOUT_MS
        var adbdRunning = false

        while (System.currentTimeMillis() < deadline) {
            val state = getProp(ADBD_SERVICE_PROP, "")
            if (state == "running") {
                adbdRunning = true
                break
            }
            Thread.sleep(ADBD_POLL_INTERVAL_MS)
        }

        if (!adbdRunning) {
            log("CRITICAL: adbd did not restart within ${ADBD_RESTART_TIMEOUT_MS}ms -- REBOOTING")
            running.set(false)
            reboot(context)
            return // unreachable, but satisfies compiler
        }

        log("adbd is running, waiting ${ADBD_SOCKET_SETTLE_MS}ms for socket setup")
        Thread.sleep(ADBD_SOCKET_SETTLE_MS)
        log("adbd configured with abstract socket '$ABSTRACT_SOCKET_NAME'")
    }

    // ------------------------------------------------------------------
    // Phase 2: TCP <-> Unix bridge
    // ------------------------------------------------------------------

    private fun startBridgeLoop() {
        val ss = ServerSocket(BRIDGE_PORT)
        ss.reuseAddress = true
        serverSocket = ss
        log("ServerSocket bound to port $BRIDGE_PORT")

        val acceptThread = Thread({
            try {
                acceptLoop(ss)
            } catch (t: Throwable) {
                log("Accept loop ended: ${t.javaClass.simpleName}: ${t.message}")
            } finally {
                running.set(false)
                closeQuietly(ss)
            }
        }, "adb-bridge-accept")
        acceptThread.isDaemon = true
        acceptThread.uncaughtExceptionHandler = safeHandler()
        acceptThread.start()

        log("Bridge active -- connect via: adb connect <device-ip>:$BRIDGE_PORT")
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (running.get() && !ss.isClosed) {
            val tcpSocket: Socket
            try {
                tcpSocket = ss.accept()
            } catch (t: Throwable) {
                if (running.get()) {
                    log("Accept failed: ${t.javaClass.simpleName}: ${t.message}")
                }
                continue
            }

            log("TCP connection from ${tcpSocket.remoteSocketAddress}")

            try {
                bridgeConnection(tcpSocket)
            } catch (t: Throwable) {
                log("Failed to bridge connection: ${t.javaClass.simpleName}: ${t.message}")
                closeQuietly(tcpSocket)
            }
        }
    }

    private fun bridgeConnection(tcpSocket: Socket) {
        val unixSocket = LocalSocket()
        try {
            unixSocket.connect(
                LocalSocketAddress(ABSTRACT_SOCKET_NAME, LocalSocketAddress.Namespace.ABSTRACT)
            )
        } catch (t: Throwable) {
            log("Failed to connect to adbd socket '$ABSTRACT_SOCKET_NAME': ${t.javaClass.simpleName}: ${t.message}")
            closeQuietly(tcpSocket)
            closeQuietly(unixSocket)
            return
        }

        val tcpIn = tcpSocket.getInputStream()
        val tcpOut = tcpSocket.getOutputStream()
        val unixIn = unixSocket.inputStream
        val unixOut = unixSocket.outputStream

        // TCP -> Unix
        val txThread = Thread({
            try {
                copyStream(tcpIn, unixOut)
            } finally {
                closeQuietly(tcpSocket)
                closeQuietly(unixSocket)
            }
        }, "adb-bridge-tx")
        txThread.isDaemon = true
        txThread.uncaughtExceptionHandler = safeHandler()

        // Unix -> TCP
        val rxThread = Thread({
            try {
                copyStream(unixIn, tcpOut)
            } finally {
                closeQuietly(tcpSocket)
                closeQuietly(unixSocket)
            }
        }, "adb-bridge-rx")
        rxThread.isDaemon = true
        rxThread.uncaughtExceptionHandler = safeHandler()

        txThread.start()
        rxThread.start()
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

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    // This receiver runs inside system_server. Keep the permission lint
    // suppression local: declaring REBOOT in the /data/app manifest makes this
    // firmware's privapp allowlist enforcement crash-loop system_server.
    @SuppressLint("MissingPermission")
    private fun reboot(context: Context) {
        log("Initiating reboot via PowerManager")
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.reboot(null)
        } catch (t: Throwable) {
            Log.e(TAG, "PowerManager.reboot() failed", t)
        }
    }

    private fun getProp(name: String, default: String): String {
        return sysPropGet.invoke(null, name, default) as String
    }

    private fun setProp(name: String, value: String) {
        sysPropSet.invoke(null, name, value)
    }

    private fun safeHandler() = Thread.UncaughtExceptionHandler { t, e ->
        Log.e(TAG, "Uncaught on ${t.name}", e)
    }

    private fun closeQuietly(closeable: Any?) {
        try {
            when (closeable) {
                is ServerSocket -> closeable.close()
                is Socket -> closeable.close()
                is LocalSocket -> closeable.close()
            }
        } catch (_: Throwable) {}
    }

    private fun log(msg: String) {
        Log.w(TAG, msg)
    }
}
