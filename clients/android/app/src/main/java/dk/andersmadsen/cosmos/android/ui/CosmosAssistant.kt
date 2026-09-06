package dk.andersmadsen.cosmos.android.ui

import android.view.View
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.SessionStatus
import kotlin.math.PI
import kotlin.math.sin

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
}

/** Mobile Material shaped by the kit tokens; the TV layout has its own TV Material theme. */
@Composable
fun CosmosTheme(content: @Composable () -> Unit) {
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

/** Connection status as one calm chip; a polite live region announces changes without stealing focus. */
@Composable
fun StatusPill(status: SessionStatus, modifier: Modifier = Modifier, fontSize: TextUnit = 13.sp) {
    val tint = when (status) {
        SessionStatus.CONNECTED -> CosmosPalette.success
        SessionStatus.RECONNECTING -> CosmosPalette.glow
        SessionStatus.DISCONNECTED -> CosmosPalette.secondary
    }
    Row(
        modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
            .background(CosmosPalette.surface, CircleShape).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(8.dp).background(tint, CircleShape))
        BasicText(status.label, style = TextStyle(color = CosmosPalette.primary, fontSize = fontSize, fontWeight = FontWeight.Medium, fontFamily = FontFamily.SansSerif))
    }
}

/** Bottom nebula texture from the owner's Android kit; static, never animated. */
@Composable
fun CosmosNebula(modifier: Modifier = Modifier) {
    Image(
        painter = painterResource(R.drawable.cosmos_nebula_bottom),
        contentDescription = null,
        contentScale = ContentScale.FillBounds,
        modifier = modifier.fillMaxWidth().height(240.dp),
    )
}

/** The response panel is a real NinePatch so the glow and corners survive resizing. */
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

@Composable
fun CosmosMessage(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text, color = CosmosPalette.text, fontSize = 18.sp, lineHeight = 23.sp,
        fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.SansSerif, textAlign = TextAlign.Center,
        modifier = modifier.fillMaxWidth(),
    )
}

/** Seven ellipses; a dismissal target with an accessible label. Decorative only while thinking. */
@Composable
fun CosmosWaveformButton(state: AssistantState, onDismiss: () -> Unit, animationsEnabled: Boolean, modifier: Modifier = Modifier) {
    val label = stringResource(R.string.close_assistant)
    Box(
        modifier = modifier.size(64.dp).semantics { contentDescription = label }
            .clickable(role = Role.Button, onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        CosmosWaveform(state, Modifier.size(48.dp).clearAndSetSemantics {}, animationsEnabled)
    }
}

/** Seven bars in the state's colour, or in [color] where a surface fixes it (white on the TV band). */
@Composable
fun CosmosWaveform(state: AssistantState, modifier: Modifier = Modifier, animationsEnabled: Boolean = true, color: Color? = null) {
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
