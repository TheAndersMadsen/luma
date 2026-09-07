package dk.andersmadsen.cosmos.android

import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Display
import android.view.View
import android.view.WindowManager
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import dk.andersmadsen.cosmos.android.ui.CosmosTvOverlay
import dk.andersmadsen.cosmos.android.ui.CosmosTvTheme
import dk.andersmadsen.cosmos.android.ui.LocalReducedMotion

/**
 * The assistant over whatever the room is already watching. A television is not
 * an app the owner switches to, so Cosmos does not wait on a screen of its own
 * here: it puts one window above every other application and lays the band or
 * the subtitle onto the picture that is already playing.
 *
 * The window is the owner's grant and nothing else: without "display over other
 * apps" it never goes up, and Cosmos says so on its own screen. While it is up
 * it is inert — no touch, no focus, no key — so the remote reaches the player
 * exactly as it did before. The one exception is a set of options, which is a
 * question to the room and needs the D-pad to answer; that frame, and only that
 * frame, takes focus for as long as it stands.
 *
 * Its other job is the honest answer to whether this screen can show anything:
 * the window being up on a lit display is what Cosmos waits for before handing a
 * reply over, so a dark screen or a refused grant reports nothing in front and
 * the reply is held rather than lost.
 */
class TvOverlayWindow(context: Context) : LifecycleOwner, SavedStateRegistryOwner {
    private val application = context.applicationContext
    private val controller = (application as CosmosApplication).controller
    private val windows = application.getSystemService(WindowManager::class.java)
    private val displays = application.getSystemService(DisplayManager::class.java)
    private val registry = LifecycleRegistry(this)
    private val savedState = SavedStateRegistryController.create(this)
    private val main = Handler(Looper.getMainLooper())
    override val lifecycle: Lifecycle get() = registry
    override val savedStateRegistry: SavedStateRegistry get() = savedState.savedStateRegistry
    private var view: View? = null
    /** Whether the window is currently laid out to take the remote; only a change touches it. */
    private var takingKeys = false

    private val display = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = refresh()
        override fun onDisplayRemoved(displayId: Int) = refresh()
        override fun onDisplayChanged(displayId: Int) {
            if (displayId == Display.DEFAULT_DISPLAY) refresh()
        }
    }

    /** Puts the window up if the owner allowed one, and follows the display from then on. */
    fun open() {
        savedState.performRestore(null)
        registry.currentState = Lifecycle.State.CREATED
        displays?.registerDisplayListener(display, main)
        refresh()
    }

    fun close() {
        displays?.unregisterDisplayListener(display)
        detach()
        registry.currentState = Lifecycle.State.DESTROYED
        controller.setOverlay(TvOverlay.DETACHED, displayOn())
    }

    /**
     * The window follows the display and the grant: up while the screen is on
     * and the owner allows it, down otherwise. The grant is read again every
     * time rather than remembered, because the owner may give it at any moment
     * and this is the only thing that notices.
     */
    fun refresh() {
        val on = displayOn()
        if (!Settings.canDrawOverlays(application)) {
            detach()
            Log.d(TAG, "window over other apps: NOT_ALLOWED, display on=$on")
            controller.setOverlay(TvOverlay.NOT_ALLOWED, on)
            return
        }
        if (on) attach() else detach()
        val overlay = if (view != null) TvOverlay.ATTACHED else TvOverlay.DETACHED
        Log.d(TAG, "window over other apps: $overlay, display on=$on")
        controller.setOverlay(overlay, on)
    }

    private fun attach() {
        if (view != null) return
        val content = ComposeView(application).apply {
            setViewTreeLifecycleOwner(this@TvOverlayWindow)
            setViewTreeSavedStateRegistryOwner(this@TvOverlayWindow)
            setContent {
                CosmosTvTheme {
                    val stage by controller.tvStage.collectAsStateWithLifecycle()
                    // Cosmos's own screen draws the same stage with its true inset;
                    // the window over it draws nothing so nothing is shown twice.
                    val ownScreen by controller.appForeground.collectAsStateWithLifecycle()
                    val frame = stage.overlayFrame(ownScreen)
                    LaunchedEffect(frame.takesKeys) { relayout(frame) }
                    CosmosTvOverlay(
                        stage, frame, reducedMotion = LocalReducedMotion.current,
                        onCommitted = controller::displayCommitted,
                        onChoose = controller::ask, onDismiss = controller::dismissReply,
                    )
                }
            }
        }
        runCatching { windows.addView(content, params(takesKeys = false)) }
            .onSuccess {
                view = content
                takingKeys = false
                registry.currentState = Lifecycle.State.RESUMED
            }
            .onFailure { error -> Log.w(TAG, "the window over other apps was refused", error) }
    }

    private fun detach() {
        val current = view ?: return
        view = null
        registry.currentState = Lifecycle.State.CREATED
        runCatching { windows.removeView(current) }
            .onFailure { error -> Log.w(TAG, "the window over other apps could not be taken down", error) }
    }

    /** Gives the window the remote for the one frame that needs it, and takes it back after. */
    private fun relayout(frame: TvOverlayFrame) {
        val current = view ?: return
        if (takingKeys == frame.takesKeys) return
        takingKeys = frame.takesKeys
        runCatching { windows.updateViewLayout(current, params(frame.takesKeys)) }
            .onFailure { error -> Log.w(TAG, "the window over other apps could not be re-laid", error) }
    }

    /**
     * A full-screen window above every application, so the band and the subtitle
     * land exactly where the stage's own geometry puts them. Not focusable and
     * not touchable is what keeps every key of the remote going to the player;
     * the options frame drops both for as long as it stands.
     */
    private fun params(takesKeys: Boolean): WindowManager.LayoutParams {
        val inert = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            (if (takesKeys) WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL else inert) or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
    }

    private fun displayOn(): Boolean =
        displays?.getDisplay(Display.DEFAULT_DISPLAY)?.state == Display.STATE_ON

    private companion object {
        const val TAG = "Cosmos"
    }
}
