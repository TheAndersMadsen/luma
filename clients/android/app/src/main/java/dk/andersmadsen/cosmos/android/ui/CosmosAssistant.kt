package dk.andersmadsen.cosmos.android.ui

import android.animation.ValueAnimator
import android.view.View
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dk.andersmadsen.cosmos.android.Presence
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.Tone
import kotlin.math.PI
import kotlin.math.sin
import kotlinx.coroutines.delay

/** UI states only. Changing state starts no microphone or speech engine; SPEAKING mirrors delivered playback. */
enum class AssistantState { IDLE, THINKING, SPEAKING, ERROR }

/** Kit tokens: the phone kit's response colours plus the TV kit's chrome, shared by both layouts. */
object CosmosPalette {
    val text = Color(0xFF58F4F1)
    val glow = Color(0xFF27E6DF)
    val background = Color(0xFF090B0C)
    val secondary = Color(0xFFA4B7BE)
    val surface = Color(0xFF111B20)
    val primary = Color(0xFFF2F7F8)
    val border = Color(0xFF33464D)
    val error = Color(0xFFFFAC9C)
    val success = Color(0xFF88E4BE)
    val tvBackground = Color(0xFF080E12)

    /** The sheet's own ground over another app: the kit surface, solid, so nothing reads through it. */
    val sheet = Color(0xFF111B20)
    /** The app behind the sheet, dimmed enough that the sheet is plainly in front of it. */
    val scrim = Color(0xE6000000)
    /** A card inset into the sheet: a step darker than the ground, with a quiet edge. */
    val card = Color(0xFF0A1013)
    val cardBorder = Color(0xFF22333A)
}

/** True when the owner turned system animations off; every transition then cuts instead of moving. */
val LocalReducedMotion = staticCompositionLocalOf { false }

/** 150–250 ms ease-out for everything that moves, and no time at all under reduced motion. */
@Composable
fun <T> calmly(durationMillis: Int = 200): FiniteAnimationSpec<T> =
    if (LocalReducedMotion.current) snap() else tween(durationMillis, easing = FastOutSlowInEasing)

/** Reads Settings.Global.ANIMATOR_DURATION_SCALE; a scale of zero means animators are off. */
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) { !ValueAnimator.areAnimatorsEnabled() }
}

/** Mobile Material shaped by the kit tokens; the TV layout has its own TV Material theme. */
@Composable
fun CosmosTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalReducedMotion provides rememberReducedMotion()) {
        CosmosMaterial(content)
    }
}

@Composable
private fun CosmosMaterial(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(
        primary = CosmosPalette.glow, onPrimary = CosmosPalette.background,
        secondary = CosmosPalette.secondary, onSecondary = CosmosPalette.background,
        background = CosmosPalette.background, onBackground = CosmosPalette.primary,
        surface = CosmosPalette.background, onSurface = CosmosPalette.primary,
        surfaceVariant = CosmosPalette.surface, onSurfaceVariant = CosmosPalette.secondary,
        surfaceContainer = CosmosPalette.surface, surfaceContainerHigh = CosmosPalette.surface,
        outline = CosmosPalette.border, outlineVariant = CosmosPalette.border,
        error = CosmosPalette.error, onError = CosmosPalette.background,
    ), content = content)
}

/** Crescent and wordmark, the same on both layouts. */
@Composable
fun CosmosWordmark(modifier: Modifier = Modifier, iconSize: Dp = 40.dp, fontSize: TextUnit = 25.sp) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(R.drawable.ic_cosmos), contentDescription = null, modifier = Modifier.size(iconSize))
        Spacer(Modifier.width(12.dp))
        BasicText("Cosmos", style = TextStyle(color = CosmosPalette.primary, fontSize = fontSize, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.SansSerif))
    }
}

/**
 * The one status line: a coloured dot, the state word, and a plain sentence under
 * it when there is one. It is the only place presence is reported, so nothing
 * floats over the app behind. A settled line fades to quiet presence after a
 * moment rather than sitting lit; TalkBack hears the word change politely.
 */
@Composable
fun PresenceLine(presence: Presence, modifier: Modifier = Modifier) {
    val tint = when (presence.tone) {
        Tone.LIVE -> CosmosPalette.success
        Tone.ACTIVE -> CosmosPalette.glow
        Tone.DONE -> CosmosPalette.success
        Tone.QUIET -> CosmosPalette.secondary
    }
    var quiet by remember { mutableStateOf(false) }
    LaunchedEffect(presence.line, presence.settled) {
        quiet = false
        if (presence.settled) { delay(2_400); quiet = true }
    }
    val fade by animateFloatAsState(if (quiet) .55f else 1f, calmly(400), label = "presence-fade")
    Column(
        modifier.fillMaxWidth().heightIn(min = 24.dp).alpha(fade)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Box(Modifier.size(7.dp).background(tint, CircleShape))
            Text(presence.line, color = CosmosPalette.primary, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        }
        presence.detail?.let { Text(it, color = CosmosPalette.secondary, fontSize = 13.sp, lineHeight = 18.sp) }
    }
}

/**
 * Bottom nebula texture from the owner's Android kit; static, never animated, and
 * only under a welcome or empty state. [dim] fades it behind the words on it.
 */
@Composable
fun CosmosNebula(modifier: Modifier = Modifier, height: Dp = 240.dp, dim: Float = 1f) {
    Image(
        painter = painterResource(R.drawable.cosmos_nebula_bottom),
        contentDescription = null,
        contentScale = ContentScale.FillBounds,
        alpha = dim,
        modifier = modifier.fillMaxWidth().height(height),
    )
}

/**
 * The same texture as a horizon inside a sheet: the glow at the top of an empty
 * state, faded into the ground beneath it so nothing is ever read through it.
 */
@Composable
fun CosmosHorizon(modifier: Modifier = Modifier, height: Dp = 76.dp) {
    val ground = CosmosPalette.sheet
    Box(modifier.fillMaxWidth().height(height).clipToBounds()) {
        CosmosNebula(Modifier.align(Alignment.BottomCenter), height = height * 2, dim = .4f)
        // Faded on all four sides so the texture is ambient light, never a pasted shape.
        Box(Modifier.matchParentSize().background(Brush.verticalGradient(listOf(ground, Color.Transparent, ground))))
        Box(Modifier.matchParentSize().background(Brush.horizontalGradient(
            0f to ground, .3f to Color.Transparent, .7f to Color.Transparent, 1f to ground,
        )))
    }
}

/**
 * The kit's glowing NinePatch panel. It is the one cyan-lit surface left, kept for
 * the pairing code, where the glow marks the one thing to look at during set-up.
 */
@Composable
fun CosmosPanel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier) {
        AndroidView(
            factory = { context ->
                View(context).apply {
                    background = context.getDrawable(R.drawable.cosmos_panel)
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                }
            },
            modifier = Modifier.matchParentSize(),
        )
        Box(Modifier.fillMaxWidth().padding(28.dp)) { content() }
    }
}

/** Where replies live: graphite, one quiet edge, no glow. Reading, not decoration. */
@Composable
fun CosmosCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier.background(CosmosPalette.card, RoundedCornerShape(20.dp))
            .border(1.dp, CosmosPalette.cardBorder, RoundedCornerShape(20.dp))
            .padding(horizontal = 18.dp, vertical = 16.dp),
        content = content,
    )
}

/** Body text a person actually reads: near-white on graphite, comfortable line height, selectable. */
@Composable
fun CosmosMessage(text: String, modifier: Modifier = Modifier) {
    SelectionContainer(modifier.fillMaxWidth()) {
        Text(
            text = text, color = CosmosPalette.primary, fontSize = 17.sp, lineHeight = 24.sp,
            fontFamily = FontFamily.SansSerif, modifier = Modifier.fillMaxWidth().widthIn(max = 560.dp),
        )
    }
}

/** The grab bar at the top of the sheet: drag it down or tap it to close. */
@Composable
fun CosmosDragHandle(onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.close_assistant)
    val hint = stringResource(R.string.close_assistant_hint)
    Box(
        modifier.fillMaxWidth().height(40.dp)
            .clickable(remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onDismiss)
            .semantics { contentDescription = "$label. $hint" },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(width = 36.dp, height = 4.dp).background(CosmosPalette.secondary.copy(alpha = .45f), CircleShape))
    }
}

/** Seven bars in the state's colour, or in [color] where a surface fixes it (white on the TV band). */
@Composable
fun CosmosWaveform(state: AssistantState, modifier: Modifier = Modifier, animationsEnabled: Boolean = !LocalReducedMotion.current, color: Color? = null) {
    val active = animationsEnabled && state in setOf(AssistantState.THINKING, AssistantState.SPEAKING)
    val phase = if (active) {
        val transition = rememberInfiniteTransition(label = "cosmos-waveform")
        val value by transition.animateFloat(
            initialValue = 0f, targetValue = (PI * 2).toFloat(),
            animationSpec = infiniteRepeatable(tween(1200, easing = LinearEasing), RepeatMode.Restart),
            label = "wave-phase",
        )
        value
    } else 0f
    val profile = remember { floatArrayOf(.22f, .56f, .83f, 1f, .83f, .56f, .22f) }
    val tint = color ?: when (state) {
        AssistantState.THINKING, AssistantState.SPEAKING -> CosmosPalette.text
        AssistantState.ERROR -> CosmosPalette.error
        AssistantState.IDLE -> Color.White
    }
    Canvas(modifier) {
        val width = size.width * .066f
        val step = size.width * .11f
        profile.forEachIndexed { index, peak ->
            val wave = .5f + .5f * sin(phase + index * .7f)
            val gain = if (active) .28f + .32f * wave else 1f
            val height = (size.height * .84f * peak * gain).coerceAtLeast(width)
            val x = size.width / 2f + (index - 3) * step - width / 2f
            drawOval(tint, Offset(x, (size.height - height) / 2f), Size(width, height))
        }
    }
}
