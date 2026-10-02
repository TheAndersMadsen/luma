package com.penumbraos.server

import java.io.Closeable
import java.io.IOException
import java.util.Collections
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The USB bridge's listener lifecycle (CenterUsbBridge), driven over fake
 * sockets: ServerService restarts it with stop() then start(), and the
 * stopped generation's accept thread must neither spin nor release the
 * replacement.
 */
class BridgeListenerTest {
    @Test
    fun aStoppedGenerationExitsWithoutTouchingItsReplacement() {
        val bridge = Harness()
        val first = FakeListener()
        val second = FakeListener()
        assertTrue(bridge.start(first))
        first.awaitAccept()
        assertFalse("a second start while one listens binds nothing", bridge.start(FakeListener()))

        bridge.stop()
        assertTrue(first.closed)
        assertTrue(bridge.start(second))
        // Only now does the stale loop's blocked accept fail, as when a
        // restart replaces the bridge before the old accept thread wakes.
        first.failAccept()
        bridge.threads[0].assertExits()
        assertEquals("the stale loop kept accepting on its closed socket", 1, first.accepts.get())
        assertEquals("a stop() is not an accept failure", 0, bridge.acceptFailures.get())

        // The replacement still owns the bridge and serves connections.
        assertFalse("the stale loop released its replacement", bridge.start(FakeListener()))
        val connection = FakeConnection()
        second.deliver(connection)
        assertSame(connection, bridge.served.poll(5, TimeUnit.SECONDS))

        bridge.stop()
        second.failAccept()
        bridge.threads[1].assertExits()
    }

    @Test
    fun aConnectionAcceptedAsTheBridgeStopsIsClosedNotServed() {
        val bridge = Harness()
        val listener = FakeListener()
        assertTrue(bridge.start(listener))
        listener.awaitAccept()

        bridge.stop()
        val late = FakeConnection()
        listener.deliver(late)
        bridge.threads[0].assertExits()

        assertTrue(late.closed)
        assertTrue(bridge.served.isEmpty())
    }

    @Test
    fun aLoopThatDiesWhileListeningReleasesTheBridgeForTheNextStart() {
        val bridge = Harness(serve = { throw IllegalStateException("worker failure") })
        val listener = FakeListener()
        assertTrue(bridge.start(listener))

        listener.deliver(FakeConnection())
        bridge.threads[0].assertExits()

        assertTrue("the dead generation left its socket bound", listener.closed)
        val next = FakeListener()
        assertTrue("start() would answer \"already running\" forever", bridge.start(next))
        bridge.stop()
        next.failAccept()
        bridge.threads[1].assertExits()
    }

    @Test
    fun aFailedStartLeavesTheBridgeFreeToStartAgain() {
        val bridge = Harness()
        val unspawned = FakeListener()
        assertThrows(IllegalStateException::class.java) {
            bridge.listener.start(
                open = { unspawned },
                spawn = { throw IllegalStateException("no thread") },
            )
        }
        assertTrue(unspawned.closed)

        val listener = FakeListener()
        assertTrue(bridge.start(listener))
        bridge.stop()
        listener.failAccept()
        bridge.threads[0].assertExits()
    }

    private class FakeConnection : Closeable {
        @Volatile
        var closed = false

        override fun close() {
            closed = true
        }
    }

    /** A listener whose accept() blocks until the test releases it. */
    private class FakeListener : Closeable {
        private val steps = LinkedBlockingQueue<() -> FakeConnection>()
        private val entered = Semaphore(0)
        val accepts = AtomicInteger()

        @Volatile
        var closed = false

        override fun close() {
            closed = true
        }

        fun accept(): FakeConnection {
            accepts.incrementAndGet()
            entered.release()
            // A closed socket fails every further accept at once: this is
            // what a stale loop that keeps going spins on.
            if (closed && steps.isEmpty()) throw IOException("Socket closed")
            val step = steps.poll(10, TimeUnit.SECONDS) ?: throw IOException("accept timed out")
            return step()
        }

        fun awaitAccept() {
            assertTrue("accept loop never reached accept()", entered.tryAcquire(5, TimeUnit.SECONDS))
        }

        fun deliver(connection: FakeConnection) = steps.put { connection }

        fun failAccept() = steps.put { throw IOException("Socket closed") }
    }

    private class Harness(serve: (FakeConnection) -> Unit = {}) {
        val served = LinkedBlockingQueue<FakeConnection>()
        val acceptFailures = AtomicInteger()
        val threads: MutableList<Thread> = Collections.synchronizedList(mutableListOf())
        val listener = BridgeListener<FakeListener, FakeConnection>(
            accept = { it.accept() },
            close = { (it as Closeable).close() },
            onAcceptFailure = { acceptFailures.incrementAndGet() },
            serve = { connection ->
                serve(connection)
                served.put(connection)
            },
        )

        fun stop() = listener.stop()

        fun start(socket: FakeListener): Boolean = listener.start(
            open = { socket },
            spawn = { acceptLoop ->
                val thread = Thread(acceptLoop, "bridge-listener-test")
                thread.isDaemon = true
                thread.uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, _ -> }
                threads += thread
                thread.start()
            },
        )
    }

    private fun Thread.assertExits() {
        join(5_000)
        assertFalse("accept loop is still running", isAlive)
    }
}
