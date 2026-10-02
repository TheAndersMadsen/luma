package com.penumbraos.hook

import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method
import java.util.concurrent.atomic.AtomicLong

/**
 * Content-free event ledger + bounded end-of-stream watchdog for the remote
 * streaming-TTS path.
 *
 * Observed defect (narration diagnostics, 2026-07-20): a narration's remote
 * audio plays audibly, but no terminal gRPC callback (`onCompleted`/`onError`)
 * ever reaches the narrator process, so `ByteArrayDataSource.signalEndOfStream`
 * never runs, ExoPlayer never reaches STATE_ENDED, and the stock
 * `future.get()` (no timeout) pins NarratorImpl's single-thread executor
 * forever. Every later narration enqueues and never drains, permanent
 * silence until reboot.
 *
 * Two responses, both narrow:
 *
 * 1. Ledger: W-level logs at each hop of the stream (service entry, proxy
 *    forwarders, parcelable re-raisers, data-source append/EOS/read-EOI,
 *    player listener completion/state). Only sizes, counts, states, and
 *    booleans are logged, never audio, text, or error message content.
 *
 * 2. Watchdog: the stock client applies `withDeadlineAfter(flag timeout)` to
 *    the RPC, so no legitimate chunk can arrive later than that deadline.
 *    If a stream has received no `appendBytes` and no end-of-stream signal
 *    for QUIESCENCE_MILLIS (comfortably beyond the deadline), the watchdog
 *    calls the stock `signalEndOfStream()`, after which the stock pipeline
 *    terminates naturally (read → END_OF_INPUT → STATE_ENDED → future
 *    completes). This cannot truncate a live stream and adds no new
 *    completion path of its own.
 */
object StreamingSpeechLedgerHooks {
    private const val TAG = "PenumbraTtsLedger"

    private const val AIBUS_SERVICE = "humaneinternal.system.aibus.AIBusService"
    private const val AIBUS_CLIENT = "humaneinternal.system.aibus.AIBusClient"
    private const val TTS_REQUEST = TierASymbols.ProtoKids.TEXT_TO_SPEECH_REQUEST
    private const val STREAM_OBSERVER = "io.grpc.stub.StreamObserver"
    private const val OBSERVER_PROXY = "humane.grpc.StreamObserverProxy"
    private const val PARCELABLE_OBSERVER = "humane.grpc.ParcelableStreamObserver"
    private const val PARCELABLE_MESSAGE = "humane.grpc.ParcelableMessageLite"
    private const val BYTE_ARRAY_DATA_SOURCE =
        "humaneinternal.system.narrator.ByteArrayDataSource"
    private const val PLAYER_LISTENER =
        "humaneinternal.system.narrator.RemoteTextToSpeech\$PlayerListener"

    // The stock client deadline is the SERVER_SPEECH_SYNTHESIS_TIMEOUT_MILLIS
    // flag (10 s in the current profile); 12 s of append silence is therefore
    // provably past any legitimate chunk.
    internal const val QUIESCENCE_MILLIS = 12_000L

    private val watchdogThread by lazy {
        HandlerThread("PenumbraTtsWatchdog").apply { start() }
    }
    private val watchdogHandler by lazy { Handler(watchdogThread.looper) }

    fun install(classLoader: ClassLoader) {
        installServiceEntryLedger(classLoader)
        installClientEntryLedger(classLoader)
        installProxyLedger(classLoader)
        installParcelableLedger(classLoader)
        installPlayerListenerLedger(classLoader)
        installDataSourceLedgerAndWatchdog(classLoader)
        Log.w(TAG, "Streaming speech ledger installed")
    }

    private fun installServiceEntryLedger(cl: ClassLoader) {
        runCatching {
            val service = cl.loadClass(AIBUS_SERVICE)
            val request = cl.loadClass(TTS_REQUEST)
            val observer = cl.loadClass(STREAM_OBSERVER)
            val method = service.getDeclaredMethod(
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAMING_TEXT_TO_SPEECH,
                request,
                observer,
            ).apply { isAccessible = true }
            hookAfterLog(method) { "service.streamingTextToSpeech invoked" }
        }.onFailure { Log.w(TAG, "  service entry ledger unavailable: ${it.javaClass.simpleName}") }
    }

    private fun installClientEntryLedger(cl: ClassLoader) {
        runCatching {
            val client = cl.loadClass(AIBUS_CLIENT)
            val request = cl.loadClass(TTS_REQUEST)
            val observer = cl.loadClass(STREAM_OBSERVER)
            val method = client.getDeclaredMethod(
                TierASymbols.Binder.AiBusBridge.WIRE_NAME_STREAMING_TEXT_TO_SPEECH,
                request,
                observer,
            ).apply { isAccessible = true }
            hookAfterLog(method) { "client.streamingTextToSpeech dispatched" }

            val binderError = client.getDeclaredMethod(
                "logBinderError", android.os.RemoteException::class.java,
            ).apply { isAccessible = true }
            hookAfterLog(binderError) { "client binder error (callbacks lost)" }
        }.onFailure { Log.w(TAG, "  client entry ledger unavailable: ${it.javaClass.simpleName}") }
    }

    private fun installProxyLedger(cl: ClassLoader) {
        runCatching {
            val proxy = cl.loadClass(OBSERVER_PROXY)
            val messageLite = Class.forName(
                "com.google.protobuf.MessageLite", false, cl,
            )
            hookAfterLog(
                proxy.getDeclaredMethod(
                    TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_NEXT,
                    messageLite,
                ).apply { isAccessible = true },
            ) { "proxy.onNext" }
            hookAfterLog(
                proxy.getDeclaredMethod(
                    TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_ERROR,
                    Throwable::class.java,
                )
                    .apply { isAccessible = true },
            ) { param ->
                val kind = (param.args.getOrNull(0) as? Throwable)?.javaClass?.simpleName
                "proxy.onError kind=$kind thrown=${param.throwable?.javaClass?.simpleName}"
            }
            hookAfterLog(
                proxy.getDeclaredMethod(
                    TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_COMPLETED,
                ).apply { isAccessible = true },
            ) { param ->
                "proxy.onCompleted thrown=${param.throwable?.javaClass?.simpleName}"
            }
        }.onFailure { Log.w(TAG, "  proxy ledger unavailable: ${it.javaClass.simpleName}") }
    }

    private fun installParcelableLedger(cl: ClassLoader) {
        runCatching {
            val parcelable = cl.loadClass(PARCELABLE_OBSERVER)
            val parcelableMessage = cl.loadClass(PARCELABLE_MESSAGE)
            hookAfterLog(
                parcelable.getDeclaredMethod(
                    TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_NEXT,
                    parcelableMessage,
                )
                    .apply { isAccessible = true },
            ) { "parcelable.onNext" }
            hookAfterLog(
                parcelable.getDeclaredMethod(
                    TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_ERROR,
                    String::class.java,
                )
                    .apply { isAccessible = true },
            ) { param ->
                val messageLength = (param.args.getOrNull(0) as? String)?.length
                "parcelable.onError msgLen=$messageLength"
            }
            hookAfterLog(
                parcelable.getDeclaredMethod(
                    TierASymbols.Binder.StreamObserver.WIRE_NAME_ON_COMPLETED,
                ).apply { isAccessible = true },
            ) { "parcelable.onCompleted" }
        }.onFailure { Log.w(TAG, "  parcelable ledger unavailable: ${it.javaClass.simpleName}") }
    }

    private fun installPlayerListenerLedger(cl: ClassLoader) {
        runCatching {
            val listener = cl.loadClass(PLAYER_LISTENER)
            listener.declaredMethods.filter {
                it.name == "signalCompletion" || it.name == "onPlaybackStateChanged"
            }.forEach { method ->
                method.isAccessible = true
                if (method.name == "onPlaybackStateChanged") {
                    hookAfterLog(method) { param ->
                        "player.onPlaybackStateChanged state=${param.args.getOrNull(0)}"
                    }
                } else {
                    hookAfterLog(method) { param ->
                        "player.signalCompletion success=${param.args.getOrNull(0)}"
                    }
                }
            }
        }.onFailure { Log.w(TAG, "  player listener ledger unavailable: ${it.javaClass.simpleName}") }
    }

    /**
     * Per-instance watchdog keyed on the data source object. Every append or
     * explicit end-of-stream feeds the watchdog. Expiry invokes the STOCK
     * `signalEndOfStream()` so termination flows through unmodified stock code.
     */
    private fun installDataSourceLedgerAndWatchdog(cl: ClassLoader) {
        runCatching {
            val dataSource = cl.loadClass(BYTE_ARRAY_DATA_SOURCE)
            val signalEndOfStream = dataSource.getDeclaredMethod("signalEndOfStream")
                .apply { isAccessible = true }
            val isStreamEnded = dataSource.getDeclaredMethod("isStreamEnded")
                .apply { isAccessible = true }
            val appendBytes = dataSource.getDeclaredMethod(
                "appendBytes", ByteArray::class.java,
            ).apply { isAccessible = true }

            // Per-source generations so concurrent streams cannot disarm each
            // other. Weak keys let finished sources be collected.
            val generations = java.util.Collections.synchronizedMap(
                java.util.WeakHashMap<Any, AtomicLong>(),
            )

            fun generationFor(source: Any): AtomicLong =
                generations.getOrPut(source) { AtomicLong(0) }

            fun armWatchdog(source: Any) {
                val generation = generationFor(source)
                val armedGeneration = generation.incrementAndGet()
                val weakSource = java.lang.ref.WeakReference(source)
                watchdogHandler.postDelayed({
                    val liveSource = weakSource.get() ?: return@postDelayed
                    if (generationFor(liveSource).get() != armedGeneration) return@postDelayed
                    val ended = runCatching {
                        isStreamEnded.invoke(liveSource) as? Boolean
                    }.getOrNull()
                    if (ended == false) {
                        Log.w(TAG, "watchdog: quiescent stream, signaling stock end-of-stream")
                        runCatching { signalEndOfStream.invoke(liveSource) }
                            .onFailure {
                                Log.w(TAG, "watchdog signal failed: ${it.javaClass.simpleName}")
                            }
                    }
                }, QUIESCENCE_MILLIS)
            }

            XposedBridge.hookMethod(appendBytes, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    runCatching {
                        val size = (param.args.getOrNull(0) as? ByteArray)?.size
                        Log.w(TAG, "source.appendBytes size=$size")
                        armWatchdog(param.thisObject)
                    }
                }
            })
            XposedBridge.hookMethod(signalEndOfStream, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    runCatching {
                        // Disarm: any pending expiry sees a newer generation.
                        generationFor(param.thisObject).incrementAndGet()
                        Log.w(TAG, "source.signalEndOfStream")
                    }
                }
            })
            val open = dataSource.declaredMethods.firstOrNull { it.name == "open" }
            if (open != null) {
                open.isAccessible = true
                XposedBridge.hookMethod(open, object : XC_MethodHook() {
                    override fun afterHookedMethod(param: MethodHookParam) {
                        runCatching {
                            Log.w(TAG, "source.open length=${param.result}")
                            armWatchdog(param.thisObject)
                        }
                    }
                })
            }
        }.onFailure { Log.w(TAG, "  data source ledger unavailable: ${it.javaClass.simpleName}") }
    }

    private fun hookAfterLog(
        method: Method,
        describe: (XC_MethodHook.MethodHookParam) -> String,
    ) {
        XposedBridge.hookMethod(method, object : XC_MethodHook() {
            override fun afterHookedMethod(param: XC_MethodHook.MethodHookParam) {
                runCatching { Log.w(TAG, describe(param)) }
            }
        })
        Log.w(TAG, "  Hooked ${method.declaringClass.simpleName}.${method.name}")
    }
}
