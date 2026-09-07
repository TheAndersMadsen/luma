package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.DevicePolicy
import dk.andersmadsen.cosmos.android.action.TaskCard
import dk.andersmadsen.cosmos.android.action.TaskCards
import dk.andersmadsen.cosmos.android.action.TaskStage
import dk.andersmadsen.cosmos.android.ui.AssistantState
import java.util.UUID

/** The three owner-facing screens; everything else is a status inside one of them. */
enum class Screen { SETUP, APPROVE, SESSION }

enum class SessionStatus(val label: String) { CONNECTED("Connected"), RECONNECTING("Reconnecting…"), DISCONNECTED("Disconnected") }

fun SurfaceState.screen(): Screen = when {
    descriptor == null -> Screen.SETUP
    phase == Phase.CONNECTED || approved -> Screen.SESSION
    else -> Screen.APPROVE
}

fun SurfaceState.sessionStatus(): SessionStatus = when {
    phase == Phase.CONNECTED -> SessionStatus.CONNECTED
    connectionWanted -> SessionStatus.RECONNECTING
    else -> SessionStatus.DISCONNECTED
}

/** SPEAKING mirrors delivered playback; THINKING covers a command in flight; nothing here starts audio. */
fun SurfaceState.assistantState(): AssistantState = when {
    speaking -> AssistantState.SPEAKING
    busy -> AssistantState.THINKING
    alert || phase == Phase.BLOCKED -> AssistantState.ERROR
    else -> AssistantState.IDLE
}

/** The device names the status line uses; null when Cosmos has not named a platform. */
fun deviceName(platform: String?): String? = when (platform) {
    "macos" -> "your Mac"
    "linux" -> "your Linux PC"
    "android" -> "your phone"
    "android_tv" -> "your TV"
    "browser" -> "your browser"
    "pin" -> "your Ai Pin"
    else -> null
}

/** Said under "Cannot confirm"; the request is never replayed on the owner's behalf. */
const val CANNOT_CONFIRM_DETAIL = "I can't confirm whether that request was handled. It was not sent again."

/** One sentence on what happened, one on what to do; nothing technical and no identifiers. */
fun explain(code: String): String = when (code) {
    "pending_operation" -> "The last request has an unknown outcome. Retry it before asking again."
    "persistence", "invalid_journal" -> "This phone could not save its session. Retry the last request before asking again."
    "invalid_signature" -> "This phone could not use its own key. Set it up again."
    "invalid_config" -> "That server address cannot be used. Enter an address that starts with https:// and nothing after it."
    "invalid_input" -> "That question is too long. Shorten it and send it again."
    "denied" -> "This phone is not approved yet. Approve it in Center, then connect."
    "busy" -> "Cosmos is still on the last request. Wait a moment and try again."
    "no_display" -> "There is no reply on screen."
    "no_speech" -> "There is no spoken reply right now."
    // Not a failed effect: the command that report was about is no longer the
    // current one, so nothing was closed and there is nothing to do about it.
    "stale_task" -> "Cosmos replaced that command before this phone could say what happened."
    "not_in_this_build" -> "Cosmos on this phone cannot use screen text or another device yet. Nothing was sent — choose This phone, remove the screen chip and ask again."
    else -> "Cosmos could not confirm that. Try again in a moment."
}

/** Whether a code is worth an error style. A task that went stale is not a failure. */
fun isFailure(code: String): Boolean = code != "stale_task"

/** The one-line status vocabulary: exact words, never an error style. */
fun TurnStatus.line(): String {
    val device = deviceName(surfacePlatform)
    return when (state) {
        "working" -> "Working"
        "waiting" -> if (device != null) "Waiting for $device" else "Waiting for a device"
        // A command is on screen at the device that would carry it out, or
        // that device is carrying it out. Neither claims it happened.
        "confirming" -> if (device != null) "Waiting for you on $device" else "Waiting for you"
        "acting" -> "Working"
        "shown" -> "Shown on ${device ?: "a device"}"
        "spoken" -> "Spoken on ${device ?: "a device"}"
        "done" -> "Completed"
        // The origin is told a device did not do it, and never why.
        "refused" -> "Not done"
        "nowhere" -> "Nowhere to show it"
        else -> "Cannot confirm"
    }
}

/** A second, quieter line only when the outcome is unknown. */
fun TurnStatus.detail(): String? = if (state == "unknown") CANNOT_CONFIRM_DETAIL else null

/**
 * A request typed on this client, kept until Cosmos answers it: snapshots carry no
 * request text. [sendsBefore] is the installation's completed-send count at the
 * moment it was typed, which is how the screen knows when its own send is over.
 */
data class Ask(val text: String, val turnBefore: UUID?, val sendsBefore: Long = 0)

/**
 * True once this client's send is over without Cosmos admitting a new turn,
 * whether the command settled or the client refused it before it left. The
 * request is no longer in flight, and the notice explains why.
 */
fun SurfaceState.sendSettled(ask: Ask): Boolean = sends > ask.sendsBefore

/** How loud the status dot is. Nothing here is an error style; a problem is a sentence, not a colour. */
enum class Tone { LIVE, ACTIVE, DONE, QUIET }

/**
 * The single line at the top of every panel: one state word, an optional plain
 * sentence under it, and whether the turn has come to rest. [settled] lets the
 * line fade to quiet presence rather than sitting there lit.
 */
data class Presence(val line: String, val detail: String?, val tone: Tone, val settled: Boolean)

private fun TurnStatus.tone(): Tone = when (state) {
    "working", "waiting", "confirming", "acting" -> Tone.ACTIVE
    "shown", "spoken", "done" -> Tone.DONE
    else -> Tone.QUIET
}

/** True while the turn is still moving, so the line stays lit and the ask bar stays busy. */
fun TurnStatus.running(): Boolean = state in setOf("working", "waiting", "confirming", "acting")

/**
 * Presence for the status line. While [ask] is in flight the line is about that
 * request — Working until Cosmos admits it and reports on the new turn — so the
 * previous turn's outcome is never mistaken for this one's.
 */
fun SurfaceState.presence(ask: Ask? = null): Presence {
    val status = status
    val admitted = ask?.let { pending -> admission?.takeIf { it.turnId != pending.turnBefore } }
    val unreported = ask != null && !sendSettled(ask) && (admitted == null || status == null || status.turnId != admitted.turnId)
    return when {
        phase != Phase.CONNECTED && sessionStatus() == SessionStatus.RECONNECTING ->
            Presence("Reconnecting…", null, Tone.ACTIVE, false)
        phase != Phase.CONNECTED -> Presence("Disconnected", "Connect this phone to ask.", Tone.QUIET, true)
        unreported -> Presence("Working", null, Tone.ACTIVE, false)
        status != null -> Presence(status.line(), status.detail(), status.tone(), !status.running())
        busy -> Presence("Working", null, Tone.ACTIVE, false)
        else -> Presence("Connected", null, Tone.LIVE, true)
    }
}

/** What the phone shows between its status line and its ask bar. */
sealed interface SheetBody {
    /** Nothing asked yet: the nebula and a few prompts that work today. */
    data object Empty : SheetBody
    /** The request the owner just sent, on screen the moment Send is pressed. */
    data class Now(val text: String) : SheetBody
    data class Reply(val card: DisplayCard) : SheetBody
    data class Spoken(val text: String) : SheetBody
    /** One plain sentence instead of a reply, when there is nothing to answer with. */
    data class Note(val text: String) : SheetBody
}

/**
 * The body of the phone panel. A typed request becomes the Now line at once and
 * stays until the reply for that admitted turn arrives; a send that settles
 * without an admission leaves the empty state and its notice behind.
 */
fun SurfaceState.sheetBody(ask: Ask?): SheetBody {
    if (phase != Phase.CONNECTED) return SheetBody.Note(
        if (sessionStatus() == SessionStatus.RECONNECTING) "Cosmos is rejoining this phone."
        else "Connect this phone to ask Cosmos something.",
    )
    val card = display
    val speech = speech
    if (ask != null) {
        val admitted = admission?.takeIf { it.turnId != ask.turnBefore }
        return when {
            admitted == null -> if (sendSettled(ask)) SheetBody.Empty else SheetBody.Now(ask.text)
            card?.turnId == admitted.turnId -> SheetBody.Reply(card)
            speech?.turnId == admitted.turnId -> SheetBody.Spoken(speech.text)
            else -> SheetBody.Now(ask.text)
        }
    }
    return when {
        card != null -> SheetBody.Reply(card)
        speech != null -> SheetBody.Spoken(speech.text)
        else -> SheetBody.Empty
    }
}

/** The empty state's prompts; the screen one only where screen text is actually attached. */
fun suggestions(screenContext: Boolean): List<String> = listOfNotNull(
    "Find cafés near me",
    "Show my notes about…",
    "What's on my screen?".takeIf { screenContext },
)

/** A prompt ending in an ellipsis is a starter for the field; the others are complete requests. */
fun isComplete(suggestion: String): Boolean = !suggestion.trimEnd().endsWith('…')

/** Where the phone asks Cosmos to continue; the phone itself sends no target and lets Cosmos decide. */
enum class Destination(val label: String, val target: String) {
    PHONE("This phone", ""), MAC("Mac", "macos"), LINUX("Linux PC", "linux"), TV("TV", "android_tv"), BROWSER("Browser", "browser");

    companion object { fun forTarget(target: String): Destination = entries.firstOrNull { it.target == target } ?: PHONE }
}

/**
 * What the assist overlay knows about the screen it opened over. Only [Attached]
 * carries text, and only while the owner keeps the chip.
 */
sealed interface AssistContext {
    /** The assist data has not arrived yet; nothing is said. */
    data object Pending : AssistContext
    data class Attached(val context: ScreenContext) : AssistContext
    /** The owner removed the chip; the request goes without context. */
    data object Removed : AssistContext
    /** The screen was locked when Cosmos opened; nothing from it is read. */
    data object Locked : AssistContext
    /** The system offered no screen text for this opening. */
    data object Unavailable : AssistContext
    /** The panel runs as a plain assist activity, which never receives screen text. */
    data object NoRole : AssistContext
}

fun AssistContext.chipLabel(): String? = (this as? AssistContext.Attached)?.let { "Using: ${it.context.app} screen" }

/** The calm line under the ask field; null when there is nothing to say. */
fun AssistContext.line(): String? = when (this) {
    AssistContext.Pending, AssistContext.Removed -> null
    is AssistContext.Attached -> "The text that was on screen. The reply stays on this phone."
    AssistContext.Locked -> "The screen was locked, so nothing from it is used."
    AssistContext.Unavailable -> "No screen text was available."
    AssistContext.NoRole -> "Cosmos can use screen text once it is your assistant."
}

/** What the TV stage shows over its content; the set-up and approve screens are not stages. */
sealed interface TvStage {
    data object Idle : TvStage
    data object Working : TvStage
    data class Transcript(val request: String) : TvStage
    /** A subtitle for the current reply; [full] is the whole answer for the paged view and [card] is acknowledged once shown. */
    data class Answer(val id: UUID, val caption: String, val full: String, val card: DisplayCard? = null) : TvStage
    /** A row of options filling the content slot; choosing one sends its title and Cosmos decides where the reply goes. */
    data class Choices(val id: UUID, val title: String, val items: List<Choice>, val card: DisplayCard) : TvStage
}

private fun DisplayCard.answer(): TvStage = when (val body = content) {
    is DisplayContent.Text -> TvStage.Answer(actionId, body.text, body.text, this)
    is DisplayContent.Places -> TvStage.Answer(actionId, body.query, content.plainText(), this)
    is DisplayContent.Choices -> TvStage.Choices(actionId, body.title, body.items, this)
}

/** The reply a stage carries, for dismissal and for keeping the typed request until it is answered. */
fun TvStage.replyId(): UUID? = when (this) { is TvStage.Answer -> id; is TvStage.Choices -> id; else -> null }

private fun SpeechReply.answer(): TvStage.Answer = TvStage.Answer(actionId, text, text)

/**
 * A card routed above shared_room never appears on a TV. A request typed here is Working
 * until Cosmos admits it as a new turn, its transcript until the reply for that turn
 * arrives, and gone once the send settles without an admission. Other replies caption the
 * stage while Cosmos keeps them current; [dismissed] names one the owner sent away with Back.
 */
fun SurfaceState.tvStage(request: Ask?, dismissed: UUID? = null): TvStage {
    val card = display?.takeUnless { it.private }
    val speech = speech
    if (request != null) {
        val admitted = admission?.takeIf { it.turnId != request.turnBefore }
        return when {
            admitted == null -> if (sendSettled(request)) TvStage.Idle else TvStage.Working
            card?.turnId == admitted.turnId -> card.answer()
            speech?.turnId == admitted.turnId -> speech.answer()
            else -> TvStage.Transcript(request.text)
        }
    }
    val answer = card?.answer() ?: speech?.answer()
    return if (answer != null && answer.replyId() != dismissed) answer else TvStage.Idle
}

/** This device in the owner's own words; the only device name either card uses. */
fun deviceWord(platform: String): String = if (platform == DevicePolicy.TV) "this TV" else "this phone"

/**
 * Where the command this device was asked to carry out stands. A ceremony on
 * screen comes first, then the command while it runs, then the one thing this
 * device is allowed to say about it: what it observed.
 */
fun SurfaceState.taskStage(nowMs: Long): TaskStage? {
    val ceremony = ceremony
    if (ceremony != null && ceremony.showing) return TaskStage.Confirming(ceremony.confirmation.description)
    val task = task ?: return null
    val report = taskReport ?: return TaskStage.Working(task.operation, nowMs - taskStartedAtMs)
    return TaskStage.Reported(task.operation, report)
}

/**
 * The task card. A television never explains a refusal, so it has no card for
 * one at all: the screen simply returns to its quiet state, and a refusal, a
 * failure and a privacy suppression stay indistinguishable in a shared room.
 */
fun SurfaceState.taskCard(nowMs: Long, platform: String): TaskCard? {
    if (taskClosed) return null
    // A television renders nothing above the shared class, command or card.
    if (platform == DevicePolicy.TV && task?.private == true) return null
    val stage = taskStage(nowMs) ?: return null
    return TaskCards.card(
        stage, deviceWord(platform),
        explain = platform != DevicePolicy.TV,
        holdsPermission = permission != null,
    )
}

/**
 * Snapshots whose message is worth a quiet notice; the pill and waveform
 * already convey the steady states. A report is here for the one thing it can
 * say — that the command it named had already been replaced — and says nothing
 * at all when it lands.
 */
private val NOTICED_OPERATIONS = setOf("send_text", "cancel", "retry_pending", "disconnect", "report")

fun SurfaceState.notice(): String? = when {
    alert || phase == Phase.BLOCKED || (hasPending && !pendingOpen) -> message
    operation in NOTICED_OPERATIONS -> message
    else -> null
}?.ifBlank { null }

/** Shown beside [notice] while the journal remembers an abandoned operation; the Mac says the same. */
const val UNKNOWN_OUTCOME_NOTICE = "A previous request has an unknown outcome. It will not be replayed automatically; you can send a new request once connected."

/** The request can still be withdrawn while its admission is the newest thing on screen. */
fun SurfaceState.offersCancel(): Boolean = canCancel && operation == "send_text"

/** The host the owner recognises, without scheme or trailing slash. */
fun serverLabel(origin: String): String = origin.trim().removePrefix("https://").removePrefix("http://").trimEnd('/')

/** Inclusive line ranges of at most [linesPerPage] lines each; a full-size page never shrinks its type. */
fun pageRanges(lineCount: Int, linesPerPage: Int): List<IntRange> {
    val perPage = linesPerPage.coerceAtLeast(1)
    if (lineCount <= 0) return listOf(0..0)
    return (0 until lineCount step perPage).map { first -> first..minOf(first + perPage, lineCount) - 1 }
}

/** The card as plain lines for a screen without links: query, numbered places, then credit text. */
fun DisplayContent.plainText(): String = when (this) {
    is DisplayContent.Text -> text
    is DisplayContent.Choices -> buildString {
        append(title)
        items.forEach { item -> append("\n\n${item.id}. ${item.title}"); if (item.detail.isNotBlank()) append("\n${item.detail}") }
    }
    is DisplayContent.Places -> buildString {
        append(query)
        if (items.isEmpty()) append("\n\nNo matching places found.")
        items.forEachIndexed { index, item -> append("\n\n${index + 1}. ${item.name}\n${item.address}") }
        if (credits.isNotEmpty()) {
            append("\n\nGoogle Maps · ")
            append(credits.joinToString(" · ") { parts ->
                parts.joinToString("") { part -> when (part) { is CreditPart.Text -> part.text; is CreditPart.Link -> part.text } }
            })
        }
    }
}
