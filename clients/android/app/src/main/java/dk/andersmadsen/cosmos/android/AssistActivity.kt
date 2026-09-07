package dk.andersmadsen.cosmos.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dk.andersmadsen.cosmos.android.assist.AssistantRole
import dk.andersmadsen.cosmos.android.ui.AssistOverlay
import dk.andersmadsen.cosmos.android.ui.AssistOverlayActions
import dk.andersmadsen.cosmos.android.ui.CosmosTheme

/**
 * The compact panel over the current app when the assistant role reaches an
 * activity (ACTION_ASSIST) rather than the voice session. It never receives the
 * screen, so it says so and offers the role; while it is on screen the
 * installation reports visible.
 */
class AssistActivity : ComponentActivity() {
    private val controller get() = (application as CosmosApplication).controller

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Left to the system so the window resizes for the keyboard, exactly as the
        // voice session's window does; the sheet then needs no IME inset of its own.
        val actions = AssistOverlayActions(
            send = { text, target, _ -> controller.send(text, target) },
            removeContext = {},
            chooseAssistant = ::selectAssistant,
            openCosmos = { startActivity(Intent(this, MainActivity::class.java)); finish() },
            dismiss = ::finish,
            committed = controller::displayCommitted,
        )
        setContent {
            CosmosTheme {
                val state by controller.state.collectAsStateWithLifecycle()
                BackHandler { finish() }
                AssistOverlay(state, AssistContext.NoRole, actions)
            }
        }
    }

    private fun selectAssistant() {
        try { startActivity(AssistantRole.intent(this)) }
        catch (_: ActivityNotFoundException) { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
        catch (_: SecurityException) { startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)) }
    }

    override fun onResume() { super.onResume(); controller.setVisible(true) }
    override fun onPause() { controller.setVisible(false); super.onPause() }
}
