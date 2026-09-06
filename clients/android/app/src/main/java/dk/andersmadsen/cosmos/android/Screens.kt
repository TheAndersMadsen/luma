package dk.andersmadsen.cosmos.android

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

/** The request typed on this TV. Snapshots carry no request text, so the stage remembers it until Cosmos answers. */
data class TvRequest(val text: String, val turnBefore: UUID?, val sending: Boolean = false)

/** What the TV stage shows over its content; the set-up and approve screens are not stages. */
sealed interface TvStage {
    data object Idle : TvStage
    data object Working : TvStage
    data class Transcript(val request: String) : TvStage
    /** A subtitle for the current reply; [full] is the whole answer for the paged view and [card] is acknowledged once shown. */
    data class Answer(val id: UUID, val caption: String, val full: String, val card: DisplayCard? = null) : TvStage
}

private fun DisplayCard.answer(): TvStage.Answer = TvStage.Answer(
    actionId, caption = when (val body = content) { is DisplayContent.Text -> body.text; is DisplayContent.Places -> body.query },
    full = content.plainText(), card = this,
)

private fun SpeechReply.answer(): TvStage.Answer = TvStage.Answer(actionId, text, text)

/**
 * A card routed above shared_room never appears on a TV. A request typed here is Working
 * until Cosmos admits it as a new turn, its transcript until the reply for that turn
 * arrives, and gone once the send settles without an admission. Other replies caption the
 * stage while Cosmos keeps them current; [dismissed] names one the owner sent away with Back.
 */
fun SurfaceState.tvStage(request: TvRequest?, dismissed: UUID? = null): TvStage {
    val card = display?.takeUnless { it.private }
    val speech = speech
    if (request != null) {
        val admitted = admission?.takeIf { it.turnId != request.turnBefore }
        return when {
            admitted == null -> if (request.sending && !busy) TvStage.Idle else TvStage.Working
            card?.turnId == admitted.turnId -> card.answer()
            speech?.turnId == admitted.turnId -> speech.answer()
            else -> TvStage.Transcript(request.text)
        }
    }
    val answer = card?.answer() ?: speech?.answer()
    return if (answer != null && answer.id != dismissed) answer else TvStage.Idle
}

/** Snapshots whose message is worth a quiet notice; the pill and waveform already convey the steady states. */
private val NOTICED_OPERATIONS = setOf("send_text", "cancel", "retry_pending", "disconnect")

fun SurfaceState.notice(): String? = when {
    alert || phase == Phase.BLOCKED || (hasPending && !pendingOpen) -> message
    operation in NOTICED_OPERATIONS -> message
    else -> null
}

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
