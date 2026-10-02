package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Synthetic stock-shaped lifecycle, not Android/physical evidence. Failure plan:
 * first/repeat intent or delayed IPC initializes Tickle before DUC=1. Rejecting
 * skips AppCompat super. Pending data/action/custom bypass the guard. Rejecting
 * an instance then completing onboarding replays it. Other experiences blocked.
 * The tested gate is the production hook callback policy, with no Android mocks.
 */
class TickleOnboardingGuardTest {
    // Before implementation there is no guard, so this fixture runs the existing
    // stock-shaped UI/action path. Class absence is not the assertion: actual
    // rendering/dispatch counters below must remain zero during onboarding.
    private class HookPolicyFixture {
        private val policy = try {
            Class.forName("com.penumbraos.hook.TickleOnboardingGate")
                .getDeclaredConstructor().apply { isAccessible = true }.newInstance()
        } catch (_: ClassNotFoundException) {
            null
        }

        fun bind(instance: Any, experience: Any, packageName: String) {
            val guard = policy ?: return
            val method = guard.javaClass.declaredMethods.find { it.name == "bind" } ?: return
            method.apply { isAccessible = true }.invoke(guard, instance, experience, packageName)
        }

        fun allowInbound(experience: Any, read: (Any) -> Int?, reject: (Any) -> Unit): Boolean {
            val guard = policy ?: return true
            val method = guard.javaClass.declaredMethods.find { it.name == "allowInbound" } ?: return true
            return method.apply { isAccessible = true }.invoke(guard, experience, read, reject) as Boolean
        }

        fun allow(instance: Any, packageName: String, read: () -> Int?, reject: () -> Unit): Boolean {
            val guard = policy ?: return true
            return guard.javaClass.getDeclaredMethod(
                "allow", Any::class.java, String::class.java,
                kotlin.jvm.functions.Function0::class.java, kotlin.jvm.functions.Function0::class.java,
            ).apply { isAccessible = true }.invoke(guard, instance, packageName, read, reject) as Boolean
        }
    }
    private class ActivityFixture(
        val gate: HookPolicyFixture,
        var provisioned: Int? = 0,
        val packageName: String = "humane.experience.tickle",
    ) {
        var unreadable = false
        var superCalls = 0
        var ui = 0
        var actions = 0
        var finished = 0
        var pendingAction = false
        var pendingData = false
        var pendingCustom = false
        var data = 0
        var custom = 0
        val experience = Any()
        var inboundCalls = 0
        var inboundNullContextCrashes = 0

        private fun reject() {
            finished++
            pendingAction = false
            pendingData = false
            pendingCustom = false
        }

        fun createOnly() {
            superCalls++
            gate.bind(this, experience, packageName)
            allowed() // Creation must latch before stock installs the incoming callback.
        }

        fun incomingMessage() {
            if (gate.allowInbound(
                    experience,
                    { owner -> (owner as ActivityFixture).provisioned },
                    { owner -> (owner as ActivityFixture).reject() },
                )) {
                inboundCalls++
                // Stock ExperiencePrivate.onReceiveMessage requires initialized
                // appContext/messengers, unlike Activity's null-safe lifecycle.
                if (ui == 0) inboundNullContextCrashes++
            }
        }

        private fun allowed(): Boolean = gate.allow(
            this,
            packageName,
            { if (unreadable) error("synthetic settings unavailable") else provisioned },
            { reject() },
        )

        fun onCreate(immediateUi: Boolean) {
            createOnly() // Stock AppCompat lifecycle remains intact.
            if (immediateUi) initializeExperienceUI()
            handleIntent()
        }

        fun initializeExperienceUI() { if (allowed()) ui++ }
        fun handleIntent() { if (allowed()) pendingAction = true }
        fun callExperienceActionHandler() { if (allowed()) actions++ }
        fun ipcConnected() {
            initializeExperienceUI()
            if (pendingAction) callExperienceActionHandler()
            if (pendingData) data++
            if (pendingCustom) custom++
        }
    }

    @Test
    fun `incomplete initial creation preserves super but suppresses UI intent and late callback`() {
        for (value in listOf<Int?>(null, 0, -1, 2)) {
            for (immediateUi in listOf(false, true)) {
                val activity = ActivityFixture(HookPolicyFixture(), value)
                activity.pendingData = true
                activity.pendingCustom = true
                activity.onCreate(immediateUi)
                activity.provisioned = 1
                activity.ipcConnected()
                assertEquals(1, activity.superCalls)
                assertEquals("initial and late UI must remain rejected", 0, activity.ui)
                assertEquals(0, activity.actions)
                assertEquals(0, activity.data)
                assertEquals(0, activity.custom)
                assertTrue(activity.finished > 0)
            }
        }
    }

    @Test
    fun `unreadable provisioning rejects and cannot replay after recovery`() {
        val activity = ActivityFixture(HookPolicyFixture(), 1)
        activity.unreadable = true
        activity.onCreate(false)
        activity.unreadable = false
        activity.ipcConnected()
        assertEquals(0, activity.ui)
        assertEquals(0, activity.actions)
        assertFalse(activity.pendingAction)
    }

    @Test
    fun `repeat intent rechecks current state and rejects the initialized instance`() {
        val activity = ActivityFixture(HookPolicyFixture(), 1)
        activity.onCreate(true)
        activity.callExperienceActionHandler()
        assertEquals(1, activity.ui)
        assertEquals(1, activity.actions)
        activity.provisioned = 0
        activity.handleIntent()
        activity.provisioned = 1
        activity.ipcConnected()
        activity.callExperienceActionHandler()
        assertEquals(1, activity.ui)
        assertEquals(1, activity.actions)
        assertFalse(activity.pendingAction)
    }

    @Test
    fun `complete fresh instance and other experiences retain normal lifecycle`() {
        val gate = HookPolicyFixture()
        val rejected = ActivityFixture(gate)
        rejected.onCreate(false)
        val fresh = ActivityFixture(gate, 1)
        fresh.onCreate(true)
        fresh.callExperienceActionHandler()
        assertEquals(1, fresh.ui)
        assertEquals(1, fresh.actions)
        assertEquals(0, fresh.finished)
        for (pkg in listOf("humane.experience.onboarding", "humane.experience.music", "humane.experience.tickle.other")) {
            val other = ActivityFixture(gate, null, pkg)
            other.onCreate(true)
            other.callExperienceActionHandler()
            assertEquals(1, other.ui)
            assertEquals(1, other.actions)
            assertEquals(0, other.finished)
        }
    }

    @Test
    fun `rejected experience swallows queued incoming messages before and after connect`() {
        val activity = ActivityFixture(HookPolicyFixture(), 0)
        activity.createOnly()
        activity.incomingMessage() // Callback can run before onConnected/UI setup.
        activity.handleIntent()
        activity.provisioned = 1
        activity.incomingMessage() // Rejected instance cannot revive after completion.
        activity.ipcConnected()
        activity.incomingMessage()
        assertEquals("no uninitialized inbound dispatch", 0, activity.inboundCalls)
        assertEquals(0, activity.inboundNullContextCrashes)
        assertEquals(1, activity.superCalls)
        assertEquals(0, activity.ui)
    }

    @Test
    fun `initialized repeat rejection suppresses inbound while fresh complete experience stays live`() {
        val gate = HookPolicyFixture()
        val old = ActivityFixture(gate, 1)
        old.onCreate(true)
        old.incomingMessage()
        assertEquals(1, old.inboundCalls)
        old.provisioned = 0
        old.handleIntent()
        old.provisioned = 1
        old.incomingMessage()
        assertEquals("rejected initialized instance remains rejected", 1, old.inboundCalls)
        val fresh = ActivityFixture(gate, 1)
        fresh.onCreate(true)
        fresh.incomingMessage()
        assertEquals(1, fresh.inboundCalls)
        assertEquals(0, fresh.inboundNullContextCrashes)
        assertEquals(0, fresh.finished)
    }
}
