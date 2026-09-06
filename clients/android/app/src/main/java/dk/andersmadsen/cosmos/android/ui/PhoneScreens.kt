package dk.andersmadsen.cosmos.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
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
import dk.andersmadsen.cosmos.android.Descriptor
import dk.andersmadsen.cosmos.android.DisplayCard
import dk.andersmadsen.cosmos.android.Fingerprint
import dk.andersmadsen.cosmos.android.Phase
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.Screen
import dk.andersmadsen.cosmos.android.SessionStatus
import dk.andersmadsen.cosmos.android.SurfaceState
import dk.andersmadsen.cosmos.android.UNKNOWN_OUTCOME_NOTICE
import dk.andersmadsen.cosmos.android.assistantState
import dk.andersmadsen.cosmos.android.notice
import dk.andersmadsen.cosmos.android.offersCancel
import dk.andersmadsen.cosmos.android.screen
import dk.andersmadsen.cosmos.android.serverLabel
import dk.andersmadsen.cosmos.android.sessionStatus

/** Everything either layout can ask the activity to do; the activity owns intents and permissions. */
class SurfaceActions(
    val prepare: (String) -> Unit,
    val connect: () -> Unit,
    val disconnect: () -> Unit,
    val send: (String) -> Unit,
    val cancel: () -> Unit,
    val retry: () -> Unit,
    val approve: (String) -> Unit,
    val copy: (String) -> Unit,
    val share: (String) -> Unit,
    val chooseAssistant: () -> Unit,
    val committed: (DisplayCard) -> Unit,
)

/** The phone: one calm screen per state over the kit's bottom nebula. */
@Composable
fun PhoneScreen(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    Box(Modifier.fillMaxSize().background(CosmosPalette.background)) {
        CosmosNebula(Modifier.align(Alignment.BottomCenter))
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 22.dp)) {
            val screen = state.screen()
            Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                CosmosWordmark(iconSize = 36.dp, fontSize = 24.sp)
                Spacer(Modifier.weight(1f))
                if (screen == Screen.SESSION) {
                    StatusPill(state.sessionStatus())
                    Spacer(Modifier.width(4.dp))
                    OverflowMenu(state, actions)
                }
            }
            when (screen) {
                Screen.SETUP -> SetupScreen(state, actions)
                Screen.APPROVE -> ApproveScreen(state, approvalRequested, actions)
                Screen.SESSION -> SessionScreen(state, actions)
            }
        }
    }
}

@Composable
private fun SetupScreen(state: SurfaceState, actions: SurfaceActions) {
    var server by rememberSaveable(state.serverOrigin) { mutableStateOf(state.serverOrigin) }
    var editing by rememberSaveable { mutableStateOf(false) }
    val preparing = state.phase == Phase.PREPARING
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp), verticalArrangement = Arrangement.Center) {
        Title("Set up this phone")
        Spacer(Modifier.height(12.dp))
        Body("Cosmos shows shared answers and speaks replies here once you approve this phone in Center.")
        Spacer(Modifier.height(24.dp))
        if (editing) {
            OutlinedTextField(
                server, { server = it }, Modifier.fillMaxWidth(), label = { Text("HTTPS server address") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done), colors = fieldColors(),
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(serverLabel(server), color = CosmosPalette.primary, fontSize = 15.sp)
                Text(" · ", color = CosmosPalette.secondary, fontSize = 15.sp)
                Text("Change", color = CosmosPalette.glow, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.clickable(role = Role.Button) { editing = true }.padding(6.dp))
            }
        }
        Spacer(Modifier.height(24.dp))
        PrimaryButton(if (preparing) "Setting up…" else "Set up this phone", enabled = state.canPrepare, busy = preparing) { actions.prepare(server) }
        Notice(state, actions)
    }
}

@Composable
private fun ApproveScreen(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    val descriptor = state.descriptor ?: return
    val url = remember(descriptor, state.serverOrigin) { descriptor.approvalUrl(state.serverOrigin) }
    var showQr by rememberSaveable { mutableStateOf(false) }
    var advanced by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Title("Approve in Center")
        Body("Center shows this fingerprint next to the phone's own. Approve only when they match.")
        CosmosPanel(Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Public-key fingerprint", color = CosmosPalette.secondary, fontSize = 12.sp)
                Spacer(Modifier.height(10.dp))
                FingerprintLines(descriptor)
            }
        }
        PrimaryButton("Approve in Center", enabled = !state.busy) { actions.approve(url) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton({ showQr = !showQr }) { Text(if (showQr) "Hide QR" else "Show QR") }
            TextButton({ advanced = !advanced }) { Text(if (advanced) "Advanced ▴" else "Advanced ▾") }
        }
        if (showQr) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                QrCodeImage(url, stringResource(R.string.approval_qr), Modifier.width(220.dp))
                Text("Scan from another signed-in device to approve this phone.", color = CosmosPalette.secondary, fontSize = 13.sp, textAlign = TextAlign.Center)
            }
        }
        Row(
            Modifier.fillMaxWidth().background(CosmosPalette.surface, RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.busy) {
                CircularProgressIndicator(Modifier.size(18.dp), color = CosmosPalette.glow, strokeWidth = 2.dp)
                Text("Checking with Center…", color = CosmosPalette.secondary, fontSize = 14.sp, modifier = Modifier.weight(1f))
            } else {
                val failed = state.alert || state.phase == Phase.BLOCKED
                Text(if (failed) state.message else "Waiting for approval in Center…", color = CosmosPalette.secondary, fontSize = 14.sp,
                    lineHeight = 19.sp, modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                OutlinedButton(actions.connect, enabled = state.canConnect) { Text(if (approvalRequested || failed) "Try again" else "Connect") }
            }
        }
        if (advanced) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({ actions.copy(descriptor.json()) }) { Text("Copy descriptor") }
                OutlinedButton({ actions.share(descriptor.json()) }) { Text("Share…") }
            }
            Text(descriptor.json(), color = CosmosPalette.secondary, fontSize = 12.sp, fontFamily = FontFamily.Monospace, lineHeight = 16.sp)
        }
    }
}

@Composable
private fun SessionScreen(state: SurfaceState, actions: SurfaceActions) {
    var draft by rememberSaveable { mutableStateOf("") }
    val status = state.sessionStatus()
    Column(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val card = state.display
            val speech = state.speech
            val maxCard = (maxHeight - 64.dp).coerceAtLeast(120.dp)
            when {
                card != null -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                    DisplayCardView(card, onCommitted = actions.committed, Modifier.fillMaxWidth().heightIn(max = maxCard))
                    if (speech != null) SpeakingLine(state)
                }
                speech != null -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                    CosmosPanel(Modifier.fillMaxWidth().heightIn(max = maxCard)) {
                        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) { CosmosMessage(speech.text) }
                    }
                    SpeakingLine(state)
                }
                else -> Column(Modifier.fillMaxSize().padding(horizontal = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    CosmosWaveform(state.assistantState(), Modifier.size(width = 72.dp, height = 48.dp))
                    Spacer(Modifier.height(20.dp))
                    when (status) {
                        SessionStatus.CONNECTED -> Hint("Ask Cosmos below. Shared answers and spoken replies for this phone appear here.")
                        SessionStatus.RECONNECTING -> Hint("Rejoining the Cosmos room…")
                        SessionStatus.DISCONNECTED -> {
                            Hint("Disconnected. Center still lists this phone as approved.")
                            Spacer(Modifier.height(16.dp))
                            Button(actions.connect, enabled = state.canConnect, shape = RoundedCornerShape(16.dp)) { Text("Connect", fontWeight = FontWeight.SemiBold) }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Text("Public text only · no microphone · no private memories", color = CosmosPalette.secondary.copy(alpha = .7f), fontSize = 12.sp, textAlign = TextAlign.Center)
                }
            }
        }
        Notice(state, actions)
        AskBar(draft, { draft = it }, enabled = state.canSend, onSend = { actions.send(draft); draft = "" }, modifier = Modifier.padding(vertical = 10.dp))
    }
}

@Composable
private fun SpeakingLine(state: SurfaceState) {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CosmosWaveform(if (state.speaking) AssistantState.SPEAKING else AssistantState.IDLE, Modifier.size(width = 48.dp, height = 32.dp))
        Spacer(Modifier.width(10.dp))
        Text(if (state.speaking) "Speaking" else "Spoken reply", color = CosmosPalette.secondary, fontSize = 13.sp,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    }
}

/** Pending, retry, unknown-outcome and failure messages, kept quiet but never hidden. */
@Composable
fun Notice(state: SurfaceState, actions: SurfaceActions, modifier: Modifier = Modifier) {
    val text = state.notice()
    if (text == null && !state.hasUnknownOutcome) return
    val failed = state.alert || state.phase == Phase.BLOCKED
    Column(modifier.fillMaxWidth().padding(top = 12.dp).background(CosmosPalette.surface, RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (text != null) Text(text, color = if (failed) CosmosPalette.error else CosmosPalette.secondary, fontSize = 13.sp, lineHeight = 18.sp,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        if (state.hasUnknownOutcome) Text(UNKNOWN_OUTCOME_NOTICE, color = CosmosPalette.secondary, fontSize = 13.sp, lineHeight = 18.sp)
        if (state.canRetry || state.offersCancel()) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (state.canRetry) TextButton(actions.retry) { Text("Retry") }
            if (state.offersCancel()) TextButton(actions.cancel) { Text("Cancel request") }
        }
    }
}

/** The ask field with its send button; Send on the keyboard submits too. */
@Composable
fun AskBar(draft: String, onDraft: (String) -> Unit, enabled: Boolean, onSend: () -> Unit, modifier: Modifier = Modifier) {
    val canSend = enabled && draft.isNotBlank()
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            draft, { onDraft(it.take(4000)) }, Modifier.weight(1f), enabled = enabled, placeholder = { Text("Ask Cosmos") },
            maxLines = 4, shape = RoundedCornerShape(24.dp), colors = fieldColors(),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (canSend) onSend() }),
        )
        FilledIconButton(onSend, Modifier.size(48.dp), enabled = canSend) {
            Icon(painterResource(R.drawable.ic_send), contentDescription = stringResource(R.string.send_question))
        }
    }
}

@Composable
private fun OverflowMenu(state: SurfaceState, actions: SurfaceActions) {
    var open by remember { mutableStateOf(false) }
    var descriptorShown by remember { mutableStateOf(false) }
    Box {
        IconButton({ open = true }) {
            Icon(painterResource(R.drawable.ic_more_vert), contentDescription = stringResource(R.string.more_actions), tint = CosmosPalette.primary)
        }
        DropdownMenu(open, { open = false }) {
            if (state.canDisconnect) DropdownMenuItem({ Text("Disconnect") }, { open = false; actions.disconnect() })
            else DropdownMenuItem({ Text("Connect") }, { open = false; actions.connect() }, enabled = state.canConnect)
            DropdownMenuItem({ Text("Choose Cosmos as default assistant") }, { open = false; actions.chooseAssistant() })
            DropdownMenuItem({ Text("Show descriptor") }, { open = false; descriptorShown = true })
        }
    }
    val descriptor = state.descriptor
    if (descriptorShown && descriptor != null) {
        val json = descriptor.json()
        AlertDialog(
            onDismissRequest = { descriptorShown = false },
            containerColor = CosmosPalette.surface, titleContentColor = CosmosPalette.primary, textContentColor = CosmosPalette.secondary,
            title = { Text("Public descriptor") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    FingerprintLines(descriptor, fontSize = 14.sp)
                    Text(json, fontSize = 12.sp, lineHeight = 16.sp, fontFamily = FontFamily.Monospace)
                    Text("Public enrollment material only; no credential is in it.", fontSize = 12.sp)
                }
            },
            confirmButton = {
                Row {
                    TextButton({ actions.copy(json) }) { Text("Copy") }
                    TextButton({ actions.share(json) }) { Text("Share…") }
                    TextButton({ descriptorShown = false }) { Text("Close") }
                }
            },
        )
    }
}

/** The fingerprint in 4-character groups, four to a line, in the kit's response colour. */
@Composable
fun FingerprintLines(descriptor: Descriptor, fontSize: TextUnit = 17.sp, modifier: Modifier = Modifier) {
    val hex = remember(descriptor.publicKey) { Fingerprint.of(descriptor.publicKey) }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (hex == null) {
            BasicText("This installation key could not be read.", style = TextStyle(color = CosmosPalette.error, fontSize = fontSize, fontFamily = FontFamily.SansSerif))
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
private fun Title(text: String) = Text(text, color = CosmosPalette.primary, fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold)

@Composable
private fun Body(text: String) = Text(text, color = CosmosPalette.secondary, fontSize = 16.sp, lineHeight = 22.sp)

@Composable
private fun Hint(text: String) = Text(text, color = CosmosPalette.secondary, fontSize = 15.sp, lineHeight = 21.sp, textAlign = TextAlign.Center)

@Composable
private fun fieldColors(): TextFieldColors = OutlinedTextFieldDefaults.colors(
    focusedTextColor = CosmosPalette.primary, unfocusedTextColor = CosmosPalette.primary,
    disabledTextColor = CosmosPalette.secondary, cursorColor = CosmosPalette.glow,
    focusedBorderColor = CosmosPalette.glow, unfocusedBorderColor = CosmosPalette.border, disabledBorderColor = CosmosPalette.border.copy(alpha = .5f),
    focusedPlaceholderColor = CosmosPalette.secondary, unfocusedPlaceholderColor = CosmosPalette.secondary,
    disabledPlaceholderColor = CosmosPalette.secondary.copy(alpha = .6f),
    focusedLabelColor = CosmosPalette.glow, unfocusedLabelColor = CosmosPalette.secondary,
)
