package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.util.concurrent.CompletableFuture

/**
 * Repairs two exact streaming-playback defects in the installed Ironman build.
 *
 * Stock prepares ExoPlayer before the first remote audio chunk arrives. Its
 * [humaneinternal.system.narrator.ByteArrayDataSource] therefore reports the
 * currently buffered byte count (often zero) as the complete resource length,
 * even though `read` is explicitly able to wait for later chunks. Reporting an
 * unknown length while that stream is still open keeps ExoPlayer reading until
 * stock signals end-of-stream. Once ended, the original finite result is kept.
 *
 * Stock's exact PlayerListener also only logs `onPlayerError`. Completing its
 * existing future exceptionally prevents the narrator/focus owner from waiting
 * forever. Both hooks validate the installed signatures and fail open if a
 * future firmware changes shape.
 */
object StreamingSpeechPlaybackHooks {
    private const val TAG = "LumaCompatibility"
    private const val BYTE_ARRAY_DATA_SOURCE =
        "humaneinternal.system.narrator.ByteArrayDataSource"
    private const val PLAYER_LISTENER =
        "humaneinternal.system.narrator.RemoteTextToSpeech\$PlayerListener"
    private const val DATA_SPEC = "androidx.media3.datasource.DataSpec"
    private const val PLAYBACK_EXCEPTION = "androidx.media3.common.PlaybackException"
    internal const val UNKNOWN_LENGTH = -1L
    internal const val STATE_IDLE = 1
    internal const val STATE_ENDED = 4

    fun install(classLoader: ClassLoader) {
        installOpenLengthRepair(classLoader)
        installPlaybackErrorRepair(classLoader)
        installCompletionHardening(classLoader)
    }

    /**
     * Repairs the two remaining paths where stock's PlayerListener never
     * completes `mFuture`, permanently pinning NarratorImpl's single-thread
     * executor inside `speakStreaming`'s untimed `future.get()` (observed
     * on-device 2026-07-20: a touchpad barge-in stopped a playing narration →
     * STATE_IDLE → future never completed → every later narration queued
     * silently until reboot).
     *
     * 1. STATE_IDLE (any `ExoPlayer.stop()`, barge-in interrupts and the
     *    explicit `stop()` method): stock's switch ignores it. Complete the
     *    future normally, matching the interrupted-narration semantics of the
     *    non-streaming path (an exceptional completion would trigger stock's
     *    local-TTS fallback and re-speak an answer the user just cut off).
     *
     * 2. STATE_ENDED with `signalCompletion(false, null)` never called (e.g.
     *    the end-of-stream came from the quiescence watchdog): stock would
     *    run `completeExceptionally(null)` and throw NullPointerException
     *    inside the listener, leaving the future incomplete. Pre-seed a real
     *    Throwable via the stock `signalCompletion` so stock's own
     *    exceptional path runs (falling back to local TTS).
     *
     * Completing an already-completed future is a no-op, so stale listeners
     * (stock adds one per narration and never removes them) are harmless.
     */
    private fun installCompletionHardening(classLoader: ClassLoader) {
        try {
            val playerListenerClass = classLoader.loadClass(PLAYER_LISTENER)
            val onPlaybackStateChanged = playerListenerClass.getDeclaredMethod(
                "onPlaybackStateChanged",
                Integer.TYPE,
            ).apply { isAccessible = true }
            val futureField = playerListenerClass.getDeclaredField(
                "mFuture",
            ).apply { isAccessible = true }
            val completedField = playerListenerClass.getDeclaredField(
                "mCompletedSuccessfully",
            ).apply { isAccessible = true }
            val throwField = playerListenerClass.getDeclaredField(
                "mThrow",
            ).apply { isAccessible = true }
            val signalCompletion = playerListenerClass.getDeclaredMethod(
                "signalCompletion",
                java.lang.Boolean.TYPE,
                Throwable::class.java,
            ).apply { isAccessible = true }
            check(futureField.type == CompletableFuture::class.java) {
                "unexpected PlayerListener.mFuture type"
            }

            XposedBridge.hookMethod(onPlaybackStateChanged, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val state = param.args.getOrNull(0) as? Int ?: return
                    if (state != STATE_ENDED) return
                    // NPE guard: give stock's exceptional branch a real cause.
                    runCatching {
                        val succeeded = (completedField.get(param.thisObject) as?
                            java.util.concurrent.atomic.AtomicBoolean)?.get()
                        val cause = throwField.get(param.thisObject) as? Throwable
                        if (succeeded == false && cause == null) {
                            signalCompletion.invoke(
                                param.thisObject,
                                false,
                                Throwable("stream ended without a completion signal"),
                            )
                            Log.w(TAG, "  Streaming speech end-without-signal repaired")
                        }
                    }
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    val state = param.args.getOrNull(0) as? Int ?: return
                    if (state != STATE_IDLE) return
                    val future = runCatching {
                        @Suppress("UNCHECKED_CAST")
                        futureField.get(param.thisObject) as? CompletableFuture<Any?>
                    }.getOrNull() ?: return
                    if (completeInterruptedPlayback(future)) {
                        Log.w(TAG, "  Streaming speech interrupted-playback release")
                    }
                }
            })
            Log.w(TAG, "  Streaming speech completion hardening installed")
        } catch (error: Throwable) {
            Log.w(
                TAG,
                "  Streaming speech completion hardening unavailable: ${error.javaClass.simpleName}",
            )
        }
    }

    private fun installOpenLengthRepair(classLoader: ClassLoader) {
        try {
            val dataSourceClass = classLoader.loadClass(BYTE_ARRAY_DATA_SOURCE)
            val dataSpecClass = classLoader.loadClass(DATA_SPEC)
            val open = dataSourceClass.getDeclaredMethod(
                "open",
                dataSpecClass,
            ).apply { isAccessible = true }
            val isStreamEnded = dataSourceClass.getDeclaredMethod(
                "isStreamEnded",
            ).apply { isAccessible = true }
            check(open.returnType == java.lang.Long.TYPE) {
                "unexpected ByteArrayDataSource.open return type"
            }
            check(isStreamEnded.returnType == java.lang.Boolean.TYPE) {
                "unexpected ByteArrayDataSource.isStreamEnded return type"
            }

            XposedBridge.hookMethod(open, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) return
                    val originalLength = param.result as? Long ?: return
                    param.result = openLengthWhileStreaming(originalLength) {
                        isStreamEnded.invoke(param.thisObject) as? Boolean
                            ?: throw IllegalStateException("invalid end-of-stream state")
                    }
                }
            })
            Log.w(TAG, "  Streaming speech open-length repair installed")
        } catch (error: Throwable) {
            Log.w(
                TAG,
                "  Streaming speech open-length repair unavailable: ${error.javaClass.simpleName}",
            )
        }
    }

    private fun installPlaybackErrorRepair(classLoader: ClassLoader) {
        try {
            val playerListenerClass = classLoader.loadClass(PLAYER_LISTENER)
            val playbackExceptionClass = classLoader.loadClass(PLAYBACK_EXCEPTION)
            val onPlayerError = playerListenerClass.getDeclaredMethod(
                "onPlayerError",
                playbackExceptionClass,
            ).apply { isAccessible = true }
            val futureField = playerListenerClass.getDeclaredField(
                "mFuture",
            ).apply { isAccessible = true }
            check(onPlayerError.returnType == Void.TYPE) {
                "unexpected PlayerListener.onPlayerError return type"
            }
            check(futureField.type == CompletableFuture::class.java) {
                "unexpected PlayerListener.mFuture type"
            }

            // Run after stock so its existing diagnostics remain unchanged.
            XposedBridge.hookMethod(onPlayerError, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) return
                    val error = param.args.getOrNull(0) as? Throwable ?: return
                    val future = runCatching {
                        futureField.get(param.thisObject) as? CompletableFuture<*>
                    }.getOrNull() ?: return
                    if (completePlaybackError(future, error)) {
                        // Never log synthesized text, audio, or provider details.
                        Log.w(
                            TAG,
                            "  ${TierASymbols.OperationalMarkers.STREAMING_SPEECH_FAILURE_RELEASED}",
                        )
                    }
                }
            })
            Log.w(TAG, "  Streaming speech playback-error repair installed")
        } catch (error: Throwable) {
            Log.w(
                TAG,
                "  Streaming speech playback-error repair unavailable: ${error.javaClass.simpleName}",
            )
        }
    }

    /** A failed state read preserves stock's result instead of changing behavior. */
    internal fun openLengthWhileStreaming(
        originalLength: Long,
        readStreamEnded: () -> Boolean,
    ): Long = runCatching {
        if (readStreamEnded()) originalLength else UNKNOWN_LENGTH
    }.getOrDefault(originalLength)

    /** CompletableFuture completion is atomic and harmless after another terminal event. */
    internal fun completePlaybackError(
        future: CompletableFuture<*>,
        error: Throwable,
    ): Boolean = future.completeExceptionally(error)

    /**
     * Interrupted playback completes normally (Boolean semantics of the stock
     * future) so stock reports finishedSpeaking instead of re-speaking the
     * interrupted answer through the local-TTS fallback.
     */
    internal fun completeInterruptedPlayback(future: CompletableFuture<Any?>): Boolean =
        future.complete(java.lang.Boolean.TRUE)
}
