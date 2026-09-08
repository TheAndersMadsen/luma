package dk.andersmadsen.cosmos.android.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
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
import dk.andersmadsen.cosmos.android.Choice
import dk.andersmadsen.cosmos.android.DisplayCard
import dk.andersmadsen.cosmos.android.captionCommitted
import dk.andersmadsen.cosmos.android.Phase
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.Screen
import dk.andersmadsen.cosmos.android.SessionStatus
import dk.andersmadsen.cosmos.android.SurfaceState
import dk.andersmadsen.cosmos.android.TV_TYPED_IN_CENTER
import dk.andersmadsen.cosmos.android.TvControl
import dk.andersmadsen.cosmos.android.TvOverlayFrame
import dk.andersmadsen.cosmos.android.TvStage
import dk.andersmadsen.cosmos.android.notice
import dk.andersmadsen.cosmos.android.pageRanges
import dk.andersmadsen.cosmos.android.screen
import dk.andersmadsen.cosmos.android.serverLabel
import dk.andersmadsen.cosmos.android.sessionStatus
import dk.andersmadsen.cosmos.android.taskCard
import dk.andersmadsen.cosmos.android.tvControl
import dk.andersmadsen.cosmos.android.tvNotice
import dk.andersmadsen.cosmos.android.tvStage
import dk.andersmadsen.cosmos.android.action.DevicePolicy
import kotlinx.coroutines.delay
import kotlin.random.Random

/** TV Material shaped by the TV kit's tokens; never mixed with the phone's mobile Material tree. */
@Composable
fun CosmosTvTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalReducedMotion provides rememberReducedMotion()) { CosmosTvMaterial(content) }
}

@Composable
private fun CosmosTvMaterial(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(
        primary = CosmosPalette.glow, onPrimary = CosmosPalette.tvBackground,
        surface = CosmosPalette.surface, onSurface = CosmosPalette.primary,
        background = CosmosPalette.tvBackground, onBackground = CosmosPalette.primary,
    ), content = content)
}

private val BODY = TextStyle(color = CosmosPalette.text, fontSize = 24.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium, fontFamily = FontFamily.SansSerif)

/** The owner's frames: the question in one pale line, the reply caption in light mint under a soft shadow. */
private val TRANSCRIPT = Color(0xFFCDE9FF)
private val CAPTION = Color(0xFF9FE8C8)
private val CAPTION_SHADOW = Shadow(Color.Black.copy(alpha = .8f), Offset(0f, 3f), blurRadius = 12f)

/** The band's own light, read off the owner's frames: a blue cloud, not the kit's cyan. */
private val NEBULA = Color(0xFF3AA8E6)
private val GRAPHITE = Brush.verticalGradient(listOf(Color(0xFF161B1F), Color(0xFF0B0F12)))

/** Options drawn over a player: dark enough to read against, thin enough to keep the picture. */
private val SCRIM = Brush.verticalGradient(listOf(Color(0xD9080E12), Color(0xF2080E12)))

/** Stage geometry as fractions of the screen height so 1080p and a phone agree: a 12% band, a 40 px corner radius at 1080p. */
private const val BAND = .12f
private const val INSET_TOP = .05f
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
fun TvScreen(state: SurfaceState, stage: TvStage, approvalRequested: Boolean, actions: SurfaceActions) {
    when (state.screen()) {
        Screen.SETUP -> TvSetupScreen(state, actions)
        Screen.APPROVE -> TvApproveScreen(state, approvalRequested, actions)
        Screen.SESSION -> TvSession(state, stage, actions)
    }
}

/**
 * Cosmos's own screen on the television: the same stage the window over other
 * apps draws, with the paged view and the reply sent away with Back, which only
 * exist where the remote has somewhere to land. The stage itself is owned by the
 * controller, because a question spoken at the remote must reach both drawings.
 */
@Composable
private fun TvSession(state: SurfaceState, stage: TvStage, actions: SurfaceActions) {
    var reading by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(stage) { if (stage !is TvStage.Answer) reading = false }
    val askLabel = stringResource(R.string.tv_ask)
    val retryLabel = stringResource(R.string.retry)
    val connectLabel = stringResource(R.string.connect)
    val cancelLabel = stringResource(R.string.cancel_request)
    val prompt = stringResource(R.string.tv_voice_prompt)
    // The television's own voice input, resolved once: it is the only microphone
    // an app reaches here, and without it this screen cannot be asked anything.
    val context = LocalContext.current
    val voiceInput = remember(context) { TvVoiceInput.available(context) }
    val speak = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        TvVoiceInput.heard(result.resultCode, result.data)?.let(actions.ask)
    }
    // The elapsed line of a running command comes from a clock, not a state.
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.task?.actionId, state.taskReport) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    // This television never explains a refusal, so it has no card for one.
    val task = state.taskCard(now, DevicePolicy.TV)
    val action = when (state.tvControl(taskRunning = task?.canCancel == true, voiceInput = voiceInput)) {
        TvControl.RETRY -> TvStageAction(retryLabel, actions.retry)
        TvControl.CANCEL -> TvStageAction(cancelLabel, actions.cancelTask)
        TvControl.CONNECT -> TvStageAction(connectLabel, actions.connect)
        // Nothing is captured here: pressing hands the request to the television's
        // own voice input, which listens behind its own indicator and returns words.
        TvControl.ASK -> TvStageAction(askLabel) { runCatching { speak.launch(TvVoiceInput.intent(prompt)) } }
        TvControl.NONE -> TvStageAction(askLabel) { }
    }
    // A television shows the answer, the question band and nothing else; whatever is
    // left to say is one word or one sentence, and the rule for that lives in tvNotice.
    val notice = state.tvNotice(now, voiceInput)
    // Back closes the paged view, then sends the current reply or transcript away.
    BackHandler(enabled = reading) { reading = false }
    BackHandler(enabled = !reading && stage !is TvStage.Idle, onBack = actions.dismissReply)
    // Back closes the card. It is not Cancel task, which is the corner action.
    BackHandler(enabled = task != null && !reading, onBack = actions.closeTask)
    if (reading && stage is TvStage.Answer) {
        TvAnswerPages(stage, actions.committed)
        return
    }
    CosmosTvStage(
        stage = stage, action = action, notice = notice, reducedMotion = LocalReducedMotion.current,
        onMore = { reading = true }, onCommitted = actions.committed,
        content = { focus, out ->
            // Choosing sends the title with no target: Cosmos decides where that reply goes.
            if (stage is TvStage.Choices) TvChoices(stage, focus, out, enabled = state.canSend, onCommitted = actions.committed, onChoose = actions.ask)
            else TvReadyContent()
        },
    )
}

/**
 * The same stage over someone else's picture, in a window that draws over other
 * applications. One thing from the owner's frames cannot cross over: no app may
 * scale another app's video, so the picture is never inset here. The band
 * arrives over the untouched picture instead, lying across its lowest eighth,
 * and the true inset stays for Cosmos's own screen. The answer needs nothing:
 * a mint subtitle over a full-screen picture is already exactly the frame.
 *
 * Nothing else is ever drawn — no notice, no mark, no control, no way to read
 * on — because over a room's television the reply is the whole of it.
 */
@Composable
fun CosmosTvOverlay(
    stage: TvStage, frame: TvOverlayFrame, reducedMotion: Boolean,
    onCommitted: (DisplayCard) -> Unit, onChoose: (String) -> Unit, onDismiss: () -> Unit,
) {
    if (frame == TvOverlayFrame.NONE) return
    val contentFocus = remember { FocusRequester() }
    BoxWithConstraints(
        Modifier.fillMaxSize()
            // While the options hold the remote, Back sends them away and gives it
            // straight back to the player. No other frame sees a key at all.
            .onKeyEvent { event ->
                if (frame.takesKeys && event.type == KeyEventType.KeyUp && event.key == Key.Back) {
                    onDismiss()
                    true
                } else {
                    false
                }
            },
    ) {
        val fullWidth = maxWidth
        val fullHeight = maxHeight
        val safeX = fullWidth * .05f
        val safeY = fullHeight * .05f
        val bandFont = (fullHeight.value * .036f).sp
        if (frame.band) {
            TvBand(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(fullHeight * BAND)) {
                Box(Modifier.padding(horizontal = safeX), contentAlignment = Alignment.Center) {
                    when {
                        stage is TvStage.Transcript -> BasicText(
                            stage.request, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = TextStyle(color = TRANSCRIPT, fontSize = bandFont, lineHeight = bandFont * 1.25f, fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center),
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
                        stage is TvStage.Working -> CosmosWaveform(AssistantState.THINKING, Modifier.size(fullHeight * .085f, fullHeight * .074f), !reducedMotion, Color.White)
                    }
                }
            }
        }
        // The subtitle, and nothing under it: reading on needs a key this window
        // does not take, and the whole answer stays on Cosmos's own screen.
        if (stage is TvStage.Answer) {
            var measured by remember(stage.id) { mutableStateOf(false) }
            var overflowed by remember(stage.id) { mutableStateOf(true) }
            TvSubtitle(stage.caption, (fullHeight.value * .04f).sp,
                Modifier.align(Alignment.BottomCenter).padding(horizontal = safeX, vertical = safeY),
                onLayout = { overflow -> measured = true; overflowed = overflow })
            val card = stage.captionCommitted(measured, overflowed)
            if (card != null) LaunchedEffect(card.actionId) { onCommitted(card) }
        }
        // The one frame that genuinely needs the remote, so the window takes focus for
        // it. The options sit over the picture rather than in place of it: what the
        // room was watching stays visible behind them, and there is nothing below
        // them to move down to.
        if (stage is TvStage.Choices) {
            TvChoices(stage, contentFocus, exitFocus = null, enabled = true,
                onCommitted = onCommitted, onChoose = onChoose, ground = SCRIM)
            LaunchedEffect(stage.id) { runCatching { contentFocus.requestFocus() } }
        }
    }
}

/** The reply as it sits over a picture: mint, bold, centred, two lines at most. */
@Composable
private fun TvSubtitle(caption: String, fontSize: TextUnit, modifier: Modifier, onLayout: (Boolean) -> Unit) {
    BasicText(
        caption, modifier.semantics { liveRegion = LiveRegionMode.Polite },
        maxLines = 2, overflow = TextOverflow.Ellipsis, style = captionStyle(fontSize),
        onTextLayout = { onLayout(it.hasVisualOverflow) },
    )
}

/** The one type a reply is ever set in on this television: mint, bold, centred, under a soft shadow. */
private fun captionStyle(fontSize: TextUnit) = TextStyle(
    color = CAPTION, fontSize = fontSize, lineHeight = fontSize * 1.25f, fontWeight = FontWeight.Bold,
    fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center, shadow = CAPTION_SHADOW,
)

/**
 * The television's own voice input, which is the whole of what a microphone can
 * be on this hardware. The microphone lives in the remote and only the system
 * reaches it: the remote's microphone button is `KEYCODE_ASSIST`, which the
 * framework consumes for the system assistant before any app sees it, and the
 * television declares no audio input device at all, so nothing in this app can
 * open one or record a sample. What is left is the recognizer the television
 * publishes: it listens behind its own full-screen indicator, for as long as
 * the person speaks, and hands back words. Those words are sent to Cosmos as
 * the ordinary public text this installation is already approved to send —
 * never as a Cosmos capture, because no audio was captured here.
 */
object TvVoiceInput {
    fun intent(prompt: String): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        .putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)

    /** Whether this television publishes one at all; the manifest's `queries` makes it visible. */
    fun available(context: Context): Boolean =
        intent("").resolveActivity(context.packageManager) != null

    /** The words, or null when the person said nothing, was not understood, or backed out. */
    fun heard(resultCode: Int, data: Intent?): String? {
        if (resultCode != Activity.RESULT_OK) return null
        return data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()?.trim()?.ifBlank { null }
    }
}

/**
 * The whole TV screen: a content layer (the graphite ready screen until a player takes
 * the slot) and the assistant over it. Working and the transcript shrink the content
 * into a rounded inset above the nebula band; a reply returns it to full screen under
 * a subtitle caption. Text keeps 5% overscan insets; the inset and band reach the edges.
 *
 * Nothing here takes typing. There is no field, no keyboard inset and no software
 * keyboard this screen can raise: the band holds the spoken question or the waveform
 * and nothing else.
 */
@Composable
fun CosmosTvStage(
    stage: TvStage,
    action: TvStageAction,
    notice: String?,
    reducedMotion: Boolean,
    onMore: () -> Unit,
    onCommitted: (DisplayCard) -> Unit,
    content: @Composable (contentFocus: FocusRequester, actionFocus: FocusRequester) -> Unit = { _, _ -> TvReadyContent() },
) {
    val inset = stage is TvStage.Working || stage is TvStage.Transcript
    // Reduced motion cuts between the two framings instead of animating them.
    val progress by animateFloatAsState(if (inset) 1f else 0f, if (reducedMotion) snap() else tween(300), label = "tv-inset")
    val actionFocus = remember { FocusRequester() }
    val contentFocus = remember { FocusRequester() }
    // Nothing on the stage is focusable but a row of choices, so the D-pad only has
    // somewhere to land while one is up. Asking is the remote's microphone, not a control.
    val choosing = stage is TvStage.Choices
    val idle = stage is TvStage.Idle
    LaunchedEffect(choosing, idle) {
        runCatching { if (choosing) contentFocus.requestFocus() else if (idle) actionFocus.requestFocus() }
    }
    val press = remember(action) { action.onClick }
    BoxWithConstraints(
        Modifier.fillMaxSize().background(Color.Black)
            // Nothing is drawn for this. The remote's own keys carry it: the assistant or
            // search key asks, and the centre key does it too while no choice row holds focus.
            .onKeyEvent { event ->
                val ask = event.key == Key.Search || event.key == Key.VoiceAssist
                val centre = !choosing && (event.key == Key.DirectionCenter || event.key == Key.Enter)
                if (event.type == KeyEventType.KeyUp && (ask || centre)) {
                    press()
                    true
                } else {
                    false
                }
            },
    ) {
        // Sizes follow the whole screen; only the content shrinks further when the keyboard takes room.
        val fullWidth = maxWidth
        val fullHeight = maxHeight
        val safeX = fullWidth * .05f
        val safeY = fullHeight * .05f
        val bandHeight = fullHeight * BAND
        val top = fullHeight * INSET_TOP
        val bandFont = (fullHeight.value * .036f).sp
        val density = LocalDensity.current
        val topPx = with(density) { top.toPx() }
        val radiusPx = with(density) { (fullHeight * INSET_RADIUS).toPx() }
        BoxWithConstraints(Modifier.fillMaxSize()) {
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
            }) { content(contentFocus, actionFocus) }
            TvBand(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(bandHeight).graphicsLayer { alpha = progress }) {
                Box(Modifier.padding(horizontal = safeX), contentAlignment = Alignment.Center) {
                    when {
                        stage is TvStage.Transcript -> BasicText(
                            stage.request, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = TextStyle(color = TRANSCRIPT, fontSize = bandFont, lineHeight = bandFont * 1.25f, fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center),
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
                        // The box is twice the tallest bar: the animated bars reach about half of it.
                        stage is TvStage.Working -> CosmosWaveform(AssistantState.THINKING, Modifier.size(fullHeight * .085f, fullHeight * .074f), !reducedMotion, Color.White)
                    }
                }
            }
            // The owner's reference frames carry nothing over the picture: while a question,
            // a waveform or an answer is up, the corner stays empty. Idle is the one framing
            // that may show the mark, because on this television OK is the only way to ask
            // and nothing else says so.
            if (stage is TvStage.Idle && !choosing) {
                TvCrescent(
                    action, fullHeight * .05f, actionFocus, null,
                    Modifier.align(Alignment.BottomEnd).padding(end = safeX, bottom = safeY),
                )
            }
            val captionInset = safeX
            if (stage is TvStage.Answer) {
                TvCaption(stage, (fullHeight.value * .04f).sp, onMore, onCommitted,
                    Modifier.align(Alignment.BottomCenter).padding(start = captionInset, end = captionInset, bottom = safeY))
            } else if (notice != null && !inset && stage !is TvStage.Choices) {
                BasicText(
                    notice, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    style = TextStyle(color = CosmosPalette.secondary, fontSize = (fullHeight.value * .026f).sp, fontFamily = FontFamily.SansSerif,
                        textAlign = TextAlign.Center, shadow = CAPTION_SHADOW),
                    modifier = Modifier.align(Alignment.BottomCenter).padding(start = captionInset, end = captionInset, bottom = safeY)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
    }
}

/**
 * A reply that is a set of options, in the stage's own language: the cards fill the
 * content, and the question and the focused option speak as the mint subtitle the
 * other answers use. OK sends the focused title back as the next request.
 */
@Composable
private fun TvChoices(
    stage: TvStage.Choices, firstFocus: FocusRequester, exitFocus: FocusRequester?, enabled: Boolean,
    onCommitted: (DisplayCard) -> Unit, onChoose: (String) -> Unit, ground: Brush = GRAPHITE,
) {
    var focused by remember(stage.id) { mutableIntStateOf(0) }
    BoxWithConstraints(Modifier.fillMaxSize().background(ground)) {
        val fullHeight = maxHeight
        val safeX = maxWidth * .05f
        val safeY = fullHeight * .05f
        val gap = maxWidth * .014f
        val count = stage.items.size
        val cardWidth = minOf((maxWidth - safeX * 2 - gap * (count - 1)) / count, maxWidth * .16f)
        val cardHeight = cardWidth * 1.5f
        val captionSize = (fullHeight.value * .04f).sp
        val bodySize = (fullHeight.value * .028f).sp
        Column(Modifier.fillMaxSize().padding(horizontal = safeX, vertical = safeY), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
                stage.items.forEachIndexed { index, item ->
                    TvChoiceCard(item, index == focused, cardWidth, cardHeight, bodySize, enabled,
                        Modifier.then(if (index == 0) Modifier.focusRequester(firstFocus) else Modifier)
                            .focusProperties { if (exitFocus != null) down = exitFocus }
                            .onFocusChanged { if (it.isFocused) focused = index }) { onChoose(item.title) }
                }
            }
            Spacer(Modifier.weight(1f))
            // The same subtitle an answer gets: the question, then what the focused option is.
            BasicText(
                stage.title, maxLines = 2, overflow = TextOverflow.Ellipsis,
                style = TextStyle(color = CAPTION, fontSize = captionSize, lineHeight = captionSize * 1.25f, fontWeight = FontWeight.SemiBold,
                    fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center, shadow = CAPTION_SHADOW),
                modifier = Modifier.fillMaxWidth(.8f),
            )
            BasicText(
                stage.items.getOrNull(focused)?.let { "${it.id}. ${it.title}${if (it.detail.isBlank()) "" else " · ${it.detail}"}" }.orEmpty(),
                maxLines = 2, overflow = TextOverflow.Ellipsis,
                style = TextStyle(color = CosmosPalette.primary.copy(alpha = .85f), fontSize = bodySize, lineHeight = bodySize * 1.3f,
                    fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center, shadow = CAPTION_SHADOW),
                modifier = Modifier.fillMaxWidth(.8f).padding(top = 8.dp).heightIn(min = bodySize.value.dp * 1.3f * 2)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
    LaunchedEffect(stage.id) { onCommitted(stage.card) }
}

/** One option: number, crescent and title; focus lifts it 8% inside a glow ring and brightens the title. */
@Composable
private fun TvChoiceCard(item: Choice, focused: Boolean, width: Dp, height: Dp, fontSize: TextUnit, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val scale by animateFloatAsState(if (focused) 1.08f else 1f, tween(150), label = "tv-choice")
    Box(
        modifier.size(width, height).graphicsLayer { scaleX = scale; scaleY = scale }
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, enabled = enabled, onClick = onClick)
            .semantics { contentDescription = "${item.id}. ${item.title}" }
            .background(if (focused) Color(0xFF16262C) else CosmosPalette.surface, RoundedCornerShape(width * .08f))
            .border(if (focused) 3.dp else 1.dp, if (focused) CosmosPalette.glow else CosmosPalette.border, RoundedCornerShape(width * .08f)),
    ) {
        BasicText(item.id, Modifier.align(Alignment.TopStart).padding(width * .08f),
            style = TextStyle(color = if (focused) CosmosPalette.glow else CosmosPalette.secondary, fontSize = fontSize, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.SansSerif))
        Image(painterResource(R.drawable.ic_cosmos), contentDescription = null, modifier = Modifier.align(Alignment.Center).size(width * .42f).alpha(if (focused) 1f else .7f))
        BasicText(
            item.title, Modifier.align(Alignment.BottomCenter).padding(horizontal = width * .08f, vertical = width * .1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
            style = TextStyle(color = if (focused) Color.White else CosmosPalette.primary.copy(alpha = .85f), fontSize = fontSize, lineHeight = fontSize * 1.2f,
                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center),
        )
    }
}

/** The graphite ready screen with the crescent mark: the stage's own content until a player takes the slot. */
@Composable
fun TvReadyContent(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(GRAPHITE), contentAlignment = Alignment.Center) {
        Image(painterResource(R.drawable.ic_cosmos), contentDescription = null, modifier = Modifier.fillMaxHeight(.24f).aspectRatio(1f), alpha = .92f)
    }
}

/**
 * The black band: a blue cloud brightest in the middle, fading to black long
 * before either end, with a few dozen static specks of light in it and one
 * centred thing. The kit's nebula supplies the wisps inside that cloud — laid
 * across the whole band, tinted from the kit's cyan to the owner's blue, and
 * faded out at both ends so the band never shows an edge of its own.
 */
@Composable
private fun TvBand(modifier: Modifier, centre: @Composable BoxScope.() -> Unit) {
    val sparkles = remember {
        val seed = Random(20260906)
        List(40) { floatArrayOf(seed.nextFloat(), seed.nextFloat(), .15f + .45f * seed.nextFloat(), .5f + seed.nextFloat()) }
    }
    Box(modifier.background(Color.Black).clipToBounds(), contentAlignment = Alignment.Center) {
        Image(
            // Cropped, not squashed: the nebula keeps its own proportion, so the band
            // shows the wisps across the middle of it rather than a flat colour.
            painterResource(R.drawable.cosmos_nebula_bottom), contentDescription = null, contentScale = ContentScale.Crop,
            alpha = .92f, colorFilter = ColorFilter.tint(NEBULA, BlendMode.Modulate),
            modifier = Modifier.matchParentSize()
                .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                .drawWithContent {
                    drawContent()
                    // A long fade from either end, so the cloud has no edge of its own.
                    drawRect(
                        Brush.horizontalGradient(
                            0f to Color.Transparent, .12f to Color.Transparent, .36f to Color.Black,
                            .64f to Color.Black, .88f to Color.Transparent, 1f to Color.Transparent,
                        ),
                        blendMode = BlendMode.DstIn,
                    )
                },
        )
        Canvas(Modifier.matchParentSize()) {
            // The core of the cloud, and the specks over the whole width.
            val middle = Offset(size.width * .5f, size.height * .55f)
            scale(scaleX = 3.0f, scaleY = 1f, pivot = middle) {
                val radius = size.height * .95f
                drawCircle(Brush.radialGradient(listOf(NEBULA.copy(alpha = .55f), NEBULA.copy(alpha = .16f), Color.Transparent), middle, radius), radius, middle)
            }
            for ((x, y, alpha, radius) in sparkles) drawCircle(Color.White.copy(alpha = alpha), radius * 1.dp.toPx(), Offset(x * size.width, y * size.height))
        }
        centre()
    }
}

/** The reply as a subtitle: two lines at most, and More for the rest in the paged view. */
@Composable
private fun TvCaption(answer: TvStage.Answer, fontSize: TextUnit, onMore: () -> Unit, onCommitted: (DisplayCard) -> Unit, modifier: Modifier) {
    var measured by remember(answer.id) { mutableStateOf(false) }
    var overflowed by remember(answer.id) { mutableStateOf(false) }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        BasicText(
            answer.caption, maxLines = 2, overflow = TextOverflow.Ellipsis, onTextLayout = { measured = true; overflowed = it.hasVisualOverflow },
            style = captionStyle(fontSize), modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (overflowed || answer.full != answer.caption) TvQuietAction(stringResource(R.string.tv_more), onMore, fontSize * .7f)
    }
    // Runs after the composition holding the caption is applied; More keeps the rest reachable.
    val card = answer.captionCommitted(measured, overflowed)
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
private fun TvCrescent(action: TvStageAction, size: Dp, focus: FocusRequester, up: FocusRequester?, modifier: Modifier) {
    var focused by remember { mutableStateOf(false) }
    Box(
        modifier.size(size + 12.dp).focusRequester(focus)
            .focusProperties { if (up != null) this.up = up }
            .onFocusChanged { focused = it.isFocused }
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = action.onClick)
            .semantics { contentDescription = action.label }
            .border(2.dp, if (focused) CosmosPalette.glow.copy(alpha = .75f) else Color.Transparent, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Image(painterResource(R.drawable.ic_cosmos), contentDescription = null, modifier = Modifier.size(size).alpha(if (focused) 1f else .4f))
    }
}

/** The whole answer at full size, one page at a time: left and right page it, Back returns to the stage. */
@Composable
private fun TvAnswerPages(answer: TvStage.Answer, onCommitted: (DisplayCard) -> Unit) {
    val text = answer.full
    var page by rememberSaveable(answer.id, text) { mutableIntStateOf(0) }
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
            androidx.compose.runtime.key(answer.id) {
                TvPagedText(text, page, onPages = { pages = it }, Modifier.weight(1f).fillMaxWidth(),
                    onComplete = { answer.card?.let(onCommitted) })
            }
            if (pages > 1) Text(
                stringResource(R.string.tv_page_of, page + 1, pages),
                fontSize = 15.sp, color = CosmosPalette.secondary, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

/** Full-size body text split into pages of whole lines; the type never shrinks to fit. */
@Composable
private fun TvPagedText(text: String, page: Int, onPages: (Int) -> Unit, modifier: Modifier = Modifier, onComplete: () -> Unit) {
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
        val currentPage = page.coerceIn(0, pageTexts.lastIndex)
        var seen by remember(text, width, height) { mutableStateOf(emptySet<Int>()) }
        var measured by remember(text, width, height, currentPage) { mutableStateOf(false) }
        Text(pageTexts[currentPage], style = BODY, onTextLayout = { measured = !it.hasVisualOverflow })
        LaunchedEffect(text, width, height, currentPage, measured) {
            if (measured) {
                seen = seen + currentPage
                if (seen.size == pageTexts.size) onComplete()
            }
        }
    }
}

@Composable
private fun TvSetupScreen(state: SurfaceState, actions: SurfaceActions) {
    val preparing = state.phase == Phase.PREPARING
    TvTextScreen(
        status = stringResource(if (preparing) R.string.setup_busy else R.string.tv_not_set_up),
        action = TvActionSpec(stringResource(if (preparing) R.string.setup_busy else R.string.tv_setup_action), state.canPrepare) { actions.prepare(state.serverOrigin) },
        notice = state.notice(),
        failed = state.alert || state.phase == Phase.BLOCKED,
    ) {
        Text(stringResource(R.string.tv_setup_title), fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold, color = CosmosPalette.primary)
        Spacer(Modifier.height(14.dp))
        Text(stringResource(R.string.tv_setup_body), fontSize = 18.sp, lineHeight = 26.sp, color = CosmosPalette.secondary)
        Spacer(Modifier.height(14.dp))
        Text(serverLabel(state.serverOrigin), fontSize = 18.sp, color = CosmosPalette.secondary)
        Spacer(Modifier.height(14.dp))
        // The whole of what this television says about typing. The address it uses is
        // the one it was built with, and nothing on this screen asks for a value.
        Text(TV_TYPED_IN_CENTER, fontSize = 18.sp, lineHeight = 26.sp, color = CosmosPalette.secondary)
    }
}

@Composable
private fun TvApproveScreen(state: SurfaceState, approvalRequested: Boolean, actions: SurfaceActions) {
    val descriptor = state.descriptor ?: return
    val url = remember(descriptor, state.serverOrigin) { descriptor.approvalUrl(state.serverOrigin) }
    val failed = state.alert || state.phase == Phase.BLOCKED
    TvTextScreen(
        status = stringResource(R.string.tv_waiting),
        action = TvActionSpec(stringResource(if (approvalRequested || state.alert) R.string.try_again else R.string.connect), state.canConnect, actions.connect),
        notice = when {
            state.busy -> stringResource(R.string.checking_with_center)
            failed -> state.message
            else -> stringResource(R.string.waiting_for_approval)
        },
        failed = failed,
    ) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(36.dp)) {
            QrCodeImage(url, stringResource(R.string.approval_qr), Modifier.fillMaxHeight())
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.tv_approve_title), fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold, color = CosmosPalette.primary)
                Text(stringResource(R.string.tv_approve_body), fontSize = 18.sp, lineHeight = 26.sp, color = CosmosPalette.secondary)
                FingerprintLines(descriptor, fontSize = 20.sp, modifier = Modifier.align(Alignment.Start))
                Text(TV_TYPED_IN_CENTER, fontSize = 18.sp, lineHeight = 26.sp, color = CosmosPalette.secondary)
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
            if (notice != null) Text(
                notice, fontSize = 15.sp, lineHeight = 21.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                color = if (failed) CosmosPalette.error else CosmosPalette.secondary,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}
