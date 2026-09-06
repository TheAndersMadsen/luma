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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import dk.andersmadsen.cosmos.android.R
import kotlin.math.PI
import kotlin.math.sin

/** UI states only. Changing state starts no microphone or speech engine. */
enum class AssistantState { IDLE, THINKING, ERROR }

object CosmosPalette {
    val text = Color(0xFF58F4F1)
    val glow = Color(0xFF27E6DF)
    val background = Color(0xFF090B0C)
    val secondary = Color(0xFFA4B7BE)
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

@Composable
fun CosmosWaveform(state: AssistantState, modifier: Modifier = Modifier, animationsEnabled: Boolean = true) {
    val active = animationsEnabled && state == AssistantState.THINKING
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
    val color = if (state == AssistantState.THINKING) CosmosPalette.text else Color.White
    Canvas(modifier) {
        val width = size.width * .066f
        val step = size.width * .11f
        profile.forEachIndexed { index, peak ->
            val wave = .5f + .5f * sin(phase + index * .7f)
            val gain = if (active) .28f + .32f * wave else 1f
            val height = (size.height * .84f * peak * gain).coerceAtLeast(width)
            val x = size.width / 2f + (index - 3) * step - width / 2f
            drawOval(color, Offset(x, (size.height - height) / 2f), Size(width, height))
        }
    }
}
