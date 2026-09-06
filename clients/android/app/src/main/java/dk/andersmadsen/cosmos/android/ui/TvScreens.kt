package dk.andersmadsen.cosmos.android.ui

import android.animation.ValueAnimator
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme
import dk.andersmadsen.cosmos.android.DisplayCard
import dk.andersmadsen.cosmos.android.Phase
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.Screen
import dk.andersmadsen.cosmos.android.SessionStatus
import dk.andersmadsen.cosmos.android.SurfaceState
import dk.andersmadsen.cosmos.android.TvRequest
import dk.andersmadsen.cosmos.android.TvStage
import dk.andersmadsen.cosmos.android.UNKNOWN_OUTCOME_NOTICE
import dk.andersmadsen.cosmos.android.notice
import dk.andersmadsen.cosmos.android.pageRanges
import dk.andersmadsen.cosmos.android.screen
import dk.andersmadsen.cosmos.android.serverLabel
import dk.andersmadsen.cosmos.android.sessionStatus
import dk.andersmadsen.cosmos.android.tvStage
import java.util.UUID
import kotlin.random.Random

/** TV Material shaped by the TV kit's tokens; never mixed with the phone's mobile Material tree. */
@Composable
fun CosmosTvTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(
        primary = CosmosPalette.glow, onPrimary = CosmosPalette.tvBackground,
        surface = CosmosPalette.surface, onSurface = CosmosPalette.primary,
        background = CosmosPalette.tvBackground, onBackground = CosmosPalette.primary,
    ), content = content)
}

private val BODY = TextStyle(color = CosmosPalette.text, fontSize = 24.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium, fontFamily = FontFamily.SansSerif)

/** The owner's frames: the live transcript in light cyan, the reply caption in light mint under a soft shadow. */
private val TRANSCRIPT = Color(0xFF8FE3F0)
private val CAPTION = Color(0xFF9FE8C8)
private val CAPTION_SHADOW = Shadow(Color.Black.copy(alpha = .8f), Offset(0f, 3f), blurRadius = 12f)
private val GRAPHITE = Brush.verticalGradient(listOf(Color(0xFF161B1F), Color(0xFF0B0F12)))

/** Stage geometry as fractions of the screen height so 1080p and a phone agree: a 12% band, a 40 px corner radius at 1080p. */
private const val BAND = .12f
private const val INSET_TOP = .012f
private const val INSET_RADIUS = .037f

/** The one focusable thing on the stage, the corner crescent, labelled for what it does now. */
class TvStageAction(val label: String, val onClick: () -> Unit)

/** A real focusable TV button for the set-up screens: filled accent when focused, slight scale, 52dp minimum height. */
@Composable
fun TvAction(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 52.dp),
        colors = ButtonDefaults.colors(
            containerColor = CosmosPalette.surface, contentColor = CosmosPalette.primary,
            focusedContainerColor = CosmosPalette.glow, focusedContentColor = CosmosPalette.tvBackground,
            disabledContainerColor = CosmosPalette.surface.copy(alpha = .55f), disabledContentColor = CosmosPalette.secondary,
        ),
        scale = ButtonDefaults.scale(focusedScale = 1.04f),
    ) { Text(label, fontSize = 18.sp, fontWeight = FontWeight.Medium) }
}

private class TvActionSpec(val label: String, val enabled: Boolean = true, val onClick: () -> Unit)

/**
 * The Shield: set-up and approval as text over the graphite stage, then the assistant
 * stage itself. Everything answers the D-pad; nothing private is ever shown here.
 */
@Composable
fun TvScreen(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    when (state.screen()) {
        Screen.SETUP -> TvSetupScreen(state, actions)
        Screen.APPROVE -> TvApproveScreen(state, approvalRequested, actions)
        Screen.SESSION -> TvSession(state, actions)
    }
}

/** Owns what only this TV knows: the typed request, the open ask field, the paged view and a reply sent away with Back. */
@Composable
private fun TvSession(state: SurfaceState, actions: SurfaceActions) {
    var request by remember { mutableStateOf<TvRequest?>(null) }
    var dismissed by remember { mutableStateOf<UUID?>(null) }
    var asking by rememberSaveable { mutableStateOf(false) }
    var reading by rememberSaveable { mutableStateOf(false) }
    val stage = state.tvStage(request, dismissed)
    // A send is in flight once the controller reports busy; settling without a new admission drops it.
    LaunchedEffect(state.busy) { if (state.busy) request = request?.copy(sending = true) }
    LaunchedEffect(stage) {
        if (stage is TvStage.Idle || stage is TvStage.Answer) request = null
        if (stage !is TvStage.Answer) reading = false
    }
    val status = state.sessionStatus()
    val askLabel = stringResource(R.string.tv_ask)
    val action = when {
        state.canRetry -> TvStageAction("Retry", actions.retry)
        status != SessionStatus.CONNECTED && state.canConnect -> TvStageAction("Connect", actions.connect)
        else -> TvStageAction(askLabel) { if (asking || state.canSend) asking = !asking }
    }
    val notice = when (status) {
        SessionStatus.RECONNECTING -> "Reconnecting…"
        SessionStatus.DISCONNECTED -> "Disconnected · OK to connect"
        SessionStatus.CONNECTED -> state.notice()
    }
    // Back closes the paged view, then the ask field, then sends the current reply or transcript away.
    BackHandler(enabled = reading) { reading = false }
    BackHandler(enabled = asking) { asking = false }
    BackHandler(enabled = !asking && !reading && stage !is TvStage.Idle) {
        dismissed = state.display?.actionId ?: state.speech?.actionId
        request = null
    }
    if (reading && stage is TvStage.Answer) {
        TvAnswerPages(stage.full)
        return
    }
    CosmosTvStage(
        stage = stage, asking = asking, action = action, notice = notice, reducedMotion = !ValueAnimator.areAnimatorsEnabled(),
        onMore = { reading = true }, onCommitted = actions.committed,
        askField = { fontSize ->
            TvAskField(fontSize, enabled = state.canSend) { text ->
                request = TvRequest(text, turnBefore = state.admission?.turnId)
                asking = false
                actions.send(text)
            }
        },
    )
}

/**
 * The whole TV screen: a content layer (the graphite ready screen until a player takes
 * the slot) and the assistant over it. Working and the transcript shrink the content
 * into a rounded inset above the nebula band; a reply returns it to full screen under
 * a subtitle caption. Text keeps 5% overscan insets; the inset and band reach the edges.
 */
@Composable
fun CosmosTvStage(
    stage: TvStage,
    asking: Boolean,
    action: TvStageAction,
    notice: String?,
    reducedMotion: Boolean,
    onMore: () -> Unit,
    onCommitted: (DisplayCard) -> Unit,
    askField: @Composable (fontSize: TextUnit) -> Unit,
    content: @Composable () -> Unit = { TvReadyContent() },
) {
    val inset = asking || stage is TvStage.Working || stage is TvStage.Transcript
    // Reduced motion cuts between the two framings instead of animating them.
    val progress by animateFloatAsState(if (inset) 1f else 0f, if (reducedMotion) snap() else tween(300), label = "tv-inset")
    val actionFocus = remember { FocusRequester() }
    LaunchedEffect(asking) { if (!asking) runCatching { actionFocus.requestFocus() } }
    BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
        // Sizes follow the whole screen; only the content shrinks further when the keyboard takes room.
        val fullWidth = maxWidth
        val fullHeight = maxHeight
        val safeX = fullWidth * .05f
        val safeY = fullHeight * .05f
        val bandHeight = fullHeight * BAND
        val top = fullHeight * INSET_TOP
        val crescent = fullHeight * .05f
        val bandFont = (fullHeight.value * .036f).sp
        val density = LocalDensity.current
        val topPx = with(density) { top.toPx() }
        val radiusPx = with(density) { (fullHeight * INSET_RADIUS).toPx() }
        BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
            val insetScale = ((maxHeight - bandHeight - top * 2) / fullHeight).coerceIn(.2f, 1f)
            Box(Modifier.align(Alignment.TopCenter).requiredSize(fullWidth, fullHeight).graphicsLayer {
                val scale = 1f - progress * (1f - insetScale)
                scaleX = scale
                scaleY = scale
                transformOrigin = TransformOrigin(.5f, 0f)
                translationY = progress * topPx
                clip = true
                // The shape applies before the scale, so the drawn radius is divided out here.
                shape = RoundedCornerShape(progress * radiusPx / scale)
            }) { content() }
            TvBand(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(bandHeight).graphicsLayer { alpha = progress }, fullWidth) {
                Box(Modifier.padding(horizontal = safeX), contentAlignment = Alignment.Center) {
                    when {
                        asking -> askField(bandFont)
                        stage is TvStage.Transcript -> BasicText(
                            stage.request, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            style = TextStyle(color = TRANSCRIPT, fontSize = bandFont, lineHeight = bandFont * 1.25f, fontWeight = FontWeight.Medium,
                                fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center),
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
                        // The box is twice the tallest bar: the animated bars reach about half of it.
                        stage is TvStage.Working -> CosmosWaveform(AssistantState.THINKING, Modifier.size(fullHeight * .085f, fullHeight * .074f), !reducedMotion, Color.White)
                    }
                }
            }
            val captionInset = safeX + crescent + 16.dp
            if (stage is TvStage.Answer && !asking) {
                TvCaption(stage, (fullHeight.value * .04f).sp, onMore, onCommitted,
                    Modifier.align(Alignment.BottomCenter).padding(start = captionInset, end = captionInset, bottom = safeY))
            } else if (notice != null && !inset) {
                BasicText(
                    notice, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    style = TextStyle(color = CosmosPalette.secondary, fontSize = (fullHeight.value * .026f).sp, fontFamily = FontFamily.SansSerif,
                        textAlign = TextAlign.Center, shadow = CAPTION_SHADOW),
                    modifier = Modifier.align(Alignment.BottomCenter).padding(start = captionInset, end = captionInset, bottom = safeY)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            // The corner crescent keeps one place in every framing: the band's right end, inside the safe inset.
            TvCrescent(action, crescent, actionFocus, Modifier.align(Alignment.BottomEnd).padding(end = safeX, bottom = (bandHeight - crescent) / 2))
        }
    }
}

/** The graphite ready screen with the crescent mark: the stage's own content until a player takes the slot. */
@Composable
fun TvReadyContent(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(GRAPHITE), contentAlignment = Alignment.Center) {
        Image(painterResource(R.drawable.ic_cosmos), contentDescription = null, modifier = Modifier.fillMaxHeight(.24f).aspectRatio(1f), alpha = .92f)
    }
}

/** The black band under the inset: the kit's nebula scaled and clipped to it, a few dozen static sparkles, and one centred thing. */
@Composable
private fun TvBand(modifier: Modifier, width: Dp, centre: @Composable BoxScope.() -> Unit) {
    val sparkles = remember {
        val seed = Random(20260906)
        List(40) { floatArrayOf(seed.nextFloat(), seed.nextFloat(), .15f + .45f * seed.nextFloat(), .5f + seed.nextFloat()) }
    }
    Box(modifier.background(Color.Black).clipToBounds(), contentAlignment = Alignment.Center) {
        Canvas(Modifier.matchParentSize()) {
            // A wide elliptical glow keeps the light in the middle of the band; the texture sits on it.
            scale(scaleX = 3.2f, scaleY = 1f) {
                val radius = size.height * .95f
                drawCircle(Brush.radialGradient(listOf(CosmosPalette.glow.copy(alpha = .5f), CosmosPalette.glow.copy(alpha = .14f), Color.Transparent), center, radius), radius, center)
            }
        }
        Image(painterResource(R.drawable.cosmos_nebula_bottom), contentDescription = null, contentScale = ContentScale.FillBounds,
            modifier = Modifier.requiredSize(width * .56f, width * .56f / 3f), alpha = .9f)
        Canvas(Modifier.matchParentSize()) {
            for ((x, y, alpha, radius) in sparkles) drawCircle(Color.White.copy(alpha = alpha), radius * 1.dp.toPx(), Offset(x * size.width, y * size.height))
        }
        centre()
    }
}

/** The reply as a subtitle: two lines at most, and More for the rest in the paged view. */
@Composable
private fun TvCaption(answer: TvStage.Answer, fontSize: TextUnit, onMore: () -> Unit, onCommitted: (DisplayCard) -> Unit, modifier: Modifier) {
    var overflowed by remember(answer.id) { mutableStateOf(false) }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        BasicText(
            answer.caption, maxLines = 2, overflow = TextOverflow.Ellipsis, onTextLayout = { overflowed = it.hasVisualOverflow },
            style = TextStyle(color = CAPTION, fontSize = fontSize, lineHeight = fontSize * 1.25f, fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center, shadow = CAPTION_SHADOW),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (overflowed || answer.full != answer.caption) TvQuietAction(stringResource(R.string.tv_more), onMore, fontSize * .7f)
    }
    // Runs after the composition holding the caption is applied; More keeps the rest reachable.
    val card = answer.card
    if (card != null) LaunchedEffect(card.actionId) { onCommitted(card) }
}

/** A focusable word with no box: brighter and underlined while focused. */
@Composable
private fun TvQuietAction(label: String, onClick: () -> Unit, fontSize: TextUnit, modifier: Modifier = Modifier) {
    var focused by remember { mutableStateOf(false) }
    BasicText(
        label,
        modifier.onFocusChanged { focused = it.isFocused }
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        style = TextStyle(color = if (focused) Color.White else CAPTION.copy(alpha = .8f), fontSize = fontSize, fontWeight = FontWeight.SemiBold,
            fontFamily = FontFamily.SansSerif, textDecoration = if (focused) TextDecoration.Underline else TextDecoration.None, shadow = CAPTION_SHADOW),
    )
}

/** The corner crescent from the kit's mark: faint until focused, then bright inside a thin glow ring. */
@Composable
private fun TvCrescent(action: TvStageAction, size: Dp, focus: FocusRequester, modifier: Modifier) {
    var focused by remember { mutableStateOf(false) }
    Box(
        modifier.size(size + 12.dp).focusRequester(focus).onFocusChanged { focused = it.isFocused }
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = action.onClick)
            .semantics { contentDescription = action.label }
            .border(2.dp, if (focused) CosmosPalette.glow.copy(alpha = .75f) else Color.Transparent, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Image(painterResource(R.drawable.ic_cosmos), contentDescription = null, modifier = Modifier.size(size).alpha(if (focused) 1f else .4f))
    }
}

/** The ask field sits in the band like the transcript it becomes; Send on the remote's keyboard submits, Back closes. */
@Composable
private fun TvAskField(fontSize: TextUnit, enabled: Boolean, onSend: (String) -> Unit) {
    var draft by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val style = TextStyle(color = TRANSCRIPT, fontSize = fontSize, fontWeight = FontWeight.Medium, fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center)
    BasicTextField(
        draft, { draft = it.take(4000) }, Modifier.fillMaxWidth().focusRequester(focus),
        textStyle = style, cursorBrush = SolidColor(TRANSCRIPT), singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { if (enabled && draft.isNotBlank()) { onSend(draft.trim()); draft = "" } }),
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.Center) {
                if (draft.isEmpty()) BasicText(stringResource(R.string.tv_ask), style = style.copy(color = TRANSCRIPT.copy(alpha = .45f)))
                inner()
            }
        },
    )
}

/** The whole answer at full size, one page at a time: left and right page it, Back returns to the stage. */
@Composable
private fun TvAnswerPages(text: String) {
    var page by rememberSaveable(text) { mutableIntStateOf(0) }
    var pages by remember { mutableIntStateOf(1) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    BoxWithConstraints(
        Modifier.fillMaxSize().background(CosmosPalette.tvBackground)
            .onKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (event.key) {
                    Key.DirectionLeft, Key.PageUp, Key.ChannelUp -> { page = (page - 1).coerceAtLeast(0); true }
                    Key.DirectionRight, Key.PageDown, Key.ChannelDown -> { page = (page + 1).coerceAtMost(pages - 1); true }
                    else -> false
                }
            }
            .focusRequester(focus).focusable(),
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = maxWidth * .05f, vertical = maxHeight * .05f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            TvPagedText(text, page, onPages = { pages = it }, Modifier.weight(1f).fillMaxWidth())
            Text(
                if (pages > 1) "Page ${page + 1} of $pages · left and right to page · Back to return" else "Back to return",
                fontSize = 15.sp, color = CosmosPalette.secondary, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

/** Full-size body text split into pages of whole lines; the type never shrinks to fit. */
@Composable
private fun TvPagedText(text: String, page: Int, onPages: (Int) -> Unit, modifier: Modifier = Modifier) {
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier) {
        val width = constraints.maxWidth
        val height = if (constraints.hasBoundedHeight) constraints.maxHeight else Int.MAX_VALUE
        val pageTexts = remember(text, width, height) {
            val layout = measurer.measure(text, BODY, constraints = Constraints(maxWidth = width))
            val perPage = (0 until layout.lineCount).count { layout.getLineBottom(it) <= height }
            pageRanges(layout.lineCount, perPage).map { range ->
                text.substring(layout.getLineStart(range.first), layout.getLineEnd(range.last, visibleEnd = true))
            }
        }
        LaunchedEffect(pageTexts.size) { onPages(pageTexts.size) }
        Text(pageTexts[page.coerceIn(0, pageTexts.lastIndex)], style = BODY)
    }
}

@Composable
private fun TvSetupScreen(state: SurfaceState, actions: SurfaceActions) {
    val preparing = state.phase == Phase.PREPARING
    TvTextScreen(
        status = if (preparing) "Setting up…" else "Not set up",
        action = TvActionSpec(if (preparing) "Setting up…" else "Set up this TV", state.canPrepare) { actions.prepare(state.serverOrigin) },
        notice = listOfNotNull(state.notice(), UNKNOWN_OUTCOME_NOTICE.takeIf { state.hasUnknownOutcome }).joinToString(" · ").ifEmpty { null },
        failed = state.alert || state.phase == Phase.BLOCKED,
    ) {
        Text("Set up this TV", fontSize = 24.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold, color = CosmosPalette.primary)
        Spacer(Modifier.height(14.dp))
        Text("Cosmos shows shared answers here after you approve this TV from your phone. Nothing private is ever shown on the TV.",
            fontSize = 18.sp, lineHeight = 26.sp, color = CosmosPalette.secondary)
        Spacer(Modifier.height(14.dp))
        Text("Server · ${serverLabel(state.serverOrigin)}", fontSize = 18.sp, color = CosmosPalette.text)
    }
}

@Composable
private fun TvApproveScreen(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    val descriptor = state.descriptor ?: return
    val url = remember(descriptor, state.serverOrigin) { descriptor.approvalUrl(state.serverOrigin) }
    val failed = state.alert || state.phase == Phase.BLOCKED
    TvTextScreen(
        status = "Waiting for approval",
        action = TvActionSpec(if (approvalRequested || state.alert) "Try again" else "Connect", state.canConnect, actions.connect),
        notice = when { state.busy -> "Checking with Center…"; failed -> state.message; else -> "Waiting for approval in Center…" },
        failed = failed,
    ) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(36.dp)) {
            QrCodeImage(url, stringResource(R.string.approval_qr), Modifier.fillMaxHeight())
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Approve this TV", fontSize = 24.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold, color = CosmosPalette.primary)
                Text("Scan the code with your phone to open the approval in Center. Center shows this fingerprint; approve only if it matches.",
                    fontSize = 18.sp, lineHeight = 26.sp, color = CosmosPalette.secondary)
                FingerprintLines(descriptor, fontSize = 20.sp, modifier = Modifier.align(Alignment.Start))
            }
        }
    }
}

/** Set-up and approval as text over the graphite stage: the status line lives here, with one real D-pad button. */
@Composable
private fun TvTextScreen(status: String, action: TvActionSpec, notice: String?, failed: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(action.enabled) { runCatching { focus.requestFocus() } }
    BoxWithConstraints(Modifier.fillMaxSize().background(GRAPHITE)) {
        Column(Modifier.fillMaxSize().padding(horizontal = maxWidth * .05f, vertical = maxHeight * .05f), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                CosmosWordmark()
                Spacer(Modifier.weight(1f))
                Text(status, fontSize = 15.sp, color = CosmosPalette.secondary, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
            Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.Center, content = content)
            TvAction(action.label, action.onClick, Modifier.focusRequester(focus), action.enabled)
            Text(
                notice ?: "Use the directional pad to move · OK to select · Back to leave",
                fontSize = 15.sp, lineHeight = 21.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                color = if (notice != null && failed) CosmosPalette.error else CosmosPalette.secondary,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}
