package com.penumbraos.server

import java.io.Closeable
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Bounds sockets and worker threads before an eSIM peer proves possession of
 * the bridge token. Loopback is reachable by ordinary apps with INTERNET, so
 * authentication timeouts alone do not prevent connection-flood exhaustion.
 */
internal class EsimConnectionAdmission(globalLimit: Int) {
    private val globalSlots = Semaphore(requirePositive(globalLimit, "globalLimit"))

    fun listener(limit: Int): Listener =
        Listener(this, Semaphore(requirePositive(limit, "listenerLimit")))

    class Listener internal constructor(
        private val admission: EsimConnectionAdmission,
        private val listenerSlots: Semaphore,
    ) {
        fun tryAcquire(): Lease? {
            if (!listenerSlots.tryAcquire()) return null
            if (!admission.globalSlots.tryAcquire()) {
                listenerSlots.release()
                return null
            }
            return Lease(admission.globalSlots, listenerSlots)
        }
    }

    class Lease internal constructor(
        private val globalSlots: Semaphore,
        private val listenerSlots: Semaphore,
    ) : Closeable {
        private val closed = AtomicBoolean(false)

        override fun close() {
            if (!closed.compareAndSet(false, true)) return
            listenerSlots.release()
            globalSlots.release()
        }
    }

    private companion object {
        fun requirePositive(value: Int, name: String): Int {
            require(value > 0) { "$name must be positive" }
            return value
        }
    }
}

/** Shared caps make the two listeners unable to exhaust the process together. */
internal object EsimConnectionAdmissions {
    private const val GLOBAL_ACTIVE_CONNECTION_LIMIT = 8
    private const val EVENTS_ACTIVE_CONNECTION_LIMIT = 4
    private const val CONTROL_ACTIVE_CONNECTION_LIMIT = 5

    private val shared = EsimConnectionAdmission(GLOBAL_ACTIVE_CONNECTION_LIMIT)
    val events: EsimConnectionAdmission.Listener =
        shared.listener(EVENTS_ACTIVE_CONNECTION_LIMIT)
    val control: EsimConnectionAdmission.Listener =
        shared.listener(CONTROL_ACTIVE_CONNECTION_LIMIT)
}
