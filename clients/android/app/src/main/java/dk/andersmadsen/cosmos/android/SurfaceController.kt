package dk.andersmadsen.cosmos.android

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.Log
import dk.andersmadsen.cosmos.android.action.ActionLedger
import dk.andersmadsen.cosmos.android.action.ActionOutcome
import dk.andersmadsen.cosmos.android.action.ActionRunner
import dk.andersmadsen.cosmos.android.action.Ceremony
import dk.andersmadsen.cosmos.android.action.CeremonyEvent
import dk.andersmadsen.cosmos.android.action.CeremonyState
import dk.andersmadsen.cosmos.android.action.DevicePolicy
import dk.andersmadsen.cosmos.android.action.DeviceTask
import dk.andersmadsen.cosmos.android.action.HeldPolicy
import dk.andersmadsen.cosmos.android.action.Operation
import dk.andersmadsen.cosmos.android.action.PlannedAction
import dk.andersmadsen.cosmos.android.action.PlaybackState
import dk.andersmadsen.cosmos.android.action.Report
import dk.andersmadsen.cosmos.android.action.Revoked
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
    /** Where the current turn stands, as Cosmos last reported it. */
    val status: TurnStatus? = null,
    /**
     * The last command this device bound, kept after Cosmos retires it so the
     * card can say how it ended. [taskReport] is what this device observed and
     * said; nothing else may claim an outcome.
     */
    val task: DeviceTask? = null,
    val taskStartedAtMs: Long = 0,
    val taskReport: Report? = null,
    /** Close hides the card; the command itself carries on. */
    val taskClosed: Boolean = false,
    /** The ceremony this device is the venue for, and how it was answered. */
    val ceremony: Ceremony? = null,
    /**
     * The owner's own permission for this installation, as Cosmos delivered it
     * over the connection this device holds. Null means this device holds none
     * — the ordinary state before the owner allows anything, and the state
     * again the moment the connection drops — and then it carries nothing out.
     */
    val permission: DevicePolicy? = null,
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
    /**
     * How many send commands this installation has finished, refused ones included.
     * A screen records it before asking and knows its own send is over when it moves;
     * no command can be running when a send starts, so it can only be that send.
     */
    val sends: Long = 0,
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
    @Volatile private var wantedVisible = false
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
                expireCeremony()
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
        // A half-open connection is exactly what an automatic reconnect is for,
        // and Connect itself finishes it. Any other pending operation waits for
        // the owner, because retrying that could repeat a request.
        val eligible = wantsConnection && !state.busy && state.descriptor != null && state.phase != Phase.BLOCKED
            && state.phase != Phase.CONNECTED && (state.pendingOpen || !state.hasPending)
            && (state.needsReconnect || state.pendingOpen || state.phase == Phase.DISCONNECTED || state.phase == Phase.PREPARED)
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
        Log.d(TAG, "snapshot ${event.operation} ${if (event.ok) "ok" else event.error} connected=${event.connected} visible=${event.visible} card=${event.display?.actionId} speech=${event.speech?.actionId} waiting=${event.invitation?.id} permission=${event.policy != null}")
        val permission = hold(event.policy)
        _state.update { previous ->
            val failure = event.error?.let(::explain)
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
                // A stale report says the command it named is no longer the
                // current one. Nothing was closed and nothing failed, so it is
                // said plainly and never styled as a failure.
                alert = event.error?.let(::isFailure) == true,
                permission = permission,
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
                status = event.status,
                // A command stays on screen after Cosmos retires it, so the
                // card can say how it ended; a new one replaces it whole.
                task = event.task ?: previous.task,
                taskStartedAtMs = if (fresh(event, previous)) System.currentTimeMillis() else previous.taskStartedAtMs,
                taskReport = if (fresh(event, previous)) null else previous.taskReport,
                taskClosed = if (fresh(event, previous)) false else previous.taskClosed,
                // A ceremony belongs to its own grant: a new one is a new
                // question, and a withdrawn one takes the sheet away.
                ceremony = when {
                    event.confirmation == null -> null
                    previous.ceremony?.confirmation?.grantId == event.confirmation.grantId -> previous.ceremony
                    else -> Ceremony.open(event.confirmation, System.currentTimeMillis())
                },
                speaking = event.speech != null && playing == event.speech.actionId,
                message = failure ?: when (event.operation) {
                    "prepare" -> "Approve this phone in Center, then connect."
                    "connect" -> "Connected."
                    "speech" -> if (event.speech != null) "Speaking the reply here." else previous.message
                    // The status line already says Working; the notice stays quiet on a clean send.
                    "send_text" -> ""
                    // A report that landed says nothing; only a stale one, which
                    // is the `failure` above, has anything left to say.
                    "report" -> ""
                    "cancel" -> "The task was cancelled."
                    "disconnect" -> "Disconnected. This phone stays approved in Center."
                    "display", "speech", "heartbeat" -> if (!event.connected && previous.phase == Phase.CONNECTED && wantsConnection) "Reconnecting…" else previous.message
                    "retry_pending" -> "The pending request was confirmed."
                    else -> previous.message
                },
            )
        }
        // Published after the state so a waiting command observes both together. Only the
        // awaited operation is recorded: a display or speech snapshot folded in the same poll
        // batch must not hide the connect snapshot the command is waiting for.
        if (event.operation == awaiting) lastOperation = event.operation
        main.post { syncPlayback(event.speech) }
        event.revoked?.let(::stop)
        // Only a snapshot the arriving frame itself produced may re-send a
        // report; the steady state carries the same command over and over.
        event.task?.let { task -> scope.launch { carryOut(task, event.operation == "task") } }
    }

    /**
     * The owner's own permission for this installation, as this device holds
     * it. The snapshot names the copy; these are its bytes, read again only
     * when the digest it names changes, and verified here against that name
     * before anything is held. A snapshot naming none — including every
     * snapshot of a dropped connection — leaves this device holding nothing,
     * and nothing is ever written to disk: it is a cache of one approval.
     */
    private fun hold(named: HeldPolicy?): DevicePolicy? {
        if (named == null) {
            heldDigest = null
            return null
        }
        if (named.digest == heldDigest) return _state.value.permission
        heldDigest = named.digest
        val policy = NativeSurface.devicePolicy(handle)?.let { DevicePolicy.decode(it, named) }
        if (policy == null) Log.w(TAG, "the delivered permission did not verify against this connection")
        return policy
    }

    /** The digest of the copy already held, so an unchanged one is not read again. */
    @Volatile private var heldDigest: String? = null

    /** True when this snapshot carries a command this device has not seen before. */
    private fun fresh(event: NativeEvent, previous: SurfaceState): Boolean =
        event.task != null && event.task.actionId != previous.task?.actionId

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

    private suspend fun command(name: String, block: () -> Int) = commands.withLock {
        if (handle == 0L) {
            _state.update { it.copy(alert = true, message = "Set this phone up first.", sends = it.sends + finished(name)) }
            return@withLock
        }
        _state.update { it.copy(busy = true) }
        lastOperation = null
        awaiting = name
        val code = withContext(Dispatchers.IO) { block() }
        if (code == NativeSurface.NOT_IN_THIS_BUILD) {
            // Refused here, before anything left the phone; the owner is told plainly that it did not go.
            Log.w(TAG, "native $name is not in this build")
            _state.update { it.copy(busy = false, alert = true, operation = name, message = explain("not_in_this_build"), sends = it.sends + finished(name)) }
            return@withLock
        }
        if (code != NativeSurface.OK) {
            Log.w(TAG, "native $name refused with code $code")
            _state.update { it.copy(busy = false, alert = true, message = if (code == NativeSurface.QUEUE_FULL) explain("busy") else explain("unavailable"), sends = it.sends + finished(name)) }
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
        _state.update { it.copy(busy = false, sends = it.sends + finished(name)) }
    }

    private fun finished(name: String): Long = if (name.startsWith("send_text")) 1 else 0

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
                            _state.update { it.copy(phase = Phase.DISCONNECTED, alert = true, message = explain(if (created == NativeSurface.QUEUE_FULL.toLong()) "busy" else "invalid_config") + " (native $created)") }
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

    // ---------------------------------------------------------------------
    // Device actions
    // ---------------------------------------------------------------------

    private val runner = ActionRunner(application, platform)
    private val ledger = ActionLedger()
    private val actions = Mutex()
    /** The command being carried out right now, so a repeated snapshot does nothing. */
    @Volatile private var carrying: UUID? = null
    /** The command whose launch this device actually started. */
    @Volatile private var launched: UUID? = null
    /** The command Cosmos retired; the effect stops and reports what it can prove. */
    @Volatile private var stopped: UUID? = null

    /**
     * Carry out one bound command. The order is the whole contract: this
     * device's own copy of the owner's policy decides first, a repeat is
     * answered from the ledger and never run again, acknowledging says only
     * that the command is legal here, and the report says only what this
     * device observed.
     */
    private suspend fun carryOut(task: DeviceTask, redispatched: Boolean) {
        val start = actions.withLock {
            if (carrying != null) return@withLock false
            val now = System.currentTimeMillis()
            val previous = ledger.recall(task.idempotencyKey, now)
            if (previous != null) {
                // A repeat produces no second effect, only the same report.
                if (redispatched) scope.launch { deliver(task.actionId, previous) }
                return@withLock false
            }
            if (!ledger.begin(task.idempotencyKey, now)) return@withLock false
            carrying = task.actionId
            true
        }
        if (!start) return
        try {
            // Whatever Cosmos said, this device may only do what the copy it
            // holds says. Holding none is holding nothing: everything is
            // refused until the owner's own permission arrives again.
            val policy = _state.value.permission ?: DevicePolicy()
            val plan = policy.plan(task.operation, runner.platform)
            if (plan == null) {
                // Refused here, whatever Cosmos said, and never acknowledged:
                // this device does not bind a command it will not attempt.
                settle(task, ActionOutcome.refused(policy.refusal(task.operation, runner.platform)))
                return
            }
            command("acknowledge_task") { NativeSurface.optional { NativeSurface.acknowledgeTask(handle) } }
            settle(task, if (plan is PlannedAction.Play) play(task, plan) else open(task, plan))
        } catch (error: Throwable) {
            Log.w(TAG, "the command could not be carried out", error)
            settle(task, ActionOutcome.failed(task.operation))
        } finally {
            carrying = null
        }
    }

    /**
     * Opening a link, an application or a place. `startActivity` returning
     * proves a launch and nothing more, so a completion needs the second
     * observation: this app's own foreground going away to the handler.
     * Navigation starting is not observable here at all, so a route that
     * launched is honestly unknown.
     */
    private suspend fun open(task: DeviceTask, plan: PlannedAction): Report {
        val resolved = runner.resolve(plan)
        val started = runner.start(plan)
        if (started) launched = task.actionId
        val tookForeground = started && awaitBackground(FOREGROUND_MS)
        if (stopped == task.actionId) return ActionOutcome.cancelled(task.operation, started)
        return if (task.operation is Operation.Route) ActionOutcome.route(resolved, started, navigating = false)
        else ActionOutcome.open(resolved, started, tookForeground)
    }

    /**
     * Playback on the television. Without the owner's notification-listener
     * grant nothing here is observable and the report is unknown; with it, the
     * session's own title must contain the bound one and it must be playing.
     */
    private suspend fun play(task: DeviceTask, plan: PlannedAction.Play): Report {
        val preferred = runner.playPackage(plan.provider)
        val started = runner.start(plan)
        if (started) launched = task.actionId
        val listener = runner.listenerGranted()
        var observed: ActionOutcome.Playback? = null
        if (started && listener) {
            val began = System.currentTimeMillis()
            var sequence = 0
            while (System.currentTimeMillis() - began < PLAYBACK_MS && stopped != task.actionId) {
                delay(500)
                val seen = runner.playback(preferred)
                if (seen != null) observed = seen
                if (seen != null && seen.state == PlaybackState.PLAYING &&
                    ActionOutcome.titleMatches(seen.title, plan.title)
                ) break
                val elapsed = System.currentTimeMillis() - began
                if (elapsed / PROGRESS_MS > sequence) {
                    sequence = (elapsed / PROGRESS_MS).toInt()
                    // Still running. It renews the deadline and claims nothing.
                    command("progress") { NativeSurface.optional { NativeSurface.progress(handle, sequence, elapsed) } }
                }
            }
        }
        if (stopped == task.actionId) return ActionOutcome.cancelled(task.operation, started)
        return ActionOutcome.playback(plan.provider, plan.itemDigest, plan.title, started, listener, observed)
    }

    /** Wait for this app's own foreground to go away, which is the launch taking the screen. */
    private suspend fun awaitBackground(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (!wantedVisible) return true
            delay(100)
        }
        return !wantedVisible
    }

    private suspend fun settle(task: DeviceTask, report: Report) {
        ledger.finish(task.idempotencyKey, report, System.currentTimeMillis())
        _state.update { if (it.task?.actionId == task.actionId) it.copy(taskReport = report) else it }
        deliver(task.actionId, report)
    }

    /**
     * Say what this device observed about exactly that command. A report names
     * the action it is about, so a command Cosmos replaced between this device
     * reading it and the worker sending closes nothing.
     */
    private suspend fun deliver(actionId: UUID, report: Report) {
        command("report") {
            NativeSurface.optional {
                NativeSurface.report(handle, actionId.toString().toByteArray(), report.json().toByteArray())
            }
        }
    }

    /** A revoke supersedes remaining work; it does not un-open an application. */
    private fun stop(revoked: Revoked) {
        if (stopped == revoked.actionId) return
        stopped = revoked.actionId
        val state = _state.value
        val task = state.task ?: return
        if (task.actionId != revoked.actionId || state.taskReport != null || carrying != null) return
        scope.launch { settle(task, ActionOutcome.cancelled(task.operation, launched == task.actionId)) }
    }

    /** The explicit Cancel task on the card. Closing the panel is not this. */
    fun cancelTask() = scope.launch {
        val state = _state.value
        val task = state.task ?: return@launch
        if (state.taskReport != null) return@launch
        stopped = task.actionId
        settle(task, ActionOutcome.cancelled(task.operation, launched == task.actionId))
    }

    /** Close hides the card. The command, if it is still running, carries on. */
    fun closeTask() {
        _state.update { it.copy(taskClosed = true) }
    }

    /**
     * The ceremony's only answer is a deliberate tap. Back dismisses the sheet
     * and sends nothing at all, so the grant expires, which denies.
     */
    fun answerCeremony(event: CeremonyEvent) {
        val before = _state.value.ceremony ?: return
        val after = before.on(event)
        if (after == before) return
        _state.update { if (it.ceremony == before) it.copy(ceremony = after) else it }
        val answer = after.answer ?: return
        scope.launch {
            command("grant") {
                NativeSurface.optional {
                    NativeSurface.grant(handle, answer.granted, (answer.attestation?.wire ?: "").toByteArray())
                }
            }
        }
    }

    /** The visible countdown running out answers nothing; it denies by expiry. */
    private fun expireCeremony() {
        val current = _state.value.ceremony ?: return
        if (current.state != CeremonyState.ASKING) return
        val after = current.on(CeremonyEvent.Elapsed(System.currentTimeMillis()))
        if (after != current) _state.update { if (it.ceremony == current) it.copy(ceremony = after) else it }
    }

    companion object {
        private const val TAG = "Cosmos"
        /** How long a launch has to take the screen before it is only a launch. */
        private const val FOREGROUND_MS = 5_000L
        /** How long the television watches for the session it asked for. */
        private const val PLAYBACK_MS = 15_000L
        private const val PROGRESS_MS = 5_000L
    }

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
    /**
     * Public text, optionally continued on a named device class and optionally with
     * the screen text the owner explicitly attached. Only the plain form exists in
     * every library; the others are refused locally when the library predates them.
     */
    fun send(text: String, target: String = "", context: ScreenContext? = null) = scope.launch {
        val bytes = text.toByteArray()
        // Each form is its own operation on the wire, and a command waits for
        // its own snapshot: awaiting the wrong name would leave the ask bar
        // busy until the deadline on every request with a destination.
        val name = when {
            context != null -> "send_text_with_context"
            target.isNotEmpty() -> "send_text_to"
            else -> "send_text"
        }
        command(name) {
            when {
                context != null -> NativeSurface.optional {
                    NativeSurface.sendTextWithContext(handle, bytes, context.app.toByteArray(), context.text.toByteArray(), target.toByteArray())
                }
                target.isNotEmpty() -> NativeSurface.optional { NativeSurface.sendTextTo(handle, bytes, target.toByteArray()) }
                else -> NativeSurface.sendText(handle, bytes)
            }
        }
    }
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
