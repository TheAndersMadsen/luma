package dk.andersmadsen.cosmos.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dk.andersmadsen.cosmos.android.ui.AssistantState
import dk.andersmadsen.cosmos.android.ui.CosmosNebula
import dk.andersmadsen.cosmos.android.ui.CosmosPalette
import dk.andersmadsen.cosmos.android.ui.CosmosPanel
import dk.andersmadsen.cosmos.android.ui.CosmosMessage
import dk.andersmadsen.cosmos.android.ui.CosmosWaveformButton
import dk.andersmadsen.cosmos.android.ui.DisplayCardView

/**
 * The compact on-demand panel over the current app (ACTION_ASSIST). It is a
 * translucent activity, not a VoiceInteractionSession: no audio, no reading of
 * the foreground app. While it is on screen the installation reports visible.
 */
class AssistActivity : ComponentActivity() {
    private val controller get() = (application as CosmosApplication).controller

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = CosmosPalette.text)) {
                val state by controller.state.collectAsStateWithLifecycle()
                var draft by rememberSaveable { mutableStateOf("") }
                BackHandler { finish() }
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val maxCardHeight = (maxHeight - 200.dp).coerceAtLeast(96.dp)
                    CosmosNebula(Modifier.align(Alignment.BottomCenter))
                    Column(
                        modifier = Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing)
                            .widthIn(max = 424.dp).fillMaxWidth().padding(horizontal = 22.dp, vertical = 4.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        val card = state.display
                        val speech = state.speech
                        if (card != null) {
                            DisplayCardView(card, onCommitted = controller::displayCommitted,
                                Modifier.fillMaxWidth().heightIn(max = maxCardHeight))
                        } else if (speech != null) {
                            CosmosPanel(Modifier.fillMaxWidth()) { CosmosMessage(speech.text) }
                        } else if (state.phase != Phase.CONNECTED) {
                            CosmosPanel(Modifier.fillMaxWidth()) { CosmosMessage("Open Cosmos and connect this installation first.") }
                        } else {
                            CosmosPanel(Modifier.fillMaxWidth()) { CosmosMessage(state.message) }
                        }
                        if (state.phase == Phase.CONNECTED) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(draft, { draft = it.take(4000) }, placeholder = { Text("Ask Cosmos", fontSize = 14.sp) },
                                    singleLine = true, modifier = Modifier.weight(1f), enabled = state.canSend)
                                Button(onClick = { controller.send(draft); draft = "" }, enabled = state.canSend && draft.isNotBlank()) { Text("Send") }
                            }
                        }
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            CosmosWaveformButton(when { state.speaking -> AssistantState.SPEAKING; state.busy -> AssistantState.THINKING; else -> AssistantState.IDLE },
                                onDismiss = { finish() }, animationsEnabled = true)
                        }
                    }
                }
            }
        }
    }

    override fun onResume() { super.onResume(); controller.setVisible(true) }
    override fun onPause() { controller.setVisible(false); super.onPause() }
}
