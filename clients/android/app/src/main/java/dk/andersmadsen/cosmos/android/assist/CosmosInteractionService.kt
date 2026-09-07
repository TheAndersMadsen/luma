package dk.andersmadsen.cosmos.android.assist

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/**
 * The assistant role's entry point. It starts no hotword detection and holds no
 * state; every invocation becomes one [CosmosInteractionSession].
 */
class CosmosInteractionService : VoiceInteractionService()

class CosmosSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = CosmosInteractionSession(this)
}

/**
 * The role requires a recognition service to be named. This one never opens the
 * microphone: every request is refused at once, so the app can honestly say it
 * captures no audio.
 */
class CosmosRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback) { listener.error(SpeechRecognizer.ERROR_CLIENT) }
    override fun onCancel(listener: Callback) {}
    override fun onStopListening(listener: Callback) {}
}

object AssistantRole {
    /** The system's role request while it is available and not yet held, otherwise its assistant settings. */
    fun intent(context: Context): Intent {
        val manager = context.getSystemService(RoleManager::class.java)
        if (manager != null && manager.isRoleAvailable(RoleManager.ROLE_ASSISTANT) && !manager.isRoleHeld(RoleManager.ROLE_ASSISTANT)) {
            return manager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)
        }
        return Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
    }
}
