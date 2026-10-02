package com.penumbraos.hook

import java.io.File
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HumaneTtsHooksTest {
    @Test
    fun `plain response text is escaped before SSML wrapping`() {
        assertEquals(
            "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" " +
                "xml:lang=\"en-US\">AT&amp;T says &lt;hello&gt; &quot;now&quot; " +
                "and &apos;later&apos;</speak>",
            HumaneTtsHooks.buildSsml("AT&T says <hello> \"now\" and 'later'"),
        )
    }

    @Test
    fun `non-envelope caller markup is escaped without a trusted provenance bit`() {
        // Markup that is not a complete <speak> envelope is still fully escaped:
        // only the stock <speak>...</speak> envelope shape is trusted to render.
        for (markup in listOf(
            "<audio src=\"https://example.invalid/private\"/>",
            "<voice name=\"other\">hello</voice>",
            "<prosody rate=\"slow\">hello</prosody>",
            "<mark name=\"secret\"/>",
        )) {
            val wrapped = HumaneTtsHooks.buildSsml(markup)
            assertTrue(markup, wrapped?.contains("&lt;") == true)
            assertTrue(markup, wrapped?.contains("&gt;") == true)
            assertFalse(markup, wrapped?.contains(markup) == true)
        }
    }

    @Test
    fun `direct stock SSML envelope is forwarded but external-fetch elements are rejected`() {
        // The stock narrator (SpeakEasyService) wraps text as
        // <speak ...><prosody ...>text</prosody></speak>. It must render through
        // the synthesizer, not be escaped and spoken as literal markup.
        val stock =
            "<speak version=\"1.0\" xml:lang=\"en-US\">" +
                "<prosody volume=\"1.20\" rate=\"1.10\">The weather is sunny</prosody></speak>"
        assertEquals(stock, HumaneTtsHooks.buildSsml(stock))
        assertFalse("must not escape a trusted envelope", stock.let {
            HumaneTtsHooks.buildSsml(it)!!.contains("&lt;speak")
        })

        // External-resource elements inside a <speak> envelope are refused.
        assertNull(
            HumaneTtsHooks.buildSsml(
                "<speak version=\"1.0\"><audio src=\"http://x\"/>hi</speak>",
            ),
        )
        assertNull(
            HumaneTtsHooks.buildSsml("<speak><lexicon uri=\"http://x\"/>hi</speak>"),
        )
    }

    @Test
    fun `valid Unicode survives while invalid XML controls and surrogates fail open`() {
        val unicode = "Hvidovre 🇩🇰 — 22 °C\nKlar"
        val wrapped = HumaneTtsHooks.buildSsml(unicode)

        assertTrue(wrapped?.contains(unicode) == true)
        assertNull(HumaneTtsHooks.buildSsml("bad\u0001control"))
        assertNull(HumaneTtsHooks.buildSsml("unpaired \uD800 surrogate"))
        assertNull(HumaneTtsHooks.buildSsml(" \t\n"))
    }

    @Test
    fun `read buffer never exceeds callback maximum`() {
        val expected = mapOf(
            1 to 1,
            512 to 512,
            2400 to 2400,
            16000 to 2400,
        )

        for ((maximum, bufferSize) in expected) {
            assertEquals(bufferSize, HumaneTtsHooks.boundedReadBufferSize(maximum))
            assertTrue(HumaneTtsHooks.boundedReadBufferSize(maximum)!! <= maximum)
        }
        assertNull(HumaneTtsHooks.boundedReadBufferSize(0))
        assertNull(HumaneTtsHooks.boundedReadBufferSize(-1))
    }

    @Test
    fun `read length rejects negative oversized and narrowing overflow values`() {
        assertEquals(
            HumaneTtsHooks.ReadLength.INVALID,
            HumaneTtsHooks.classifyReadLength(-1L, 2400),
        )
        assertEquals(
            HumaneTtsHooks.ReadLength.END_OF_STREAM,
            HumaneTtsHooks.classifyReadLength(0L, 2400),
        )
        assertEquals(
            HumaneTtsHooks.ReadLength.DATA,
            HumaneTtsHooks.classifyReadLength(1L, 2400),
        )
        assertEquals(
            HumaneTtsHooks.ReadLength.DATA,
            HumaneTtsHooks.classifyReadLength(2400L, 2400),
        )
        assertEquals(
            HumaneTtsHooks.ReadLength.INVALID,
            HumaneTtsHooks.classifyReadLength(2401L, 2400),
        )
        assertEquals(
            HumaneTtsHooks.ReadLength.INVALID,
            HumaneTtsHooks.classifyReadLength(Long.MAX_VALUE, 2400),
        )
        assertEquals(
            HumaneTtsHooks.ReadLength.INVALID,
            HumaneTtsHooks.classifyReadLength(1L, 0),
        )
    }

    @Test
    fun `done requires started callback positive audio and fully drained stream`() {
        assertTrue(
            HumaneTtsHooks.isValidSynthesisCompletion(
                callbackStarted = true,
                totalBytes = 1L,
                streamStatus = "AllData",
            ),
        )
        // The start-snapshot result reason ("SynthesizingAudioCompleted" /
        // "SynthesizingAudioStarted") is NOT a completion signal for the
        // streaming API and must be rejected. Only the drained
        // AudioDataStream status "AllData" proves full synthesis.
        for ((started, bytes, status) in listOf(
            Triple(false, 1L, "AllData"),
            Triple(true, 0L, "AllData"),
            Triple(true, 1L, null),
            Triple(true, 1L, "Canceled"),
            Triple(true, 1L, "PartialData"),
            Triple(true, 1L, "NoData"),
            Triple(true, 1L, "Unknown"),
            Triple(true, 1L, "SynthesizingAudioCompleted"),
            Triple(true, 1L, "SynthesizingAudioStarted"),
        )) {
            assertFalse(
                "started=$started bytes=$bytes status=$status",
                HumaneTtsHooks.isValidSynthesisCompletion(started, bytes, status),
            )
        }
    }

    @Test
    fun `terminal callback is exactly once in sequential success and failure paths`() {
        for (first in HumaneTtsHooks.TerminalCallback.entries) {
            val terminals = mutableListOf<HumaneTtsHooks.TerminalCallback>()
            val gate = HumaneTtsHooks.TerminalCallbackGate(terminals::add)

            assertEquals(HumaneTtsHooks.TerminalDispatch.SENT, gate.send(first))
            assertEquals(
                HumaneTtsHooks.TerminalDispatch.ALREADY_SENT,
                gate.send(HumaneTtsHooks.TerminalCallback.DONE),
            )
            assertEquals(
                HumaneTtsHooks.TerminalDispatch.ALREADY_SENT,
                gate.send(HumaneTtsHooks.TerminalCallback.ERROR),
            )
            assertEquals(listOf(first), terminals)
            assertEquals(first, gate.sentTerminal())
        }
    }

    @Test
    fun `throwing reflective terminal is never retried`() {
        val invocations = AtomicInteger()
        val gate = HumaneTtsHooks.TerminalCallbackGate {
            invocations.incrementAndGet()
            throw InvocationTargetException(IllegalStateException("callback failed"))
        }

        assertEquals(
            HumaneTtsHooks.TerminalDispatch.INVOCATION_FAILED,
            gate.send(HumaneTtsHooks.TerminalCallback.DONE),
        )
        assertEquals(
            HumaneTtsHooks.TerminalDispatch.ALREADY_SENT,
            gate.send(HumaneTtsHooks.TerminalCallback.ERROR),
        )
        assertEquals(1, invocations.get())
        assertEquals(HumaneTtsHooks.TerminalCallback.DONE, gate.sentTerminal())
    }

    @Test
    fun `terminal gate is atomic when done and error race`() {
        repeat(50) {
            val ready = CountDownLatch(16)
            val release = CountDownLatch(1)
            val invocations = AtomicInteger()
            val gate = HumaneTtsHooks.TerminalCallbackGate { invocations.incrementAndGet() }
            val threads = List(16) { index ->
                Thread {
                    ready.countDown()
                    release.await()
                    gate.send(
                        if (index % 2 == 0) {
                            HumaneTtsHooks.TerminalCallback.DONE
                        } else {
                            HumaneTtsHooks.TerminalCallback.ERROR
                        },
                    )
                }
            }

            threads.forEach(Thread::start)
            assertTrue(ready.await(1, TimeUnit.SECONDS))
            release.countDown()
            threads.forEach { it.join(1_000L) }
            assertEquals(1, invocations.get())
            assertTrue(gate.sentTerminal() != null)
        }
    }

    @Test
    fun `cancel and valid completion race to one coherent terminal state`() {
        repeat(50) {
            val terminals = mutableListOf<HumaneTtsHooks.TerminalCallback>()
            val gate = HumaneTtsHooks.TerminalCallbackGate {
                synchronized(terminals) { terminals += it }
            }
            val control = HumaneTtsHooks.SynthesisControl(Any(), 10_000L, gate)
            val ready = CountDownLatch(2)
            val release = CountDownLatch(1)
            val cancel = Thread {
                ready.countDown()
                release.await()
                control.cancel()
            }
            val complete = Thread {
                ready.countDown()
                release.await()
                control.completeSuccess()
            }

            cancel.start()
            complete.start()
            assertTrue(ready.await(1, TimeUnit.SECONDS))
            release.countDown()
            cancel.join(1_000L)
            complete.join(1_000L)

            assertEquals(1, terminals.size)
            when (control.currentState()) {
                HumaneTtsHooks.SynthesisState.SUCCEEDED -> assertEquals(
                    HumaneTtsHooks.TerminalCallback.DONE,
                    terminals.single(),
                )
                HumaneTtsHooks.SynthesisState.CANCELLED -> assertEquals(
                    HumaneTtsHooks.TerminalCallback.ERROR,
                    terminals.single(),
                )
                else -> throw AssertionError("unexpected state ${control.currentState()}")
            }
        }
    }

    @Test
    fun `callback touch followed by start failure remains handled as one error`() {
        val terminals = mutableListOf<HumaneTtsHooks.TerminalCallback>()
        val gate = HumaneTtsHooks.TerminalCallbackGate(terminals::add)
        val control = HumaneTtsHooks.SynthesisControl(Any(), 10_000L, gate)

        control.markCallbackTouched()
        assertTrue(control.fail())
        assertFalse(control.completeSuccess())
        assertTrue(control.callbackWasTouched())
        assertEquals(HumaneTtsHooks.SynthesisState.FAILED, control.currentState())
        assertEquals(listOf(HumaneTtsHooks.TerminalCallback.ERROR), terminals)
    }

    @Test
    fun `deadline cancels blocked worker closes resources and emits one error`() {
        val now = AtomicLong(0L)
        val terminals = mutableListOf<HumaneTtsHooks.TerminalCallback>()
        val gate = HumaneTtsHooks.TerminalCallbackGate(terminals::add)
        val control = HumaneTtsHooks.SynthesisControl(
            service = Any(),
            deadlineMillis = 1_000L,
            terminal = gate,
            nanoTime = now::get,
        )
        val result = CloseCounter()
        val stream = CloseCounter()
        assertTrue(control.attachSynthesisResult(result))
        assertTrue(control.attachAudioStream(stream))
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val future = FutureTask {
            started.countDown()
            release.await()
        }
        val worker = Thread(future)
        control.attachWorker(future)
        worker.start()
        assertTrue(started.await(1, TimeUnit.SECONDS))

        now.set(TimeUnit.SECONDS.toNanos(2L))
        assertEquals(
            HumaneTtsHooks.AwaitOutcome.TIMED_OUT,
            HumaneTtsHooks.awaitSynthesisFuture(control, future),
        )
        release.countDown()
        worker.join(1_000L)

        assertTrue(future.isCancelled)
        assertEquals(HumaneTtsHooks.SynthesisState.CANCELLED, control.currentState())
        assertEquals(listOf(HumaneTtsHooks.TerminalCallback.ERROR), terminals)
        assertEquals(1, result.closeCount.get())
        assertEquals(1, stream.closeCount.get())
        control.closeResources()
        assertEquals(1, result.closeCount.get())
        assertEquals(1, stream.closeCount.get())
    }

    @Test
    fun `onStop style cancellation interrupts blocked worker and cannot become done`() {
        val terminals = mutableListOf<HumaneTtsHooks.TerminalCallback>()
        val gate = HumaneTtsHooks.TerminalCallbackGate(terminals::add)
        val control = HumaneTtsHooks.SynthesisControl(Any(), 10_000L, gate)
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val future = FutureTask {
            started.countDown()
            release.await()
        }
        val worker = Thread(future)
        control.attachWorker(future)
        worker.start()
        assertTrue(started.await(1, TimeUnit.SECONDS))

        assertTrue(control.cancel())
        assertFalse(control.completeSuccess())
        release.countDown()
        worker.join(1_000L)

        assertTrue(future.isCancelled)
        assertEquals(listOf(HumaneTtsHooks.TerminalCallback.ERROR), terminals)
        assertEquals(HumaneTtsHooks.SynthesisState.CANCELLED, control.currentState())
    }

    @Test
    fun `source contract has bounded stop path and no sensitive provider diagnostics`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/HumaneTtsHooks.kt",
        ).readText()

        assertTrue(source.contains("SYNTHESIS_DEADLINE_MILLIS"))
        assertTrue(source.contains("MAX_BLOCKING_SYNTHESIS_THREADS"))
        assertTrue(source.contains("\"onStop\""))
        assertTrue(source.contains("activeSynthesis"))
        assertTrue(source.contains("classifyReadLength(read, buffer.size)"))
        assertFalse(source.contains("isValidSSML"))
        assertFalse(source.contains("getResultId"))
        assertFalse(source.contains("SynthesisBackend"))
        assertFalse(source.contains("getProperties"))
        assertFalse(source.contains("describeSynthesisResult"))
        assertFalse(source.contains("Log.e("))
        assertFalse(source.contains("throwable.message"))
        assertFalse(source.contains("throwable.javaClass"))
        assertFalse(source.contains("t.message"))
        assertFalse(source.contains("Log.e(TAG, \"id=\$requestId stream synthesis failed started=\$callbackStarted\", t)"))
        assertFalse(
            Regex("Log\\.[a-z]+\\([^\\n]+,\\s*(?:t|error|throwable)\\)")
                .containsMatchIn(source),
        )
    }

    private class CloseCounter : AutoCloseable {
        val closeCount = AtomicInteger()

        override fun close() {
            closeCount.incrementAndGet()
        }
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
