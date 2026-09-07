package dk.andersmadsen.cosmos.android

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dk.andersmadsen.cosmos.android.assist.AssistantRole
import dk.andersmadsen.cosmos.android.ui.AssistOverlay
import dk.andersmadsen.cosmos.android.ui.AssistOverlayActions
import dk.andersmadsen.cosmos.android.ui.CosmosTheme
import dk.andersmadsen.cosmos.android.ui.TvVoiceInput

/**
 * The assistant opening over the current app. On a phone that is the compact
 * panel; it never receives the screen, so it says so and offers the role.
 *
 * On a television it is not a panel at all. Asking there is speaking, and the
 * answer belongs over whatever is playing rather than on a screen the owner
 * has to switch to, so this activity draws nothing: it opens the television's
 * own voice input, which listens behind the system's own indicator, hands the
 * words to Cosmos and gets out of the way. The band over the picture then
 * carries the question, and the reply arrives as a subtitle on it.
 */
class AssistActivity : ComponentActivity() {
    private val controller get() = (application as CosmosApplication).controller
    private val television get() = controller.platform == "android_tv"
    private val speak = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        TvVoiceInput.heard(result.resultCode, result.data)?.let(controller::ask)
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (television) {
            ask()
            return
        }
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

    /**
     * Nothing is captured here: the words come from the television's own voice
     * input. A television that publishes none cannot be spoken to at all, and
     * then this opens Cosmos's own screen, which says where to ask instead.
     */
    private fun ask() {
        // Debug builds only: the words the television's own voice input would have
        // returned, so the frames over a running player can be driven from a
        // workstation without speaking. Release builds ignore the extra.
        val heard = if (BuildConfig.DEBUG) intent?.getStringExtra(ASK_EXTRA) else null
        if (heard != null) {
            controller.ask(heard)
            finish()
            return
        }
        try {
            speak.launch(TvVoiceInput.intent(getString(R.string.tv_voice_prompt)))
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }
    }

    private fun selectAssistant() {
        try { startActivity(AssistantRole.intent(this)) }
        catch (_: ActivityNotFoundException) { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
        catch (_: SecurityException) { startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)) }
    }

    // Only the panel is a screen of Cosmos's own. The television's asking draws
    // nothing, so it reports nothing in front: the window over the player is
    // already this installation's answer to whether it can show a reply.
    override fun onResume() { super.onResume(); if (!television) controller.setVisible(true) }
    override fun onPause() { if (!television) controller.setVisible(false); super.onPause() }

    companion object {
        /** Debug builds only: `--es cosmos.ask "…"` stands in for what the remote heard. */
        const val ASK_EXTRA = "cosmos.ask"
    }
}
