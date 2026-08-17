package com.penumbraos.hook

import android.content.Context
import android.os.Process
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
import java.io.BufferedReader
import java.io.InputStreamReader
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicLong

object EsimEventEmitter {

    private const val TAG = "PenumbraHook"
    private const val TCP_HOST = "127.0.0.1"
    private const val TCP_PORT = 16789
    private const val SOURCE_PROCESS = StockSymbols.EsimLpa.PACKAGE
    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val AUTH_TIMEOUT_MS = 5_000
    private const val MAX_PENDING_EVENTS = 256
    private const val DROP_WARNING_INTERVAL_NANOS = 5_000_000_000L

    private val pendingEvents = LinkedBlockingQueue<PendingEvent>(MAX_PENDING_EVENTS)
    private val lastDropWarningNanos = AtomicLong(0)

    @Volatile
    private var appContext: Context? = null

    init {
        Thread({
            while (true) {
                try {
                    val event = pendingEvents.take()
                    send(event)
                } catch (t: Throwable) {
                    Log.w(TAG, "eSIM event worker failed", t)
                }
            }
        }, "penumbra-esim-events").apply {
            isDaemon = true
            uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, error ->
                Log.e(TAG, "Uncaught on ${thread.name}", error)
            }
            start()
        }
    }

    fun setContext(context: Context) {
        appContext = context.applicationContext
    }

    fun emitActionStarted(operation: EsimOperationSnapshot) {
        val extras = JSONObject()
        EsimBridgeAuthentication.actionStartedExtras(
            // DISABLED per R-006: ICCID is an eSIM identifier; redact from event payloads.
            // The server already knows the ICCID from the operation intent; echoing it
            // in events expands the identifier surface without adding correlation value.
            iccid = null,
            nickname = operation.nickname,
            source = operation.source,
            activationCodeProvided = operation.activationCodeProvided,
        ).forEach { (key, value) -> extras.put(key, value ?: JSONObject.NULL) }
        emit(
            operation,
            "esim.action_started",
            JSONObject().put(
                "extras",
                extras,
            )
        )
    }

    fun emitSyspropUpdate(operation: EsimOperationSnapshot, key: String, value: String?) {
        emit(
            operation,
            "esim.sysprop_update",
            JSONObject()
                .put("key", key)
                .put("value", value)
        )
    }

    fun emitDeviceIdentifier(operation: EsimOperationSnapshot, key: String, value: String?) {
        emitSyspropUpdate(operation, key, value)
    }

    fun emitProfileMutationResult(
        request: EsimOperationSnapshot,
        operation: String,
        result: String,
        message: String?,
    ) {
        emit(
            request,
            "esim.profile_mutation_result",
            JSONObject()
                .put("operation", operation)
                // DISABLED per R-006: redact eSIM identifier (target ICCID) from event payload.
                // The operation_token provides request correlation; the ICCID is not needed here.
                .put("target_iccid", JSONObject.NULL)
                .put("nickname", request.nickname)
                .put("result", result)
                .put("message", message)
        )
    }

    fun emitDownloadProgress(
        operation: EsimOperationSnapshot,
        phase: String,
        progress: Int? = null,
        message: String? = null,
    ) {
        emit(
            operation,
            "esim.download_progress",
            JSONObject()
                .put("phase", phase)
                .put("progress", progress?.let { Integer.valueOf(it) } ?: JSONObject.NULL)
                // DISABLED per R-006: redact eSIM identifier (download ICCID) from event payload.
                .put("iccid", JSONObject.NULL)
                .put("message", message)
        )
    }

    fun emitDownloadResult(operation: EsimOperationSnapshot, result: String, message: String?) {
        emit(
            operation,
            "esim.download_result",
            JSONObject()
                .put("result", result)
                // DISABLED per R-006: redact eSIM identifier (download ICCID) from event payload.
                .put("iccid", JSONObject.NULL)
                .put("message", message)
        )
    }

    private fun emit(operation: EsimOperationSnapshot, type: String, payload: JSONObject) {
        val event = JSONObject()
            .put("version", 1)
            .put("type", type)
            .put("ts_ms", System.currentTimeMillis())
            .put("source_process", SOURCE_PROCESS)
            .put("source_pid", Process.myPid())
            .put("request_id", operation.requestId)
            .put("action", operation.action)
            .put("operation_token", operation.operationToken)
            .put("payload", payload)

        enqueue(
            PendingEvent(
                type = type,
                body = event.toString(),
                bridgeAuthToken = operation.bridgeAuthToken,
            ),
        )
    }

    private fun enqueue(event: PendingEvent) {
        if (pendingEvents.offer(event)) return

        // Keep the newest operation state while preventing a stalled or
        // attacked loopback listener from growing the LPA process without
        // bound. The queue is FIFO during normal operation.
        pendingEvents.poll()
        pendingEvents.offer(event)
        logDroppedEvent()
    }

    private fun logDroppedEvent() {
        val now = System.nanoTime()
        val previous = lastDropWarningNanos.get()
        if (previous != 0L && now - previous < DROP_WARNING_INTERVAL_NANOS) return
        if (lastDropWarningNanos.compareAndSet(previous, now)) {
            Log.w(TAG, "Dropped oldest queued eSIM event at queue limit")
        }
    }

    private fun send(event: PendingEvent) {
        var socket: Socket? = null
        var reader: BufferedReader? = null
        var writer: OutputStreamWriter? = null
        try {
            val token = event.bridgeAuthToken ?: run {
                val context = checkNotNull(appContext) { "eSIM event context unavailable" }
                EsimBridgeAuthentication.loadToken(context)
            }
            socket = Socket().apply {
                connect(InetSocketAddress(TCP_HOST, TCP_PORT), CONNECT_TIMEOUT_MS)
                soTimeout = AUTH_TIMEOUT_MS
            }
            reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
            writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)
            if (!EsimBridgeAuthentication.authenticateServer(reader, writer, token)) {
                Log.w(TAG, "eSIM event authentication was rejected")
                return
            }
            writer.write(event.body)
            writer.write('\n'.code)
            writer.flush()
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to emit eSIM event type=${event.type} (${t.javaClass.simpleName})")
        } finally {
            try {
                reader?.close()
            } catch (_: Throwable) {
            }
            try {
                writer?.close()
            } catch (_: Throwable) {
            }
            try {
                socket?.close()
            } catch (_: Throwable) {
            }
        }
    }

    private data class PendingEvent(
        val type: String,
        val body: String,
        val bridgeAuthToken: String?,
    )
}
