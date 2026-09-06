package dk.andersmadsen.cosmos.android

import android.content.Intent
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dk.andersmadsen.cosmos.android.ui.AskBar
import dk.andersmadsen.cosmos.android.ui.CosmosMessage
import dk.andersmadsen.cosmos.android.ui.CosmosNebula
import dk.andersmadsen.cosmos.android.ui.CosmosPanel
import dk.andersmadsen.cosmos.android.ui.CosmosTheme
import dk.andersmadsen.cosmos.android.ui.CosmosWaveformButton
import dk.andersmadsen.cosmos.android.ui.DisplayCardView
import dk.andersmadsen.cosmos.android.ui.StatusPill

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
            CosmosTheme {
                val state by controller.state.collectAsStateWithLifecycle()
                var draft by rememberSaveable { mutableStateOf("") }
                BackHandler { finish() }
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    // Long cards scroll inside the panel; the pill, ask row and waveform keep their room.
                    val maxCardHeight = (maxHeight - 236.dp).coerceAtLeast(96.dp)
                    CosmosNebula(Modifier.align(Alignment.BottomCenter))
                    Column(
                        modifier = Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.safeDrawing)
                            .widthIn(max = 424.dp).fillMaxWidth().padding(horizontal = 22.dp, vertical = 4.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { StatusPill(state.sessionStatus()) }
                        val card = state.display
                        val speech = state.speech
                        val status = state.sessionStatus()
                        when {
                            card != null -> DisplayCardView(card, onCommitted = controller::displayCommitted,
                                Modifier.fillMaxWidth().heightIn(max = maxCardHeight))
                            speech != null -> CosmosPanel(Modifier.fillMaxWidth().heightIn(max = maxCardHeight)) {
                                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) { CosmosMessage(speech.text) }
                            }
                            status == SessionStatus.RECONNECTING -> CosmosPanel(Modifier.fillMaxWidth()) { CosmosMessage("Rejoining the Cosmos room…") }
                            state.phase != Phase.CONNECTED -> CosmosPanel(Modifier.fillMaxWidth()) { CosmosMessage("Open Cosmos and connect this phone first.") }
                            else -> CosmosPanel(Modifier.fillMaxWidth().heightIn(max = maxCardHeight)) {
                                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                                    CosmosMessage(state.notice() ?: "Shared answers and spoken replies for this phone appear here.")
                                }
                            }
                        }
                        if (state.phase == Phase.CONNECTED) {
                            AskBar(draft, { draft = it }, enabled = state.canSend, onSend = { controller.send(draft); draft = "" })
                        } else if (status == SessionStatus.DISCONNECTED) {
                            TextButton({ startActivity(Intent(this@AssistActivity, MainActivity::class.java)); finish() }) { Text("Open Cosmos") }
                        }
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            CosmosWaveformButton(state.assistantState(), onDismiss = { finish() }, animationsEnabled = true)
                        }
                    }
                }
            }
        }
    }

    override fun onResume() { super.onResume(); controller.setVisible(true) }
    override fun onPause() { controller.setVisible(false); super.onPause() }
}
