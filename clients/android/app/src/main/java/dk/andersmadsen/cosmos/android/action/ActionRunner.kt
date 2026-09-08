package dk.andersmadsen.cosmos.android.action

import android.app.NotificationManager
import android.app.SearchManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.provider.MediaStore
import android.util.Log

/**
 * The platform half of a device action: the intents this device sends, and the
 * two things it can honestly observe — that an application took the screen,
 * and, on a television with the owner's notification-listener grant, that a
 * media session is playing.
 *
 * Every decision lives in the pure files beside this one. Nothing here builds
 * a command from a string: an intent carries values the runtime minted and
 * the delivered [DevicePolicy] re-verified, and nothing else.
 */
class ActionRunner(private val application: Context, val platform: String) {
    /** The application that would handle this, or null when nothing here would. */
    fun resolve(plan: PlannedAction): String? {
        val intent = intent(plan) ?: return null
        val resolved = runCatching {
            application.packageManager.resolveActivity(intent, 0)?.activityInfo?.packageName
        }.getOrNull()
        // The system resolver activity is a chooser, not a handler.
        return resolved?.takeUnless { it == "android" || it.isEmpty() }
    }

    /** Start it. False means nothing on this device would take it. */
    fun start(plan: PlannedAction): Boolean {
        val intent = intent(plan) ?: return false
        return runCatching {
            application.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        }.getOrElse { error ->
            Log.w(TAG, "the device could not start ${plan::class.simpleName}", error)
            false
        }
    }

    /**
     * The exact intent for a plan the local policy already approved. Navigation
     * falls back to a plain geographic pin when no navigation application takes
     * the first one; both carry the same runtime-minted coordinates.
     */
    private fun intent(plan: PlannedAction): Intent? = when (plan) {
        is PlannedAction.OpenLink -> Intent(Intent.ACTION_VIEW, Uri.parse(plan.url))
            .addCategory(Intent.CATEGORY_BROWSABLE)
        is PlannedAction.OpenApp -> runCatching {
            application.packageManager.getLaunchIntentForPackage(plan.id)
        }.getOrNull()
        is PlannedAction.Navigate -> {
            val navigation = Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=${plan.lat},${plan.lng}&mode=d"))
            val resolved = runCatching {
                application.packageManager.resolveActivity(navigation, 0)?.activityInfo?.packageName
            }.getOrNull()
            if (resolved != null && resolved != "android") navigation
            else Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode("${plan.lat},${plan.lng}(${plan.name})")))
        }
        is PlannedAction.Play -> playIntent(plan)
    }

    private fun playIntent(plan: PlannedAction.Play): Intent? {
        val manager = application.packageManager
        return MediaProviders.packages(plan.provider).firstNotNullOfOrNull { name ->
            val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
                .putExtra(SearchManager.QUERY, plan.query)
                .setPackage(name)
            runCatching { manager.resolveActivity(intent, 0) }.getOrNull()?.let { intent }
        }
    }

    /**
     * Whether the owner has given this installation the notification-listener
     * access that makes playback observable at all. Without it this device
     * cannot see a media session, and the honest report is always unknown.
     */
    fun listenerGranted(): Boolean = runCatching {
        application.getSystemService(NotificationManager::class.java)
            .isNotificationListenerAccessGranted(ComponentName(application, PlaybackListenerService::class.java))
    }.getOrDefault(false)

    /**
     * What a media session says right now: the item's title, whether it is
     * playing or still buffering, and the position. [preferred] is the package
     * this device asked, so another application's music is not read as an
     * answer to this command.
     */
    fun playback(preferred: String?): ActionOutcome.Playback? {
        if (preferred.isNullOrEmpty() || !listenerGranted()) return null
        val sessions = runCatching {
            application.getSystemService(MediaSessionManager::class.java)
                .getActiveSessions(ComponentName(application, PlaybackListenerService::class.java))
        }.getOrElse { error ->
            Log.w(TAG, "media sessions could not be read", error)
            return null
        }
        val controller = ActionOutcome.uniqueSession(sessions, preferred) { it.packageName }
            ?: return null
        val state = controller.playbackState ?: return null
        val title = controller.metadata?.getString(MediaMetadata.METADATA_KEY_TITLE)
            ?: controller.metadata?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
            ?: return null
        val playback = when (state.state) {
            PlaybackState.STATE_PLAYING -> dk.andersmadsen.cosmos.android.action.PlaybackState.PLAYING
            PlaybackState.STATE_BUFFERING, PlaybackState.STATE_CONNECTING ->
                dk.andersmadsen.cosmos.android.action.PlaybackState.BUFFERING
            else -> return null
        }
        return ActionOutcome.Playback(title, playback, state.position.coerceAtLeast(0))
    }

    companion object { private const val TAG = "Cosmos" }
}
