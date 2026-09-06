package dk.andersmadsen.cosmos.android

import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dk.andersmadsen.cosmos.android.ui.AssistantState
import dk.andersmadsen.cosmos.android.ui.CosmosPalette
import dk.andersmadsen.cosmos.android.ui.CosmosWaveform
import dk.andersmadsen.cosmos.android.ui.DisplayCardView

class MainActivity : ComponentActivity() {
    private val controller get() = (application as CosmosApplication).controller
    private val roleRequest = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = CosmosPalette.text)) {
                val state by controller.state.collectAsStateWithLifecycle()
                var server by rememberSaveable { mutableStateOf(state.serverOrigin) }
                var draft by rememberSaveable { mutableStateOf("") }
                Surface(Modifier.fillMaxSize(), color = CosmosPalette.background) {
                    Column(Modifier.safeDrawingPadding().fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Cosmos", fontSize = 26.sp, color = CosmosPalette.text)
                        Text(statusText(state), color = CosmosPalette.secondary)
                        state.display?.let { card ->
                            DisplayCardView(card, onCommitted = controller::displayCommitted,
                                Modifier.fillMaxWidth().heightIn(max = 360.dp))
                        }
                        OutlinedTextField(server, { server = it }, label = { Text("HTTPS server address") },
                            singleLine = true, modifier = Modifier.fillMaxWidth(), enabled = state.canPrepare)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { controller.prepare(server) }, enabled = state.canPrepare) { Text("Prepare") }
                            Button(onClick = { controller.connect() }, enabled = state.canConnect) {
                                Text(if (state.pendingOpen) "Reconnect" else "Connect")
                            }
                            OutlinedButton(onClick = { controller.disconnect() }, enabled = state.canDisconnect) { Text("Disconnect") }
                        }
                        state.descriptor?.let { descriptor ->
                            Text("Public installation descriptor", color = CosmosPalette.secondary, fontSize = 12.sp)
                            Text(descriptor.json(), color = CosmosPalette.text, fontSize = 12.sp)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = { copy(descriptor.json()) }) { Text("Copy descriptor") }
                                OutlinedButton(onClick = { share(descriptor.json()) }) { Text("Share…") }
                            }
                            Text("In Center, approve this installation under Native installations. Compare the fingerprint before confirming.",
                                color = CosmosPalette.secondary, fontSize = 12.sp)
                        }
                        OutlinedTextField(draft, { draft = it.take(4000) }, label = { Text("Ask Cosmos (public text)") },
                            minLines = 2, modifier = Modifier.fillMaxWidth(), enabled = state.canSend)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { controller.send(draft); draft = "" }, enabled = state.canSend && draft.isNotBlank()) { Text("Send") }
                            OutlinedButton(onClick = { controller.cancel() }, enabled = state.canCancel) { Text("Cancel request") }
                            if (state.canRetry) OutlinedButton(onClick = { controller.retryPending() }) { Text("Retry pending") }
                        }
                        Text(state.message, color = CosmosPalette.text)
                        Spacer(Modifier.width(1.dp))
                        OutlinedButton(onClick = { selectAssistant() }, modifier = Modifier.fillMaxWidth()) { Text("Choose Cosmos as default assistant") }
                        Text("This surface is public text and one shared card while the app is in the foreground. No microphone, no private memories, no device actions.",
                            color = CosmosPalette.secondary, fontSize = 12.sp)
                        CosmosWaveform(if (state.busy) AssistantState.THINKING else AssistantState.IDLE, Modifier.fillMaxWidth().heightIn(48.dp))
                    }
                }
            }
        }
    }

    override fun onResume() { super.onResume(); controller.setVisible(true) }
    override fun onPause() { controller.setVisible(false); super.onPause() }

    private fun statusText(state: SurfaceState): String = when (state.phase) {
        Phase.DISCONNECTED -> "Disconnected"
        Phase.PREPARING -> "Opening installation identity…"
        Phase.PREPARED -> "Installation prepared. Center approval is required."
        Phase.CONNECTING -> "Connecting to Cosmos…"
        Phase.CONNECTED -> if (state.visible) "Connected · visible shared display" else "Connected for public text"
        Phase.BLOCKED -> "Connection stopped. Resolve the reported error before continuing."
    }

    private fun copy(text: String) {
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Cosmos descriptor", text))
    }

    private fun share(text: String) {
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_TEXT, text), "Share public descriptor"))
    }

    private fun selectAssistant() {
        val manager = getSystemService(RoleManager::class.java)
        if (manager != null && manager.isRoleAvailable(RoleManager.ROLE_ASSISTANT) && !manager.isRoleHeld(RoleManager.ROLE_ASSISTANT)) {
            try { roleRequest.launch(manager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)); return }
            catch (_: ActivityNotFoundException) { } catch (_: SecurityException) { }
        }
        try { startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)) }
        catch (_: ActivityNotFoundException) { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
    }
}
