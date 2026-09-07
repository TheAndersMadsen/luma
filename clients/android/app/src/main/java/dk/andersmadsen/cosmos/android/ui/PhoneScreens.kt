package dk.andersmadsen.cosmos.android.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.activity.compose.BackHandler
import dk.andersmadsen.cosmos.android.Ask
import dk.andersmadsen.cosmos.android.Descriptor
import dk.andersmadsen.cosmos.android.action.Ceremony
import dk.andersmadsen.cosmos.android.action.CeremonyEvent
import dk.andersmadsen.cosmos.android.action.DevicePolicy
import dk.andersmadsen.cosmos.android.action.TaskCard
import dk.andersmadsen.cosmos.android.deviceWord
import dk.andersmadsen.cosmos.android.taskCard
import dk.andersmadsen.cosmos.android.Destination
import dk.andersmadsen.cosmos.android.DisplayCard
import dk.andersmadsen.cosmos.android.Fingerprint
import dk.andersmadsen.cosmos.android.Phase
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.Screen
import dk.andersmadsen.cosmos.android.SessionStatus
import dk.andersmadsen.cosmos.android.SheetBody
import dk.andersmadsen.cosmos.android.SurfaceState
import dk.andersmadsen.cosmos.android.isComplete
import dk.andersmadsen.cosmos.android.notice
import dk.andersmadsen.cosmos.android.offersCancel
import dk.andersmadsen.cosmos.android.presence
import dk.andersmadsen.cosmos.android.screen
import dk.andersmadsen.cosmos.android.serverLabel
import dk.andersmadsen.cosmos.android.sessionStatus
import dk.andersmadsen.cosmos.android.sheetBody
import kotlinx.coroutines.delay

/** Everything either layout can ask the activity to do; the activity owns intents and permissions. */
class SurfaceActions(
    val prepare: (String) -> Unit,
    val connect: () -> Unit,
    val disconnect: () -> Unit,
    /** Public text and the device class to continue on; an empty target lets Cosmos decide. */
    val send: (text: String, target: String) -> Unit,
    val cancel: () -> Unit,
    val retry: () -> Unit,
    val approve: (String) -> Unit,
    val copy: (String) -> Unit,
    val share: (String) -> Unit,
    val chooseAssistant: () -> Unit,
    val committed: (DisplayCard) -> Unit,
    /** The explicit Cancel task on a running command; closing a panel is never this. */
    val cancelTask: () -> Unit = {},
    /** Hide the task card. The command, if it is still running, carries on. */
    val closeTask: () -> Unit = {},
    /** The one deliberate answer to a ceremony, or Back, which answers nothing. */
    val answerCeremony: (CeremonyEvent) -> Unit = {},
    /** A question spoken at the television, kept until Cosmos answers it. */
    val ask: (String) -> Unit = {},
    /** Back on the television: the reply on screen is sent away. */
    val dismissReply: () -> Unit = {},
)

/** The phone: one calm screen per state. The nebula lives under the welcome and empty states only. */
@Composable
fun PhoneScreen(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    val screen = state.screen()
    Box(Modifier.fillMaxSize().background(CosmosPalette.background)) {
        if (screen != Screen.SESSION) CosmosNebula(Modifier.align(Alignment.BottomCenter), dim = .8f)
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(horizontal = 22.dp)) {
            Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                CosmosWordmark(iconSize = 36.dp, fontSize = 24.sp)
                Spacer(Modifier.weight(1f))
                if (screen == Screen.SESSION) OverflowMenu(state, actions)
            }
            when (screen) {
                Screen.SETUP -> SetupScreen(state, actions)
                Screen.APPROVE -> ApproveScreen(state, approvalRequested, actions)
                Screen.SESSION -> SessionScreen(state, actions)
            }
        }
    }
}

/** Step one: name the server once, then one button. No identifiers, no formats, no choices to make. */
@Composable
private fun SetupScreen(state: SurfaceState, actions: SurfaceActions) {
    var server by rememberSaveable(state.serverOrigin) { mutableStateOf(state.serverOrigin) }
    var editing by rememberSaveable { mutableStateOf(false) }
    val preparing = state.phase == Phase.PREPARING
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp), verticalArrangement = Arrangement.Center) {
        Step(1)
        Spacer(Modifier.height(10.dp))
        Title(stringResource(R.string.setup_title))
        Spacer(Modifier.height(12.dp))
        Body(stringResource(R.string.setup_body))
        Spacer(Modifier.height(24.dp))
        if (editing) {
            OutlinedTextField(
                server, { server = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.server_address)) }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done), colors = fieldColors(),
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(serverLabel(server), color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
                Text(
                    stringResource(R.string.change), color = CosmosPalette.glow, fontSize = CosmosType.quiet,
                    modifier = Modifier.heightIn(min = 48.dp).clickable(role = Role.Button) { editing = true }.padding(horizontal = 12.dp, vertical = 14.dp),
                )
            }
        }
        Spacer(Modifier.height(20.dp))
        PrimaryButton(
            if (preparing) stringResource(R.string.setup_busy) else stringResource(R.string.setup_action),
            enabled = state.canPrepare, busy = preparing,
        ) { actions.prepare(server) }
        Notice(state, actions)
    }
}

/**
 * Step two: the pairing code, large enough to read across a desk, and the same
 * link as a QR for another signed-in device. Setup material stays behind Details.
 */
@Composable
private fun ApproveScreen(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    val descriptor = state.descriptor ?: return
    val url = remember(descriptor, state.serverOrigin) { descriptor.approvalUrl(state.serverOrigin) }
    var details by rememberSaveable { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Step(2)
        Title(stringResource(R.string.approve_title))
        Body(stringResource(R.string.approve_body))
        CosmosPanel(Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(stringResource(R.string.pairing_code), color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
                Spacer(Modifier.height(12.dp))
                FingerprintLines(descriptor)
            }
        }
        PrimaryButton(stringResource(R.string.approve_action), enabled = !state.busy) { actions.approve(url) }
        ProgressLine(state, approvalRequested, actions)
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            QrCodeImage(url, stringResource(R.string.approval_qr), Modifier.width(200.dp))
            Text(stringResource(R.string.approve_scan), color = CosmosPalette.secondary, fontSize = CosmosType.quiet, textAlign = TextAlign.Center)
        }
        Disclosure(details, { details = it }) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ actions.copy(descriptor.json()) }) { Text(stringResource(R.string.copy)) }
                OutlinedButton({ actions.share(descriptor.json()) }) { Text(stringResource(R.string.share)) }
            }
            Text(descriptor.json(), color = CosmosPalette.secondary, fontSize = 12.sp, fontFamily = FontFamily.Monospace, lineHeight = 16.sp)
        }
    }
}

/** The one progress line while Center decides: a spinner, a sentence, and Try again only when it can help. */
@Composable
private fun ProgressLine(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    val failed = state.alert || state.phase == Phase.BLOCKED
    Row(
        Modifier.fillMaxWidth().background(CosmosPalette.card, RoundedCornerShape(16.dp))
            .border(1.dp, CosmosPalette.cardBorder, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (state.busy) {
            CircularProgressIndicator(Modifier.size(18.dp), color = CosmosPalette.glow, strokeWidth = 2.dp)
            Text(stringResource(R.string.checking_with_center), color = CosmosPalette.secondary, fontSize = CosmosType.quiet, modifier = Modifier.weight(1f))
        } else {
            Text(
                if (failed) state.message else stringResource(R.string.waiting_for_approval),
                color = if (failed) CosmosPalette.error else CosmosPalette.secondary, fontSize = CosmosType.quiet, lineHeight = CosmosType.quietLine,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
            )
            OutlinedButton(actions.connect, enabled = state.canConnect) {
                Text(if (approvalRequested || failed) stringResource(R.string.try_again) else stringResource(R.string.connect))
            }
        }
    }
}

/**
 * The connected phone: the mark, the status line, the ask bar, and whatever the
 * owner's last request produced. Nothing else has to be read, so the screen holds
 * one reply, the request in flight, or the quiet empty state.
 */
@Composable
private fun SessionScreen(state: SurfaceState, actions: SurfaceActions) {
    var draft by rememberSaveable { mutableStateOf("") }
    var target by rememberSaveable { mutableStateOf("") }
    var choosing by rememberSaveable { mutableStateOf(false) }
    var ask by remember { mutableStateOf<Ask?>(null) }
    val body = state.sheetBody(ask)
    LaunchedEffect(body) { if (body !is SheetBody.Now) ask = null }
    val status = state.sessionStatus()
    Column(Modifier.fillMaxSize()) {
        PresenceLine(state.presence(ask), Modifier.padding(top = 8.dp, bottom = 4.dp))
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val maxCard = (maxHeight - 24.dp).coerceAtLeast(120.dp)
            when {
                body is SheetBody.Reply -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                    // Choosing an option is a request like any other: Cosmos decides where its reply goes.
                    DisplayCardView(body.card, onCommitted = actions.committed, Modifier.fillMaxWidth().heightIn(max = maxCard), onChoose = { title ->
                        ask = Ask(title, turnBefore = state.admission?.turnId, sendsBefore = state.sends)
                        actions.send(title, "")
                    })
                    if (state.speech != null) SpeakingLine(state)
                }
                body is SheetBody.Spoken -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                    CosmosCard(Modifier.fillMaxWidth().heightIn(max = maxCard)) {
                        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) { CosmosMessage(body.text) }
                    }
                    SpeakingLine(state)
                }
                body is SheetBody.Now -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) { AskedLine(body.text) }
                body is SheetBody.Note -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Hint(body.text)
                    if (status == SessionStatus.DISCONNECTED) {
                        Spacer(Modifier.height(16.dp))
                        Button(actions.connect, enabled = state.canConnect, shape = RoundedCornerShape(16.dp)) {
                            Text(stringResource(R.string.connect), fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                // A whole prompt is sent; one that trails off becomes the start of the field.
                else -> EmptyScreen(state.canSend, draft.isBlank()) { prompt ->
                    if (isComplete(prompt) && state.canSend) {
                        ask = Ask(prompt, turnBefore = state.admission?.turnId, sendsBefore = state.sends)
                        actions.send(prompt, target)
                    } else draft = prompt.trimEnd().removeSuffix("…")
                }
            }
        }
        // A ceremony is its own card, and it replaces the task card while it
        // is up: one question on screen, two equal answers, one countdown.
        val ceremony = state.ceremony
        if (ceremony != null && ceremony.showing) CeremonySheet(ceremony, actions)
        else TaskPanel(state, actions)
        Notice(state, actions)
        if (state.phase == Phase.CONNECTED) AskBar(
            draft = draft, onDraft = { draft = it }, canSend = state.canSend,
            onSend = {
                val text = draft.trim()
                ask = Ask(text, turnBefore = state.admission?.turnId, sendsBefore = state.sends)
                draft = ""
                actions.send(text, target)
            },
            target = target, onTarget = { target = it }, choosing = choosing, onChoosing = { choosing = it },
            modifier = Modifier.padding(vertical = 10.dp),
        )
    }
}

/**
 * The quiet screen: the kit nebula, and one row of small prompt chips above it that
 * steps aside the moment there is anything in the field. Nothing here is a sentence,
 * because nothing here has been asked yet.
 */
@Composable
private fun EmptyScreen(enabled: Boolean, idle: Boolean, onPrompt: (String) -> Unit) {
    Box(Modifier.fillMaxSize()) {
        CosmosNebula(Modifier.align(Alignment.BottomCenter), dim = .5f)
        if (idle) CosmosSuggestionRow(
            screenContext = false, enabled = enabled, onPrompt = onPrompt,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
        )
    }
}

/** The request the owner just sent, held on screen until its reply lands. */
@Composable
private fun AskedLine(text: String) {
    Row(
        Modifier.fillMaxWidth().background(CosmosPalette.card, RoundedCornerShape(20.dp))
            .padding(horizontal = 18.dp, vertical = 16.dp)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CosmosWaveform(AssistantState.THINKING, Modifier.size(width = 34.dp, height = 24.dp).padding(top = 2.dp))
        Text(text, color = CosmosPalette.primary, fontSize = CosmosType.body, lineHeight = CosmosType.bodyLine, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun SpeakingLine(state: SurfaceState) {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CosmosWaveform(if (state.speaking) AssistantState.SPEAKING else AssistantState.IDLE, Modifier.size(width = 48.dp, height = 32.dp))
        Spacer(Modifier.width(10.dp))
        Text(
            if (state.speaking) stringResource(R.string.speaking) else stringResource(R.string.spoken_reply),
            color = CosmosPalette.secondary, fontSize = CosmosType.quiet, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

/**
 * A running command: the state word, one sentence about what is happening, the
 * elapsed time from a shared clock, and Cancel task. Close hides this card and
 * the command carries on, which is why the two are different controls.
 */
@Composable
private fun TaskPanel(state: SurfaceState, actions: SurfaceActions) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.task?.actionId, state.taskReport) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val card = state.taskCard(now, DevicePolicy.PHONE) ?: return
    TaskCardView(card, actions)
}

@Composable
private fun TaskCardView(card: TaskCard, actions: SurfaceActions) {
    Column(
        Modifier.fillMaxWidth().padding(top = 12.dp).animateContentSize(calmly(200))
            .background(CosmosPalette.card, RoundedCornerShape(16.dp))
            .border(1.dp, CosmosPalette.cardBorder, RoundedCornerShape(16.dp))
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                card.state, color = CosmosPalette.primary, fontSize = CosmosType.quiet,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            Spacer(Modifier.weight(1f))
            // Reserved either way, so the line does not jump when it appears.
            Text(card.elapsed ?: "", color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
        }
        card.sentence?.let { Text(it, color = CosmosPalette.secondary, fontSize = CosmosType.quiet, lineHeight = CosmosType.quietLine) }
        card.next?.let { Text(it, color = CosmosPalette.secondary, fontSize = CosmosType.quiet, lineHeight = CosmosType.quietLine) }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (card.canCancel) TextButton(actions.cancelTask) { Text(stringResource(R.string.cancel_request)) }
            TextButton(actions.closeTask) { Text(stringResource(R.string.close_assistant)) }
        }
    }
}

/**
 * The ceremony. The owner's own words for the effect, two answers of exactly
 * the same weight, and a countdown that is visible while it runs. Back closes
 * the card and answers nothing at all, so the permission expires unanswered,
 * which denies.
 */
@Composable
private fun CeremonySheet(ceremony: Ceremony, actions: SurfaceActions) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(ceremony.confirmation.grantId) {
        while (true) {
            now = System.currentTimeMillis()
            delay(250)
        }
    }
    BackHandler(enabled = true) { actions.answerCeremony(CeremonyEvent.Back) }
    val description = ceremony.confirmation.description
    val verb = description.verb.replaceFirstChar { it.uppercase() }
    Column(
        Modifier.fillMaxWidth().padding(top = 12.dp)
            .background(CosmosPalette.surface, RoundedCornerShape(20.dp))
            .border(1.dp, CosmosPalette.border, RoundedCornerShape(20.dp))
            .padding(horizontal = 18.dp, vertical = 16.dp)
            .semantics(mergeDescendants = false) { liveRegion = LiveRegionMode.Assertive },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(R.string.confirm_question, verb, description.subject, deviceWord(DevicePolicy.PHONE)),
            color = CosmosPalette.primary, fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold,
        )
        Text(description.effect, color = CosmosPalette.secondary, fontSize = 15.sp, lineHeight = 21.sp)
        Text(
            stringResource(if (description.privacy == "private" || description.privacy == "near_user")
                R.string.confirm_class_private else R.string.confirm_class_shared),
            color = CosmosPalette.secondary, fontSize = 13.sp,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // Two answers, one weight: declining is never the quieter control.
            OutlinedButton({ actions.answerCeremony(CeremonyEvent.Decline) }, Modifier.weight(1f).height(52.dp),
                shape = RoundedCornerShape(16.dp)) {
                Text(stringResource(R.string.confirm_decline), fontSize = 16.sp)
            }
            OutlinedButton({ actions.answerCeremony(CeremonyEvent.Confirm) }, Modifier.weight(1f).height(52.dp),
                shape = RoundedCornerShape(16.dp)) {
                Text(stringResource(R.string.confirm_allow), fontSize = 16.sp)
            }
        }
        Text(
            stringResource(R.string.confirm_countdown, ceremony.secondsLeft(now)),
            color = CosmosPalette.secondary, fontSize = 13.sp,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

/**
 * The one notice: a failure or a pending operation the owner can still act on,
 * as a single sentence with the control that helps. An abandoned earlier request
 * is not one of these — it is the status line's own outcome and is said there.
 */
@Composable
fun Notice(state: SurfaceState, actions: SurfaceActions, modifier: Modifier = Modifier) {
    val text = state.notice() ?: return
    val failed = state.alert || state.phase == Phase.BLOCKED
    Column(
        modifier.fillMaxWidth().padding(top = 12.dp).background(CosmosPalette.card, RoundedCornerShape(16.dp))
            .border(1.dp, CosmosPalette.cardBorder, RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(text, color = if (failed) CosmosPalette.error else CosmosPalette.secondary,
            fontSize = CosmosType.quiet, lineHeight = CosmosType.quietLine,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        if (state.canRetry || state.offersCancel()) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (state.canRetry) TextButton(actions.retry) { Text(stringResource(R.string.retry)) }
            if (state.offersCancel()) TextButton(actions.cancel) { Text(stringResource(R.string.cancel_request)) }
        }
    }
}

/**
 * The ask field with its send button; Send on the keyboard submits too. With
 * [onTarget] the destination sits beside the field as one pill, and opening it
 * replaces that pill with the row of device names rather than crowding it.
 */
@Composable
fun AskBar(
    draft: String, onDraft: (String) -> Unit, canSend: Boolean, onSend: () -> Unit,
    target: String, onTarget: (String) -> Unit, choosing: Boolean, onChoosing: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    // The field never goes dead: the next question can be typed while one is in flight.
    val ready = canSend && draft.isNotBlank()
    Column(modifier.fillMaxWidth().animateContentSize(calmly(200)), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // Open, the row takes the pill's place rather than sitting on top of its own label.
        if (choosing) DestinationRow(Destination.forTarget(target)) { onTarget(it.target); onChoosing(false) }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!choosing) DestinationButton(Destination.forTarget(target)) { onChoosing(true) }
            OutlinedTextField(
                // The field grows to four lines, but a newline is a send, never a blank line in the request.
                draft, { typed -> onDraft(typed.replace("\n", " ").take(4000)) },
                Modifier.weight(1f).onPreviewKeyEvent { event ->
                    val enter = event.key == Key.Enter || event.key == Key.NumPadEnter
                    if (enter && event.type == KeyEventType.KeyDown && ready) { onSend(); true } else enter
                },
                placeholder = { Text(stringResource(R.string.ask_placeholder)) },
                maxLines = 4, shape = RoundedCornerShape(24.dp), colors = fieldColors(),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (ready) onSend() }),
            )
            FilledIconButton(onSend, Modifier.size(48.dp), enabled = ready) {
                Icon(
                    painterResource(R.drawable.ic_send),
                    contentDescription = stringResource(if (canSend) R.string.send_question else R.string.sending_question),
                )
            }
        }
    }
}

/**
 * The destination as one pill. Cosmos chooses the screen from what the answer is,
 * so by default there is nothing here to read — only the chevron that opens the
 * override. A named destination shows itself before sending.
 */
@Composable
private fun DestinationButton(destination: Destination, onClick: () -> Unit) {
    val open = stringResource(R.string.continue_on_choose)
    val label = if (destination.names) stringResource(R.string.continue_on_current, destination.label) else open
    Text(
        if (destination.names) "${destination.label} ▾" else "▾",
        color = if (destination.names) CosmosPalette.primary else CosmosPalette.secondary,
        fontSize = CosmosType.quiet,
        modifier = Modifier.heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClickLabel = open, onClick = onClick)
            .background(CosmosPalette.card, CircleShape).padding(horizontal = 16.dp, vertical = 14.dp)
            .semantics { contentDescription = label },
    )
}

/** Plain labels only: the picker says where to continue, not what is eligible; Cosmos decides that. */
@Composable
private fun DestinationRow(chosen: Destination, onSelect: (Destination) -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(stringResource(R.string.continue_on), color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for (destination in Destination.entries) {
                val current = destination == chosen
                Text(
                    destination.label, fontSize = CosmosType.quiet,
                    color = if (current) CosmosPalette.background else CosmosPalette.primary,
                    modifier = Modifier.heightIn(min = 48.dp)
                        .semantics { selected = current }
                        .clickable(role = Role.RadioButton) { onSelect(destination) }
                        .background(if (current) CosmosPalette.glow else CosmosPalette.card, CircleShape)
                        .then(if (current) Modifier else Modifier.border(1.dp, CosmosPalette.cardBorder, CircleShape))
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                )
            }
        }
    }
}

@Composable
private fun OverflowMenu(state: SurfaceState, actions: SurfaceActions) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton({ open = true }, Modifier.size(48.dp)) {
            Icon(painterResource(R.drawable.ic_more_vert), contentDescription = stringResource(R.string.more_actions), tint = CosmosPalette.primary)
        }
        DropdownMenu(open, { open = false }) {
            if (state.canDisconnect) DropdownMenuItem({ Text(stringResource(R.string.disconnect)) }, { open = false; actions.disconnect() })
            else DropdownMenuItem({ Text(stringResource(R.string.connect)) }, { open = false; actions.connect() }, enabled = state.canConnect)
            DropdownMenuItem({ Text(stringResource(R.string.choose_assistant)) }, { open = false; actions.chooseAssistant() })
        }
    }
}

/** The single Details disclosure: everything technical lives behind it and nowhere else. */
@Composable
private fun Disclosure(open: Boolean, onOpen: (Boolean) -> Unit, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().animateContentSize(calmly(200)), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton({ onOpen(!open) }) {
            Text(stringResource(if (open) R.string.hide_details else R.string.details))
        }
        if (open) content()
    }
}

/** The pairing code in 4-character groups, four to a line, the way it is compared by eye. */
@Composable
fun FingerprintLines(descriptor: Descriptor, fontSize: TextUnit = 18.sp, modifier: Modifier = Modifier) {
    val hex = remember(descriptor.publicKey) { Fingerprint.of(descriptor.publicKey) }
    Column(modifier.widthIn(max = 420.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (hex == null) {
            BasicText(stringResource(R.string.pairing_code_unreadable), style = TextStyle(color = CosmosPalette.error, fontSize = fontSize, fontFamily = FontFamily.SansSerif))
        } else {
            for (line in Fingerprint.lines(hex)) {
                BasicText(line, style = TextStyle(color = CosmosPalette.text, fontSize = fontSize, lineHeight = fontSize * 1.5f,
                    fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp))
            }
        }
    }
}

@Composable
private fun PrimaryButton(label: String, enabled: Boolean, busy: Boolean = false, onClick: () -> Unit) {
    Button(onClick, Modifier.fillMaxWidth().height(52.dp), enabled = enabled, shape = RoundedCornerShape(16.dp)) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), color = LocalContentColor.current, strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
        }
        Text(label, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun Step(number: Int) = Text(
    stringResource(R.string.step_of, number), color = CosmosPalette.secondary, fontSize = CosmosType.quiet,
)

@Composable
private fun Title(text: String) = Text(text, color = CosmosPalette.primary, fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold)

@Composable
private fun Body(text: String) = Text(text, color = CosmosPalette.secondary, fontSize = CosmosType.body, lineHeight = CosmosType.bodyLine)

@Composable
private fun Hint(text: String) = Text(text, color = CosmosPalette.secondary, fontSize = CosmosType.quiet, lineHeight = CosmosType.quietLine, textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth())

@Composable
private fun fieldColors(): TextFieldColors = OutlinedTextFieldDefaults.colors(
    focusedTextColor = CosmosPalette.primary, unfocusedTextColor = CosmosPalette.primary,
    disabledTextColor = CosmosPalette.secondary, cursorColor = CosmosPalette.glow,
    focusedBorderColor = CosmosPalette.glow, unfocusedBorderColor = CosmosPalette.border, disabledBorderColor = CosmosPalette.border.copy(alpha = .5f),
    focusedPlaceholderColor = CosmosPalette.secondary, unfocusedPlaceholderColor = CosmosPalette.secondary,
    disabledPlaceholderColor = CosmosPalette.secondary.copy(alpha = .6f),
    focusedLabelColor = CosmosPalette.glow, unfocusedLabelColor = CosmosPalette.secondary,
)
