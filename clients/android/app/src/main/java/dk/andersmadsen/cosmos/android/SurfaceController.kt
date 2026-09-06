package dk.andersmadsen.cosmos.android

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
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
    /** The current spoken reply, if any; [speaking] is true only while its audio plays. */
    val speech: SpeechReply? = null,
    /** A private card is waiting for this device's unlocked foreground; it carries no content. */
    val invitation: Invitation? = null,
    val speaking: Boolean = false,
    val message: String = "Prepare this installation, then approve its public descriptor in Center.",
    val busy: Boolean = false,
    /** Center admitted this installation at least once; a denial clears it. Persisted beside the server origin. */
    val approved: Boolean = false,
    /** True from Connect (explicit or retained) until Disconnect; the session service runs while it is set. */
    val connectionWanted: Boolean = false,
    /** The last native call or snapshot failed and [message] explains it. */
    val alert: Boolean = false,
    /** The operation of the last folded snapshot, so the UI can tell fresh feedback from steady state. */
    val operation: String = "",
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
    private val preferences = application.getSharedPreferences("cosmos-installation", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(SurfaceState(
        serverOrigin = preferences.getString("serverOrigin", null) ?: "https://center.andersmadsen.dk",
        approved = preferences.getBoolean("approved", false),
    ))
    val state: StateFlow<SurfaceState> = _state
    private var handle = 0L
    private var wantedVisible = false
    private var acknowledged: UUID? = null
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var playing: UUID? = null
    private var played: UUID? = null
    /** True after an explicit Disconnect until the next explicit Connect; automatic reconnection stays off. */
    @Volatile private var wantsConnection = false
        set(value) {
            if (field == value) return
            field = value
            // The session service runs exactly while a connection is wanted, so the joined
            // room survives the screen turning off; the UI mirrors the same flag.
            _state.update { it.copy(connectionWanted = value) }
            SessionService.setWanted(application, value)
        }
    @Volatile private var reconnectAttempt = 0
    @Volatile private var reconnectDueAt = 0L

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
                reconnectIfDue()
                delay(200)
            }
        }
        // An existing installation journal means this phone was set up before:
        // open it on launch so a retained connection rejoins without a tap.
        if (journal.read() != null) prepare(_state.value.serverOrigin)
    }

    /**
     * A dropped room (network change, server restart) is rejoined without the
     * owner pressing Connect: bounded backoff, only while the installation was
     * connected on purpose, never over a pending or blocked operation.
     */
    private suspend fun reconnectIfDue() {
        val state = _state.value
        val eligible = wantsConnection && !state.busy && state.descriptor != null && state.phase != Phase.BLOCKED
            && state.phase != Phase.CONNECTED && !state.hasPending && (state.needsReconnect || state.pendingOpen || state.phase == Phase.DISCONNECTED || state.phase == Phase.PREPARED)
        if (!eligible) return
        val now = System.currentTimeMillis()
        if (reconnectDueAt == 0L) { reconnectDueAt = now + backoffMs(reconnectAttempt); return }
        if (now < reconnectDueAt) return
        if (reconnecting) return
        reconnectDueAt = 0L
        reconnectAttempt = (reconnectAttempt + 1).coerceAtMost(6)
        Log.d(TAG, "automatic reconnect attempt $reconnectAttempt")
        // The attempt runs beside the poll loop: a command settles only when the
        // loop folds its snapshot, so awaiting it here would stall both.
        reconnecting = true
        scope.launch {
            try {
                command("connect") { NativeSurface.connect(handle) }
                if (_state.value.phase == Phase.CONNECTED) {
                    reconnectAttempt = 0
                    if (wantedVisible) command("set_visible") { NativeSurface.setVisible(handle, true) }
                }
            } finally {
                reconnecting = false
            }
        }
    }
    @Volatile private var reconnecting = false

    private fun backoffMs(attempt: Int): Long = when (attempt) { 0 -> 1_500L; 1 -> 3_000L; 2 -> 6_000L; 3 -> 12_000L; else -> 30_000L }

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
        Log.d(TAG, "snapshot ${event.operation} ${if (event.ok) "ok" else event.error} connected=${event.connected} visible=${event.visible} card=${event.display?.actionId} speech=${event.speech?.actionId} waiting=${event.invitation?.id}")
        _state.update { previous ->
            val failure = event.error?.let(::message)
            val phase = when {
                event.connected -> Phase.CONNECTED
                event.error in setOf("invalid_signature", "invalid_response", "invalid_journal", "panic", "persistence") -> Phase.BLOCKED
                event.operation == "prepare" && event.ok -> Phase.PREPARED
                previous.descriptor != null -> Phase.PREPARED
                else -> Phase.DISCONNECTED
            }
            // A retained signed connection means the owner connected on purpose;
            // rejoin it after a relaunch or a dropped room without another tap.
            if (event.operation == "prepare" && event.ok && (event.pendingOpen || event.needsReconnect)) wantsConnection = true
            val approved = when { event.connected -> true; event.error == "denied" -> false; else -> previous.approved }
            if (approved != previous.approved) preferences.edit().putBoolean("approved", approved).apply()
            previous.copy(
                approved = approved,
                alert = failure != null,
                operation = event.operation,
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
                speech = event.speech,
                invitation = event.invitation,
                speaking = event.speech != null && playing == event.speech.actionId,
                message = failure ?: when (event.operation) {
                    "prepare" -> "Approve this public descriptor in Center, then connect."
                    "connect" -> "Cosmos confirmed the connection. Cards and spoken replies may arrive here while this screen is visible."
                    "speech" -> if (event.speech != null) "Cosmos is speaking the reply on this device." else previous.message
                    "send_text" -> "Request admitted by Cosmos. The response appears on the approved display it selects."
                    "cancel" -> "Cancellation admitted by Cosmos."
                    "disconnect" -> "Session disconnected. Owner approval remains in Center."
                    "display", "speech", "heartbeat" -> if (!event.connected && previous.phase == Phase.CONNECTED && wantsConnection) "The Cosmos connection dropped. Reconnecting…" else previous.message
                    "retry_pending" -> "Cosmos confirmed the pending operation with its exact request."
                    else -> previous.message
                },
            )
        }
        // Published after the state so a waiting command observes both together. Only the
        // awaited operation is recorded: a display or speech snapshot folded in the same poll
        // batch must not hide the connect snapshot the command is waiting for.
        if (event.operation == awaiting) lastOperation = event.operation
        main.post { syncPlayback(event.speech) }
    }

    /**
     * Plays the exact delivered bytes once, then acknowledges. A retired or replaced
     * reply stops immediately and is never acknowledged. Runs on the main thread.
     */
    private fun syncPlayback(speech: SpeechReply?) {
        val current = playing
        if (current != null && speech?.actionId != current) stopPlayback()
        if (speech == null || speech.actionId == playing || speech.actionId == played) return
        val bytes = NativeSurface.speechAudio(handle) ?: return
        if (bytes.size != speech.byteLength) { Log.w(TAG, "speech bytes did not match the snapshot"); return }
        val file = File(application.cacheDir, "speech-${speech.actionId}.mp3")
        val started = runCatching {
            file.writeBytes(bytes)
            MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                setDataSource(file.path)
                setOnCompletionListener {
                    if (playing == speech.actionId) {
                        played = speech.actionId
                        stopPlayback()
                        _state.update { it.copy(speaking = false) }
                        scope.launch { command("acknowledge_speech") { NativeSurface.acknowledgeSpeech(handle) } }
                    }
                }
                setOnErrorListener { _, _, _ -> stopPlayback(); _state.update { it.copy(speaking = false) }; true }
                prepare()
                start()
            }
        }.getOrElse { error -> Log.w(TAG, "speech playback failed", error); file.delete(); return }
        player = started
        playing = speech.actionId
        _state.update { it.copy(speaking = true) }
    }

    private fun stopPlayback() {
        val id = playing ?: return
        playing = null
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        File(application.cacheDir, "speech-$id.mp3").delete()
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
        "no_speech" -> "No spoken reply is current."
        else -> "The Cosmos connection could not be confirmed."
    }

    private suspend fun command(name: String, block: () -> Int) = commands.withLock {
        if (handle == 0L) {
            _state.update { it.copy(alert = true, message = "Prepare this installation first.") }
            return@withLock
        }
        _state.update { it.copy(busy = true) }
        lastOperation = null
        awaiting = name
        val code = withContext(Dispatchers.IO) { block() }
        if (code != NativeSurface.OK) {
            Log.w(TAG, "native $name refused with code $code")
            _state.update { it.copy(busy = false, alert = true, message = if (code == NativeSurface.QUEUE_FULL) message("busy") else message("unavailable")) }
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
    @Volatile private var awaiting: String? = null

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
                            preferences.edit().putString("serverOrigin", origin).apply()
                        } else {
                            _state.update { it.copy(phase = Phase.DISCONNECTED, alert = true, message = message(if (created == NativeSurface.QUEUE_FULL.toLong()) "busy" else "invalid_config") + " (native $created)") }
                        }
                    }.onFailure { error ->
                        Log.w(TAG, "prepare failed", error)
                        _state.update { it.copy(phase = Phase.BLOCKED, alert = true, message = "The installation identity or protected storage could not be opened.") }
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
        wantsConnection = true
        reconnectAttempt = 0
        reconnectDueAt = 0L
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
    fun disconnect() = scope.launch {
        wantsConnection = false
        reconnectDueAt = 0L
        command("disconnect") { NativeSurface.disconnect(handle) }
    }

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
