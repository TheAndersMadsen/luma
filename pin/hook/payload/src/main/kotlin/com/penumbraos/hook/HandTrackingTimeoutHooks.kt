package com.penumbraos.hook

import android.app.Application
import android.content.Context
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.time.Instant
import java.util.ArrayDeque
import java.util.UUID

internal fun hasActiveHandTrackingHold(
    aiResponseActive: Boolean,
    narrationActive: Boolean,
    projectionActive: Boolean,
): Boolean = aiResponseActive || narrationActive || projectionActive

internal fun shouldInterceptHandTrackingUpdate(managerEnabled: Boolean?): Boolean =
    managerEnabled == true

internal fun isConfirmedHandTrackingRunning(observedRunning: Boolean?): Boolean =
    observedRunning == true

internal fun shouldUseStockHandTrackingRuntime(
    managerContextPresent: Boolean,
    serviceValid: Boolean?,
): Boolean = managerContextPresent && serviceValid == true

internal class StockTranscriptionAcceptanceCapture(
    private val arbitratorOwner: Any?,
    identifier: UUID?,
) {
    private val currentIdentifier = identifier?.toString()
    private var observed = false
    private var accepted: Boolean? = null
    private var consumed = false

    fun observe(candidateIdentifier: String?, stockResult: Boolean?) {
        if (observed || currentIdentifier == null || candidateIdentifier != currentIdentifier) return
        observed = true
        accepted = stockResult
    }

    fun consumeShouldHold(candidateOwner: Any?): Boolean {
        if (consumed || arbitratorOwner == null || candidateOwner !== arbitratorOwner) return false
        consumed = true
        return observed && accepted == true
    }
}

internal fun commitStockAcceptedTranscriptionHold(
    acceptance: StockTranscriptionAcceptanceCapture,
    arbitratorOwner: Any?,
    managerLock: Any,
    sessionArmed: () -> Boolean,
    activateHold: () -> Unit,
): Boolean = synchronized(managerLock) {
    if (!acceptance.consumeShouldHold(arbitratorOwner) || !sessionArmed()) {
        false
    } else {
        activateHold()
        true
    }
}

internal fun reconcileProjectionStateFromStock(
    readStockProjectionActive: () -> Boolean?,
    applyObservedProjectionState: (Boolean) -> Unit,
): Boolean {
    val observedProjectionActive = readStockProjectionActive() ?: return false
    applyObservedProjectionState(observedProjectionActive)
    return true
}

internal fun commitHandTrackingTimeoutIfEligible(
    managerLock: Any,
    expectedGeneration: Int,
    currentGeneration: () -> Int,
    sessionArmed: () -> Boolean,
    activeHold: () -> Boolean,
    stop: () -> Unit,
): Boolean = synchronized(managerLock) {
    if (expectedGeneration != currentGeneration() || !sessionArmed() || activeHold()) {
        false
    } else {
        stop()
        true
    }
}

internal fun shouldScheduleTimeoutAfterProjectionLoss(
    sessionArmed: Boolean,
    projectionWasActive: Boolean,
    aiResponseActive: Boolean,
    narrationActive: Boolean,
): Boolean =
    sessionArmed &&
        projectionWasActive &&
        !hasActiveHandTrackingHold(
            aiResponseActive = aiResponseActive,
            narrationActive = narrationActive,
            projectionActive = false,
        )

/**
 * Replaces Humane's low-power hand-tracking lifetime policy.
 *
 * Humane's original HandTrackingManager uses indefinite "timer exceptions" for
 * narration, calls, music, and laser/projection state. In practice that can leave
 * the ToF/hand scanner searching for a hand long after the interaction ended.
 *
 * Amended policy:
 * - Touchpad activity, or an intentional voice narration start, may arm a session from idle
 * - TTS keeps tracking aMlive for the duration of the narration
 * - A stock-observed projection holds tracking; projection loss starts the short timeout
 * - Music/call/alert/sound state does not start or hold hand tracking by default
 */
object HandTrackingTimeoutHooks {

    private const val TAG = "PenumbraHook"

    private const val MANAGER_CLASS = "humaneinternal.system.coordination.HandTrackingManager"
    private const val REASON_CLASS = "humaneinternal.system.coordination.HandTrackingManager\$Reason"
    private const val MAIN_APPLICATION_CLASS = StockSymbols.Ironman.MAIN_APPLICATION_CLASS
    private const val HAND_TRACKING_SERVICE_CLASS = "humaneinternal.system.coordination.HandTrackingService"
    private const val SYSTEM_MODE_STUB_CLASS = "humane.sysmode.ISystemModeService\$Stub"
    private const val SYSTEM_MODE_SERVICE_NAME = "humane.service.SystemModeService"
    private const val NARRATION_HATS_LOCK_REASON = "PenumbraNarration"
    private const val FLAT_HAND_SERVICE_CLASS = "humaneinternal.system.hats.FlatHandService"
    private const val FLAT_HAND_CALLBACK_CLASS = "humaneinternal.system.hats.FlatHandService\$FlatHandCallback"
    private const val ARBITRATOR_CLASS = "humaneinternal.system.tao.Arbitrator"
    private const val AI_MIC_EVENT_CLASS = "humaneinternal.system.intent.AiMicEvent"

    private const val DEFAULT_TIMEOUT_MS = 10_000L
    private const val KEY_TIMEOUT_MS = "penumbra.hand_tracking.timeout_ms"
    private const val KEY_ALLOW_ALERT_START = "penumbra.hand_tracking.allow_alert_start"
    private const val KEY_ALLOW_SOUND_START = "penumbra.hand_tracking.allow_sound_start"

    @Volatile
    private var installed = false

    @Volatile
    private var sessionArmed = false

    @Volatile
    private var aiResponseActive = false

    @Volatile
    private var narrationActive = false

    @Volatile
    private var projectionActive = false

    @Volatile
    private var managerRef: Any? = null

    @Volatile
    private var stockFallbackActive = false

    @Volatile
    private var narrationHatsToken: IBinder? = null

    @Volatile
    private var systemModeServiceRef: Any? = null

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var timerGeneration = 0

    private val timerHandler = Handler(Looper.getMainLooper())
    private val projectionHandler = Handler(Looper.getMainLooper())
    private val stockTranscriptionAcceptanceStack =
        ThreadLocal<ArrayDeque<StockTranscriptionAcceptanceCapture>>()

    private lateinit var managerClass: Class<*>
    private lateinit var reasonClass: Class<*>
    private lateinit var sharedInstanceMethod: Method
    private lateinit var startIfNeededMethod: Method
    private lateinit var cancelTimerMethod: Method
    private lateinit var stopMethod: Method
    private lateinit var enabledField: Field
    private lateinit var timerExceptionsField: Field
    private lateinit var contextField: Field
    private lateinit var timeoutIntentCounterField: Field
    private lateinit var lastPendingTimeoutField: Field
    private lateinit var handTrackingServiceClass: Class<*>
    private lateinit var systemModeStubClass: Class<*>

    fun install(cl: ClassLoader) {
        if (installed) return

        try {
            loadManagerSymbols(cl)
            hookApplicationContext(cl)
            hookUpdate()
            hookStop()
            hookProjectionCallbacks(cl)
            hookArbitratorActiveResponse(cl)
            installed = true
            Log.w(TAG, "  Hand tracking timeout hooks installed")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to install hand tracking timeout hooks", t)
        }
    }

    private fun loadManagerSymbols(cl: ClassLoader) {
        managerClass = cl.loadClass(MANAGER_CLASS)
        reasonClass = cl.loadClass(REASON_CLASS)

        sharedInstanceMethod = managerClass.getDeclaredMethod("sharedInstance").apply { isAccessible = true }
        startIfNeededMethod = managerClass.getDeclaredMethod("startIfNeeded").apply { isAccessible = true }
        cancelTimerMethod = managerClass.getDeclaredMethod("cancelTimer").apply { isAccessible = true }
        stopMethod = managerClass.getDeclaredMethod("stop").apply { isAccessible = true }

        enabledField = managerClass.getDeclaredField("mEnabled").apply { isAccessible = true }
        timerExceptionsField = managerClass.getDeclaredField("mTimerExceptions").apply { isAccessible = true }
        contextField = managerClass.getDeclaredField("mContext").apply { isAccessible = true }
        timeoutIntentCounterField = managerClass.getDeclaredField("mTimeoutIntentCounter").apply { isAccessible = true }
        lastPendingTimeoutField = managerClass.getDeclaredField("mLastPendingTimeout").apply { isAccessible = true }
        handTrackingServiceClass = cl.loadClass(HAND_TRACKING_SERVICE_CLASS)
        systemModeStubClass = cl.loadClass(SYSTEM_MODE_STUB_CLASS)
    }

    private fun hookApplicationContext(cl: ClassLoader) {
        try {
            val applicationClass = cl.loadClass(MAIN_APPLICATION_CLASS)
            val method = applicationClass.getDeclaredMethod("onCreate").apply { isAccessible = true }
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    val application = param.thisObject as? Application ?: return
                    appContext = application.applicationContext
                    Log.w(TAG, "  Captured application context for hand tracking timeout hook")
                }
            })
            Log.w(TAG, "  Hooked MainApplication.onCreate() for hand tracking context")
        } catch (t: Throwable) {
            Log.w(TAG, "  MainApplication.onCreate hand tracking context hook unavailable: ${t.message}")
        }
    }

    private fun hookUpdate() {
        val updateMethod = managerClass.getDeclaredMethod("update", reasonClass).apply { isAccessible = true }
        XposedBridge.hookMethod(updateMethod, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                val manager = param.thisObject ?: return
                val reason = (param.args.getOrNull(0) as? Enum<*>)?.name ?: return
                val managerEnabled = readManagerEnabled(manager)
                if (!shouldInterceptHandTrackingUpdate(managerEnabled)) {
                    if (managerEnabled == false) {
                        Log.w(TAG, "  Hand tracking feature disabled; delegating update($reason) to stock")
                    } else {
                        Log.w(TAG, "  Hand tracking feature gate unreadable; delegating update($reason) to stock")
                    }
                    return
                }
                if (!isStockHandTrackingRuntimeReady(manager)) {
                    Log.w(TAG, "  Stock hand tracking runtime not ready; delegating update($reason) to stock")
                    return
                }
                if (stockFallbackActive) {
                    Log.w(TAG, "  Stock owns hand tracking recovery; delegating update($reason)")
                    return
                }

                synchronized(manager) {
                    val timerExceptionsBefore = snapshotTimerExceptions(manager)
                    try {
                        if (!handleUpdate(manager, reason)) {
                            resetHookState()
                            restoreTimerExceptions(manager, timerExceptionsBefore)
                            stockFallbackActive = true
                            Log.w(TAG, "  Hand tracking replacement declined update($reason); delegating to stock")
                            return@synchronized
                        }
                        managerRef = manager
                        // Suppress Humane's original indefinite timer-exception policy
                        // only after our enabled replacement completed successfully.
                        param.result = null
                    } catch (t: Throwable) {
                        Log.e(TAG, "  HandTrackingManager.update($reason) hook failed", t)
                        resetHookState()
                        restoreTimerExceptions(manager, timerExceptionsBefore)
                        stockFallbackActive = true
                        // Leave the result unset after removing partial hook state so
                        // the enabled stock implementation owns recovery until stop().
                    }
                }
            }
        })
        Log.w(TAG, "  Hooked HandTrackingManager.update(Reason)")
    }

    private fun hookStop() {
        XposedBridge.hookMethod(stopMethod, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                if (param.throwable != null) return
                val manager = param.thisObject
                if (manager != null) {
                    synchronized(manager) {
                        resetHookState()
                        stockFallbackActive = false
                        clearTimerExceptions(manager)
                    }
                } else {
                    resetHookState()
                    stockFallbackActive = false
                }
                Log.w(TAG, "  Hand tracking session stopped; hook state cleared")
            }
        })
        Log.w(TAG, "  Hooked HandTrackingManager.stop()")
    }

    private fun hookProjectionCallbacks(cl: ClassLoader) {
        val symbols = try {
            val serviceClass = cl.loadClass(FLAT_HAND_SERVICE_CLASS)
            ProjectionCallbackSymbols(
                callbackClass = cl.loadClass(FLAT_HAND_CALLBACK_CLASS),
                sharedInstanceMethod = serviceClass.getDeclaredMethod("sharedInstance").apply { isAccessible = true },
                isProjectionActiveMethod = serviceClass.getDeclaredMethod("getIsFlatHandDetected").apply {
                    isAccessible = true
                },
            )
        } catch (t: Throwable) {
            Log.w(TAG, "  Stock projection state unavailable, projection reconciliation hooks skipped: ${t.message}")
            return
        }

        hookProjectionMethod(symbols.callbackClass, "onNewFlatHandProjection", emptyArray()) {
            enqueueProjectionStateReconciliation(symbols)
        }
        hookProjectionMethod(symbols.callbackClass, "onFlatHandProjectionLost", emptyArray()) {
            enqueueProjectionStateReconciliation(symbols)
        }
    }

    private data class ProjectionCallbackSymbols(
        val callbackClass: Class<*>,
        val sharedInstanceMethod: Method,
        val isProjectionActiveMethod: Method,
    )

    private fun hookArbitratorActiveResponse(cl: ClassLoader) {
        val arbitratorClass = try {
            cl.loadClass(ARBITRATOR_CLASS)
        } catch (t: Throwable) {
            Log.w(TAG, "  $ARBITRATOR_CLASS unavailable, AI response hold hooks skipped: ${t.message}")
            return
        }

        try {
            val runManagerField = arbitratorClass.getDeclaredField("mRunManager").apply { isAccessible = true }
            val isInActiveRunMethod = runManagerField.type
                .getDeclaredMethod("isInActiveRun", String::class.java)
                .apply { isAccessible = true }
            val registerAiMicEventMethod = arbitratorClass.getDeclaredMethod(
                "registerAiMicEvent",
                cl.loadClass(AI_MIC_EVENT_CLASS),
            ).apply { isAccessible = true }
            val eventForTranscriptionMethod = arbitratorClass.getDeclaredMethod(
                "eventForTranscription",
                UUID::class.java,
                Instant::class.java,
                String::class.java,
                Boolean::class.javaPrimitiveType,
            ).apply { isAccessible = true }
            XposedBridge.hookMethod(isInActiveRunMethod, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) return
                    currentStockTranscriptionAcceptance()?.observe(
                        candidateIdentifier = param.args.getOrNull(0) as? String,
                        stockResult = param.result as? Boolean,
                    )
                }
            })
            XposedBridge.hookMethod(registerAiMicEventMethod, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) return
                    // In the inspected stock image, synchronized eventForTranscription
                    // calls synchronized registerAiMicEvent reentrantly. Commit here,
                    // before the outer monitor can be released and clear can overtake it.
                    runCatching {
                        applyStockAcceptedTranscriptionHold(param.thisObject)
                    }.onFailure {
                        Log.w(TAG, "  Accepted-transcription hold bookkeeping failed; stock result preserved")
                    }
                }
            })
            XposedBridge.hookMethod(eventForTranscriptionMethod, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    beginStockTranscriptionAcceptance(
                        arbitratorOwner = param.thisObject,
                        identifier = param.args.getOrNull(0) as? UUID,
                    )
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    endStockTranscriptionAcceptance()
                }
            })
            Log.w(TAG, "  Hooked Arbitrator.eventForTranscription()")
        } catch (t: Throwable) {
            Log.w(TAG, "  Arbitrator.eventForTranscription hook unavailable: ${t.message}")
        }

        try {
            val method = arbitratorClass.getDeclaredMethod("clearInteractiveSession").apply { isAccessible = true }
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) return
                    val manager = managerForActiveSession() ?: return
                    synchronized(manager) {
                        if (!sessionArmed) return@synchronized
                        aiResponseActive = false

                        if (narrationActive) {
                            cancelTimer(manager)
                            logState("Interactive session cleared while narration active; preserving narration hold")
                            return@synchronized
                        }

                        if (projectionActive) {
                            cancelTimer(manager)
                            logState("Interactive session cleared while projection active; preserving projection hold")
                            return@synchronized
                        }

                        scheduleTimeout(manager, "interactive_session_clear")
                    }
                }
            })
            Log.w(TAG, "  Hooked Arbitrator.clearInteractiveSession()")
        } catch (t: Throwable) {
            Log.w(TAG, "  Arbitrator.clearInteractiveSession hook unavailable: ${t.message}")
        }
    }

    private fun beginStockTranscriptionAcceptance(arbitratorOwner: Any?, identifier: UUID?) {
        val stack = stockTranscriptionAcceptanceStack.get()
            ?: ArrayDeque<StockTranscriptionAcceptanceCapture>().also {
                stockTranscriptionAcceptanceStack.set(it)
            }
        stack.addLast(StockTranscriptionAcceptanceCapture(arbitratorOwner, identifier))
    }

    private fun currentStockTranscriptionAcceptance(): StockTranscriptionAcceptanceCapture? =
        stockTranscriptionAcceptanceStack.get()?.peekLast()

    private fun endStockTranscriptionAcceptance(): StockTranscriptionAcceptanceCapture? {
        val stack = stockTranscriptionAcceptanceStack.get() ?: return null
        val acceptance = stack.pollLast()
        if (stack.isEmpty()) stockTranscriptionAcceptanceStack.remove()
        return acceptance
    }

    private fun applyStockAcceptedTranscriptionHold(arbitratorOwner: Any?) {
        val acceptance = currentStockTranscriptionAcceptance() ?: return
        val manager = managerForActiveSession() ?: return
        commitStockAcceptedTranscriptionHold(
            acceptance = acceptance,
            arbitratorOwner = arbitratorOwner,
            managerLock = manager,
            sessionArmed = { sessionArmed },
            activateHold = {
                val wasHeld = isActiveHold()
                aiResponseActive = true
                if (!wasHeld) {
                    cancelTimer(manager)
                    logState("Hand tracking timeout held for active AI response")
                } else {
                    logState("Active AI response observed while hand tracking already held")
                }
            },
        )
    }

    private fun enqueueProjectionStateReconciliation(symbols: ProjectionCallbackSymbols) {
        val accepted = projectionHandler.post {
            val reconciled = reconcileProjectionStateFromStock(
                readStockProjectionActive = {
                    runCatching {
                        val service = symbols.sharedInstanceMethod.invoke(null)
                            ?: return@runCatching null
                        symbols.isProjectionActiveMethod.invoke(service) as? Boolean
                    }.onFailure {
                        Log.w(TAG, "  Failed to read stock projection state: ${it.message}")
                    }.getOrNull()
                },
                applyObservedProjectionState = { observedActive ->
                    if (observedActive) {
                        handleProjectionStart()
                    } else {
                        handleProjectionLost()
                    }
                },
            )
            if (!reconciled) {
                logState("Stock projection state unreadable; timeout bookkeeping unchanged")
            }
        }
        if (!accepted) {
            logState("Projection state reconciliation queue unavailable; timeout bookkeeping unchanged")
        }
    }

    private fun hookProjectionMethod(
        clazz: Class<*>,
        methodName: String,
        paramTypes: Array<Class<*>>,
        handler: () -> Unit,
    ) {
        try {
            val method = clazz.getDeclaredMethod(methodName, *paramTypes).apply { isAccessible = true }
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) {
                        // FlatHandService commits its detection field before
                        // listener dispatch. Preserve the stock throwable while
                        // reconciling that observable committed state.
                        Log.w(TAG, "  Stock projection callback $methodName failed; reconciling committed state")
                    }
                    try {
                        handler()
                    } catch (t: Throwable) {
                        Log.e(TAG, "  Projection hook $methodName failed", t)
                    }
                }
            })
            Log.w(TAG, "  Hooked FlatHandCallback.$methodName()")
        } catch (t: Throwable) {
            Log.w(TAG, "  FlatHandCallback.$methodName hook unavailable: ${t.message}")
        }
    }

    private fun handleUpdate(manager: Any, reason: String): Boolean {
        return when (reason) {
            "TOUCHPAD" -> {
                if (!invokeStartIfNeeded(manager, reason)) return false
                if (!clearTimerExceptions(manager)) return false
                releaseNarrationHatsLock("new_touchpad")
                sessionArmed = true
                aiResponseActive = false
                narrationActive = false
                // Projection presence is owned by the native callback lifecycle.
                // A touchpad refresh during projection must not erase that hold.
                logState("TOUCHPAD armed hand tracking session")
                scheduleTimeout(manager, "touchpad")
            }

            "NARRATION_START" -> {
                if (!invokeStartIfNeeded(manager, reason)) return false
                if (!clearTimerExceptions(manager)) return false
                if (!sessionArmed) {
                    sessionArmed = true
                    aiResponseActive = false
                    narrationActive = false
                    logState("NARRATION_START armed hand tracking session (voice-initiated)")
                }
                narrationActive = true
                acquireNarrationHatsLock("narration_start")
                if (!cancelTimer(manager)) return false
                logState(TierASymbols.OperationalMarkers.HAND_TRACKING_HELD_FOR_NARRATION)
                true
            }

            "NARRATION_END" -> {
                if (!sessionArmed) {
                    logState("NARRATION_END has no replacement-owned session; delegating to stock")
                    return false
                }
                if (!isActualHandTrackingRunning("narration_end")) return false
                if (!clearTimerExceptions(manager)) return false
                releaseNarrationHatsLock("narration_end")
                aiResponseActive = false
                narrationActive = false
                if (projectionActive) {
                    if (!cancelTimer(manager)) return false
                    logState(
                        "${TierASymbols.OperationalMarkers.NARRATION_END_RELEASED_HOLD}; " +
                            "preserving active projection hold",
                    )
                    true
                } else {
                    logState(TierASymbols.OperationalMarkers.NARRATION_END_RELEASED_HOLD)
                    scheduleTimeout(manager, "narration_end")
                }
            }

            "LASER_START" -> {
                if (!sessionArmed) {
                    logState("LASER_START has no replacement-owned session; delegating to stock")
                    return false
                }
                if (!invokeStartIfNeeded(manager, reason)) return false
                if (!clearTimerExceptions(manager)) return false
                projectionActive = true
                if (!cancelTimer(manager)) return false
                logState("Projection hold started from LASER_START")
                true
            }

            "LASER_END" -> {
                if (!sessionArmed) {
                    logState("LASER_END has no replacement-owned session; delegating to stock")
                    return false
                }
                if (!clearTimerExceptions(manager)) return false
                projectionActive = false
                logState("Projection hold ended from LASER_END")
                if (!isActiveHold()) {
                    scheduleTimeout(manager, "laser_end")
                } else {
                    true
                }
            }

            "ALERT" -> {
                if (allowAlertStart(manager)) {
                    if (!invokeStartIfNeeded(manager, reason)) return false
                    if (!clearTimerExceptions(manager)) return false
                    sessionArmed = true
                    scheduleTimeout(manager, "alert")
                } else {
                    clearTimerExceptions(manager)
                }
            }

            "SOUND" -> {
                if (allowSoundStart(manager)) {
                    if (!invokeStartIfNeeded(manager, reason)) return false
                    if (!clearTimerExceptions(manager)) return false
                    sessionArmed = true
                    scheduleTimeout(manager, "sound")
                } else {
                    clearTimerExceptions(manager)
                }
            }

            "CALL_START", "CALL_END", "MUSIC_START", "MUSIC_END" -> {
                if (!clearTimerExceptions(manager)) return false
                // Intentionally ignored. Music/call UI interactions must be initiated by touchpad again.
                Log.w(TAG, "  Ignoring hand tracking reason $reason")
                true
            }

            else -> {
                Log.w(TAG, "  Unknown hand tracking reason $reason; delegating to stock")
                false
            }
        }
    }

    private fun invokeStartIfNeeded(manager: Any, reason: String): Boolean {
        return runCatching {
            startIfNeededMethod.invoke(manager)
            true
        }.onFailure {
            Log.w(TAG, "  Stock startIfNeeded failed before replacement update($reason): ${it.message}")
        }.getOrDefault(false)
    }

    private fun handleProjectionStart() {
        val manager = managerForStateSynchronization() ?: run {
            projectionActive = true
            logState("Projection start observed without stock manager synchronization")
            return
        }
        synchronized(manager) {
            val wasActive = projectionActive
            projectionActive = true
            if (!sessionArmed || !isStockHandTrackingRuntimeReady(manager)) {
                logState("Projection start observed without an active replacement session")
                return@synchronized
            }

            // The stock callback has already updated FlatHandService and notified
            // its listeners. Only repair timeout bookkeeping here; native HATS
            // keeps privacy, thermal, tracking, and projector safety ownership.
            cancelTimer(manager)
            if (wasActive) {
                logState("Duplicate projection start callback preserved projection hold")
            } else {
                logState("Projection hold started from native projection callback")
            }
        }
    }

    private fun handleProjectionLost() {
        val manager = managerForStateSynchronization() ?: run {
            projectionActive = false
            logState("Projection lost observed without stock manager synchronization")
            return
        }
        synchronized(manager) {
            val wasActive = projectionActive
            projectionActive = false
            if (!sessionArmed || !isStockHandTrackingRuntimeReady(manager)) {
                logState("Projection lost observed without an active replacement session")
                return@synchronized
            }
            if (!wasActive) {
                // Arbitrator normally emits LASER_END synchronously from the stock
                // callback before this after-hook runs. Its timeout decision already
                // owns this transition, so do not create a duplicate timer.
                logState("Duplicate projection lost callback left timeout state unchanged")
                return@synchronized
            }

            if (
                shouldScheduleTimeoutAfterProjectionLoss(
                    sessionArmed = sessionArmed,
                    projectionWasActive = wasActive,
                    aiResponseActive = aiResponseActive,
                    narrationActive = narrationActive,
                )
            ) {
                logState("Projection hold ended from native projection callback")
                scheduleTimeout(manager, "projection_lost")
            } else {
                cancelTimer(manager)
                logState("Projection ended while another hand tracking hold remains active")
            }
        }
    }

    private fun managerForStateSynchronization(): Any? {
        return managerRef
            ?: runCatching { sharedInstanceMethod.invoke(null) }.getOrNull()?.also { managerRef = it }
    }

    private fun managerForActiveSession(): Any? {
        if (!sessionArmed) return null
        val manager = managerRef ?: runCatching { sharedInstanceMethod.invoke(null) }.getOrNull()?.also { managerRef = it }
        return manager?.takeIf(::isStockHandTrackingRuntimeReady)
    }

    private fun scheduleTimeout(manager: Any, reason: String): Boolean {
        if (!clearTimerExceptions(manager)) return false
        if (!cancelTimer(manager)) return false

        val timeoutMs = timeoutMs(configContext(manager))
        val generation = ++timerGeneration
        val targetManager = manager
        val accepted = timerHandler.postDelayed({
            try {
                val committed = commitHandTrackingTimeoutIfEligible(
                    managerLock = targetManager,
                    expectedGeneration = generation,
                    currentGeneration = { timerGeneration },
                    sessionArmed = { sessionArmed },
                    activeHold = { isActiveHold() },
                    stop = {
                        clearTimerExceptions(targetManager)
                        logState("Hand tracking timeout elapsed; stopping session ($reason)")
                        stopMethod.invoke(targetManager)
                    },
                )
                if (!committed) {
                    logState("Ignoring hand tracking timeout after locked state recheck ($reason, generation=$generation)")
                }
            } catch (t: Throwable) {
                Log.e(TAG, "  Failed to stop hand tracking on timeout", t)
            }
        }, timeoutMs)
        if (!accepted) {
            timerGeneration += 1
            logState("Hand tracking timeout queue rejected schedule ($reason)")
            return false
        }

        logState("Scheduled hand tracking stop in ${timeoutMs}ms ($reason, generation=$generation)")
        return true
    }

    private fun cancelTimer(manager: Any): Boolean {
        timerGeneration++
        timerHandler.removeCallbacksAndMessages(null)
        val stockTimerCancelled = runCatching {
            cancelTimerMethod.invoke(manager)
            true
        }.onFailure {
            Log.w(TAG, "  Failed to cancel Humane hand tracking timer: ${it.message}")
        }.getOrDefault(false)
        val pendingTimeoutCleared = runCatching {
            lastPendingTimeoutField.set(manager, null)
            true
        }.onFailure {
            Log.w(TAG, "  Failed to clear Humane pending hand tracking timeout: ${it.message}")
        }.getOrDefault(false)
        val cancelled = stockTimerCancelled && pendingTimeoutCleared
        if (cancelled) {
            logState("Cancelled hand tracking timeout")
        }
        return cancelled
    }

    private fun clearTimerExceptions(manager: Any): Boolean {
        return runCatching {
            val exceptions = timerExceptionsField.get(manager)
            if (exceptions is MutableList<*>) {
                exceptions.clear()
                true
            } else if (exceptions is java.util.Collection<*>) {
                @Suppress("UNCHECKED_CAST")
                (exceptions as java.util.Collection<Any>).clear()
                true
            } else {
                false
            }
        }.onFailure {
            Log.w(TAG, "  Failed to clear hand tracking timer exceptions: ${it.message}")
        }.getOrDefault(false)
    }

    private fun snapshotTimerExceptions(manager: Any): List<Any>? {
        return runCatching {
            val exceptions = timerExceptionsField.get(manager) as? Collection<*> ?: return@runCatching null
            exceptions.filterNotNull()
        }.onFailure {
            Log.w(TAG, "  Failed to snapshot hand tracking timer exceptions: ${it.message}")
        }.getOrNull()
    }

    private fun restoreTimerExceptions(manager: Any, snapshot: List<Any>?) {
        if (snapshot == null) return
        runCatching {
            val exceptions = timerExceptionsField.get(manager)
            if (exceptions is MutableCollection<*>) {
                @Suppress("UNCHECKED_CAST")
                (exceptions as MutableCollection<Any>).apply {
                    clear()
                    addAll(snapshot)
                }
            }
        }.onFailure {
            Log.w(TAG, "  Failed to restore hand tracking timer exceptions: ${it.message}")
        }
    }

    private fun readManagerEnabled(manager: Any): Boolean? {
        return runCatching { enabledField.getBoolean(manager) }
            .onFailure {
                Log.w(TAG, "  Failed to read HandTrackingManager.mEnabled: ${it.message}")
            }
            .getOrNull()
    }

    private fun acquireNarrationHatsLock(reason: String) {
        if (!sessionArmed) return
        if (narrationHatsToken != null) {
            Log.w(TAG, "Narration HATSLock already held ($reason)")
            return
        }

        val service = systemModeService() ?: run {
            Log.w(TAG, "SystemModeService unavailable; cannot acquire narration HATSLock ($reason)")
            return
        }
        val token = Binder()
        runCatching {
            val method = service.javaClass.getMethod("acquireHATSLock", IBinder::class.java, String::class.java)
            method.invoke(service, token, NARRATION_HATS_LOCK_REASON)
            narrationHatsToken = token
            Log.w(TAG, "Acquired narration HATSLock ($reason)")
        }.onFailure {
            Log.w(TAG, "Failed to acquire narration HATSLock ($reason): ${it.message}")
        }
    }

    private fun releaseNarrationHatsLock(reason: String) {
        val token = narrationHatsToken ?: return
        narrationHatsToken = null

        val service = systemModeService() ?: run {
            Log.w(TAG, "SystemModeService unavailable; dropped narration HATSLock token locally ($reason)")
            return
        }
        runCatching {
            val method = service.javaClass.getMethod("releaseHATSLock", IBinder::class.java)
            method.invoke(service, token)
            Log.w(TAG, "Released narration HATSLock ($reason)")
        }.onFailure {
            Log.w(TAG, "Failed to release narration HATSLock ($reason): ${it.message}")
        }
    }

    private fun systemModeService(): Any? {
        systemModeServiceRef?.let { return it }
        return runCatching {
            val serviceManagerClass = Class.forName("android.os.ServiceManager")
            val getServiceMethod = serviceManagerClass.getMethod("getService", String::class.java)
            val binder = getServiceMethod.invoke(null, SYSTEM_MODE_SERVICE_NAME) as? IBinder ?: return null
            val asInterfaceMethod = systemModeStubClass.getMethod("asInterface", IBinder::class.java)
            asInterfaceMethod.invoke(null, binder)?.also { systemModeServiceRef = it }
        }.onFailure {
            Log.w(TAG, "Failed to bind SystemModeService for narration HATSLock: ${it.message}")
        }.getOrNull()
    }

    private fun isActualHandTrackingRunning(reason: String): Boolean {
        return runCatching {
            val service = handTrackingServiceClass.getDeclaredMethod("sharedInstance").invoke(null)
            val isValid = handTrackingServiceClass.getDeclaredMethod("isValid").invoke(service) as? Boolean ?: false
            if (!isValid) {
                Log.w(TAG, "Actual hand tracking service invalid during revalidation ($reason)")
                return false
            }

            val isRunningMethod = handTrackingServiceClass.getDeclaredMethod("isRunning")
            val running = isRunningMethod.invoke(service) as? Boolean
            Log.w(TAG, "Observed actual hand tracking ($reason): running=$running")
            isConfirmedHandTrackingRunning(running)
        }.onFailure {
            Log.w(TAG, "Failed to observe actual hand tracking ($reason): ${it.message}")
        }.getOrDefault(false)
    }

    private fun isActiveHold(): Boolean {
        return hasActiveHandTrackingHold(
            aiResponseActive = aiResponseActive,
            narrationActive = narrationActive,
            projectionActive = projectionActive,
        )
    }

    private fun isStockHandTrackingRuntimeReady(manager: Any): Boolean {
        val managerContextPresent = runCatching { contextField.get(manager) is Context }
            .onFailure {
                Log.w(TAG, "  Failed to read stock HandTrackingManager context: ${it.message}")
            }
            .getOrNull() ?: false
        val serviceValid = runCatching {
            val service = handTrackingServiceClass.getDeclaredMethod("sharedInstance").invoke(null)
            handTrackingServiceClass.getDeclaredMethod("isValid").invoke(service) as? Boolean
        }.onFailure {
            Log.w(TAG, "  Failed to read stock HandTrackingService readiness: ${it.message}")
        }.getOrNull()

        return shouldUseStockHandTrackingRuntime(
            managerContextPresent = managerContextPresent,
            serviceValid = serviceValid,
        )
    }

    private fun configContext(manager: Any): Context? {
        return (runCatching { contextField.get(manager) as? Context }.getOrNull()) ?: appContext
    }

    private fun timeoutMs(context: Context?): Long {
        val configured = if (context == null) {
            DEFAULT_TIMEOUT_MS
        } else {
            runCatching {
                Settings.Global.getLong(context.contentResolver, KEY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
            }.getOrDefault(DEFAULT_TIMEOUT_MS)
        }
        return configured.coerceIn(1_000L, 60_000L)
    }

    private fun allowAlertStart(manager: Any): Boolean {
        val context = configContext(manager) ?: return false
        return runCatching {
            Settings.Global.getInt(context.contentResolver, KEY_ALLOW_ALERT_START, 0) != 0
        }.getOrDefault(false)
    }

    private fun allowSoundStart(manager: Any): Boolean {
        val context = configContext(manager) ?: return false
        return runCatching {
            Settings.Global.getInt(context.contentResolver, KEY_ALLOW_SOUND_START, 0) != 0
        }.getOrDefault(false)
    }

    private fun logState(message: String) {
        Log.w(
            TAG,
            "$message | sessionArmed=$sessionArmed aiResponseActive=$aiResponseActive " +
                "narrationActive=$narrationActive projectionActive=$projectionActive generation=$timerGeneration",
        )
    }

    private fun resetHookState() {
        releaseNarrationHatsLock("reset_hook_state")
        sessionArmed = false
        aiResponseActive = false
        narrationActive = false
        projectionActive = false
        managerRef = null
        timerGeneration += 1
        timerHandler.removeCallbacksAndMessages(null)
        projectionHandler.removeCallbacksAndMessages(null)
    }
}
