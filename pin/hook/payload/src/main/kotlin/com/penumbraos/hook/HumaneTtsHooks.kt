package com.penumbraos.hook

import android.os.SystemClock
import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Future
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Streaming replacement for the embedded Microsoft TTS engine
 */
object HumaneTtsHooks {
    private const val TAG = "PenumbraTTS"
    private const val SAMPLE_RATE_HZ = 24000
    private const val AUDIO_FORMAT_PCM_16BIT = 2
    private const val CHANNEL_COUNT_MONO = 1
    private const val TARGET_READ_BYTES = 2400 // 50ms at 24kHz 16-bit mono PCM
    private const val SYNTHESIS_DEADLINE_MILLIS = 15_000L
    private const val MAX_BLOCKING_SYNTHESIS_THREADS = 2
    // `StartSpeakingSsml` returns a start-snapshot result whose reason stays
    // `SynthesizingAudioStarted`; completion of the streamed synthesis is only
    // observable on the drained `AudioDataStream`, whose status must be
    // `AllData` (a `Canceled` status means Azure ended the stream early).
    private const val COMPLETED_STREAM_STATUS = "AllData"

    internal enum class TerminalCallback {
        DONE,
        ERROR,
    }

    internal enum class TerminalDispatch {
        SENT,
        ALREADY_SENT,
        INVOCATION_FAILED,
    }

    /**
     * Android's synthesis callback accepts exactly one terminal notification.
     * Mark the terminal before invoking foreign code so a throwing or re-entrant
     * callback cannot cause a second terminal notification from the catch path.
     */
    internal class TerminalCallbackGate(
        private val notify: (TerminalCallback) -> Unit,
    ) {
        private val terminal = AtomicReference<TerminalCallback?>(null)

        fun send(value: TerminalCallback): TerminalDispatch {
            if (!terminal.compareAndSet(null, value)) {
                return TerminalDispatch.ALREADY_SENT
            }
            return try {
                notify(value)
                TerminalDispatch.SENT
            } catch (_: Throwable) {
                // The terminal is deliberately retained. Retrying after a
                // reflective callback threw could notify Android twice.
                TerminalDispatch.INVOCATION_FAILED
            }
        }

        fun sentTerminal(): TerminalCallback? = terminal.get()
    }

    internal enum class SynthesisState {
        ACTIVE,
        SUCCEEDED,
        FAILED,
        CANCELLED,
    }

    internal enum class AwaitOutcome {
        COMPLETED,
        TIMED_OUT,
        CANCELLED,
        FAILED,
    }

    internal data class CallbackInvocation<T>(
        val admitted: Boolean,
        val value: T? = null,
        val failed: Boolean = false,
    )

    internal class SynthesisControl(
        internal val service: Any,
        deadlineMillis: Long,
        private val terminal: TerminalCallbackGate,
        private val callbackTouched: AtomicBoolean = AtomicBoolean(false),
        private val nanoTime: () -> Long = System::nanoTime,
    ) {
        private val lifecycleLock = Any()
        private val state = AtomicReference(SynthesisState.ACTIVE)
        private val worker = AtomicReference<Future<*>?>(null)
        private val synthesisResult = AtomicReference<Any?>(null)
        private val audioStream = AtomicReference<Any?>(null)
        private val deadlineNanos = nanoTime() +
            TimeUnit.MILLISECONDS.toNanos(deadlineMillis.coerceAtLeast(1L))

        fun attachWorker(future: Future<*>) {
            check(worker.compareAndSet(null, future)) { "worker already attached" }
            if (state.get() != SynthesisState.ACTIVE) {
                future.cancel(true)
            }
        }

        fun callbackWasTouched(): Boolean = callbackTouched.get()

        internal fun markCallbackTouched() { callbackTouched.set(true) }

        fun currentState(): SynthesisState = state.get()

        fun remainingNanos(): Long = deadlineNanos - nanoTime()

        fun checkpoint() {
            if (state.get() != SynthesisState.ACTIVE) throw CancellationException()
            if (remainingNanos() <= 0L) {
                cancel()
                throw TimeoutException()
            }
        }

        fun attachSynthesisResult(value: Any): Boolean =
            attachResource(synthesisResult, value)

        fun attachAudioStream(value: Any): Boolean =
            attachResource(audioStream, value)

        fun closeResources() {
            safeClose(audioStream.getAndSet(null))
            safeClose(synthesisResult.getAndSet(null))
        }

        fun completeSuccess(): Boolean = transition(
            SynthesisState.SUCCEEDED,
            TerminalCallback.DONE,
        )

        fun fail(): Boolean = transition(
            SynthesisState.FAILED,
            TerminalCallback.ERROR,
        )

        fun cancel(): Boolean {
            val changed = synchronized(lifecycleLock) {
                if (state.get() != SynthesisState.ACTIVE) {
                    false
                } else {
                    state.set(SynthesisState.CANCELLED)
                    callbackTouched.set(true)
                    true
                }
            }
            if (!changed) {
                stopWorkerAndClose()
                return false
            }
            // Stop blocking provider work and release its handles before the
            // terminal Binder callback. Even if that foreign callback stalls,
            // the synchronous start/read path is already cancelled.
            stopWorkerAndClose()
            terminal.send(TerminalCallback.ERROR)
            return true
        }

        fun <T> invokeActiveCallback(block: () -> T): CallbackInvocation<T> =
            synchronized(lifecycleLock) {
                if (state.get() != SynthesisState.ACTIVE) {
                    return@synchronized CallbackInvocation(admitted = false)
                }
                callbackTouched.set(true)
                try {
                    CallbackInvocation(admitted = true, value = block())
                } catch (_: Throwable) {
                    CallbackInvocation(admitted = true, failed = true)
                }
            }

        fun stopWorkerAndClose() {
            worker.get()?.cancel(true)
            closeResources()
        }

        private fun attachResource(slot: AtomicReference<Any?>, value: Any): Boolean {
            if (!slot.compareAndSet(null, value)) {
                safeClose(value)
                return false
            }
            if (state.get() != SynthesisState.ACTIVE) {
                safeClose(slot.getAndSet(null))
                return false
            }
            return true
        }

        private fun transition(
            terminalState: SynthesisState,
            callback: TerminalCallback,
        ): Boolean {
            val changed = synchronized(lifecycleLock) {
                if (state.get() != SynthesisState.ACTIVE) {
                    false
                } else {
                    state.set(terminalState)
                    callbackTouched.set(true)
                    true
                }
            }
            if (!changed) return false
            terminal.send(callback)
            return true
        }
    }

    internal interface SynthesisDriver {
        val textLength: Int
        val readBufferSize: Int

        fun startSynthesis(): Any?
        fun openAudioStream(result: Any): Any?
        fun readAudio(audioStream: Any, buffer: ByteArray): Any?
        fun startCallback(): Any?
        fun writeAudio(buffer: ByteArray, length: Int): Any?
        fun completionStatus(audioStream: Any): String?
    }

    private data class PreparedSynthesis(
        override val textLength: Int,
        val ssml: String,
        val callback: Any,
        override val readBufferSize: Int,
        val synthesizer: Any,
        val startSpeakingSsml: Method,
        val audioStreamFromResult: Method,
        val readData: Method,
        val streamStatus: Method,
        val callbackStart: Method,
        val callbackAudioAvailable: Method,
        val callbackDone: Method,
        val callbackError: Method,
    ) : SynthesisDriver {
        override fun startSynthesis(): Any? =
            startSpeakingSsml.invoke(synthesizer, ssml)

        override fun openAudioStream(result: Any): Any? =
            audioStreamFromResult.invoke(null, result)

        override fun readAudio(audioStream: Any, buffer: ByteArray): Any? =
            readData.invoke(audioStream, buffer as Any)

        override fun startCallback(): Any? = callbackStart.invoke(
            callback,
            SAMPLE_RATE_HZ,
            AUDIO_FORMAT_PCM_16BIT,
            CHANNEL_COUNT_MONO,
        )

        override fun writeAudio(buffer: ByteArray, length: Int): Any? =
            callbackAudioAvailable.invoke(callback, buffer, 0, length)

        override fun completionStatus(audioStream: Any): String? =
            streamStatus.invoke(audioStream)?.toString()
    }

    private val synthesisThreadIds = AtomicLong(1)
    private val synthesisExecutor = ThreadPoolExecutor(
        0,
        MAX_BLOCKING_SYNTHESIS_THREADS,
        30L,
        TimeUnit.SECONDS,
        SynchronousQueue(),
        { runnable ->
            Thread(runnable, "PenumbraTTS-${synthesisThreadIds.getAndIncrement()}").apply {
                isDaemon = true
            }
        },
        ThreadPoolExecutor.AbortPolicy(),
    )
    private val activeSynthesis = AtomicReference<SynthesisControl?>(null)
    private val stopGeneration = AtomicLong(0)

    private val nextRequestId = AtomicLong(1)
    private val requestIdByThread = ThreadLocal<Long?>()
    private val onSynthesizeStartByThread = ThreadLocal<Long?>()
    private val initializeStartByThread = ThreadLocal<Long?>()
    private val loadLanguageStartByThread = ThreadLocal<Long?>()

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing Humane TTS hooks...")
        hookHumaneTtsService(cl)
        Log.w(TAG, "Humane TTS hooks installed")
    }

    private fun hookHumaneTtsService(cl: ClassLoader) {
        val serviceClass = loadClassOrNull(cl, "humane.voice.tts.HumaneTTSService") ?: return
        val synthesisRequestClass = loadClassOrNull(cl, "android.speech.tts.SynthesisRequest") ?: return
        val synthesisCallbackClass = loadClassOrNull(cl, "android.speech.tts.SynthesisCallback") ?: return

        hookMethod(serviceClass, "onSynthesizeText", synthesisRequestClass, synthesisCallbackClass,
            before = { param ->
                val requestId = nextRequestId.getAndIncrement()
                val startMs = nowMs()
                requestIdByThread.set(requestId)
                onSynthesizeStartByThread.set(startMs)

                val request = param.args.getOrNull(0)
                val callback = param.args.getOrNull(1)
                if (request != null && callback != null) {
                    val handled = tryAudioDataStreamSynthesis(param.thisObject, request, callback, requestId)
                    if (handled) {
                        param.result = null
                    }
                }
            },
            after = { param ->
                val requestId = requestIdByThread.get()
                val throwable = param.throwable
                if (throwable != null) {
                    val startMs = onSynthesizeStartByThread.get() ?: 0L
                    Log.w(
                        TAG,
                        "id=$requestId tts stock path failed totalMs=${elapsedSince(startMs)}",
                    )
                }
                requestIdByThread.remove()
                onSynthesizeStartByThread.remove()
            }
        )

        hookMethod(serviceClass, "initializeSynthesizer",
            before = {
                initializeStartByThread.set(nowMs())
            },
            after = { param ->
                val startMs = initializeStartByThread.get() ?: 0L
                Log.w(
                    TAG,
                    "id=${requestId()} initializeSynthesizer end durationMs=${elapsedSince(startMs)} " +
                        "failed=${param.throwable != null}",
                )
                initializeStartByThread.remove()
            }
        )

        hookMethod(serviceClass, "onLoadLanguage", String::class.java, String::class.java, String::class.java,
            before = {
                loadLanguageStartByThread.set(nowMs())
            },
            after = { param ->
                val result = param.result as? Int
                val throwable = param.throwable
                if (throwable != null || result == -2 || result == -1) {
                    val startMs = loadLanguageStartByThread.get() ?: 0L
                    Log.w(
                        TAG,
                        "id=${requestId()} tts languageLoadFailed durationMs=${elapsedSince(startMs)} " +
                            "failed=${throwable != null}",
                    )
                }
                loadLanguageStartByThread.remove()
            }
        )

        hookMethod(
            serviceClass,
            "onStop",
            before = { param ->
                cancelActiveSynthesis(param.thisObject)
            },
        )
    }

    private fun tryAudioDataStreamSynthesis(
        service: Any,
        request: Any,
        synthesisCallback: Any,
        requestId: Long,
    ): Boolean {
        val startMs = nowMs()
        val observedStopGeneration = stopGeneration.get()
        val prepared = prepareSynthesis(
            service,
            request,
            synthesisCallback,
            requestId,
        ) ?: return false
        val callbackTouched = AtomicBoolean(false)
        val terminal = TerminalCallbackGate { value ->
            when (value) {
                TerminalCallback.DONE -> prepared.callbackDone
                TerminalCallback.ERROR -> prepared.callbackError
            }.invoke(prepared.callback)
        }
        val control = SynthesisControl(
            service,
            SYNTHESIS_DEADLINE_MILLIS,
            terminal,
            callbackTouched,
        )
        var stoppedBeforeRegistration = false
        val previous = synchronized(activeSynthesis) {
            if (stopGeneration.get() != observedStopGeneration) {
                stoppedBeforeRegistration = true
                null
            } else {
                activeSynthesis.getAndSet(control)
            }
        }
        if (stoppedBeforeRegistration) {
            control.cancel()
            return true
        }
        previous?.cancel()

        val future = try {
            synthesisExecutor.submit {
                driveSynthesis(prepared, control)
            }
        } catch (_: Throwable) {
            val untouchedFailOpen = synchronized(activeSynthesis) {
                if (
                    activeSynthesis.get() === control &&
                    control.currentState() == SynthesisState.ACTIVE &&
                    !control.callbackWasTouched()
                ) {
                    activeSynthesis.set(null)
                    true
                } else {
                    false
                }
            }
            Log.w(TAG, "id=$requestId tts worker unavailable")
            if (untouchedFailOpen) return false
            control.cancel()
            return true
        }
        control.attachWorker(future)

        val outcome = try {
            awaitSynthesisFuture(control, future)
        } finally {
            activeSynthesis.compareAndSet(control, null)
        }
        Log.w(
            TAG,
            "id=$requestId tts stream end totalMs=${elapsedSince(startMs)} " +
                "outcome=${outcome.name.lowercase()} state=${control.currentState().name.lowercase()} " +
                "callbackTouched=${control.callbackWasTouched()}",
        )
        // Once a validated worker was accepted, this hook exclusively owns the
        // callback. Timeouts, cancellation, provider failures, and callback
        // invocation failures are terminal and must never fall back into stock
        // on the same callback instance.
        return true
    }

    private fun prepareSynthesis(
        service: Any,
        request: Any,
        synthesisCallback: Any,
        requestId: Long,
    ): PreparedSynthesis? {
        return try {
            val requestClass = request.javaClass
            val text = requestClass
                .getMethod("getCharSequenceText")
                .invoke(request)
                ?.toString()
                ?: return null
            val ssml = buildSsml(text) ?: return null
            val language = requestClass.getMethod("getLanguage").invoke(request) as? String
                ?: return null
            val country = requestClass.getMethod("getCountry").invoke(request) as? String
                ?: return null
            val variant = requestClass.getMethod("getVariant").invoke(request) as? String
                ?: return null
            if (language.isBlank() || country.isBlank()) return null

            val callbackClass = synthesisCallback.javaClass
            val callbackMaxBuffer = callbackClass.getMethod("getMaxBufferSize")
            val callbackStart = callbackClass.getMethod(
                "start",
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
            )
            val callbackAudioAvailable = callbackClass.getMethod(
                "audioAvailable",
                ByteArray::class.java,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
            )
            val callbackDone = callbackClass.getMethod("done")
            val callbackError = callbackClass.getMethod("error")
            val androidMaxBufferSize = callbackMaxBuffer.invoke(synthesisCallback) as? Int
                ?: return null
            val readBufferSize = boundedReadBufferSize(androidMaxBufferSize) ?: return null

            val serviceClass = service.javaClass
            val onLoadLanguage = serviceClass.getDeclaredMethod(
                "onLoadLanguage",
                String::class.java,
                String::class.java,
                String::class.java,
            ).apply { isAccessible = true }
            val loadResult = onLoadLanguage.invoke(service, language, country, variant) as? Int
                ?: return null
            if (loadResult < 0) return null

            val synthesizer = serviceClass.getDeclaredField("mSynthesizer")
                .apply { isAccessible = true }
                .get(service)
                ?: return null
            val classLoader = serviceClass.classLoader ?: return null
            val synthesisResultClass = classLoader.loadClass(
                "com.microsoft.cognitiveservices.speech.SpeechSynthesisResult",
            )
            val audioDataStreamClass = classLoader.loadClass(
                "com.microsoft.cognitiveservices.speech.AudioDataStream",
            )

            PreparedSynthesis(
                textLength = text.length,
                ssml = ssml,
                callback = synthesisCallback,
                readBufferSize = readBufferSize,
                synthesizer = synthesizer,
                startSpeakingSsml = synthesizer.javaClass.getMethod(
                    "StartSpeakingSsml",
                    String::class.java,
                ),
                audioStreamFromResult = audioDataStreamClass.getMethod(
                    "fromResult",
                    synthesisResultClass,
                ),
                readData = audioDataStreamClass.getMethod("readData", ByteArray::class.java),
                streamStatus = audioDataStreamClass.getMethod("getStatus"),
                callbackStart = callbackStart,
                callbackAudioAvailable = callbackAudioAvailable,
                callbackDone = callbackDone,
                callbackError = callbackError,
            )
        } catch (_: Throwable) {
            Log.w(TAG, "id=$requestId tts preparation unavailable")
            null
        }
    }

    internal fun driveSynthesis(
        driver: SynthesisDriver,
        control: SynthesisControl,
    ) {
        var callbackStarted = false
        var totalBytes = 0L

        try {
            control.checkpoint()
            val result = driver.startSynthesis()
                ?: run {
                    control.fail()
                    return
                }
            if (!control.attachSynthesisResult(result)) return
            control.checkpoint()

            val audioStream = driver.openAudioStream(result)
                ?: run {
                    control.fail()
                    return
                }
            if (!control.attachAudioStream(audioStream)) return
            val buffer = ByteArray(driver.readBufferSize)

            while (true) {
                control.checkpoint()
                val readValue = driver.readAudio(audioStream, buffer) as? Number
                    ?: run {
                        control.fail()
                        return
                    }
                control.checkpoint()
                val read = readValue.toLong()
                when (classifyReadLength(read, buffer.size)) {
                    ReadLength.INVALID -> {
                        control.fail()
                        return
                    }
                    ReadLength.END_OF_STREAM -> break
                    ReadLength.DATA -> Unit
                }

                if (!callbackStarted) {
                    control.checkpoint()
                    val startAttempt = control.invokeActiveCallback {
                        driver.startCallback()
                    }
                    if (!startAttempt.admitted) return
                    if (startAttempt.failed || startAttempt.value as? Int != 0) {
                        control.fail()
                        return
                    }
                    callbackStarted = true
                }

                control.checkpoint()
                val audioAttempt = control.invokeActiveCallback {
                    driver.writeAudio(buffer, read.toInt())
                }
                if (!audioAttempt.admitted) return
                if (audioAttempt.failed || audioAttempt.value as? Int != 0) {
                    control.fail()
                    return
                }
                totalBytes = try {
                    Math.addExact(totalBytes, read)
                } catch (_: ArithmeticException) {
                    control.fail()
                    return
                }
            }

            control.checkpoint()
            val completed = driver.completionStatus(audioStream)
            if (!isValidSynthesisCompletion(callbackStarted, totalBytes, completed)) {
                control.fail()
                return
            }
            control.completeSuccess()
        } catch (_: Throwable) {
            control.fail()
        } finally {
            control.closeResources()
        }
    }

    internal fun awaitSynthesisFuture(
        control: SynthesisControl,
        future: Future<*>,
    ): AwaitOutcome = try {
        val remainingNanos = control.remainingNanos()
        if (remainingNanos <= 0L) throw TimeoutException()
        future.get(remainingNanos, TimeUnit.NANOSECONDS)
        if (control.currentState() == SynthesisState.ACTIVE) {
            control.fail()
            AwaitOutcome.FAILED
        } else {
            AwaitOutcome.COMPLETED
        }
    } catch (_: TimeoutException) {
        if (control.cancel()) {
            AwaitOutcome.TIMED_OUT
        } else {
            awaitOutcomeForTerminalState(control)
        }
    } catch (_: CancellationException) {
        control.cancel()
        awaitOutcomeForTerminalState(control)
    } catch (_: ExecutionException) {
        control.fail()
        awaitOutcomeForTerminalState(control)
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        control.cancel()
        awaitOutcomeForTerminalState(control)
    }

    private fun awaitOutcomeForTerminalState(control: SynthesisControl): AwaitOutcome =
        when (control.currentState()) {
            SynthesisState.SUCCEEDED -> AwaitOutcome.COMPLETED
            SynthesisState.FAILED -> AwaitOutcome.FAILED
            SynthesisState.CANCELLED -> AwaitOutcome.CANCELLED
            SynthesisState.ACTIVE -> AwaitOutcome.FAILED
        }

    private fun cancelActiveSynthesis(service: Any) {
        val cancelled = synchronized(activeSynthesis) {
            stopGeneration.incrementAndGet()
            val active = activeSynthesis.get()
            if (active != null && active.service === service) {
                activeSynthesis.set(null)
                active
            } else {
                null
            }
        }
        if (cancelled != null) {
            cancelled.cancel()
            Log.w(TAG, "tts stream cancelled by stock onStop")
        }
    }

    internal enum class ReadLength {
        DATA,
        END_OF_STREAM,
        INVALID,
    }

    internal fun classifyReadLength(read: Long, bufferSize: Int): ReadLength = when {
        bufferSize <= 0 || read < 0L || read > bufferSize.toLong() -> ReadLength.INVALID
        read == 0L -> ReadLength.END_OF_STREAM
        else -> ReadLength.DATA
    }

    internal fun isValidSynthesisCompletion(
        callbackStarted: Boolean,
        totalBytes: Long,
        streamStatus: String?,
    ): Boolean = callbackStarted &&
        totalBytes > 0L &&
        streamStatus == COMPLETED_STREAM_STATUS

    /**
     * Build the SSML sent to the Cognitive Services synthesizer.
     *
     * The stock narrator (NarratorImpl / SpeakEasyService) already wraps most
     * responses in a `<speak version="1.0" xml:lang="...">` envelope (often with
     * a `<prosody>` for the configured volume/rate) before the text reaches the
     * TTS engine. Escaping and re-wrapping that text double-wraps it, so the
     * synthesizer speaks the literal markup ("speak version 1.0 xml lang en-US
     * prosody volume 1.20 rate 1.10 ..."). Detect a well-formed stock envelope
     * and forward it unchanged — the stock's own SSML renders correctly through
     * the same SDK — while rejecting external-resource elements (`<audio>`,
     * `<lexicon>`, mstts background audio) as a safety bound. Plain text keeps
     * the always-escape-then-wrap path, since only the envelope shape is trusted.
     */
    internal fun buildSsml(text: String): String? {
        if (text.isBlank() || !containsOnlyXml10Characters(text)) return null
        val trimmed = text.trim()
        if (trimmed.startsWith("<speak") && trimmed.endsWith("</speak>")) {
            val lowered = trimmed.lowercase()
            if (lowered.contains("<audio") ||
                lowered.contains("<lexicon") ||
                lowered.contains("backgroundaudio")
            ) {
                return null
            }
            return text
        }
        return "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" " +
            "xml:lang=\"en-US\">${escapeXmlText(text)}</speak>"
    }

    /** Never allocate or submit a chunk larger than Android advertises. */
    internal fun boundedReadBufferSize(androidMaxBufferSize: Int): Int? =
        androidMaxBufferSize
            .takeIf { it > 0 }
            ?.let { minOf(TARGET_READ_BYTES, it) }

    private fun containsOnlyXml10Characters(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            val codePoint = Character.codePointAt(value, index)
            val valid = codePoint == 0x9 ||
                codePoint == 0xA ||
                codePoint == 0xD ||
                codePoint in 0x20..0xD7FF ||
                codePoint in 0xE000..0xFFFD ||
                codePoint in 0x10000..0x10FFFF
            if (!valid) return false
            index += Character.charCount(codePoint)
        }
        return true
    }

    private fun escapeXmlText(value: String): String = buildString(value.length) {
        for (character in value) {
            when (character) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '\"' -> append("&quot;")
                '\'' -> append("&apos;")
                else -> append(character)
            }
        }
    }

    private fun safeClose(target: Any?) {
        try {
            if (target is AutoCloseable) {
                target.close()
            } else if (target != null) {
                // One lookup and one invocation only. Retrying a public close as
                // declared after InvocationTargetException can close twice.
                target.javaClass.getMethod("close").invoke(target)
            }
        } catch (_: Throwable) {
        }
    }

    private fun hookMethod(
        clazz: Class<*>,
        name: String,
        vararg paramTypes: Class<*>,
        before: ((XC_MethodHook.MethodHookParam) -> Unit)? = null,
        after: ((XC_MethodHook.MethodHookParam) -> Unit)? = null,
    ) {
        try {
            val method = clazz.getDeclaredMethod(name, *paramTypes)
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    before?.invoke(param)
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    after?.invoke(param)
                }
            })
            Log.w(TAG, "  Hooked ${clazz.name}.$name(${paramTypes.joinToString { it.simpleName }})")
        } catch (_: Throwable) {
            Log.w(TAG, "  Failed to hook ${clazz.name}.$name")
        }
    }


    private fun loadClassOrNull(cl: ClassLoader, className: String): Class<*>? {
        return try {
            cl.loadClass(className)
        } catch (_: Throwable) {
            Log.w(TAG, "  $className not found, skipping")
            null
        }
    }

    private fun requestId(): Long? = requestIdByThread.get()
    private fun nowMs(): Long = SystemClock.elapsedRealtime()
    private fun elapsedSince(startMs: Long): Long = if (startMs > 0L) nowMs() - startMs else -1L
}
