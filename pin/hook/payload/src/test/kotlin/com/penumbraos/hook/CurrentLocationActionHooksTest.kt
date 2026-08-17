package com.penumbraos.hook

import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CurrentLocationActionHooksTest {

    @Test
    fun `refresh policy waits only for missing or stale fixes off the main thread`() {
        assertFalse(
            CurrentLocationActionHooks.shouldRefreshCurrentLocation(
                hasLastKnownLocation = true,
                isStale = false,
                isMainThread = false,
            ),
        )
        assertTrue(
            CurrentLocationActionHooks.shouldRefreshCurrentLocation(
                hasLastKnownLocation = false,
                isStale = true,
                isMainThread = false,
            ),
        )
        assertTrue(
            CurrentLocationActionHooks.shouldRefreshCurrentLocation(
                hasLastKnownLocation = true,
                isStale = true,
                isMainThread = false,
            ),
        )
        assertFalse(
            CurrentLocationActionHooks.shouldRefreshCurrentLocation(
                hasLastKnownLocation = false,
                isStale = true,
                isMainThread = true,
            ),
        )
    }

    @Test
    fun `concurrent callers share one in-flight stock refresh`() {
        val singleFlight = LocationRefreshSingleFlight()
        val manager = Any()
        val refresh = CompletableFuture<Any?>()
        val starts = AtomicInteger()
        val ready = CountDownLatch(2)
        val go = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)

        val calls = List(2) {
            pool.submit<LocationRefreshLease?> {
                ready.countDown()
                assertTrue(go.await(1, TimeUnit.SECONDS))
                singleFlight.acquire(manager) {
                    starts.incrementAndGet()
                    refresh
                }
            }
        }
        assertTrue(ready.await(1, TimeUnit.SECONDS))
        go.countDown()

        val first = calls[0].get(1, TimeUnit.SECONDS)
        val second = calls[1].get(1, TimeUnit.SECONDS)
        pool.shutdownNow()

        assertSame(refresh, first?.future)
        assertSame(refresh, second?.future)
        assertEquals(1, starts.get())
    }

    @Test
    fun `completed refresh is cleared and a changed manager never shares an active future`() {
        val singleFlight = LocationRefreshSingleFlight()
        val firstManager = Any()
        val secondManager = Any()
        val first = CompletableFuture<Any?>()

        assertSame(first, singleFlight.acquire(firstManager) { first }?.future)
        assertNull(
            singleFlight.acquire(secondManager) {
                throw AssertionError("a changed manager must fail open")
            },
        )

        first.complete(null)
        val second = CompletableFuture.completedFuture<Any?>(null)
        assertSame(second, singleFlight.acquire(firstManager) { second }?.future)
    }

    @Test
    fun `expired wait window fails open then hard retirement permits recovery`() {
        var now = 0L
        val singleFlight = LocationRefreshSingleFlight(
            shareWindowNanos = 100_000_000L,
            hardRetireNanos = 150_000_000L,
            nanoTime = { now },
        )
        val manager = Any()
        val hung = CompletableFuture<Any?>()
        val replacement = CompletableFuture<Any?>()
        val starts = AtomicInteger()

        assertSame(hung, singleFlight.acquire(manager) {
            starts.incrementAndGet()
            hung
        }?.future)
        now = 99_000_000L
        val shared = singleFlight.acquire(manager) {
            starts.incrementAndGet()
            replacement
        }
        assertSame(hung, shared?.future)
        assertEquals(1L, shared?.waitTimeoutMs)

        now = 100_000_000L
        assertNull(singleFlight.acquire(manager) {
            starts.incrementAndGet()
            replacement
        })
        now = 149_000_000L
        assertNull(singleFlight.acquire(manager) {
            starts.incrementAndGet()
            replacement
        })
        assertFalse(hung.isCancelled)
        assertEquals(1, starts.get())

        now = 150_000_000L
        assertSame(replacement, singleFlight.acquire(manager) {
            starts.incrementAndGet()
            replacement
        }?.future)
        assertEquals(2, starts.get())

        // A late completion from the retired request must not clear the new
        // identity or permit a third overlapping refresh.
        hung.complete(null)
        assertSame(replacement, singleFlight.acquire(manager) {
            starts.incrementAndGet()
            CompletableFuture<Any?>()
        }?.future)
        assertEquals(2, starts.get())
    }

    @Test
    fun `refresh wait reports completion timeout and failure without throwing`() {
        assertEquals(
            LocationRefreshWait.COMPLETED,
            CurrentLocationActionHooks.awaitLocationRefresh(
                CompletableFuture.completedFuture(null),
                10,
            ),
        )
        assertEquals(
            LocationRefreshWait.TIMED_OUT,
            CurrentLocationActionHooks.awaitLocationRefresh(CompletableFuture<Any?>(), 1),
        )
        val failed = CompletableFuture<Any?>().apply {
            completeExceptionally(IllegalStateException("test failure"))
        }
        assertEquals(
            LocationRefreshWait.FAILED,
            CurrentLocationActionHooks.awaitLocationRefresh(failed, 10),
        )
    }

    @Test
    fun `hook is exact bounded fail-open and never fabricates a location observation`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/CurrentLocationActionHooks.kt",
        ).readText()
        val ironman = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()

        assertTrue(source.contains("getDeclaredMethod(\"resolve\", actionClass)"))
        assertTrue(source.contains("getDeclaredMethod(\"getLastKnownLocation\")"))
        assertTrue(source.contains("getDeclaredMethod(\"isCurrentLocationStale\")"))
        assertTrue(source.contains("getDeclaredField(\"mService\")"))
        assertTrue(source.contains("\"getCurrentLocationFuture\""))
        assertTrue(source.contains("Long::class.javaPrimitiveType!!"))
        assertTrue(source.contains("LOCATION_REQUEST_TIMEOUT_MS = 12_000L"))
        assertTrue(source.contains("LOCATION_AWAIT_TIMEOUT_MS = 13_000L"))
        assertTrue(source.contains("LOCATION_HARD_RETIRE_TIMEOUT_MS = 15_000L"))
        assertTrue(source.contains("Looper.myLooper() === Looper.getMainLooper()"))
        assertTrue(source.contains("catch (error: Throwable)"))
        assertFalse(source.contains("param.result ="))
        assertFalse(source.contains("SuccessObservation"))
        assertFalse(source.contains("latitude"))
        assertFalse(source.contains("longitude"))
        assertTrue(ironman.contains("CurrentLocationActionHooks.install(cl)"))
    }

    @Test
    fun `weather preflight remains request agnostic and stock authored`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/CurrentLocationActionHooks.kt",
        ).readText()

        assertTrue(source.contains("CentralActionHandler.resolve(GetCurrentLocationAction)"))
        assertTrue(source.contains("getDeclaredMethod(\"resolve\", actionClass)"))
        assertTrue(source.contains("getCurrentLocationFuture"))
        assertFalse(source.contains("utterance", ignoreCase = true))
        assertFalse(source.contains("weather", ignoreCase = true))
        assertFalse(source.contains("param.result ="))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
