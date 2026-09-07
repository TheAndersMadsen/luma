package dk.andersmadsen.cosmos.android.assist

import android.app.KeyguardManager
import android.app.assist.AssistStructure
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import android.util.Log
import android.view.View
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import dk.andersmadsen.cosmos.android.AssistContext
import dk.andersmadsen.cosmos.android.CosmosApplication
import dk.andersmadsen.cosmos.android.MainActivity
import dk.andersmadsen.cosmos.android.NativeSurface
import dk.andersmadsen.cosmos.android.R
import dk.andersmadsen.cosmos.android.ScreenContext
import dk.andersmadsen.cosmos.android.ScreenText
import dk.andersmadsen.cosmos.android.ScreenTextNode
import dk.andersmadsen.cosmos.android.ui.AssistOverlay
import dk.andersmadsen.cosmos.android.ui.AssistOverlayActions
import dk.andersmadsen.cosmos.android.ui.CosmosTheme

/**
 * One opening of the assistant over the current app. The window shows the same
 * kit overlay as [dk.andersmadsen.cosmos.android.AssistActivity]; what this adds is
 * the screen: the system hands over the visible text of the app the owner was in,
 * which becomes a chip the owner can keep or remove before asking. Nothing is
 * read from a locked screen, screenshots are discarded, and no audio is captured.
 */
class CosmosInteractionSession(context: Context) : VoiceInteractionSession(context), LifecycleOwner, SavedStateRegistryOwner {
    private val registry = LifecycleRegistry(this)
    private val savedState = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = registry
    override val savedStateRegistry: SavedStateRegistry get() = savedState.savedStateRegistry
    private val controller get() = (context.applicationContext as CosmosApplication).controller
    private val assist = mutableStateOf<AssistContext>(AssistContext.Pending)
    /** Counts openings so each show starts with a fresh draft and destination. */
    private val opening = mutableIntStateOf(0)
    private val main = Handler(Looper.getMainLooper())
    private val settle = Runnable { if (assist.value == AssistContext.Pending) assist.value = AssistContext.Unavailable }

    init { setTheme(R.style.Theme_Cosmos_Overlay) }

    override fun onCreate() {
        super.onCreate()
        savedState.performRestore(null)
        registry.currentState = Lifecycle.State.CREATED
    }

    override fun onCreateContentView(): View = ComposeView(context).apply {
        setViewTreeLifecycleOwner(this@CosmosInteractionSession)
        setViewTreeSavedStateRegistryOwner(this@CosmosInteractionSession)
        val actions = AssistOverlayActions(
            send = { text, target, screen -> controller.send(text, target, screen) },
            removeContext = { assist.value = AssistContext.Removed },
            chooseAssistant = { open(AssistantRole.intent(context)) },
            openCosmos = { open(Intent(context, MainActivity::class.java)); hide() },
            dismiss = ::hide,
            committed = controller::displayCommitted,
        )
        setContent {
            CosmosTheme {
                val state by controller.state.collectAsStateWithLifecycle()
                key(opening.intValue) { AssistOverlay(state, assist.value, actions) }
            }
        }
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        opening.intValue += 1
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        assist.value = when {
            keyguard?.isKeyguardLocked == true -> AssistContext.Locked
            showFlags and SHOW_WITH_ASSIST == 0 -> AssistContext.Unavailable
            else -> AssistContext.Pending
        }
        main.removeCallbacks(settle)
        if (assist.value == AssistContext.Pending) main.postDelayed(settle, 2_000)
        registry.currentState = Lifecycle.State.RESUMED
        controller.setVisible(true)
    }

    /** The first window's structure names the app and carries the text; later windows are ignored. */
    override fun onHandleAssist(state: AssistState) {
        if (assist.value != AssistContext.Pending) return
        val structure = state.assistStructure
        val packageName = state.assistData?.getString(Intent.EXTRA_ASSIST_PACKAGE) ?: structure?.activityComponent?.packageName
        val text = structure?.let { ScreenText.extract(it.textNodes()) }.orEmpty()
        if (packageName.isNullOrEmpty() || text.isEmpty()) {
            assist.value = AssistContext.Unavailable
            return
        }
        Log.d(TAG, "assist text from $packageName: ${text.toByteArray().size} bytes")
        assist.value = AssistContext.Attached(ScreenContext(appLabel(packageName), packageName, text))
    }

    /** The system may still take one when its own setting asks; it is dropped here unread. */
    override fun onHandleScreenshot(screenshot: Bitmap?) {}

    override fun onHide() {
        main.removeCallbacks(settle)
        controller.setVisible(false)
        assist.value = AssistContext.Pending
        registry.currentState = Lifecycle.State.CREATED
        super.onHide()
    }

    override fun onDestroy() {
        registry.currentState = Lifecycle.State.DESTROYED
        super.onDestroy()
    }

    override fun onBackPressed() { hide() }

    private fun open(intent: Intent) {
        try { startAssistantActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (error: ActivityNotFoundException) { Log.w(TAG, "assistant activity unavailable", error) }
        catch (error: SecurityException) { Log.w(TAG, "assistant activity refused", error) }
    }

    private fun appLabel(packageName: String): String {
        val manager = context.packageManager
        val label = try { manager.getApplicationLabel(manager.getApplicationInfo(packageName, 0)).toString().trim() }
        catch (_: PackageManager.NameNotFoundException) { packageName }
        return ScreenText.truncateUtf8(label.ifEmpty { packageName }, NativeSurface.MAX_APP_BYTES)
    }

    companion object {
        private const val TAG = "Cosmos"
        /** Enough for any real screen; a runaway hierarchy stops here. */
        private const val MAX_NODES = 4_000

        /** Every text-bearing node in structure order, marked visible and password so the pure extraction can decide. */
        fun AssistStructure.textNodes(): List<ScreenTextNode> {
            val nodes = ArrayList<ScreenTextNode>()
            for (index in 0 until windowNodeCount) collect(getWindowNodeAt(index).rootViewNode, true, nodes)
            return nodes
        }

        private fun collect(node: AssistStructure.ViewNode, parentVisible: Boolean, into: MutableList<ScreenTextNode>) {
            if (into.size >= MAX_NODES) return
            val visible = parentVisible && node.visibility == View.VISIBLE
            val password = node.isAssistBlocked || ScreenText.isPasswordInput(node.inputType)
                || node.autofillHints?.any { it == View.AUTOFILL_HINT_PASSWORD } == true
            node.text?.let { into.add(ScreenTextNode(it.toString(), password, visible)) }
            for (index in 0 until node.childCount) collect(node.getChildAt(index), visible, into)
        }
    }
}
