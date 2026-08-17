package com.penumbraos.hook

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * Revives the Tickle prototype launcher so its cards open the REAL stock Humane
 * experiences, the same way the stock systemnavigation launcher does
 * (`Intent.makeMainActivity(component)` + `startActivity`, see
 * humane.experience.systemnavigation.ActivityManager).
 *
 * The stock HomeController scroller (HomeController.createView) adds 8 cards
 * through the single ScrollView.addItem(View, Runnable) path:
 * - two StackView cards first (Clock with DateTimeView children, Weather with
 *   WeatherView children) whose stock Runnable only cycles nextCard(), then
 * - NavigateCards: "settings", "listen" (Tickle-internal mockups), "message",
 *   "call", "capture" (null stubs), and "r*ck".
 *
 * We replace the tap handler (2nd arg to ScrollView.addItem) for the NavigateCards
 * we own so each launches the corresponding stock experience/app. The Clock and
 * Weather StackView cards keep their stock cycling behavior (see below) — real
 * data is supplied by TickleRealDataHooks, not by relaunching another surface.
 * - "listen"   -> stock Music experience    (confirmed ComponentName)
 * - "settings" -> stock Settings experience  (confirmed ComponentName)
 * - "message"  -> stock Messages experience  (humane.experience.messages; was
 *                 pointed at the AOSP com.android.mms app — present but a
 *                 touchscreen UI, wrong for the laser Pin)
 * - "call"/"capture" -> generic system-resolved dialer/camera intents (kept)
 *
 * StackView cards are identified by their first child view class (DateTimeView
 * vs WeatherView), which HomeController populates before calling addItem. Card
 * selection is gesture + projector driven, so the launches require physical
 * on-device verification (ADB cannot synthesize the hand/laser selection).
 */

/** What stock target a Tickle home NavigateCard opens, decided by its label. */
internal sealed interface TickleCardTarget {
    /** Open a stock Humane experience by package name (via HumaneExperienceActivity). */
    data class Experience(val packageName: String) : TickleCardTarget

    /** Open a generic, system-resolved action with no fixed package. */
    data class SystemAction(val kind: String) : TickleCardTarget

    /** Not owned by the hook; leave the stock behavior in place. */
    object Stock : TickleCardTarget
}

/**
 * Map a NavigateCard label to the target the hook should open.
 *
 * Pure and Android-free so the hook module's plain-JUnit tests can pin it. The
 * invariant it guards: "message" opens the Humane messages EXPERIENCE, never the
 * AOSP `com.android.mms` package (device-confirmed present on the Pin, but its
 * touchscreen ConversationList UI is wrong for the laser projector).
 * "call"/"capture" stay generic system-resolved intents because the Pin resolves
 * those to its dialer/camera; only the labels listed here are owned.
 */
internal fun resolveTickleCardTarget(label: String): TickleCardTarget = when (label) {
    "listen" -> TickleCardTarget.Experience(StockSymbols.Music.PACKAGE)
    "settings" -> TickleCardTarget.Experience(StockSymbols.Settings.PACKAGE)
    "message" -> TickleCardTarget.Experience(StockSymbols.Messages.PACKAGE)
    "call" -> TickleCardTarget.SystemAction("dial")
    "capture" -> TickleCardTarget.SystemAction("camera")
    else -> TickleCardTarget.Stock
}

object TickleLauncherHooks {
    private const val TAG = "PenumbraHook"

    // Stock experiences expose an exported MAIN+LAUNCHER activity at this class.
    // Registry: humaneinternal.experience.HumanePackageManager (pkg + "/" + activity).
    private const val EXPERIENCE_ACTIVITY =
        StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY
    private val MUSIC = ComponentName(StockSymbols.Music.PACKAGE, EXPERIENCE_ACTIVITY)
    private val SETTINGS = ComponentName(
        StockSymbols.Settings.PACKAGE,
        StockSymbols.Settings.SETTINGS_EXPERIENCE_CLASS,
    )
    // The Pin's messaging surface is the stock Humane messages EXPERIENCE, which
    // exposes the same HumaneExperienceActivity entry point as music/clock (device
    // -confirmed: humane.experience.messages/...HumaneExperienceActivity resolves
    // for ACTION_MAIN). The card previously targeted the AOSP `com.android.mms`
    // package. That package IS present and launchable on the Pin
    // (com.android.mms.ui.ConversationList), so the tap opened the raw AOSP MMS
    // app — a touchscreen phone UI, wrong for the screenless laser projector and
    // inconsistent with every other card, which opens its Humane experience.
    // Route to the Pin-native messaging experience instead.
    private val MESSAGES = ComponentName(StockSymbols.Messages.PACKAGE, EXPERIENCE_ACTIVITY)

    private fun launchExperience(context: Context, target: ComponentName, label: String) {
        try {
            val intent = Intent.makeMainActivity(target)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            Log.i(TAG, "  TickleLauncherHooks: launched $label -> ${target.packageName}")
        } catch (e: Throwable) {
            Log.e(TAG, "  TickleLauncherHooks: failed to launch $label", e)
        }
    }

    private fun launchGeneric(context: Context, intent: Intent, label: String) {
        try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            Log.i(TAG, "  TickleLauncherHooks: launched $label (generic)")
        } catch (e: Throwable) {
            Log.e(TAG, "  TickleLauncherHooks: failed to launch $label", e)
        }
    }

    @Volatile
    private var installed = false
    @Volatile
    private var onCreateHooked = false

    private const val MAX_SCROLLVIEW_ATTEMPTS = 60
    private const val SCROLLVIEW_RETRY_MS = 250L
    private val retryHandler = Handler(Looper.getMainLooper())

    fun install(classLoader: ClassLoader) {
        // The factory calls this from AppComponentFactory.instantiateApplication,
        // which runs before the Tickle UI dex resolves — so ScrollView is not yet
        // loadable and hooking it here silently no-ops (the live defect that left
        // the launcher cards, including the message card, running stock). Defer to
        // ExperienceApplication.onCreate and install the ScrollView hook from the
        // running app's own classloader, which has the UI classes.
        if (onCreateHooked || installed) return
        try {
            val appClass =
                classLoader.loadClass(StockSymbols.ExperienceRuntime.EXPERIENCE_APPLICATION_CLASS)
            HookUtils.hookMethodAfter(appClass, "onCreate", emptyArray()) { param ->
                val application = param.thisObject as? android.app.Application
                installScrollViewHook(application?.classLoader ?: classLoader, attempt = 0)
            }
            onCreateHooked = true
        } catch (e: Throwable) {
            Log.e(TAG, "  TickleLauncherHooks: failed to hook onCreate", e)
        }
    }

    private fun installScrollViewHook(classLoader: ClassLoader, attempt: Int) {
        if (installed) return
        val scrollViewClass = try {
            classLoader.loadClass("humane.experience.tickle.ui.scroller.ScrollView")
        } catch (_: ClassNotFoundException) {
            // Not the Tickle process, or the UI dex has not resolved yet. Retry a
            // bounded number of times; the home renders many seconds after
            // onCreate (behind gesture PIN entry), so this lands in time.
            if (attempt < MAX_SCROLLVIEW_ATTEMPTS) {
                retryHandler.postDelayed(
                    { installScrollViewHook(classLoader, attempt + 1) },
                    SCROLLVIEW_RETRY_MS,
                )
            }
            return
        }
        try {
            val addItemMethod = scrollViewClass.getMethod(
                "addItem",
                classLoader.loadClass("humane.ui.View"),
                Runnable::class.java,
            )

            XposedBridge.hookMethod(addItemMethod, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        val view = param.args[0] ?: return

                        // Context from the ScrollView's TickleView superclass.
                        val scrollView = param.thisObject
                        val contextField =
                            scrollView.javaClass.superclass.getDeclaredField("mContext")
                        contextField.isAccessible = true
                        val context = contextField.get(scrollView) as? Context ?: return

                        // Clock/Weather are StackView cards whose stock Runnable
                        // cycles nextCard() (page through the three cities). Leave
                        // that stock behavior in place.
                        //
                        // A previous version repointed the WEATHER card at the
                        // systemnavigation home ring (there is no standalone weather
                        // experience). That yanks the user out of Tickle to the home
                        // on a tap — which reads as a crash — so it is removed. The
                        // clock override is dropped with it for consistency: the
                        // cards page their real data, and card LAUNCHING stays the
                        // job of the NavigateCards below (settings/listen/message/…).
                        if (view.javaClass.name.endsWith(".stack.StackView")) {
                            return
                        }

                        if (!view.javaClass.name.contains("NavigateCard")) return

                        val labelField = view.javaClass.getDeclaredField("mLabel")
                        labelField.isAccessible = true
                        val label = labelField.get(view) as? String ?: return

                        // Replace the tap handler for cards we own. This overrides
                        // the Tickle-internal mockups for settings/listen, opens the
                        // stock messages experience for "message", and fills the
                        // null stubs for call/capture. `resolveTickleCardTarget`
                        // owns the label->target decision and is unit-tested.
                        val handler: Runnable? = when (val target = resolveTickleCardTarget(label)) {
                            is TickleCardTarget.Experience -> when (target.packageName) {
                                StockSymbols.Music.PACKAGE ->
                                    Runnable { launchExperience(context, MUSIC, label) }
                                StockSymbols.Settings.PACKAGE ->
                                    Runnable { launchExperience(context, SETTINGS, label) }
                                StockSymbols.Messages.PACKAGE ->
                                    Runnable { launchExperience(context, MESSAGES, label) }
                                else -> null
                            }
                            is TickleCardTarget.SystemAction -> when (target.kind) {
                                "dial" -> Runnable {
                                    launchGeneric(context, Intent(Intent.ACTION_DIAL), label)
                                }
                                "camera" -> Runnable {
                                    launchGeneric(
                                        context,
                                        Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA),
                                        label,
                                    )
                                }
                                else -> null
                            }
                            TickleCardTarget.Stock -> null
                        }
                        if (handler != null) {
                            param.args[1] = handler
                        }
                    } catch (e: Throwable) {
                        Log.e(TAG, "  TickleLauncherHooks: addItem hook failed", e)
                    }
                }
            })

            installed = true
            Log.i(TAG, "  TickleLauncherHooks installed (Tickle process)")
        } catch (e: Throwable) {
            Log.e(TAG, "  TickleLauncherHooks: failed to install", e)
        }
    }
}
