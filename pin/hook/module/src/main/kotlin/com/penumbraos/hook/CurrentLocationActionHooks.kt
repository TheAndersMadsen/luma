package com.penumbraos.hook

import android.os.Looper
import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Makes stock's `GetCurrentLocation` action live up to its name.
 *
 * Humane's `CentralActionHandler.resolve(GetCurrentLocationAction)` only reads
 * `HumaneLocationManager.getLastKnownLocation()` and its stale bit. It never
 * requests an update. When that cached fix is stale, Penumbra's server must
 * reject it and the first location prompt fails even if a network fix arrives
 * seconds later.
 *
 * Before only that exact resolver runs, request one update through stock's own
 * `getCurrentLocationFuture(long)` API and wait on Switchboard's worker thread.
 * The original resolver still creates the observation, parent link, stale bit,
 * and coordinates. A timeout or any hook failure falls through to that original
 * behavior, so this hook cannot turn untrusted or stale data into a fresh fix.
 */
object CurrentLocationActionHooks {

    private const val TAG = "LumaCompatibility"
    private const val CENTRAL_ACTION_HANDLER =
        "humaneinternal.system.intent.CentralActionHandler"
    private const val GET_CURRENT_LOCATION_ACTION =
        "humaneinternal.system.intent.actions.system.GetCurrentLocationAction"
    private const val HUMANE_LOCATION_MANAGER = "humane.system.HumaneLocationManager"

    // Stock AiMic allows 25 seconds. This leaves roughly 12 seconds for the
    // server's bounded reverse-geocode/provider response after the refresh.
    internal const val LOCATION_REQUEST_TIMEOUT_MS = 12_000L
    internal const val LOCATION_AWAIT_TIMEOUT_MS = 13_000L
    internal const val LOCATION_HARD_RETIRE_TIMEOUT_MS = 15_000L

    private val refreshes = LocationRefreshSingleFlight()

    fun install(cl: ClassLoader) {
        try {
            val handlerClass = Class.forName(CENTRAL_ACTION_HANDLER, false, cl)
            val actionClass = Class.forName(GET_CURRENT_LOCATION_ACTION, false, cl)
            val managerClass = Class.forName(HUMANE_LOCATION_MANAGER, false, cl)
            val resolve = handlerClass.getDeclaredMethod("resolve", actionClass).apply {
                isAccessible = true
            }
            val managerField = handlerClass.getDeclaredField("mLocationManager").apply {
                isAccessible = true
            }
            val serviceField = managerClass.getDeclaredField("mService").apply {
                isAccessible = true
            }
            val getLastKnownLocation = managerClass
                .getDeclaredMethod("getLastKnownLocation")
                .apply { isAccessible = true }
            val isCurrentLocationStale = managerClass
                .getDeclaredMethod("isCurrentLocationStale")
                .apply { isAccessible = true }
            val getCurrentLocationFuture = managerClass
                .getDeclaredMethod(
                    "getCurrentLocationFuture",
                    Long::class.javaPrimitiveType!!,
                )
                .apply { isAccessible = true }

            XposedBridge.hookMethod(resolve, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        // Stock Switchboard calls CentralActionHandler from its
                        // ExecutorService. If a firmware change moves this resolver
                        // to the UI thread, preserve stock behavior instead of ever
                        // waiting there.
                        val onMainThread = Looper.myLooper() === Looper.getMainLooper()
                        if (onMainThread) {
                            Log.w(TAG, "  Current-location refresh skipped on the main thread")
                            return
                        }

                        val manager = managerField.get(param.thisObject) ?: return
                        // Stock returns a future that never completes when its
                        // location Binder is disconnected because no callback is
                        // registered. Do not turn that boot/reconnect race into a
                        // retained single-flight entry.
                        if (serviceField.get(manager) == null) {
                            Log.w(TAG, "  Current-location refresh skipped while service reconnects")
                            return
                        }
                        val lastKnown = getLastKnownLocation.invoke(manager)
                        val isStale = isCurrentLocationStale.invoke(manager) as? Boolean ?: true
                        if (!shouldRefreshCurrentLocation(lastKnown != null, isStale, false)) {
                            return
                        }

                        val refresh = refreshes.acquire(manager) {
                            getCurrentLocationFuture.invoke(
                                manager,
                                LOCATION_REQUEST_TIMEOUT_MS,
                            ) as? CompletableFuture<*>
                        } ?: return

                        val wait = awaitLocationRefresh(
                            refresh.future,
                            refresh.waitTimeoutMs,
                        )
                        when (wait) {
                            LocationRefreshWait.COMPLETED ->
                                Log.w(TAG, "  Current-location refresh completed before stock resolve")
                            LocationRefreshWait.TIMED_OUT ->
                                Log.w(TAG, "  Current-location refresh timed out; using stock result")
                            LocationRefreshWait.INTERRUPTED ->
                                Log.w(TAG, "  Current-location refresh interrupted; using stock result")
                            LocationRefreshWait.FAILED ->
                                Log.w(TAG, "  Current-location refresh failed; using stock result")
                        }
                    } catch (error: Throwable) {
                        // Never replace the result or propagate into stock's
                        // action executor. The unchanged resolver remains the
                        // only producer of location observations.
                        Log.w(
                            TAG,
                            "  Current-location refresh unavailable; using stock result " +
                                "(${error.javaClass.simpleName})",
                        )
                    }
                }
            })
            Log.w(TAG, "  Installed one-shot refresh for stock GetCurrentLocation")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "  Failed to install current-location action refresh: " +
                    error.javaClass.simpleName,
            )
        }
    }

    internal fun shouldRefreshCurrentLocation(
        hasLastKnownLocation: Boolean,
        isStale: Boolean,
        isMainThread: Boolean,
    ): Boolean = !isMainThread && (!hasLastKnownLocation || isStale)

    internal fun awaitLocationRefresh(
        future: CompletableFuture<*>,
        timeoutMs: Long,
    ): LocationRefreshWait = try {
        future.get(timeoutMs, TimeUnit.MILLISECONDS)
        LocationRefreshWait.COMPLETED
    } catch (_: TimeoutException) {
        LocationRefreshWait.TIMED_OUT
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        LocationRefreshWait.INTERRUPTED
    } catch (_: ExecutionException) {
        LocationRefreshWait.FAILED
    } catch (_: Throwable) {
        LocationRefreshWait.FAILED
    }
}

internal enum class LocationRefreshWait {
    COMPLETED,
    TIMED_OUT,
    INTERRUPTED,
    FAILED,
}

internal data class LocationRefreshLease(
    val future: CompletableFuture<*>,
    val waitTimeoutMs: Long,
)

/** Share one stock refresh without ever sharing it across manager instances. */
internal class LocationRefreshSingleFlight(
    private val shareWindowNanos: Long =
        TimeUnit.MILLISECONDS.toNanos(CurrentLocationActionHooks.LOCATION_AWAIT_TIMEOUT_MS),
    private val hardRetireNanos: Long =
        TimeUnit.MILLISECONDS.toNanos(CurrentLocationActionHooks.LOCATION_HARD_RETIRE_TIMEOUT_MS),
    private val nanoTime: () -> Long = System::nanoTime,
) {
    init {
        require(shareWindowNanos > 0L)
        require(hardRetireNanos > shareWindowNanos)
    }

    private data class Active(
        val manager: Any,
        val future: CompletableFuture<*>,
        val shareDeadlineNanos: Long,
        val hardRetireDeadlineNanos: Long,
    )

    private val lock = Any()
    private var active: Active? = null

    fun acquire(
        manager: Any,
        start: () -> CompletableFuture<*>?,
    ): LocationRefreshLease? = synchronized(lock) {
        active?.let { current ->
            if (!current.future.isDone && !current.future.isCancelled) {
                val now = nanoTime()
                if (now < current.hardRetireDeadlineNanos) {
                    // A different manager means a changed runtime. Fail open for
                    // that call instead of binding it to another object's result.
                    if (current.manager !== manager) return@synchronized null

                    // Keep the lease through the share window so another stock
                    // request cannot overlap it. During the short retirement
                    // cooldown, later callers fail open without waiting again.
                    val remainingNanos = current.shareDeadlineNanos - now
                    if (remainingNanos <= 0L) return@synchronized null
                    return@synchronized LocationRefreshLease(
                        future = current.future,
                        waitTimeoutMs = TimeUnit.NANOSECONDS
                            .toMillis(remainingNanos)
                            .coerceAtLeast(1L),
                    )
                }

                // Stock's request lifetime ended before this deadline. Retire a
                // missing callback without cancelling its future. The identity
                // check below prevents a late completion from clearing the next
                // refresh. This restores service after a Binder reconnect while
                // still forbidding overlap inside the hard window.
                active = null
            } else {
                active = null
            }
        }

        val future = start() ?: return@synchronized null
        val startedAtNanos = nanoTime()
        val entry = Active(
            manager = manager,
            future = future,
            shareDeadlineNanos = startedAtNanos + shareWindowNanos,
            hardRetireDeadlineNanos = startedAtNanos + hardRetireNanos,
        )
        active = entry
        future.whenComplete { _, _ ->
            synchronized(lock) {
                if (active === entry) active = null
            }
        }
        LocationRefreshLease(
            future = future,
            waitTimeoutMs = TimeUnit.NANOSECONDS
                .toMillis(shareWindowNanos)
                .coerceAtLeast(1L),
        )
    }
}
