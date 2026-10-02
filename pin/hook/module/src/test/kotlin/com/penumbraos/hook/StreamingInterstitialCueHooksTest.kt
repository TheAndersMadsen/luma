package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Test

/** Guards the privacy-safe, intentionally inert streaming-cue entry point. */
class StreamingInterstitialCueHooksTest {
    @Test
    fun `install never inspects stock classes or installs an interceptor`() {
        val rejectingLoader = object : ClassLoader(null) {
            override fun loadClass(name: String): Class<*> {
                throw AssertionError("inert install must not load $name")
            }
        }

        StreamingInterstitialCueHooks.install(rejectingLoader)
    }

    @Test
    fun `hook exposes no forwarding or reflection helpers`() {
        assertEquals(
            listOf("install"),
            StreamingInterstitialCueHooks::class.java.declaredMethods
                .map { it.name }
                .sorted(),
        )
    }

    @Test
    fun `hook retains no process-global cue state`() {
        assertEquals(
            listOf("INSTANCE"),
            StreamingInterstitialCueHooks::class.java.declaredFields
                .map { it.name }
                .sorted(),
        )
    }
}
