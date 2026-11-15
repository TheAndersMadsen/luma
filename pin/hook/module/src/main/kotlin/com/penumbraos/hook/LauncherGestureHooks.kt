package com.penumbraos.hook

import android.app.Activity
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Intent
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import dev.luma.gestures.GestureConfig
import dev.luma.gestures.GestureEngine
import dev.luma.gestures.GestureMode
import dev.luma.gestures.GestureFeatures
import dev.luma.gestures.GestureObservation
import dev.luma.gestures.ClipMotion
import dev.luma.gestures.ClipSnapshot
import dev.luma.gestures.HandFrame
import org.json.JSONObject
import java.util.UUID
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicLong

/**
 * INFERRED: opt-in finger shortcuts in the stock normal launcher. Reuses
 * humaneinternal.system.hats.FlatHandService's callback and registration thread.
 * Stock HandTrackingHandler.handleMessage registers projection callbacks only;
 * its FlatHandCallback.onHandTrackingSummary is empty. Add/remove JUST the summary
 * subscription while Home owns input. Never call triggerStart/Stop or alter HATS,
 * hand-tracking timeouts, projection eligibility, or stock gesture dispatch.
 */
object LauncherGestureHooks {
    private const val TAG = "LumaGestures"
    private const val HOME = "humane.experience.systemnavigation.home.HomeInteractor"
    private const val FLAT_SERVICE = "humaneinternal.system.hats.FlatHandService"
    private const val PROVISIONED = "humane.settings.global.DUC_PROVISIONED"
    private var installed = false

    @Synchronized
    fun install(cl: ClassLoader) {
        if (installed) return
        val hooks = mutableListOf<XC_MethodHook.Unhook>()
        try {
            val adapter = Adapter(cl)
            fun after(type: Class<*>, name: String, parameters: Array<Class<*>> = emptyArray(), block: (XC_MethodHook.MethodHookParam) -> Unit) {
                val method = type.getDeclaredMethod(name, *parameters).apply { isAccessible = true }
                hooks += XposedBridge.hookMethod(method, object : XC_MethodHook() {
                    override fun afterHookedMethod(param: MethodHookParam) {
                        if (param.throwable == null) runCatching { block(param) }
                            .onFailure { adapter.invalidate("callback_failed") }
                    }
                })
            }
            val home = cl.loadClass(HOME)
            after(home, "didBecomeActive") { adapter.home = WeakReference(it.thisObject); adapter.refresh() }
            after(home, "didResignActive") { adapter.home = null; adapter.refresh() }
            val activity = cl.loadClass(StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY)
            after(activity, "onResume") { adapter.resume(it.thisObject as Activity) }
            after(activity, "onPause") { adapter.pause(it.thisObject as Activity) }
            after(activity, "onWindowFocusChanged", arrayOf(Boolean::class.javaPrimitiveType!!)) { adapter.refresh() }

            // Stock HomeView.showDashboard/hideDashboard also run for non-gesture
            // navigation. Observe the actual mode, not just synthetic key events.
            val view = cl.loadClass("humane.experience.systemnavigation.home.HomeView")
            after(view, "showDashboard") { adapter.refresh() }
            after(view, "hideDashboard", arrayOf(Boolean::class.javaPrimitiveType!!)) { adapter.refresh() }

            val callback = cl.loadClass("$FLAT_SERVICE\$FlatHandCallback")
            after(callback, "onHandTrackingSummary", arrayOf(cl.loadClass("humane.handtracking.HandTrackingSummary"))) {
                adapter.summary(it.thisObject, it.args[0])
            }
            after(callback, "onFlatHandProjectionLost") {
                adapter.invalidate(null)
                adapter.main.post { adapter.refresh() }
            }
            after(callback, "onNewFlatHandProjection") { adapter.main.post { adapter.refresh() } }
            after(cl.loadClass(FLAT_SERVICE), "binderDied") { adapter.invalidate("service_lost") }
            after(cl.loadClass("$FLAT_SERVICE\$HandTrackingHandler"), "handleMessage", arrayOf(Message::class.java)) {
                adapter.main.post { adapter.refresh() }
            }
            installed = true
            Log.i(TAG, "Launcher gesture adapter installed; disabled unless configured")
        } catch (error: Throwable) {
            hooks.forEach { it.unhook() }
            Log.w(TAG, "Launcher gesture adapter unavailable (${error.javaClass.simpleName})")
        }
    }

    private class Adapter(cl: ClassLoader) {
        val main = Handler(Looper.getMainLooper())
        var home: WeakReference<Any>? = null
        private var activity: WeakReference<Activity>? = null
        private var resumed = false
        private var observer: ContentObserver? = null
        private var config = GestureConfig.OFF
        private var revision = ""
        private var invalidConfig = false
        private var adapterFaulted = false
        private var engine = GestureEngine(config)
        private val loader = cl
        private var feedback: LauncherGestureFeedback? = null
        private val publisher = LauncherGesturePublisher { acceptClip(it) }
        private var clip: ClipSnapshot? = null
        private var clipMotion: ClipMotion? = null
        private var clipView: LauncherClipView? = null
        private var latestFrame: HandFrame? = null
        private var latestProjectable = false
        private var reason: String? = null
        private val sessionId = UUID.randomUUID().toString()
        private var matchSequence = 0L
        private var lastMatch: JSONObject? = null
        private val heartbeat = object : Runnable {
            override fun run() {
                if (!resumed) return
                val now = SystemClock.elapsedRealtime()
                if (latestFrame?.let { now - it.observedAtMs > 250 } == true || !eligible()) {
                    latestFrame = null
                    engine.cancel()
                    hideFeedback()
                    reason = if (eligible()) "stale_frame" else "home_required"
                    clipMotion?.takeIf { it.started }?.cancel()
                }
                runCatching { activity?.get()?.let { publisher.open(it) }; showClip(now); publish(now) }
                    .onFailure { adapterFaulted = true; engine.cancel(); hideClip() }
                main.postDelayed(this, 200)
            }
        }
        private var lastStatus: Pair<GestureEngine.Status, Set<dev.luma.gestures.Finger>>? = null
        private val epoch = AtomicLong(0)
        private val reader = StockHandFrameReader()
        private val flatClass = cl.loadClass(FLAT_SERVICE)
        private val shared = flatClass.getMethod("sharedInstance")
        private val projection = flatClass.getMethod("getIsFlatHandDetected")
        private val hats = flatClass.getDeclaredField("mHATS").apply { isAccessible = true }
        private val callback = flatClass.getDeclaredField("mCallback").apply { isAccessible = true }
        private val handler = flatClass.getDeclaredField("mHandler").apply { isAccessible = true }
        private val service = cl.loadClass("humane.handtracking.IHandTrackingService")
        private val callbackType = cl.loadClass("humane.handtracking.IHandTrackingCallback")
        private val register = service.getMethod("registerHandTrackingSummaryCallback", callbackType)
        private val unregister = service.getMethod("unregisterHandTrackingSummaryCallback", callbackType)
        private val homeType = cl.loadClass(HOME)
        private val isActive = homeType.getMethod("isActive")
        private val controller = homeType.getDeclaredField("mController").apply { isAccessible = true }
        private val controllerView = cl.loadClass("humane.experience.systemnavigation.home.HomeController")
            .getDeclaredField("mView").apply { isAccessible = true }
        private val dashboard = cl.loadClass("humane.experience.systemnavigation.home.HomeView")
            .getDeclaredField("mIsDashboardVisible").apply { isAccessible = true }
        private val homeState = cl.loadClass("humane.experience.systemnavigation.home.HomeView")
            .getDeclaredField("mMainHomeState").apply { isAccessible = true }

        // Subscription mutations run only on stock's HATS Handler, where stock
        // already does the synchronous Binder registration. No Binder wait on UI.
        private data class Subscription(val service: Any, val callback: Any, val epoch: Long)
        @Volatile private var subscription: Subscription? = null
        private data class Pending(val epoch: Long, val frame: HandFrame?, val projectable: Boolean = false)
        private val queue = ArrayDeque<Pending>()
        private var drainPosted = false

        fun resume(value: Activity) {
            activity = WeakReference(value)
            resumed = true
            if (observer == null) {
                val resolver = value.applicationContext.contentResolver
                observer = object : ContentObserver(main) {
                    override fun onChange(selfChange: Boolean) { loadConfig(); refresh() }
                }.also { resolver.registerContentObserver(Settings.Global.getUriFor(GestureConfig.SETTING), false, it) }
            }
            loadConfig()
            refresh()
            publisher.open(value)
            main.removeCallbacks(heartbeat)
            main.post(heartbeat)
        }

        fun pause(value: Activity) {
            if (activity?.get() === value) {
                resumed = false
                refresh()
                main.removeCallbacks(heartbeat)
                publisher.close()
            }
        }

        private fun loadConfig() {
            invalidConfig = false
            config = try {
                val current = activity?.get() ?: return
                val raw = Settings.Global.getString(current.contentResolver, GestureConfig.SETTING)
                revision = GestureConfig.revision(raw)
                GestureConfig.parse(raw)
            } catch (_: Exception) {
                invalidConfig = true
                Log.w(TAG, "Invalid or unreadable configuration; gestures disabled")
                GestureConfig.OFF
            }
            engine = GestureEngine(config)
        }

        private fun eligible(): Boolean = try {
            val current = activity?.get()
            val node = home?.get()
            val view = node?.let { controller.get(it) }?.let { controllerView.get(it) }
            val keyguard = current?.getSystemService(KeyguardManager::class.java)
            // Stock PincodeViewController.createView uses Android's
            // isKeyguardLocked. Onboarding WelcomeNode.launchHome writes DUC_PROVISIONED.
                !adapterFaulted && (config.mode != GestureMode.OFF || clipOwnsInput()) && resumed && current != null &&
                !current.isFinishing && !current.isDestroyed && current.hasWindowFocus() &&
                keyguard != null && !keyguard.isKeyguardLocked && !keyguard.isDeviceLocked &&
                Settings.Global.getInt(current.contentResolver, PROVISIONED, 0) == 1 &&
                node != null && isActive.invoke(node) == true && view != null && dashboard.get(view) == false &&
                homeState.get(view)?.toString() == "CONTENT"
        } catch (_: Exception) { false }

        fun invalidate(reason: String?) {
            epoch.incrementAndGet() // Immediately invalidate Binder frames already queued.
            publisher.cancelCopy()
            main.post {
                engine.cancel()
                latestFrame = null
                hideFeedback()
                clipMotion?.takeIf { it.started }?.cancel()
                hideClip()
                this.reason = reason ?: "hand_lost"
                lastStatus = null
                if (reason != null) Log.i(TAG, reason)
            }
        }

        fun refresh() {
            if (Looper.myLooper() != Looper.getMainLooper()) { main.post { refresh() }; return }
            val generation = epoch.incrementAndGet()
            engine.cancel()
            latestFrame = null
            hideFeedback()
            lastStatus = null
            val wanted = eligible()
            if (!wanted) { clipMotion?.takeIf { it.started }?.cancel(); hideClip() }
            runCatching {
                val flat = shared.invoke(null)
                val worker = handler.get(flat) as Handler
                worker.post {
                    if (generation != epoch.get()) return@post
                    val old = subscription
                    subscription = null
                    if (old != null) runCatching { unregister.invoke(old.service, old.callback) }
                    if (!wanted) return@post
                    runCatching {
                        val native = hats.get(flat) ?: return@runCatching
                        val nativeCallback = callback.get(flat) ?: return@runCatching
                        register.invoke(native, nativeCallback)
                        if (generation == epoch.get()) {
                            subscription = Subscription(native, nativeCallback, generation)
                            Log.i(TAG, "Summary subscription ready")
                        } else {
                            runCatching { unregister.invoke(native, nativeCallback) }
                        }
                    }.onFailure { invalidate("subscription_failed") }
                }
            }.onFailure { invalidate("subscription_unavailable") }
        }

        fun summary(owner: Any, summary: Any?) {
            val current = subscription ?: return
            if (current.callback !== owner || current.epoch != epoch.get()) return
            val now = SystemClock.elapsedRealtime()
            val projectable = runCatching { projection.invoke(shared.invoke(null)) == true }.getOrDefault(false)
            val sample = summary?.let { reader.sample(it, now, projectable) }
            synchronized(queue) {
                if (queue.size >= 4) {
                    // INFERRED: bounded delivery. Dropping an intermediate pose
                    // cancels, otherwise an unseen conflicting gesture could fire.
                    queue.clear()
                    queue.add(Pending(current.epoch, null))
                }
                queue.add(Pending(current.epoch, sample?.frame, sample?.projectable == true))
                if (!drainPosted) { drainPosted = true; main.post {
                    runCatching { drain() }.onFailure { adapterFaulted = true; invalidate("callback_failed") }
                } }
            }
        }

        private fun drain() {
            val pending = synchronized(queue) { queue.toList().also { queue.clear(); drainPosted = false } }
            for (item in pending) {
                if (item.epoch != epoch.get()) continue
                if (item.frame == null || !eligible() || SystemClock.elapsedRealtime() - item.frame.observedAtMs > 250) {
                    engine.cancel()
                    latestFrame = null
                    latestProjectable = false
                    reason = if (item.frame == null) "hand_lost" else "stale_frame"
                    clipMotion?.takeIf { it.started }?.cancel()
                    publisher.cancelCopy()
                    hideClip()
                    hideFeedback()
                    continue
                }
                // Clip owns its native press surface. Finger shortcuts cannot
                // activate beneath it, even when the same hand curls a finger.
                val clipActive = clipOwnsInput()
                val match = if (clipActive) { engine.cancel(); null } else engine.accept(item.frame.takeIf { item.projectable })
                latestFrame = item.frame
                latestProjectable = item.projectable
                clipMotion?.accept(item.frame, item.projectable, SystemClock.elapsedRealtime())
                reason = if (!item.projectable) "projection_unavailable" else null
                val title = GestureFeatures.catalog.find { it.id == engine.candidateFeature }?.title
                val message = when {
                    title != null && engine.releaseReady -> "Release: $title"
                    title != null -> "$title · ${(engine.holdProgress * 100).toInt()}%"
                    engine.status == GestureEngine.Status.CALIBRATING -> "Hold your hand open"
                    else -> null
                }
                val root = home?.get()?.let { controller.get(it) }?.let { controllerView.get(it) }
                if (message != null && root != null) {
                    val display = feedback ?: LauncherGestureFeedback(loader).also { feedback = it }
                    display.show(root, message)
                } else hideFeedback()
                val status = engine.status to engine.curledFingers
                if (config.mode == GestureMode.OBSERVE && status != lastStatus) {
                    Log.i(TAG, "status=${status.first} fingers=${status.second.joinToString(",") { it.name.lowercase() }}")
                    lastStatus = status
                }
                if (match != null) {
                    if (match.observeOnly) {
                        recordMatch(match.feature, "observed")
                        Log.i(TAG, "observed feature=${match.feature}")
                    }
                    else if (eligible()) {
                        // Stop recognition before dispatch. Returning to Home starts
                        // fresh calibration, never replays an old completed gesture.
                        invalidate(null)
                        recordMatch(match.feature, if (launch(match.feature)) "launched" else "failed")
                        publish(SystemClock.elapsedRealtime())
                        break
                    }
                }
            }
        }

        private fun recordMatch(feature: String, outcome: String) {
            lastMatch = JSONObject().put("id", "$sessionId:${++matchSequence}")
                .put("feature", feature).put("outcome", outcome)
        }

        private fun activeClip(): ClipSnapshot? = clip?.takeIf { SystemClock.elapsedRealtime() < it.expiresAtMs }
        private fun clipOwnsInput(): Boolean = activeClip() != null && clipMotion?.let { !it.started || it.visible } == true

        private fun acceptClip(value: ClipSnapshot?) {
            val changed = value?.article?.id != clip?.article?.id
            clip = value
            if (changed) {
                clipMotion = value?.let { ClipMotion() }
                hideClip()
                refresh()
            }
        }

        private fun showClip(now: Long) {
            val snapshot = activeClip()
            val motion = clipMotion
            if (snapshot == null || motion == null || !eligible() || (motion.started && !motion.visible)) { hideClip(); return }
            val root = home?.get()?.let { controller.get(it) }?.let { controllerView.get(it) } ?: return
            val display = clipView ?: LauncherClipView(loader, requireNotNull(activity?.get())) { pressed ->
                runCatching {
                    val current = activeClip()
                    val movement = clipMotion
                    if (current != null && movement != null) {
                        movement.held = pressed
                        if (pressed && current.phase == "ready" && eligible() && movement.press(latestFrame, latestProjectable, SystemClock.elapsedRealtime())) {
                            publisher.copy(current.article.id)
                            publish(SystemClock.elapsedRealtime())
                        }
                    }
                }.onFailure { adapterFaulted = true; clipMotion?.cancel(); hideClip() }
            }.also { clipView = it }
            hideFeedback()
            display.show(root, motion.presentation(snapshot, now), motion.visible)
        }

        private fun hideClip() {
            runCatching { clipView?.hide() }.onFailure { adapterFaulted = true }
        }

        private fun hideFeedback() {
            runCatching { feedback?.hide() }.onFailure { adapterFaulted = true }
        }

        private fun publish(now: Long) {
            if (clipMotion?.let { it.started && !it.visible } == true || !eligible()) publisher.cancelCopy()
            val active = eligible()
            val status = when {
                adapterFaulted -> "unavailable"
                invalidConfig -> "unavailable"
                config.mode == GestureMode.OFF -> "off"
                !active -> "suspended"
                engine.releaseReady -> "release"
                else -> engine.status.name.lowercase()
            }
            publisher.publish(GestureObservation.snapshot(now, status,
                if (adapterFaulted) "callback_failed" else if (invalidConfig) "invalid_config" else reason, active, latestFrame != null && latestProjectable,
                engine.curledFingers, engine.candidateFeature, engine.holdProgress, latestFrame, revision, lastMatch))
        }

        private fun launch(feature: String): Boolean {
            val current = activity?.get() ?: return false
            // Stock humaneinternal.experience.HumanePackageManager discovers these
            // MAIN activities. Luma's existing TickleLauncherHooks uses the same
            // explicit targets; action selection here is INFERRED and allowlisted.
            val target = when (feature) {
                "open_music" -> ComponentName(StockSymbols.Music.PACKAGE, StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY)
                "open_messages" -> ComponentName(StockSymbols.Messages.PACKAGE, StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY)
                "open_settings" -> ComponentName(StockSymbols.Settings.PACKAGE, StockSymbols.Settings.SETTINGS_EXPERIENCE_CLASS)
                else -> return false
            }
            return runCatching { current.startActivity(Intent.makeMainActivity(target)) }
                .onSuccess { Log.i(TAG, "launched feature=$feature") }
                .onFailure { Log.w(TAG, "launch_failed feature=$feature"); refresh() }
                .isSuccess
        }
    }
}
