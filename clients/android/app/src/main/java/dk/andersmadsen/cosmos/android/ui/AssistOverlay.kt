package dk.andersmadsen.cosmos.android.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.traversalIndex
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dk.andersmadsen.cosmos.android.Ask
import dk.andersmadsen.cosmos.android.AssistContext
import dk.andersmadsen.cosmos.android.DisplayCard
import dk.andersmadsen.cosmos.android.Phase
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.ScreenContext
import dk.andersmadsen.cosmos.android.SheetBody
import dk.andersmadsen.cosmos.android.SurfaceState
import dk.andersmadsen.cosmos.android.chipLabel
import dk.andersmadsen.cosmos.android.isComplete
import dk.andersmadsen.cosmos.android.line
import dk.andersmadsen.cosmos.android.notice
import dk.andersmadsen.cosmos.android.presence
import dk.andersmadsen.cosmos.android.sheetBody
import dk.andersmadsen.cosmos.android.suggestions
import kotlin.math.roundToInt

/** What the overlay can ask its host, the assist activity or the voice session, to do. */
class AssistOverlayActions(
    val send: (text: String, target: String, context: ScreenContext?) -> Unit,
    val removeContext: () -> Unit,
    val chooseAssistant: () -> Unit,
    val openCosmos: () -> Unit,
    val dismiss: () -> Unit,
    val committed: (DisplayCard) -> Unit,
)

/**
 * The assistant over the current app, shared by the ACTION_ASSIST activity and the
 * voice-interaction session. It is a real bottom sheet: a dimmed app behind, a solid
 * graphite ground, and one vertical order inside it — handle, status line, reply,
 * screen chip, ask bar. It never reads audio or the screen itself; the host hands it
 * [context], and only a chip the owner kept travels with a request.
 */
@Composable
fun AssistOverlay(state: SurfaceState, context: AssistContext, actions: AssistOverlayActions) {
    var draft by rememberSaveable { mutableStateOf("") }
    var target by rememberSaveable { mutableStateOf("") }
    var choosing by rememberSaveable { mutableStateOf(false) }
    var ask by remember { mutableStateOf<Ask?>(null) }
    val attached = (context as? AssistContext.Attached)?.context
    val body = state.sheetBody(ask)
    LaunchedEffect(body) { if (body !is SheetBody.Now) ask = null }
    val presence = state.presence(ask)
    val haptics = LocalHapticFeedback.current
    // The one buzz the phone gives: Cosmos is waiting for the owner to do something.
    LaunchedEffect(presence.line) {
        if (state.status?.state == "waiting") haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }
    val closeLabel = stringResource(R.string.close_assistant)

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val maxBody = maxHeight * .55f
        // The app behind is dimmed and inert: a tap on it closes the picker, then the sheet.
        Box(
            Modifier.fillMaxSize().background(CosmosPalette.scrim)
                .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button) {
                    if (choosing) choosing = false else actions.dismiss()
                }
                // Read after the sheet: the sheet is what the owner came for.
                .semantics { contentDescription = closeLabel; traversalIndex = 1f },
        )
        var drag by remember { mutableFloatStateOf(0f) }
        val density = LocalDensity.current
        Column(
            Modifier.align(Alignment.BottomCenter).semantics { isTraversalGroup = true; traversalIndex = 0f }
                .statusBarsPadding().widthIn(max = 560.dp).fillMaxWidth()
                .offset { IntOffset(0, drag.roundToInt()) }
                // Both hosts resize their window for the keyboard, so the sheet only keeps
                // itself clear of the gesture bar; adding an IME inset here would double it.
                .background(CosmosPalette.sheet, RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                .navigationBarsPadding().padding(bottom = 12.dp),
        ) {
            CosmosDragHandle(
                onDismiss = actions.dismiss,
                modifier = Modifier.padding(top = 8.dp).draggable(
                    orientation = Orientation.Vertical,
                    state = rememberDraggableState { delta -> drag = (drag + delta).coerceAtLeast(0f) },
                    onDragStopped = { if (drag > with(density) { 72.dp.toPx() }) actions.dismiss() else drag = 0f },
                ),
            )
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp).animateContentSize(calmly(220)),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PresenceLine(presence, Modifier.padding(top = 4.dp))
                // A whole prompt is sent; one that trails off becomes the start of the field.
                SheetBodyView(
                    body, maxBody, attached != null, draft.isBlank(), actions,
                    // Choosing an option is a request like any other: Cosmos decides where its reply goes.
                    onChoose = { title ->
                        ask = Ask(title, turnBefore = state.admission?.turnId, sendsBefore = state.sends)
                        actions.send(title, "", null)
                    },
                    onPrompt = { prompt ->
                        if (isComplete(prompt) && state.canSend) {
                            ask = Ask(prompt, turnBefore = state.admission?.turnId, sendsBefore = state.sends)
                            actions.send(prompt, target, attached)
                        } else {
                            draft = prompt.trimEnd().removeSuffix("…")
                        }
                    },
                )
                SheetNotice(state, actions)
                AssistContextRow(context, actions.removeContext, actions.chooseAssistant)
                if (state.phase == Phase.CONNECTED) {
                    AskBar(
                        draft = draft, onDraft = { draft = it }, canSend = state.canSend,
                        onSend = {
                            val text = draft.trim()
                            ask = Ask(text, turnBefore = state.admission?.turnId, sendsBefore = state.sends)
                            draft = ""
                            actions.send(text, target, attached)
                        },
                        target = target, onTarget = { target = it },
                        choosing = choosing, onChoosing = { choosing = it },
                    )
                }
            }
        }
    }
}

/** The reply, the request just sent, the empty state, or one plain sentence. Never more than one. */
@Composable
private fun SheetBodyView(
    body: SheetBody,
    maxHeight: Dp,
    hasScreenContext: Boolean,
    idle: Boolean,
    actions: AssistOverlayActions,
    onChoose: (String) -> Unit,
    onPrompt: (String) -> Unit,
) {
    when (body) {
        is SheetBody.Reply -> DisplayCardView(
            body.card, onCommitted = actions.committed,
            Modifier.fillMaxWidth().heightIn(max = maxHeight), onChoose = onChoose,
        )
        is SheetBody.Spoken -> CosmosCard(Modifier.fillMaxWidth().heightIn(max = maxHeight)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) { CosmosMessage(body.text) }
        }
        is SheetBody.Now -> NowLine(body.text)
        is SheetBody.Note -> Text(
            body.text, color = CosmosPalette.secondary, fontSize = 15.sp, lineHeight = 21.sp,
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        )
        // Once there is something in the field the prompts have done their job and step aside.
        SheetBody.Empty -> if (idle) EmptyState(hasScreenContext, onPrompt)
    }
}

/** What was just asked, on screen the instant Send is pressed, with the working bars beside it. */
@Composable
private fun NowLine(text: String) {
    Row(
        Modifier.fillMaxWidth().background(CosmosPalette.card, RoundedCornerShape(20.dp))
            .padding(horizontal = 18.dp, vertical = 14.dp)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CosmosWaveform(AssistantState.THINKING, Modifier.size(width = 30.dp, height = 22.dp).padding(top = 2.dp))
        Text(text, color = CosmosPalette.primary, fontSize = 16.sp, lineHeight = 22.sp, modifier = Modifier.weight(1f))
    }
}

/** Nothing asked yet: a horizon of the kit nebula, then the prompts that work today under it. */
@Composable
private fun EmptyState(hasScreenContext: Boolean, onPrompt: (String) -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        CosmosHorizon()
        for (prompt in suggestions(hasScreenContext)) SuggestionRow(prompt, onPrompt)
    }
}

@Composable
private fun SuggestionRow(prompt: String, onPrompt: (String) -> Unit) {
    val label = stringResource(R.string.suggestion, prompt)
    Text(
        prompt, color = CosmosPalette.primary, fontSize = 15.sp, lineHeight = 20.sp,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .clickable(role = Role.Button) { onPrompt(prompt) }
            .background(CosmosPalette.card, RoundedCornerShape(16.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp)
            .semantics { contentDescription = label },
    )
}

/** A failure or a pending operation, as one sentence with the action that can help. */
@Composable
private fun SheetNotice(state: SurfaceState, actions: AssistOverlayActions) {
    val text = state.notice() ?: return
    val failed = state.alert || state.phase == Phase.BLOCKED
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text, color = if (failed) CosmosPalette.error else CosmosPalette.secondary, fontSize = 13.sp, lineHeight = 18.sp,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (state.phase != Phase.CONNECTED) {
            TextButton(actions.openCosmos) { Text(stringResource(R.string.open_cosmos)) }
        }
    }
}

/** The honest chip: which app's text is attached, removable with one tap. */
@Composable
fun AssistContextRow(context: AssistContext, onRemove: () -> Unit, onChooseAssistant: () -> Unit, modifier: Modifier = Modifier) {
    val label = context.chipLabel()
    val line = context.line()
    if (label == null && line == null) return
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (label != null) {
            val remove = stringResource(R.string.remove_context)
            Row(
                Modifier.heightIn(min = 48.dp).clickable(role = Role.Button, onClickLabel = remove, onClick = onRemove)
                    .background(CosmosPalette.card, CircleShape)
                    .padding(horizontal = 16.dp, vertical = 12.dp)
                    .semantics { contentDescription = "$label. $remove" },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(label, color = CosmosPalette.primary, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                Text("✕", color = CosmosPalette.secondary, fontSize = 14.sp)
            }
        }
        if (line != null) Text(line, color = CosmosPalette.secondary.copy(alpha = .75f), fontSize = 12.sp, lineHeight = 17.sp)
        if (context == AssistContext.NoRole) {
            Spacer(Modifier.height(2.dp))
            TextButton(onChooseAssistant) { Text(stringResource(R.string.choose_assistant)) }
        }
    }
}
