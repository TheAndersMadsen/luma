package com.penumbraos.hook

import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandTrackingTimeoutHooksTest {
    @Test
    fun `replacement update requires a positive stock feature gate`() {
        assertTrue(shouldInterceptHandTrackingUpdate(true))
        assertFalse(shouldInterceptHandTrackingUpdate(false))
        assertFalse(shouldInterceptHandTrackingUpdate(null))
    }

    @Test
    fun `running cache requires a positive native observation`() {
        assertTrue(isConfirmedHandTrackingRunning(true))
        assertFalse(isConfirmedHandTrackingRunning(false))
        assertFalse(isConfirmedHandTrackingRunning(null))
    }

    @Test
    fun `replacement runtime requires stock context and a valid stock service`() {
        assertTrue(
            shouldUseStockHandTrackingRuntime(
                managerContextPresent = true,
                serviceValid = true,
            ),
        )
        assertFalse(
            shouldUseStockHandTrackingRuntime(
                managerContextPresent = false,
                serviceValid = true,
            ),
        )
        assertFalse(
            shouldUseStockHandTrackingRuntime(
                managerContextPresent = true,
                serviceValid = false,
            ),
        )
        assertFalse(
            shouldUseStockHandTrackingRuntime(
                managerContextPresent = true,
                serviceValid = null,
            ),
        )
    }

    @Test
    fun `AI response hold uses the exact first stock predicate result for the current identifier`() {
        val identifier = UUID.fromString("00000000-0000-0000-0000-000000000001")
        val owner = Any()
        val managerLock = Any()
        var activations = 0
        val accepted = StockTranscriptionAcceptanceCapture(owner, identifier)
        accepted.observe(identifier.toString(), true)
        assertTrue(
            commitStockAcceptedTranscriptionHold(
                acceptance = accepted,
                arbitratorOwner = owner,
                managerLock = managerLock,
                sessionArmed = { true },
                activateHold = {
                    assertTrue(Thread.holdsLock(managerLock))
                    activations++
                },
            ),
        )
        assertTrue(activations == 1)
        assertFalse(
            commitStockAcceptedTranscriptionHold(
                acceptance = accepted,
                arbitratorOwner = owner,
                managerLock = managerLock,
                sessionArmed = { true },
                activateHold = { activations++ },
            ),
        )

        val inactive = StockTranscriptionAcceptanceCapture(owner, identifier)
        inactive.observe(identifier.toString(), false)
        inactive.observe(identifier.toString(), true)
        assertFalse(
            commitStockAcceptedTranscriptionHold(
                inactive,
                owner,
                managerLock,
                sessionArmed = { true },
                activateHold = { activations++ },
            ),
        )

        val unreadable = StockTranscriptionAcceptanceCapture(owner, identifier)
        unreadable.observe(identifier.toString(), null)
        unreadable.observe(identifier.toString(), true)
        assertFalse(
            commitStockAcceptedTranscriptionHold(
                unreadable,
                owner,
                managerLock,
                sessionArmed = { true },
                activateHold = { activations++ },
            ),
        )

        val unrelatedFirst = StockTranscriptionAcceptanceCapture(owner, identifier)
        unrelatedFirst.observe("00000000-0000-0000-0000-000000000002", true)
        unrelatedFirst.observe(identifier.toString(), true)
        assertTrue(
            commitStockAcceptedTranscriptionHold(
                unrelatedFirst,
                owner,
                managerLock,
                sessionArmed = { true },
                activateHold = { activations++ },
            ),
        )

        val missingIdentifier = StockTranscriptionAcceptanceCapture(owner, null)
        missingIdentifier.observe(identifier.toString(), true)
        assertFalse(
            commitStockAcceptedTranscriptionHold(
                missingIdentifier,
                owner,
                managerLock,
                sessionArmed = { true },
                activateHold = { activations++ },
            ),
        )

        val wrongOwner = StockTranscriptionAcceptanceCapture(owner, identifier)
        wrongOwner.observe(identifier.toString(), true)
        assertFalse(
            commitStockAcceptedTranscriptionHold(
                wrongOwner,
                Any(),
                managerLock,
                sessionArmed = { true },
                activateHold = { activations++ },
            ),
        )

        val inactiveSession = StockTranscriptionAcceptanceCapture(owner, identifier)
        inactiveSession.observe(identifier.toString(), true)
        assertFalse(
            commitStockAcceptedTranscriptionHold(
                inactiveSession,
                owner,
                managerLock,
                sessionArmed = { false },
                activateHold = { activations++ },
            ),
        )
        assertTrue(activations == 2)
    }

    @Test
    fun `nested accepted registration commits before synchronized clear can enter`() {
        val identifier = UUID.fromString("00000000-0000-0000-0000-000000000001")
        val arbitrator = Any()
        val managerLock = Any()
        val acceptance = StockTranscriptionAcceptanceCapture(arbitrator, identifier).apply {
            observe(identifier.toString(), true)
        }
        val holdActive = AtomicBoolean(false)
        val commitSucceeded = AtomicBoolean(false)
        val registrationCommitted = CountDownLatch(1)
        val clearAttempting = CountDownLatch(1)
        val allowOuterEventReturn = CountDownLatch(1)
        val clearFinished = CountDownLatch(1)

        val eventThread = thread(name = "stock-transcription-event") {
            synchronized(arbitrator) {
                commitSucceeded.set(
                    commitStockAcceptedTranscriptionHold(
                        acceptance,
                        arbitrator,
                        managerLock,
                        sessionArmed = { true },
                        activateHold = { holdActive.set(true) },
                    ),
                )
                registrationCommitted.countDown()
                allowOuterEventReturn.await(2, TimeUnit.SECONDS)
            }
        }
        val clearThread = thread(name = "stock-interactive-clear") {
            registrationCommitted.await(2, TimeUnit.SECONDS)
            clearAttempting.countDown()
            synchronized(arbitrator) {
                synchronized(managerLock) {
                    holdActive.set(false)
                }
                clearFinished.countDown()
            }
        }

        try {
            assertTrue(registrationCommitted.await(2, TimeUnit.SECONDS))
            assertTrue(clearAttempting.await(2, TimeUnit.SECONDS))
            assertEquals(1L, clearFinished.count)
            assertTrue(commitSucceeded.get())
            assertTrue(holdActive.get())
        } finally {
            allowOuterEventReturn.countDown()
        }
        assertTrue(clearFinished.await(2, TimeUnit.SECONDS))
        eventThread.join(2_000)
        clearThread.join(2_000)
        assertFalse(eventThread.isAlive)
        assertFalse(clearThread.isAlive)
        assertFalse(holdActive.get())
    }

    @Test
    fun `delayed callback reconciliation applies current stock state instead of stale event kind`() {
        var stockProjectionActive = true
        var hookProjectionActive = false
        val delayedCallbacks = mutableListOf<() -> Unit>()

        // Start body completed, but its after-hook has not run yet.
        delayedCallbacks += {
            reconcileProjectionStateFromStock(
                readStockProjectionActive = { stockProjectionActive },
                applyObservedProjectionState = { hookProjectionActive = it },
            )
        }

        // Lost body completes before the delayed start after-hook. Both queued
        // repairs must observe the latest stock state when they actually run.
        stockProjectionActive = false
        delayedCallbacks += {
            reconcileProjectionStateFromStock(
                readStockProjectionActive = { stockProjectionActive },
                applyObservedProjectionState = { hookProjectionActive = it },
            )
        }

        delayedCallbacks.asReversed().forEach { it() }
        assertFalse(hookProjectionActive)
    }

    @Test
    fun `unreadable stock projection state is not applied`() {
        var applications = 0
        assertFalse(
            reconcileProjectionStateFromStock(
                readStockProjectionActive = { null },
                applyObservedProjectionState = { applications++ },
            ),
        )
        assertTrue(applications == 0)
    }

    @Test
    fun `timeout commit rechecks generation session and holds under the manager lock`() {
        val managerLock = Any()
        var generation = 7
        var armed = true
        var projectionActive = false
        var stops = 0

        // A projection can start after an earlier speculative timeout check.
        projectionActive = true
        assertFalse(
            commitHandTrackingTimeoutIfEligible(
                managerLock = managerLock,
                expectedGeneration = 7,
                currentGeneration = { generation },
                sessionArmed = { armed },
                activeHold = { projectionActive },
                stop = { stops++ },
            ),
        )
        assertTrue(stops == 0)

        projectionActive = false
        generation = 8
        assertFalse(
            commitHandTrackingTimeoutIfEligible(
                managerLock = managerLock,
                expectedGeneration = 7,
                currentGeneration = { generation },
                sessionArmed = { armed },
                activeHold = { projectionActive },
                stop = { stops++ },
            ),
        )

        assertTrue(
            commitHandTrackingTimeoutIfEligible(
                managerLock = managerLock,
                expectedGeneration = 8,
                currentGeneration = { generation },
                sessionArmed = { armed },
                activeHold = { projectionActive },
                stop = {
                    assertTrue(Thread.holdsLock(managerLock))
                    stops++
                },
            ),
        )
        assertTrue(stops == 1)

        armed = false
        assertFalse(
            commitHandTrackingTimeoutIfEligible(
                managerLock = managerLock,
                expectedGeneration = 8,
                currentGeneration = { generation },
                sessionArmed = { armed },
                activeHold = { projectionActive },
                stop = { stops++ },
            ),
        )
    }

    @Test
    fun `projection alone is an active hand tracking hold`() {
        assertFalse(
            hasActiveHandTrackingHold(
                aiResponseActive = false,
                narrationActive = false,
                projectionActive = false,
            ),
        )
        assertTrue(
            hasActiveHandTrackingHold(
                aiResponseActive = false,
                narrationActive = false,
                projectionActive = true,
            ),
        )
        assertTrue(
            hasActiveHandTrackingHold(
                aiResponseActive = true,
                narrationActive = false,
                projectionActive = false,
            ),
        )
        assertTrue(
            hasActiveHandTrackingHold(
                aiResponseActive = false,
                narrationActive = true,
                projectionActive = false,
            ),
        )
    }

    @Test
    fun `projection loss schedules only for a real active transition with no other hold`() {
        assertTrue(
            shouldScheduleTimeoutAfterProjectionLoss(
                sessionArmed = true,
                projectionWasActive = true,
                aiResponseActive = false,
                narrationActive = false,
            ),
        )

        assertFalse(
            shouldScheduleTimeoutAfterProjectionLoss(
                sessionArmed = false,
                projectionWasActive = true,
                aiResponseActive = false,
                narrationActive = false,
            ),
        )
        assertFalse(
            shouldScheduleTimeoutAfterProjectionLoss(
                sessionArmed = true,
                projectionWasActive = false,
                aiResponseActive = false,
                narrationActive = false,
            ),
        )
        assertFalse(
            shouldScheduleTimeoutAfterProjectionLoss(
                sessionArmed = true,
                projectionWasActive = true,
                aiResponseActive = true,
                narrationActive = false,
            ),
        )
        assertFalse(
            shouldScheduleTimeoutAfterProjectionLoss(
                sessionArmed = true,
                projectionWasActive = true,
                aiResponseActive = false,
                narrationActive = true,
            ),
        )
    }

    @Test
    fun `projection callbacks observe stock first and only repair timeout bookkeeping`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HandTrackingTimeoutHooks.kt",
        ).readText()
        val projectionHook = source
            .substringAfter("private fun hookProjectionMethod(")
            .substringBefore("private fun handleUpdate(")
        val projectionHandlers = source
            .substringAfter("private fun handleProjectionStart()")
            .substringBefore("private fun managerForActiveSession()")
        val touchpadUpdate = source
            .substringAfter("\"TOUCHPAD\" -> {")
            .substringBefore("\"NARRATION_START\" -> {")

        assertTrue(source.contains("\"onNewFlatHandProjection\""))
        assertTrue(source.contains("\"onFlatHandProjectionLost\""))
        assertTrue(source.contains("getDeclaredMethod(\"getIsFlatHandDetected\")"))
        assertTrue(projectionHook.contains("override fun afterHookedMethod"))
        assertFalse(projectionHook.contains("override fun beforeHookedMethod"))
        assertFalse(projectionHook.contains("param.result"))
        assertTrue(projectionHook.contains("if (param.throwable != null)"))
        val throwableObservation = projectionHook
            .substringAfter("if (param.throwable != null) {")
            .substringBefore("try {")
        assertFalse(throwableObservation.contains("return"))
        assertTrue(
            projectionHook.indexOf("if (param.throwable != null)") <
                projectionHook.indexOf("handler()"),
        )
        assertTrue(source.contains("projectionHandler.post"))
        assertTrue(source.contains("reconcileProjectionStateFromStock("))

        assertTrue(projectionHandlers.contains("projectionActive = true"))
        assertTrue(projectionHandlers.contains("projectionActive = false"))
        assertTrue(projectionHandlers.contains("cancelTimer(manager)"))
        assertTrue(projectionHandlers.contains("scheduleTimeout(manager, \"projection_lost\")"))
        assertFalse(projectionHandlers.contains("startIfNeededMethod.invoke"))
        assertFalse(projectionHandlers.contains("stopMethod.invoke"))
        assertFalse(projectionHandlers.contains("handTrackingServiceClass"))
        assertFalse(touchpadUpdate.contains("projectionActive = false"))
        assertTrue(
            projectionHandlers.indexOf("projectionActive = true") <
                projectionHandlers.indexOf("if (!sessionArmed"),
        )
    }

    @Test
    fun `disabled or unreadable stock gate delegates without replacement initialization`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HandTrackingTimeoutHooks.kt",
        ).readText()
        val updateHook = source
            .substringAfter("private fun hookUpdate()")
            .substringBefore("private fun hookStop()")
        val gateCheck = updateHook.substringBefore("try {")
        val replacement = updateHook.substringAfter("try {").substringBefore("catch (t: Throwable)")

        assertTrue(source.contains("getDeclaredField(\"mEnabled\")"))
        assertTrue(gateCheck.contains("readManagerEnabled(manager)"))
        assertTrue(gateCheck.contains("if (!shouldInterceptHandTrackingUpdate(managerEnabled))"))
        assertTrue(gateCheck.contains("if (!isStockHandTrackingRuntimeReady(manager))"))
        assertTrue(gateCheck.contains("return"))
        assertFalse(gateCheck.contains("handleUpdate(manager, reason)"))
        assertFalse(gateCheck.contains("ensureRuntimeInitialized"))

        assertTrue(replacement.contains("handleUpdate(manager, reason)"))
        assertTrue(replacement.contains("param.result = null"))
        assertFalse(updateHook.substringAfter("catch (t: Throwable)").contains("param.result = null"))
        assertFalse(source.contains("getDeclaredMethod(\"initialize\")"))
        assertFalse(source.contains("contextField.set(manager"))
    }

    @Test
    fun `fallthrough happens before replacement state mutation and unexpected failure is rolled back`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HandTrackingTimeoutHooks.kt",
        ).readText()
        val updateHook = source
            .substringAfter("private fun hookUpdate()")
            .substringBefore("private fun hookStop()")
        val updateHandler = source
            .substringAfter("private fun handleUpdate(")
            .substringBefore("private fun invokeStartIfNeeded(")
        val touchpadUpdate = updateHandler
            .substringAfter("\"TOUCHPAD\" -> {")
            .substringBefore("\"NARRATION_START\" -> {")
        val narrationStart = updateHandler
            .substringAfter("\"NARRATION_START\" -> {")
            .substringBefore("\"NARRATION_END\" -> {")
        val laserStart = updateHandler
            .substringAfter("\"LASER_START\" -> {")
            .substringBefore("\"LASER_END\" -> {")

        fun assertStartPrecedesMutation(startBoundary: String, stateMutation: String) {
            val start = startBoundary.indexOf("invokeStartIfNeeded(manager, reason)")
            val clear = startBoundary.indexOf("clearTimerExceptions(manager)")
            val mutation = startBoundary.indexOf(stateMutation)
            assertTrue(start >= 0)
            assertTrue(clear >= 0)
            assertTrue(mutation >= 0)
            assertTrue(start < clear)
            assertTrue(start < mutation)
        }

        assertStartPrecedesMutation(touchpadUpdate, "sessionArmed = true")
        assertStartPrecedesMutation(narrationStart, "sessionArmed = true")
        assertStartPrecedesMutation(laserStart, "projectionActive = true")
        assertTrue(updateHook.contains("resetHookState()"))
        assertTrue(updateHook.contains("restoreTimerExceptions(manager, timerExceptionsBefore)"))
        assertTrue(updateHook.contains("stockFallbackActive = true"))
        assertTrue(updateHandler.contains("Unknown hand tracking reason \$reason; delegating to stock"))
    }

    @Test
    fun `session-bound lifecycle events delegate when no replacement session is armed`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HandTrackingTimeoutHooks.kt",
        ).readText()
        val updateHandler = source
            .substringAfter("private fun handleUpdate(")
            .substringBefore("private fun invokeStartIfNeeded(")
        val sessionBoundBranches = listOf(
            updateHandler.substringAfter("\"NARRATION_END\" -> {").substringBefore("\"LASER_START\" -> {"),
            updateHandler.substringAfter("\"LASER_START\" -> {").substringBefore("\"LASER_END\" -> {"),
            updateHandler.substringAfter("\"LASER_END\" -> {").substringBefore("\"ALERT\" -> {"),
        )

        sessionBoundBranches.forEach { branch ->
            val noSessionPath = branch
                .substringAfter("if (!sessionArmed) {")
                .substringBefore("}")
            assertTrue(noSessionPath.contains("delegating to stock"))
            assertTrue(noSessionPath.contains("return false"))
            assertFalse(noSessionPath.contains("return true"))
        }
    }

    @Test
    fun `native running state is observation only`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HandTrackingTimeoutHooks.kt",
        ).readText()
        val observation = source
            .substringAfter("private fun isActualHandTrackingRunning(")
            .substringBefore("private fun isActiveHold()")

        assertTrue(observation.contains("getDeclaredMethod(\"isValid\")"))
        assertTrue(observation.contains("getDeclaredMethod(\"isRunning\")"))
        assertTrue(observation.contains("isConfirmedHandTrackingRunning(running)"))
        assertFalse(observation.contains("getDeclaredMethod(\"start\")"))
        assertFalse(source.contains("isHandTrackingRunningField"))
    }

    @Test
    fun `stock fallback lasts until a successful stock stop and timeout commit is wired`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HandTrackingTimeoutHooks.kt",
        ).readText()
        val stopHook = source
            .substringAfter("private fun hookStop()")
            .substringBefore("private fun hookProjectionCallbacks(")
        val timeout = source
            .substringAfter("private fun scheduleTimeout(")
            .substringBefore("private fun cancelTimer(")
        val reset = source
            .substringAfter("private fun resetHookState()")
            .substringBeforeLast("}")

        assertTrue(stopHook.contains("if (param.throwable != null) return"))
        assertTrue(stopHook.contains("stockFallbackActive = false"))
        assertFalse(reset.contains("stockFallbackActive = false"))
        assertTrue(timeout.contains("commitHandTrackingTimeoutIfEligible("))
        assertTrue(timeout.contains("if (!accepted)"))
        assertFalse(source.contains("token="))
    }

    @Test
    fun `AI response hook mirrors stock active-run acceptance without reading content`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HandTrackingTimeoutHooks.kt",
        ).readText()
        val responseHook = source
            .substringAfter("val runManagerField = arbitratorClass.getDeclaredField(\"mRunManager\")")
            .substringBefore("Log.w(TAG, \"  Hooked Arbitrator.eventForTranscription()\")")
        val eventHook = responseHook.substringAfter("XposedBridge.hookMethod(eventForTranscriptionMethod")
        val registerHook = responseHook
            .substringAfter("XposedBridge.hookMethod(registerAiMicEventMethod")
            .substringBefore("XposedBridge.hookMethod(eventForTranscriptionMethod")
        val holdApplication = source
            .substringAfter("private fun applyStockAcceptedTranscriptionHold(")
            .substringBefore("private fun enqueueProjectionStateReconciliation(")

        assertTrue(responseHook.contains("getDeclaredMethod(\"isInActiveRun\", String::class.java)"))
        assertTrue(responseHook.contains("XposedBridge.hookMethod(isInActiveRunMethod"))
        assertTrue(responseHook.contains("currentStockTranscriptionAcceptance()?.observe("))
        assertTrue(responseHook.contains("stockResult = param.result as? Boolean"))
        assertTrue(registerHook.contains("override fun afterHookedMethod"))
        assertTrue(registerHook.contains("if (param.throwable != null) return"))
        assertTrue(registerHook.contains("applyStockAcceptedTranscriptionHold(param.thisObject)"))
        assertTrue(registerHook.contains("runCatching"))
        assertTrue(registerHook.contains("stock result preserved"))
        assertTrue(eventHook.contains("override fun beforeHookedMethod"))
        assertTrue(eventHook.contains("arbitratorOwner = param.thisObject"))
        assertTrue(eventHook.contains("identifier = param.args.getOrNull(0) as? UUID"))
        assertTrue(eventHook.contains("endStockTranscriptionAcceptance()"))
        assertFalse(eventHook.contains("aiResponseActive = true"))
        assertFalse(responseHook.contains("param.args.getOrNull(2)"))
        assertTrue(holdApplication.contains("commitStockAcceptedTranscriptionHold("))
        assertTrue(holdApplication.contains("managerLock = manager"))
        assertTrue(holdApplication.contains("sessionArmed = { sessionArmed }"))
        assertTrue(holdApplication.contains("aiResponseActive = true"))
        assertFalse(responseHook.contains("isInActiveRunMethod.invoke"))
        assertFalse(responseHook.contains("identifier="))
        assertFalse(responseHook.contains("transcript="))
        assertFalse(responseHook.contains("param.result ="))
        assertFalse(responseHook.contains("param.throwable ="))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
