package dk.andersmadsen.cosmos.android

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dk.andersmadsen.cosmos.android.assist.AssistantRole
import dk.andersmadsen.cosmos.android.ui.CosmosTheme
import dk.andersmadsen.cosmos.android.ui.CosmosTvTheme
import dk.andersmadsen.cosmos.android.ui.PhoneScreen
import dk.andersmadsen.cosmos.android.ui.SurfaceActions
import dk.andersmadsen.cosmos.android.ui.TvScreen

/**
 * One activity for the Pixel and the Shield. Leanback devices get the TV layout;
 * a debug build also honours the `cosmos.layout=tv` extra so the TV layout can be
 * checked on a phone. Intents, the clipboard, roles and permissions live here;
 * the screens themselves only see [SurfaceState] and [SurfaceActions].
 */
class MainActivity : ComponentActivity() {
    private val controller get() = (application as CosmosApplication).controller
    private val roleRequest = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { }
    private val notificationRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    /** Set by Approve in Center: the next resume tries to connect once and the screen offers Try again. */
    private val approvalRequested = mutableStateOf(false)
    private var connectOnResume = false
    private var notificationsAsked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val actions = SurfaceActions(
            prepare = controller::prepare, connect = { controller.connect() }, disconnect = { controller.disconnect() },
            send = { text, target -> controller.send(text, target) }, cancel = { controller.cancel() }, retry = { controller.retryPending() },
            approve = ::approve, copy = ::copy, share = ::share, chooseAssistant = ::selectAssistant,
            committed = controller::displayCommitted,
            cancelTask = { controller.cancelTask() }, closeTask = controller::closeTask,
            answerCeremony = controller::answerCeremony,
            ask = controller::ask, dismissReply = controller::dismissReply,
        )
        val tv = tvLayout()
        setContent {
            val state by controller.state.collectAsStateWithLifecycle()
            LaunchedEffect(state.connectionWanted) { if (state.connectionWanted) requestNotifications() }
            LaunchedEffect(state.screen()) { if (state.screen() != Screen.APPROVE) approvalRequested.value = false }
            if (tv) CosmosTvTheme {
                // The same stage the window over other apps draws, so a question spoken
                // at the remote reads the same whichever screen the owner is looking at.
                val stage by controller.tvStage.collectAsStateWithLifecycle()
                TvScreen(state, stage, approvalRequested.value, actions)
            } else CosmosTheme { PhoneScreen(state, approvalRequested.value, actions) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (BuildConfig.DEBUG && intent.hasExtra(LAYOUT_EXTRA)) {
            setIntent(intent)
            recreate()
        }
    }

    override fun onResume() {
        super.onResume()
        controller.setVisible(true)
        if (connectOnResume) {
            connectOnResume = false
            if (controller.state.value.canConnect) controller.connect()
        }
    }

    override fun onPause() { controller.setVisible(false); super.onPause() }

    private fun tvLayout(): Boolean =
        controller.platform == "android_tv" || (BuildConfig.DEBUG && intent.getStringExtra(LAYOUT_EXTRA) == "tv")

    /** The session notification needs the runtime permission on Android 13+; asked once per process. */
    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT < 33 || notificationsAsked) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        notificationsAsked = true
        notificationRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun approve(url: String) {
        approvalRequested.value = true
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            connectOnResume = true
        } catch (_: ActivityNotFoundException) {
            copy(url)
        }
    }

    private fun copy(text: String) {
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Cosmos descriptor", text))
    }

    private fun share(text: String) {
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_TEXT, text), "Share public descriptor"))
    }

    private fun selectAssistant() {
        try { roleRequest.launch(AssistantRole.intent(this)); return }
        catch (_: ActivityNotFoundException) { } catch (_: SecurityException) { }
        try { startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)) }
        catch (_: ActivityNotFoundException) { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
    }

    companion object {
        /** Debug builds only: `--es cosmos.layout tv` renders the Shield layout on a phone. */
        const val LAYOUT_EXTRA = "cosmos.layout"
    }
}
