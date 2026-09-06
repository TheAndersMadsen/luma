package dk.andersmadsen.cosmos.android

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID

enum class Phase { DISCONNECTED, PREPARING, PREPARED, CONNECTING, CONNECTED, BLOCKED }

/** Everything the UI may show. Credentials and journal bytes never enter it. */
data class SurfaceState(
    val phase: Phase = Phase.DISCONNECTED,
    val serverOrigin: String = "https://center.andersmadsen.dk",
    val descriptor: Descriptor? = null,
    val hasPending: Boolean = false,
    val pendingOpen: Boolean = false,
    val needsReconnect: Boolean = false,
    val canRetry: Boolean = false,
    val hasUnknownOutcome: Boolean = false,
    val admission: Admission? = null,
    val visible: Boolean = false,
    val display: DisplayCard? = null,
    val message: String = "Prepare this installation, then approve its public descriptor in Center.",
    val busy: Boolean = false,
) {
    val canPrepare get() = !busy && phase in setOf(Phase.DISCONNECTED, Phase.PREPARED, Phase.BLOCKED) && !hasPending
    val canConnect get() = !busy && descriptor != null && phase in setOf(Phase.PREPARED, Phase.DISCONNECTED) || (!busy && (needsReconnect || pendingOpen))
    val canSend get() = !busy && phase == Phase.CONNECTED && !hasPending && !pendingOpen && !needsReconnect
    val canCancel get() = canSend && admission != null
    val canDisconnect get() = !busy && phase !in setOf(Phase.DISCONNECTED, Phase.PREPARED)
}

/**
 * Owns the single native handle for the process. Commands are serialized;
 * snapshots are polled on a short interval and folded into [state]. Rendering
 * acknowledgment is a separate explicit call made after the card is on screen.
 */
class SurfaceController(context: Context) {
    private val application = context.applicationContext
    private val identity = KeystoreIdentity.open(application)
    private val journal = JournalStore.open(application)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val commands = Mutex()
    private val _state = MutableStateFlow(SurfaceState(serverOrigin = application
        .getSharedPreferences("cosmos-installation", Context.MODE_PRIVATE)
        .getString("serverOrigin", null) ?: "https://center.andersmadsen.dk"))
    val state: StateFlow<SurfaceState> = _state
    private var handle = 0L
    private var wantedVisible = false
    private var acknowledged: UUID? = null

    private val callbacks = object : NativeCallbacks {
        override fun publicKey(): ByteArray = identity.publicKeySec1()
        override fun signSha256(message: ByteArray): ByteArray = identity.signSha256(message)
        override fun readJournal(): ByteArray? = journal.read()
        override fun writeJournalAtomically(bytes: ByteArray): Boolean = runCatching { journal.writeAtomically(bytes) }.isSuccess
    }

    init {
        scope.launch {
            while (true) {
                drain()
                delay(200)
            }
        }
    }

    /** Leanback devices such as the Shield enroll as android_tv so hints can name the TV. */
    val platform: String = if (application.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)) "android_tv" else "android"

    private fun bootEpoch(): String {
        val id = File("/proc/sys/kernel/random/boot_id").readText().trim()
        return UUID.fromString(id).toString()
    }

    private fun drain() {
        val current = handle
        if (current == 0L) return
        repeat(16) {
            val bytes = NativeSurface.poll(current) ?: return
            val event = runCatching { NativeEvent.decode(bytes) }.getOrNull()
            if (event == null) {
                Log.w(TAG, "undecodable snapshot: ${String(bytes, Charsets.UTF_8).take(400)}")
                _state.update { it.copy(phase = Phase.BLOCKED, message = "Cosmos returned a response this app could not verify.") }
                return
            }
            fold(event)
        }
    }

    private fun fold(event: NativeEvent) {
        // Snapshots are redacted by the native client: no journal, token or request text.
        Log.d(TAG, "snapshot ${event.operation} ${if (event.ok) "ok" else event.error} connected=${event.connected} visible=${event.visible} card=${event.display?.actionId}")
        _state.update { previous ->
            val failure = event.error?.let(::message)
            val phase = when {
                event.connected -> Phase.CONNECTED
                event.error in setOf("invalid_signature", "invalid_response", "invalid_journal", "panic", "persistence") -> Phase.BLOCKED
                event.operation == "prepare" && event.ok -> Phase.PREPARED
                previous.descriptor != null -> Phase.PREPARED
                else -> Phase.DISCONNECTED
            }
            previous.copy(
                phase = phase,
                descriptor = event.descriptor ?: previous.descriptor,
                hasPending = event.pending != null || event.pendingOpen,
                pendingOpen = event.pendingOpen,
                needsReconnect = event.needsReconnect,
                canRetry = (event.pending?.canRetry ?: false) && !event.needsReconnect,
                hasUnknownOutcome = event.lastUnknown != null,
                admission = event.admission,
                visible = event.visible,
                display = event.display,
                message = failure ?: when (event.operation) {
                    "prepare" -> "Approve this public descriptor in Center, then connect."
                    "connect" -> "Cosmos confirmed the connection. Cards may appear here while this screen is visible."
                    "send_text" -> "Request admitted by Cosmos. The response appears on the approved display it selects."
                    "cancel" -> "Cancellation admitted by Cosmos."
                    "disconnect" -> "Session disconnected. Owner approval remains in Center."
                    "retry_pending" -> "Cosmos confirmed the pending operation with its exact request."
                    else -> previous.message
                },
            )
        }
        // Published after the state so a waiting command observes both together.
        lastOperation = event.operation
    }

    private fun message(code: String): String = when (code) {
        "pending_operation" -> "The request outcome is unknown. Retry the exact pending request before sending another."
        "persistence", "invalid_journal" -> "Protected storage failed. Retry the pending request before connecting or sending."
        "invalid_signature" -> "The installation identity could not be used from the Keystore."
        "invalid_config" -> "Enter an HTTPS server address with no path, credentials or query."
        "invalid_input" -> "Enter public text of at most 4,000 UTF-8 bytes."
        "denied" -> "Approve this installation in Center before connecting."
        "busy" -> "Wait for the current operation to finish."
        "no_display" -> "No card is currently shown."
        else -> "The Cosmos connection could not be confirmed."
    }

    private suspend fun command(name: String, block: () -> Int) = commands.withLock {
        if (handle == 0L) {
            _state.update { it.copy(message = "Prepare this installation first.") }
            return@withLock
        }
        _state.update { it.copy(busy = true) }
        lastOperation = null
        val code = withContext(Dispatchers.IO) { block() }
        if (code != NativeSurface.OK) {
            Log.w(TAG, "native $name refused with code $code")
            _state.update { it.copy(busy = false, message = if (code == NativeSurface.QUEUE_FULL) message("busy") else message("unavailable")) }
            return@withLock
        }
        // Wait for the operation's own snapshot; the poll loop folds it.
        val deadline = System.currentTimeMillis() + 90_000
        while (System.currentTimeMillis() < deadline) {
            delay(100)
            val settled = _state.value.let { it.phase == Phase.BLOCKED || lastOperation == name }
            if (settled) break
        }
        lastOperation = null
        _state.update { it.copy(busy = false) }
    }

    @Volatile private var lastOperation: String? = null

    fun prepare(serverOrigin: String) {
        val origin = serverOrigin.trim().trimEnd('/')
        scope.launch {
            commands.withLock {
                _state.update { it.copy(busy = true, phase = Phase.PREPARING, descriptor = null, serverOrigin = origin) }
                withContext(Dispatchers.IO) {
                    runCatching {
                        if (handle != 0L) { NativeSurface.destroy(handle); handle = 0 }
                        val config = JSONObject().put("version", 1).put("serverOrigin", origin)
                            .put("enrollmentId", identity.enrollmentId.toString()).put("platform", platform)
                            .put("bootEpoch", bootEpoch()).toString().toByteArray()
                        // The native process slot is released shortly after destroy; retry that window.
                        var created = NativeSurface.create(config, callbacks)
                        var attempts = 0
                        while (created == NativeSurface.QUEUE_FULL.toLong() && attempts < 30) {
                            attempts += 1
                            Thread.sleep(300)
                            created = NativeSurface.create(config, callbacks)
                        }
                        Log.d(TAG, "native create returned $created after $attempts retries")
                        if (!NativeSurface.isStatus(created)) {
                            handle = created
                            application.getSharedPreferences("cosmos-installation", Context.MODE_PRIVATE)
                                .edit().putString("serverOrigin", origin).apply()
                        } else {
                            _state.update { it.copy(phase = Phase.DISCONNECTED, message = message(if (created == NativeSurface.QUEUE_FULL.toLong()) "busy" else "invalid_config") + " (native $created)") }
                        }
                    }.onFailure { error ->
                        Log.w(TAG, "prepare failed", error)
                        _state.update { it.copy(phase = Phase.BLOCKED, message = "The installation identity or protected storage could not be opened.") }
                    }
                }
                if (handle != 0L) {
                    val deadline = System.currentTimeMillis() + 30_000
                    while (System.currentTimeMillis() < deadline && _state.value.descriptor == null && _state.value.phase == Phase.PREPARING) delay(100)
                }
                _state.update { it.copy(busy = false) }
            }
        }
    }

    companion object { private const val TAG = "Cosmos" }

    fun connect() = scope.launch {
        command("connect") { NativeSurface.connect(handle) }
        // Visibility lives on the connection: re-report the retained foreground
        // state after every successful connect, even if a snapshot lagged.
        if (wantedVisible && _state.value.phase == Phase.CONNECTED) {
            command("set_visible") { NativeSurface.setVisible(handle, true) }
        }
    }
    fun send(text: String) = scope.launch { command("send_text") { NativeSurface.sendText(handle, text.toByteArray()) } }
    fun retryPending() = scope.launch { command("retry_pending") { NativeSurface.retryPending(handle) } }
    fun cancel() = scope.launch { command("cancel") { NativeSurface.cancel(handle) } }
    fun disconnect() = scope.launch { command("disconnect") { NativeSurface.disconnect(handle) } }

    /** The app's own foreground report. Availability only; never occupancy or identity. */
    fun setVisible(visible: Boolean) {
        if (wantedVisible == visible) return
        wantedVisible = visible
        if (handle == 0L) return
        scope.launch { command("set_visible") { NativeSurface.setVisible(handle, visible) } }
    }

    /** Call only after the complete card, credits included, is committed to the screen. */
    fun displayCommitted(card: DisplayCard) {
        if (acknowledged == card.actionId || _state.value.display != card) return
        acknowledged = card.actionId
        scope.launch { command("acknowledge") { NativeSurface.acknowledge(handle) } }
    }
}
