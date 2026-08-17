package com.penumbraos.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteCenterPolicyTest {
    private val usableNetwork = RemoteCenterPolicy.NetworkState(
        hasInternetCapability = true,
        validated = true,
        suspended = false,
        blocked = false,
    )

    @Test
    fun optInIsDefaultOffEvenWhenEveryOtherPrerequisiteIsReady() {
        val policy = RemoteCenterPolicy()

        assertNoConnection(policy.start(0L))
        val authorization = policy.beginAuthorizationProvisioning()
        assertNoConnection(
            policy.onAuthorizationProvisioned(
                authorization,
                0L,
            ),
        )
        val backendGeneration = RemoteCenterPolicy.BackendGeneration()
        assertNoConnection(policy.onBackendGenerationChanged(backendGeneration, 0L))
        assertNoConnection(policy.onBackendReadyChanged(backendGeneration, true, 0L))
        val transition = policy.onNetworksChanged(listOf(usableNetwork), 0L)

        assertNoConnection(transition)
        assertEquals(RemoteCenterPolicy.Phase.DISABLED, transition.snapshot.phase)
        assertFalse(transition.snapshot.optedIn)

        val enabled = policy.enable(0L)
        assertTrue(enabled.effect is RemoteCenterPolicy.Effect.BeginConnection)
        assertEquals(RemoteCenterPolicy.Phase.CONNECTING, enabled.snapshot.phase)

        val delayedBegin = enabled.effect as RemoteCenterPolicy.Effect.BeginConnection
        val revokedBeforeEffectApplication = policy.revoke()
        assertClose(revokedBeforeEffectApplication, delayedBegin.generation)
        assertFalse(delayedBegin.generation.isCurrent())
    }

    @Test
    fun usableNetworkRequiresValidatedInternetAndFailsClosedForUnsafeCapabilities() {
        val unsafeNetworks = listOf(
            RemoteCenterPolicy.NetworkState(validated = true),
            RemoteCenterPolicy.NetworkState(hasInternetCapability = true),
            RemoteCenterPolicy.NetworkState(
                hasInternetCapability = true,
                validated = true,
            ),
            usableNetwork.copy(captivePortal = true),
            usableNetwork.copy(suspended = true),
            usableNetwork.copy(blocked = true),
        )
        unsafeNetworks.forEach { network ->
            assertFalse(network.usable)
            val policy = readyPolicyWithoutNetwork()
            val transition = policy.onNetworksChanged(listOf(network), 0L)
            assertNoConnection(transition)
            assertEquals(RemoteCenterPolicy.Phase.WAITING_FOR_NETWORK, transition.snapshot.phase)
        }

        assertTrue(usableNetwork.usable)
    }

    @Test
    fun aggregateNetworkViewSurvivesLossOfOneRouteWhileAnotherRemainsUsable() {
        val policy = readyPolicyWithoutNetwork()
        val unusable = RemoteCenterPolicy.NetworkState(hasInternetCapability = true)
        val first = policy.onNetworksChanged(listOf(usableNetwork, unusable), 0L)
        val generation = beginGeneration(first)

        val handoff = policy.onNetworksChanged(listOf(unusable, usableNetwork), 1L)
        assertSame(generation, handoff.snapshot.activeGeneration)
        assertSame(RemoteCenterPolicy.Effect.None, handoff.effect)

        val lostLastUsable = policy.onNetworksChanged(listOf(unusable), 2L)
        assertClose(lostLastUsable, generation)
        assertEquals(RemoteCenterPolicy.Phase.WAITING_FOR_NETWORK, lostLastUsable.snapshot.phase)
        assertFalse(lostLastUsable.snapshot.usableNetworkAvailable)
    }

    @Test
    fun transportOpenWaitsForAuthenticatedHeartbeatAndHeartbeatFencesOldTimer() {
        val policy = fullyReadyPolicy()
        val generation = policy.snapshot().activeGeneration!!
        val connectTimeout = policy.snapshot().timer!!

        val opened = policy.onTransportOpened(generation, 100L)
        assertEquals(RemoteCenterPolicy.Phase.AWAITING_HEARTBEAT, opened.snapshot.phase)
        assertEquals(RemoteCenterPolicy.TimerKind.HEARTBEAT_TIMEOUT, opened.snapshot.timer!!.kind)
        assertEquals(0, opened.snapshot.consecutiveFailures)

        val firstHeartbeat = policy.onAuthenticatedActivity(generation, 200L)
        val firstLivenessTimer = firstHeartbeat.snapshot.timer!!
        assertEquals(RemoteCenterPolicy.Phase.ONLINE, firstHeartbeat.snapshot.phase)
        assertEquals(RemoteCenterPolicy.TimerKind.LIVENESS_TIMEOUT, firstLivenessTimer.kind)

        val secondHeartbeat = policy.onAuthenticatedActivity(generation, 300L)
        val currentTimer = secondHeartbeat.snapshot.timer!!
        assertNotSame(firstLivenessTimer, currentTimer)

        assertOnline(policy.onTimer(connectTimeout, Long.MAX_VALUE), generation, currentTimer)
        assertOnline(policy.onTimer(firstLivenessTimer, Long.MAX_VALUE), generation, currentTimer)
    }

    @Test
    fun missingHeartbeatAndExpiredLivenessCloseExactlyOneGeneration() {
        val policy = RemoteCenterPolicy(
            timing = RemoteCenterPolicy.Timing(
                initialBackoffMs = 100L,
                maximumBackoffMs = 1_000L,
                connectionTimeoutMs = 50L,
                heartbeatTimeoutMs = 60L,
            ),
            entropy = RemoteCenterPolicy.Entropy { 0.0 },
        )
        ready(policy)
        val generation = policy.snapshot().activeGeneration!!
        val opened = policy.onTransportOpened(generation, 10L)
        val heartbeatTimer = opened.snapshot.timer!!

        val early = policy.onTimer(heartbeatTimer, 69L)
        assertSame(heartbeatTimer, early.snapshot.timer)
        assertEquals(RemoteCenterPolicy.Phase.AWAITING_HEARTBEAT, early.snapshot.phase)

        val expired = policy.onTimer(heartbeatTimer, 70L)
        assertClose(expired, generation)
        assertEquals(RemoteCenterPolicy.Phase.BACKING_OFF, expired.snapshot.phase)
        assertEquals(RemoteCenterPolicy.TimerKind.RETRY, expired.snapshot.timer!!.kind)
        assertEquals(1, expired.snapshot.consecutiveFailures)

        val duplicate = policy.onTimer(heartbeatTimer, Long.MAX_VALUE)
        assertSame(RemoteCenterPolicy.Effect.None, duplicate.effect)
        assertEquals(1, duplicate.snapshot.consecutiveFailures)
    }

    @Test
    fun absoluteDeadlinesWinWhenLateSuccessCallbacksArriveBeforeTimerCallbacks() {
        val policy = RemoteCenterPolicy(
            timing = RemoteCenterPolicy.Timing(
                initialBackoffMs = 10L,
                maximumBackoffMs = 10L,
                connectionTimeoutMs = 50L,
                heartbeatTimeoutMs = 60L,
            ),
            entropy = RemoteCenterPolicy.Entropy { 1.0 },
        )
        ready(policy)

        val lateOpenGeneration = policy.snapshot().activeGeneration!!
        val lateOpen = policy.onTransportOpened(lateOpenGeneration, 50L)
        assertClose(lateOpen, lateOpenGeneration)
        assertEquals(RemoteCenterPolicy.Phase.BACKING_OFF, lateOpen.snapshot.phase)

        val heartbeatGeneration = beginGeneration(
            policy.onTimer(lateOpen.snapshot.timer!!, 60L),
        )
        policy.onTransportOpened(heartbeatGeneration, 61L)
        val lateFirstHeartbeat = policy.onAuthenticatedActivity(heartbeatGeneration, 121L)
        assertClose(lateFirstHeartbeat, heartbeatGeneration)

        val onlineGeneration = beginGeneration(
            policy.onTimer(lateFirstHeartbeat.snapshot.timer!!, 131L),
        )
        policy.onTransportOpened(onlineGeneration, 132L)
        policy.onAuthenticatedActivity(onlineGeneration, 133L)
        val lateOnlineActivity = policy.onAuthenticatedActivity(onlineGeneration, 193L)
        assertClose(lateOnlineActivity, onlineGeneration)
        assertEquals(RemoteCenterPolicy.Phase.BACKING_OFF, lateOnlineActivity.snapshot.phase)
    }

    @Test
    fun exponentialEqualJitterIsBoundedCappedAndDoesNotResetOnSocketOpen() {
        val entropySamples = ArrayDeque(listOf(0.0, 1.0, 1.0, 1.0))
        val policy = RemoteCenterPolicy(
            timing = RemoteCenterPolicy.Timing(
                initialBackoffMs = 100L,
                maximumBackoffMs = 250L,
                connectionTimeoutMs = 1_000L,
                heartbeatTimeoutMs = 1_000L,
            ),
            entropy = RemoteCenterPolicy.Entropy { entropySamples.removeFirst() },
        )
        ready(policy)

        var now = 0L
        val expectedDelays = listOf(50L, 200L, 250L, 250L)
        expectedDelays.forEachIndexed { index, expectedDelay ->
            val generation = policy.snapshot().activeGeneration!!
            val opened = policy.onTransportOpened(generation, now)
            assertEquals(index, opened.snapshot.consecutiveFailures)

            val failed = policy.onTransientTransportFailure(generation, now)
            assertEquals(now + expectedDelay, failed.snapshot.timer!!.deadlineElapsedRealtimeMs)
            assertEquals(index + 1, failed.snapshot.consecutiveFailures)

            now += expectedDelay
            val retried = policy.onTimer(failed.snapshot.timer!!, now)
            assertTrue(retried.effect is RemoteCenterPolicy.Effect.BeginConnection)
        }
    }

    @Test
    fun authenticatedLivenessResetsBackoffButNetworkFlapsDoNot() {
        val policy = RemoteCenterPolicy(
            timing = RemoteCenterPolicy.Timing(
                initialBackoffMs = 100L,
                maximumBackoffMs = 1_000L,
                connectionTimeoutMs = 1_000L,
                heartbeatTimeoutMs = 1_000L,
                stableLivenessBeforeBackoffResetMs = 10L,
            ),
            entropy = RemoteCenterPolicy.Entropy { 1.0 },
        )
        ready(policy)
        val firstGeneration = policy.snapshot().activeGeneration!!
        val firstFailure = policy.onTransientTransportFailure(firstGeneration, 0L)
        val retry = firstFailure.snapshot.timer!!
        assertEquals(1, firstFailure.snapshot.consecutiveFailures)

        val offline = policy.onNetworksChanged(emptyList(), 10L)
        assertEquals(RemoteCenterPolicy.Phase.WAITING_FOR_NETWORK, offline.snapshot.phase)
        assertSame(retry, offline.snapshot.timer)
        assertEquals(1, offline.snapshot.consecutiveFailures)

        val onlineBeforeDeadline = policy.onNetworksChanged(listOf(usableNetwork), 20L)
        assertEquals(RemoteCenterPolicy.Phase.BACKING_OFF, onlineBeforeDeadline.snapshot.phase)
        assertSame(retry, onlineBeforeDeadline.snapshot.timer)

        val secondGeneration = beginGeneration(policy.onTimer(retry, 100L))
        policy.onTransportOpened(secondGeneration, 100L)
        val live = policy.onAuthenticatedActivity(secondGeneration, 101L)
        assertEquals(RemoteCenterPolicy.Phase.ONLINE, live.snapshot.phase)
        assertEquals(1, live.snapshot.consecutiveFailures)

        val stable = policy.onAuthenticatedActivity(secondGeneration, 111L)
        assertEquals(RemoteCenterPolicy.Phase.ONLINE, stable.snapshot.phase)
        assertEquals(0, stable.snapshot.consecutiveFailures)
    }

    @Test
    fun stopDisableAndRevokeFenceCallbacksWithDistinctPersistenceSemantics() {
        val policy = fullyReadyPolicy()
        val firstGeneration = policy.snapshot().activeGeneration!!

        val stopped = policy.stop()
        assertClose(stopped, firstGeneration)
        assertFalse(firstGeneration.isCurrent())
        assertEquals(RemoteCenterPolicy.Phase.STOPPED, stopped.snapshot.phase)
        assertTrue(stopped.snapshot.optedIn)
        assertEquals(RemoteCenterPolicy.Authorization.CURRENT, stopped.snapshot.authorization)
        assertStale(policy.onAuthenticatedActivity(firstGeneration, 1L))

        val restarted = policy.start(2L)
        val secondGeneration = beginGeneration(restarted)
        assertNotSame(firstGeneration, secondGeneration)

        val disabled = policy.disable()
        assertClose(disabled, secondGeneration)
        assertEquals(RemoteCenterPolicy.Phase.DISABLED, disabled.snapshot.phase)
        assertFalse(disabled.snapshot.optedIn)
        assertEquals(RemoteCenterPolicy.Authorization.CURRENT, disabled.snapshot.authorization)

        val thirdGeneration = beginGeneration(policy.enable(3L))
        val revoked = policy.revoke()
        assertClose(revoked, thirdGeneration)
        assertEquals(RemoteCenterPolicy.Phase.REVOKED, revoked.snapshot.phase)
        assertEquals(RemoteCenterPolicy.Authorization.REVOKED, revoked.snapshot.authorization)
        assertFalse(revoked.snapshot.optedIn)

        val enabledWithoutNewAuthorization = policy.enable(4L)
        assertNoConnection(enabledWithoutNewAuthorization)
        assertEquals(RemoteCenterPolicy.Phase.REVOKED, enabledWithoutNewAuthorization.snapshot.phase)

        val reprovisioning = policy.beginAuthorizationProvisioning()
        val reprovisioned = policy.onAuthorizationProvisioned(reprovisioning, 5L)
        assertTrue(reprovisioned.effect is RemoteCenterPolicy.Effect.BeginConnection)
        assertEquals(RemoteCenterPolicy.Authorization.CURRENT, reprovisioned.snapshot.authorization)
    }

    @Test
    fun staleGenerationsFailuresAndTimersCannotMutateReplacementAttempt() {
        val policy = fullyReadyPolicy()
        val firstGeneration = policy.snapshot().activeGeneration!!
        val firstTimer = policy.snapshot().timer!!
        policy.stop()
        val secondGeneration = beginGeneration(policy.start(1L))

        assertStale(policy.onTransportOpened(firstGeneration, 2L))
        assertStale(policy.onTimer(firstTimer, Long.MAX_VALUE))
        assertSame(secondGeneration, policy.snapshot().activeGeneration)
        assertEquals(RemoteCenterPolicy.Authorization.CURRENT, policy.snapshot().authorization)
    }

    @Test
    fun authorizationRotationFencesOldConnectionAndRestartsWithFreshGeneration() {
        val policy = RemoteCenterPolicy()
        val originalAuthorization = policy.beginAuthorizationProvisioning()
        val backendGeneration = RemoteCenterPolicy.BackendGeneration()
        ready(policy, authorization = originalAuthorization, backend = backendGeneration)
        val originalConnection = policy.snapshot().activeGeneration!!

        val replacementAuthorization = policy.beginAuthorizationProvisioning()
        val rotated = policy.onAuthorizationProvisioned(replacementAuthorization, 1L)
        val restart = rotated.effect as RemoteCenterPolicy.Effect.RestartConnection
        assertSame(originalConnection, restart.closingGeneration)
        assertSame(rotated.snapshot.activeGeneration, restart.openingGeneration)
        assertNotSame(originalConnection, restart.openingGeneration)
        assertFalse(originalConnection.isCurrent())
        assertTrue(restart.openingGeneration.isCurrent())

        assertStale(policy.onAuthenticatedActivity(originalConnection, 2L))
        val staleProvisioning = policy.onAuthorizationProvisioned(originalAuthorization, 2L)
        assertStale(staleProvisioning)
        assertSame(restart.openingGeneration, staleProvisioning.snapshot.activeGeneration)
        val idempotent = policy.onAuthorizationProvisioned(replacementAuthorization, 3L)
        assertSame(RemoteCenterPolicy.Effect.None, idempotent.effect)
        assertSame(restart.openingGeneration, idempotent.snapshot.activeGeneration)

        val staleRevocation = policy.onDurablyRecordedRevocation(originalAuthorization)
        assertStale(staleRevocation)
        assertSame(restart.openingGeneration, staleRevocation.snapshot.activeGeneration)

        val revoked = policy.onDurablyRecordedRevocation(replacementAuthorization)
        assertClose(revoked, restart.openingGeneration)
        assertEquals(RemoteCenterPolicy.Phase.REVOKED, revoked.snapshot.phase)
        val staleProvisioningCompletion =
            policy.onAuthorizationProvisioned(replacementAuthorization, 4L)
        assertNoConnection(staleProvisioningCompletion)
        assertEquals(
            RemoteCenterPolicy.Phase.REVOKED,
            staleProvisioningCompletion.snapshot.phase,
        )
    }

    @Test
    fun staleProvisioningCompletionCannotResurrectRevocationOrReplaceNewerJob() {
        val policy = RemoteCenterPolicy()
        policy.start(0L)
        policy.enable(0L)
        val backend = RemoteCenterPolicy.BackendGeneration()
        policy.onBackendGenerationChanged(backend, 0L)
        policy.onBackendReadyChanged(backend, true, 0L)
        policy.onNetworksChanged(listOf(usableNetwork), 0L)

        val pendingBeforeRevocation = policy.beginAuthorizationProvisioning()
        policy.revoke()
        val afterRevocation = policy.onAuthorizationProvisioned(pendingBeforeRevocation, 1L)
        assertStale(afterRevocation)
        assertEquals(RemoteCenterPolicy.Phase.REVOKED, afterRevocation.snapshot.phase)

        val superseded = policy.beginAuthorizationProvisioning()
        val current = policy.beginAuthorizationProvisioning()
        val staleCompletion = policy.onAuthorizationProvisioned(superseded, 2L)
        assertStale(staleCompletion)
        assertEquals(RemoteCenterPolicy.Phase.REVOKED, staleCompletion.snapshot.phase)

        val provisioned = policy.onAuthorizationProvisioned(current, 3L)
        assertNoConnection(provisioned)
        assertEquals(RemoteCenterPolicy.Phase.DISABLED, provisioned.snapshot.phase)
        assertTrue(policy.enable(4L).effect is RemoteCenterPolicy.Effect.BeginConnection)
    }

    @Test
    fun backendReadinessIsBoundToCurrentBackendGeneration() {
        val policy = RemoteCenterPolicy()
        val oldBackend = RemoteCenterPolicy.BackendGeneration()
        ready(policy, backend = oldBackend)
        val oldConnection = policy.snapshot().activeGeneration!!

        val newBackend = RemoteCenterPolicy.BackendGeneration()
        val replaced = policy.onBackendGenerationChanged(newBackend, 1L)
        assertClose(replaced, oldConnection)
        assertEquals(RemoteCenterPolicy.Phase.WAITING_FOR_BACKEND, replaced.snapshot.phase)

        val staleReady = policy.onBackendReadyChanged(oldBackend, true, 2L)
        assertStale(staleReady)
        assertEquals(RemoteCenterPolicy.Phase.WAITING_FOR_BACKEND, staleReady.snapshot.phase)

        val currentReady = policy.onBackendReadyChanged(newBackend, true, 3L)
        val newConnection = beginGeneration(currentReady)
        val staleLoss = policy.onBackendReadyChanged(oldBackend, false, 4L)
        assertStale(staleLoss)
        assertSame(newConnection, staleLoss.snapshot.activeGeneration)

        val staleReplacement = policy.onBackendGenerationChanged(oldBackend, 5L)
        assertStale(staleReplacement)
        assertSame(newConnection, staleReplacement.snapshot.activeGeneration)
    }

    @Test
    fun durablyRecordedRevocationCancelsBackoffWithoutAnActiveConnection() {
        val policy = RemoteCenterPolicy()
        val authorization = policy.beginAuthorizationProvisioning()
        ready(policy, authorization = authorization)
        val connection = policy.snapshot().activeGeneration!!
        val backingOff = policy.onTransientTransportFailure(connection, 0L)
        assertEquals(RemoteCenterPolicy.Phase.BACKING_OFF, backingOff.snapshot.phase)
        assertTrue(backingOff.snapshot.timer != null)

        val revoked = policy.onDurablyRecordedRevocation(authorization)
        assertSame(RemoteCenterPolicy.Effect.None, revoked.effect)
        assertEquals(RemoteCenterPolicy.Phase.REVOKED, revoked.snapshot.phase)
        assertNull(revoked.snapshot.timer)
        assertFalse(revoked.snapshot.optedIn)
    }

    @Test
    fun relayOutageAndBackendLossCanOnlyAffectConnectorLifecycle() {
        val outagePolicy = fullyReadyPolicy()
        val generation = outagePolicy.snapshot().activeGeneration!!
        val outage = outagePolicy.onTransientTransportFailure(generation, 0L)
        assertTrue(outage.effect is RemoteCenterPolicy.Effect.CloseConnection)

        val backendPolicy = RemoteCenterPolicy()
        val backend = RemoteCenterPolicy.BackendGeneration()
        ready(backendPolicy, backend = backend)
        val backendConnection = backendPolicy.snapshot().activeGeneration!!
        val backendLoss = backendPolicy.onBackendReadyChanged(backend, false, 1L)
        assertClose(backendLoss, backendConnection)
        assertEquals(RemoteCenterPolicy.Phase.WAITING_FOR_BACKEND, backendLoss.snapshot.phase)
    }

    @Test
    fun deadlineArithmeticSaturatesAndInvalidEntropyFallsBackToBoundedJitter() {
        val invalidEntropySources = listOf(
            RemoteCenterPolicy.Entropy { Double.NaN },
            RemoteCenterPolicy.Entropy { -1.0 },
            RemoteCenterPolicy.Entropy { 2.0 },
            RemoteCenterPolicy.Entropy { error("entropy unavailable") },
        )
        invalidEntropySources.forEach { entropy ->
            val policy = RemoteCenterPolicy(
                timing = RemoteCenterPolicy.Timing(
                    initialBackoffMs = 9L,
                    maximumBackoffMs = 9L,
                    connectionTimeoutMs = 10L,
                    heartbeatTimeoutMs = 10L,
                ),
                entropy = entropy,
            )
            ready(policy)
            val generation = policy.snapshot().activeGeneration!!
            val failed = policy.onTransientTransportFailure(generation, 0L)
            assertEquals(7L, failed.snapshot.timer!!.deadlineElapsedRealtimeMs)
        }

        val saturatingPolicy = RemoteCenterPolicy(
            timing = RemoteCenterPolicy.Timing(
                initialBackoffMs = 9L,
                maximumBackoffMs = Long.MAX_VALUE,
                connectionTimeoutMs = 10L,
                heartbeatTimeoutMs = 10L,
            ),
            entropy = RemoteCenterPolicy.Entropy { 1.0 },
        )
        ready(saturatingPolicy, now = Long.MAX_VALUE - 5L)
        assertEquals(Long.MAX_VALUE, saturatingPolicy.snapshot().timer!!.deadlineElapsedRealtimeMs)

        val generation = saturatingPolicy.snapshot().activeGeneration!!
        val failed = saturatingPolicy.onTransientTransportFailure(
            generation,
            Long.MAX_VALUE - 5L,
        )
        assertEquals(Long.MAX_VALUE, failed.snapshot.timer!!.deadlineElapsedRealtimeMs)
    }

    private fun readyPolicyWithoutNetwork(): RemoteCenterPolicy = RemoteCenterPolicy().also { policy ->
        val authorization = policy.beginAuthorizationProvisioning()
        val backend = RemoteCenterPolicy.BackendGeneration()
        policy.start(0L)
        policy.enable(0L)
        policy.onAuthorizationProvisioned(authorization, 0L)
        policy.onBackendGenerationChanged(backend, 0L)
        policy.onBackendReadyChanged(backend, true, 0L)
    }

    private fun fullyReadyPolicy(): RemoteCenterPolicy = RemoteCenterPolicy().also { ready(it) }

    private fun ready(
        policy: RemoteCenterPolicy,
        now: Long = 0L,
        authorization: RemoteCenterPolicy.AuthorizationGeneration? = null,
        backend: RemoteCenterPolicy.BackendGeneration = RemoteCenterPolicy.BackendGeneration(),
    ) {
        val exactAuthorization = authorization ?: policy.beginAuthorizationProvisioning()
        policy.start(now)
        policy.enable(now)
        policy.onAuthorizationProvisioned(exactAuthorization, now)
        policy.onBackendGenerationChanged(backend, now)
        policy.onBackendReadyChanged(backend, true, now)
        policy.onNetworksChanged(listOf(usableNetwork), now)
    }

    private fun beginGeneration(
        transition: RemoteCenterPolicy.Transition,
    ): RemoteCenterPolicy.Generation {
        val effect = transition.effect
        assertTrue(effect is RemoteCenterPolicy.Effect.BeginConnection)
        return (effect as RemoteCenterPolicy.Effect.BeginConnection).generation
    }

    private fun assertClose(
        transition: RemoteCenterPolicy.Transition,
        generation: RemoteCenterPolicy.Generation,
    ) {
        val effect = transition.effect
        assertTrue(effect is RemoteCenterPolicy.Effect.CloseConnection)
        assertSame(generation, (effect as RemoteCenterPolicy.Effect.CloseConnection).generation)
    }

    private fun assertNoConnection(transition: RemoteCenterPolicy.Transition) {
        assertFalse(transition.effect is RemoteCenterPolicy.Effect.BeginConnection)
        assertFalse(transition.effect is RemoteCenterPolicy.Effect.RestartConnection)
    }

    private fun assertStale(transition: RemoteCenterPolicy.Transition) {
        assertSame(RemoteCenterPolicy.Effect.None, transition.effect)
    }

    private fun assertOnline(
        transition: RemoteCenterPolicy.Transition,
        generation: RemoteCenterPolicy.Generation,
        timer: RemoteCenterPolicy.TimerTicket,
    ) {
        assertSame(RemoteCenterPolicy.Effect.None, transition.effect)
        assertEquals(RemoteCenterPolicy.Phase.ONLINE, transition.snapshot.phase)
        assertSame(generation, transition.snapshot.activeGeneration)
        assertSame(timer, transition.snapshot.timer)
    }
}
