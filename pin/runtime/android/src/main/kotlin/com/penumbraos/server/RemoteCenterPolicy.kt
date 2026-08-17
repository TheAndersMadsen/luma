package com.penumbraos.server

import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pure lifecycle policy for an optional remote Center relay.
 *
 * This class deliberately has no Android, transport, persistence, endpoint, credential, request,
 * or payload dependency. In particular, [Effect.BeginConnection] is authority only to start the
 * separately configured, fixed-purpose relay transport. It is not authority to choose a
 * destination, proxy local HTTP, run commands, access files, create a tunnel, or update software.
 * Any future remote operation needs its own typed and independently reviewed authorization.
 *
 * Callers persist opt-in or revocation before invoking [enable], [disable], or [revoke]. Every
 * policy invocation, timer reconciliation, and effect application runs in order on one
 * connector-owned serial executor, never inline in a ServerRuntime callback. The synchronized
 * methods are a defensive fence, not a replacement for that single owner. Before executing a
 * delayed begin, the runner rechecks [Generation.isCurrent]; fencing permanently tombstones the
 * generation before returning a close effect. Relay failure produces connector-local effects
 * only. There is intentionally no ServerRuntime effect or callback in this API.
 */
internal class RemoteCenterPolicy(
    private val timing: Timing = Timing(),
    private val entropy: Entropy = Entropy {
        ThreadLocalRandom.current().nextDouble()
    },
) {
    fun interface Entropy {
        /** Returns a sample in the inclusive range 0.0 through 1.0. */
        fun nextUnitDouble(): Double
    }

    data class Timing(
        val initialBackoffMs: Long = 1_000L,
        val maximumBackoffMs: Long = 60_000L,
        val connectionTimeoutMs: Long = 20_000L,
        val heartbeatTimeoutMs: Long = 60_000L,
        val stableLivenessBeforeBackoffResetMs: Long = 30_000L,
    ) {
        init {
            require(initialBackoffMs > 0L) { "initialBackoffMs must be positive" }
            require(maximumBackoffMs >= initialBackoffMs) {
                "maximumBackoffMs must be at least initialBackoffMs"
            }
            require(connectionTimeoutMs > 0L) { "connectionTimeoutMs must be positive" }
            require(heartbeatTimeoutMs > 0L) { "heartbeatTimeoutMs must be positive" }
            require(stableLivenessBeforeBackoffResetMs > 0L) {
                "stableLivenessBeforeBackoffResetMs must be positive"
            }
        }
    }

    /** Framework-neutral projection of the capabilities for one Android network. */
    data class NetworkState(
        val hasInternetCapability: Boolean = false,
        val validated: Boolean = false,
        val captivePortal: Boolean = false,
        /** Null means the adapter could not establish the current state. */
        val suspended: Boolean? = null,
        /** Null means Android has not supplied a current blocked-state observation. */
        val blocked: Boolean? = null,
    ) {
        val usable: Boolean
            get() = hasInternetCapability &&
                validated &&
                !captivePortal &&
                suspended == false &&
                blocked == false
    }

    enum class Authorization {
        MISSING,
        CURRENT,
        REVOKED,
    }

    enum class Phase {
        DISABLED,
        STOPPED,
        NEEDS_AUTHORIZATION,
        WAITING_FOR_BACKEND,
        WAITING_FOR_NETWORK,
        CONNECTING,
        AWAITING_HEARTBEAT,
        ONLINE,
        BACKING_OFF,
        REVOKED,
    }

    enum class TimerKind {
        CONNECTION_TIMEOUT,
        HEARTBEAT_TIMEOUT,
        LIVENESS_TIMEOUT,
        RETRY,
    }

    /**
     * Opaque identity for one connection attempt. Equality is intentionally referential so a
     * callback from a previous policy instance or attempt can never match a current attempt.
     */
    class Generation internal constructor() {
        private val current = AtomicBoolean(true)

        /** The effect runner must check this immediately before starting transport work. */
        fun isCurrent(): Boolean = current.get()

        internal fun invalidate() {
            current.set(false)
        }

        override fun toString(): String = "RemoteCenterGeneration"
    }

    /** Opaque identity for one securely provisioned authorization revision. */
    class AuthorizationGeneration internal constructor(
        private val issuer: Any,
    ) {
        private val current = AtomicBoolean(true)

        internal fun isCurrent(): Boolean = current.get()

        internal fun isIssuedBy(expectedIssuer: Any): Boolean = issuer === expectedIssuer

        internal fun invalidate() {
            current.set(false)
        }

        override fun toString(): String = "RemoteCenterAuthorizationGeneration"
    }

    /** Opaque identity for one local backend process/readiness epoch. */
    class BackendGeneration internal constructor() {
        private val current = AtomicBoolean(true)

        internal fun isCurrent(): Boolean = current.get()

        internal fun invalidate() {
            current.set(false)
        }

        override fun toString(): String = "RemoteCenterBackendGeneration"
    }

    /**
     * Opaque identity for one scheduled deadline. A generation alone cannot distinguish an old
     * liveness timer from a newer timer installed by a heartbeat on the same connection.
     */
    class TimerTicket internal constructor(
        val kind: TimerKind,
        val generation: Generation,
        val deadlineElapsedRealtimeMs: Long,
    ) {
        override fun toString(): String =
            "RemoteCenterTimer(kind=$kind, deadlineElapsedRealtimeMs=$deadlineElapsedRealtimeMs)"
    }

    sealed class Effect {
        object None : Effect()

        /** Begin only if [Generation.isCurrent] is still true immediately before transport work. */
        data class BeginConnection(val generation: Generation) : Effect()

        /** Idempotently close only the relay transport for this attempt. */
        data class CloseConnection(val generation: Generation) : Effect()

        /** Close the old relay before beginning the replacement authorization generation. */
        data class RestartConnection(
            val closingGeneration: Generation,
            val openingGeneration: Generation,
        ) : Effect()
    }

    data class Snapshot(
        val phase: Phase,
        val lifecycleStarted: Boolean,
        val optedIn: Boolean,
        val authorization: Authorization,
        val backendReady: Boolean,
        val usableNetworkAvailable: Boolean,
        val consecutiveFailures: Int,
        val activeGeneration: Generation?,
        val timer: TimerTicket?,
    )

    /**
     * After every transition, the runner must cancel every previously armed ticket other than
     * [Snapshot.timer], then arm that exact ticket for its absolute deadline. This reconciliation
     * is required even for [Effect.None]: an early timer delivery returns the same ticket so it can
     * be re-armed, while superseded tickets are rejected by identity.
     */
    class Transition internal constructor(
        val snapshot: Snapshot,
        val effect: Effect,
    )

    private var phase = Phase.DISABLED
    private val authorizationTicketIssuer = Any()
    private var lifecycleStarted = false
    private var optedIn = false
    private var authorization = Authorization.MISSING
    private var authorizationGeneration: AuthorizationGeneration? = null
    private var pendingAuthorizationGeneration: AuthorizationGeneration? = null
    private var backendReady = false
    private var backendGeneration: BackendGeneration? = null
    private var usableNetworkAvailable = false
    private var consecutiveFailures = 0
    private var activeGeneration: Generation? = null
    private var timer: TimerTicket? = null
    private var onlineSinceElapsedRealtimeMs: Long? = null

    @Synchronized
    fun snapshot(): Snapshot = snapshotLocked()

    /** Starts connector lifecycle only. Default-off opt-in remains authoritative. */
    @Synchronized
    fun start(nowElapsedRealtimeMs: Long): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        lifecycleStarted = true
        return reconcileLocked(nowElapsedRealtimeMs)
    }

    /** Stops volatile connector work while retaining opt-in and authorization. */
    @Synchronized
    fun stop(): Transition {
        lifecycleStarted = false
        consecutiveFailures = 0
        timer = null
        val fenced = fenceActiveLocked()
        phase = ineligiblePhaseLocked() ?: Phase.STOPPED
        return transitionLocked(closeEffect(fenced))
    }

    /** Enables only after the caller has durably persisted explicit user opt-in. */
    @Synchronized
    fun enable(nowElapsedRealtimeMs: Long): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        optedIn = true
        return reconcileLocked(nowElapsedRealtimeMs)
    }

    /** Disables after durable opt-out, retaining enrollment for a later explicit re-enable. */
    @Synchronized
    fun disable(): Transition {
        optedIn = false
        consecutiveFailures = 0
        timer = null
        val fenced = fenceActiveLocked()
        phase = ineligiblePhaseLocked() ?: Phase.DISABLED
        return transitionLocked(closeEffect(fenced))
    }

    /**
     * Creates the sole ticket that a trusted component may use for one asynchronous provisioning
     * job. Starting another job or revoking admission tombstones the prior pending ticket.
     */
    @Synchronized
    fun beginAuthorizationProvisioning(): AuthorizationGeneration {
        pendingAuthorizationGeneration?.invalidate()
        return AuthorizationGeneration(authorizationTicketIssuer).also {
            pendingAuthorizationGeneration = it
        }
    }

    /**
     * Records that the authorization for a policy-minted pending ticket has been durably
     * provisioned. Provisioning never opts the user in by itself.
     */
    @Synchronized
    fun onAuthorizationProvisioned(
        generation: AuthorizationGeneration,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        if (authorizationGeneration === generation) {
            // The same generation cannot resurrect admission after revocation.
            return if (authorization == Authorization.CURRENT) {
                reconcileLocked(nowElapsedRealtimeMs)
            } else {
                transitionLocked()
            }
        }
        if (!generation.isIssuedBy(authorizationTicketIssuer) ||
            pendingAuthorizationGeneration !== generation ||
            !generation.isCurrent()
        ) {
            return transitionLocked()
        }

        pendingAuthorizationGeneration = null
        authorizationGeneration?.invalidate()
        authorizationGeneration = generation
        authorization = Authorization.CURRENT
        consecutiveFailures = 0
        timer = null
        val fenced = fenceActiveLocked()
        val reconciled = reconcileLocked(nowElapsedRealtimeMs)
        if (fenced == null) return reconciled

        val begin = reconciled.effect as? Effect.BeginConnection
        return if (begin != null) {
            Transition(
                reconciled.snapshot,
                Effect.RestartConnection(fenced, begin.generation),
            )
        } else {
            Transition(reconciled.snapshot, Effect.CloseConnection(fenced))
        }
    }

    /**
     * Records durable local revocation. Remote cleanup, if any, is bounded best effort and cannot
     * precede this fence or re-enable reconnects when it fails.
     */
    @Synchronized
    fun revoke(): Transition {
        authorization = Authorization.REVOKED
        authorizationGeneration?.invalidate()
        pendingAuthorizationGeneration?.invalidate()
        pendingAuthorizationGeneration = null
        optedIn = false
        consecutiveFailures = 0
        timer = null
        val fenced = fenceActiveLocked()
        phase = Phase.REVOKED
        return transitionLocked(closeEffect(fenced))
    }

    /**
     * Applies a relay-reported revocation only after the caller has durably disabled and revoked
     * this authorization. Binding to the authorization generation allows a revocation to cancel a
     * pending retry while preventing an old enrollment from revoking its replacement.
     */
    @Synchronized
    fun onDurablyRecordedRevocation(generation: AuthorizationGeneration): Transition {
        if (authorizationGeneration !== generation || authorization != Authorization.CURRENT) {
            return transitionLocked()
        }
        authorization = Authorization.REVOKED
        generation.invalidate()
        pendingAuthorizationGeneration?.invalidate()
        pendingAuthorizationGeneration = null
        optedIn = false
        consecutiveFailures = 0
        timer = null
        val fenced = fenceActiveLocked()
        phase = Phase.REVOKED
        return transitionLocked(closeEffect(fenced))
    }

    /**
     * Accepts only a separately proven local-backend readiness result. Process creation alone is
     * not readiness, and this one-way input gives the relay no authority over ServerRuntime.
     */
    @Synchronized
    fun onBackendGenerationChanged(
        generation: BackendGeneration,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        if (backendGeneration === generation) {
            return reconcilePrerequisiteChangeLocked(nowElapsedRealtimeMs)
        }
        if (!generation.isCurrent()) return transitionLocked()
        backendGeneration?.invalidate()
        backendGeneration = generation
        backendReady = false
        return reconcilePrerequisiteChangeLocked(nowElapsedRealtimeMs)
    }

    /** Ignores readiness completions from every backend generation except the current one. */
    @Synchronized
    fun onBackendReadyChanged(
        generation: BackendGeneration,
        ready: Boolean,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        if (backendGeneration !== generation) return transitionLocked()
        backendReady = ready
        return reconcilePrerequisiteChangeLocked(nowElapsedRealtimeMs)
    }

    /**
     * Replaces the aggregate Android network view. One usable Wi-Fi or cellular network is enough;
     * loss of another network cannot tear down a still-usable route.
     */
    @Synchronized
    fun onNetworksChanged(
        networks: Iterable<NetworkState>,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        usableNetworkAvailable = networks.any(NetworkState::usable)
        return reconcilePrerequisiteChangeLocked(nowElapsedRealtimeMs)
    }

    /** Transport establishment is not liveness; an authenticated frame is still required. */
    @Synchronized
    fun onTransportOpened(
        generation: Generation,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        if (activeGeneration !== generation || phase != Phase.CONNECTING) {
            return transitionLocked()
        }
        if (!hasLiveTimerLocked(
                generation,
                TimerKind.CONNECTION_TIMEOUT,
                nowElapsedRealtimeMs,
            )
        ) {
            return transientFailureLocked(generation, nowElapsedRealtimeMs)
        }
        timer = newTimerLocked(
            TimerKind.HEARTBEAT_TIMEOUT,
            generation,
            deadline(nowElapsedRealtimeMs, timing.heartbeatTimeoutMs),
        )
        phase = Phase.AWAITING_HEARTBEAT
        return transitionLocked()
    }

    /**
     * Marks liveness only for an authenticated, policy-valid heartbeat or frame. Local health,
     * socket writes, and unauthenticated bytes must never call this method.
     */
    @Synchronized
    fun onAuthenticatedActivity(
        generation: Generation,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        if (activeGeneration !== generation ||
            phase !in setOf(Phase.CONNECTING, Phase.AWAITING_HEARTBEAT, Phase.ONLINE)
        ) {
            return transitionLocked()
        }
        val expectedTimerKind = when (phase) {
            Phase.CONNECTING -> TimerKind.CONNECTION_TIMEOUT
            Phase.AWAITING_HEARTBEAT -> TimerKind.HEARTBEAT_TIMEOUT
            Phase.ONLINE -> TimerKind.LIVENESS_TIMEOUT
            else -> error("active remote Center phase changed while locked")
        }
        if (!hasLiveTimerLocked(generation, expectedTimerKind, nowElapsedRealtimeMs)) {
            return transientFailureLocked(generation, nowElapsedRealtimeMs)
        }
        val alreadyOnline = phase == Phase.ONLINE
        if (!alreadyOnline) {
            onlineSinceElapsedRealtimeMs = nowElapsedRealtimeMs
        } else {
            val onlineSince = onlineSinceElapsedRealtimeMs
            if (onlineSince != null &&
                nowElapsedRealtimeMs >= deadline(
                    onlineSince,
                    timing.stableLivenessBeforeBackoffResetMs,
                )
            ) {
                consecutiveFailures = 0
            }
        }
        timer = newTimerLocked(
            TimerKind.LIVENESS_TIMEOUT,
            generation,
            deadline(nowElapsedRealtimeMs, timing.heartbeatTimeoutMs),
        )
        phase = Phase.ONLINE
        return transitionLocked()
    }

    /** Applies a bounded transient retry only to its exact active generation. */
    @Synchronized
    fun onTransientTransportFailure(
        generation: Generation,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        if (activeGeneration !== generation) return transitionLocked()
        return transientFailureLocked(generation, nowElapsedRealtimeMs)
    }

    /**
     * Delivers a scheduled deadline. Tickets are identity-bound, so cancelled or superseded timer
     * callbacks are inert even when they refer to the same connection generation.
     */
    @Synchronized
    fun onTimer(
        ticket: TimerTicket,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        requireElapsedTime(nowElapsedRealtimeMs)
        if (timer !== ticket) return transitionLocked()
        if (nowElapsedRealtimeMs < ticket.deadlineElapsedRealtimeMs) {
            return transitionLocked()
        }

        return when (ticket.kind) {
            TimerKind.RETRY -> {
                timer = null
                reconcileLocked(nowElapsedRealtimeMs)
            }
            TimerKind.CONNECTION_TIMEOUT,
            TimerKind.HEARTBEAT_TIMEOUT,
            TimerKind.LIVENESS_TIMEOUT -> {
                if (activeGeneration !== ticket.generation) {
                    timer = null
                    transitionLocked()
                } else {
                    transientFailureLocked(ticket.generation, nowElapsedRealtimeMs)
                }
            }
        }
    }

    private fun reconcilePrerequisiteChangeLocked(nowElapsedRealtimeMs: Long): Transition {
        val ineligible = ineligiblePhaseLocked()
        if (ineligible == null) return reconcileLocked(nowElapsedRealtimeMs)

        val fenced = fenceActiveLocked()
        phase = ineligible
        return transitionLocked(closeEffect(fenced))
    }

    private fun reconcileLocked(nowElapsedRealtimeMs: Long): Transition {
        val ineligible = ineligiblePhaseLocked()
        if (ineligible != null) {
            val fenced = fenceActiveLocked()
            phase = ineligible
            return transitionLocked(closeEffect(fenced))
        }

        if (activeGeneration != null) return transitionLocked()

        val pendingTimer = timer
        if (pendingTimer != null) {
            if (pendingTimer.kind != TimerKind.RETRY) {
                timer = null
            } else if (nowElapsedRealtimeMs < pendingTimer.deadlineElapsedRealtimeMs) {
                phase = Phase.BACKING_OFF
                return transitionLocked()
            } else {
                timer = null
            }
        }

        val generation = Generation()
        activeGeneration = generation
        onlineSinceElapsedRealtimeMs = null
        timer = newTimerLocked(
            TimerKind.CONNECTION_TIMEOUT,
            generation,
            deadline(nowElapsedRealtimeMs, timing.connectionTimeoutMs),
        )
        phase = Phase.CONNECTING
        return transitionLocked(Effect.BeginConnection(generation))
    }

    private fun transientFailureLocked(
        generation: Generation,
        nowElapsedRealtimeMs: Long,
    ): Transition {
        check(activeGeneration === generation)
        fenceActiveLocked()
        consecutiveFailures = if (consecutiveFailures == Int.MAX_VALUE) {
            Int.MAX_VALUE
        } else {
            consecutiveFailures + 1
        }
        val retryDelay = retryDelayMs(consecutiveFailures)
        timer = newTimerLocked(
            TimerKind.RETRY,
            generation,
            deadline(nowElapsedRealtimeMs, retryDelay),
        )
        phase = ineligiblePhaseLocked() ?: Phase.BACKING_OFF
        return transitionLocked(Effect.CloseConnection(generation))
    }

    private fun ineligiblePhaseLocked(): Phase? = when {
        authorization == Authorization.REVOKED -> Phase.REVOKED
        !optedIn -> Phase.DISABLED
        !lifecycleStarted -> Phase.STOPPED
        authorization != Authorization.CURRENT -> Phase.NEEDS_AUTHORIZATION
        !backendReady -> Phase.WAITING_FOR_BACKEND
        !usableNetworkAvailable -> Phase.WAITING_FOR_NETWORK
        else -> null
    }

    private fun fenceActiveLocked(): Generation? {
        val fenced = activeGeneration ?: return null
        activeGeneration = null
        fenced.invalidate()
        onlineSinceElapsedRealtimeMs = null
        if (timer?.generation === fenced && timer?.kind != TimerKind.RETRY) {
            timer = null
        }
        return fenced
    }

    private fun retryDelayMs(failureCount: Int): Long {
        var cap = timing.initialBackoffMs
        var doublings = failureCount - 1
        while (doublings > 0 && cap < timing.maximumBackoffMs) {
            val doubled = if (cap > Long.MAX_VALUE / 2L) Long.MAX_VALUE else cap * 2L
            cap = minOf(timing.maximumBackoffMs, doubled)
            doublings -= 1
        }

        // Equal jitter avoids both synchronized retry waves and zero-delay retry storms.
        val lowerBound = cap / 2L + cap % 2L
        val span = cap - lowerBound
        val sampled = try {
            entropy.nextUnitDouble()
        } catch (_: Throwable) {
            0.5
        }
        val unit = if (sampled.isFinite() && sampled in 0.0..1.0) sampled else 0.5
        val offset = (span.toDouble() * unit).toLong().coerceIn(0L, span)
        return lowerBound + offset
    }

    private fun deadline(nowElapsedRealtimeMs: Long, delayMs: Long): Long =
        if (nowElapsedRealtimeMs > Long.MAX_VALUE - delayMs) {
            Long.MAX_VALUE
        } else {
            nowElapsedRealtimeMs + delayMs
        }

    private fun newTimerLocked(
        kind: TimerKind,
        generation: Generation,
        deadlineElapsedRealtimeMs: Long,
    ): TimerTicket = TimerTicket(kind, generation, deadlineElapsedRealtimeMs)

    private fun hasLiveTimerLocked(
        generation: Generation,
        expectedKind: TimerKind,
        nowElapsedRealtimeMs: Long,
    ): Boolean {
        val current = timer ?: return false
        return current.generation === generation &&
            current.kind == expectedKind &&
            nowElapsedRealtimeMs < current.deadlineElapsedRealtimeMs
    }

    private fun closeEffect(generation: Generation?): Effect =
        generation?.let(Effect::CloseConnection) ?: Effect.None

    private fun transitionLocked(effect: Effect = Effect.None): Transition =
        Transition(snapshotLocked(), effect)

    private fun snapshotLocked(): Snapshot = Snapshot(
        phase = phase,
        lifecycleStarted = lifecycleStarted,
        optedIn = optedIn,
        authorization = authorization,
        backendReady = backendReady,
        usableNetworkAvailable = usableNetworkAvailable,
        consecutiveFailures = consecutiveFailures,
        activeGeneration = activeGeneration,
        timer = timer,
    )

    private fun requireElapsedTime(nowElapsedRealtimeMs: Long) {
        require(nowElapsedRealtimeMs >= 0L) { "elapsed realtime must not be negative" }
    }
}
