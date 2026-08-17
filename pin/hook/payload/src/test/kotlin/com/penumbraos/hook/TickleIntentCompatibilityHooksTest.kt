package com.penumbraos.hook

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TickleIntentCompatibilityHooksTest {
    @Test
    fun `only stock normalized tickle phrases are intercepted`() {
        listOf(
            "tickle my fancy",
            "tickle tickle tickle",
            "tickle",
        ).forEach { phrase ->
            assertTrue(TickleIntentCompatibilityHooks.isExactTicklePhrase(phrase))
        }

        listOf(
            "Tickle",
            "tickle!",
            " tickle",
            "tickle  tickle tickle",
            "please tickle",
            "tickles",
            "",
            "tickle me",
            "tickle tickle",
            "tickle tickle tickle tickle",
            "tickle my fancy please",
            "TICKLE",
            "tickle my fancy tickle tickle tickle",
        ).forEach { phrase ->
            assertFalse(TickleIntentCompatibilityHooks.isExactTicklePhrase(phrase))
        }
    }

    @Test
    fun `exact phrase sources list matches stock contract`() {
        val compiled = mutableMapOf<String, List<Pattern>>()
        val groups = mutableMapOf<Pattern, List<String>>()
        TickleIntentCompatibilityHooks.ensureTickleRegexes(compiled, groups)
        val patterns = checkNotNull(compiled["Tickle"]).map(Pattern::pattern)
        assertEquals(3, patterns.size)
        assertTrue(patterns.contains("tickle"))
        assertTrue(patterns.contains("tickle my fancy"))
        assertTrue(patterns.contains("tickle tickle tickle"))
    }

    @Test
    fun `tickle gate live reads every time and fails closed`() {
        val enabled = AtomicBoolean(false)
        var reads = 0
        val liveRead = {
            reads++
            enabled.get()
        }

        assertEquals(
            false,
            TickleIntentCompatibilityHooks.liveTickleDecision("Tickle", liveRead),
        )
        enabled.set(true)
        assertEquals(
            true,
            TickleIntentCompatibilityHooks.liveTickleDecision("Tickle", liveRead),
        )
        enabled.set(false)
        assertEquals(
            false,
            TickleIntentCompatibilityHooks.liveTickleDecision("Tickle", liveRead),
        )
        assertEquals(3, reads)
        assertEquals(
            false,
            TickleIntentCompatibilityHooks.liveTickleDecision("Tickle") {
                throw IllegalStateException("feature service unavailable")
            },
        )
    }

    @Test
    fun `non tickle actions preserve stock result without reading flag`() {
        var reads = 0
        val decision = TickleIntentCompatibilityHooks.liveTickleDecision(
            "PlayMusic",
        ) {
            reads++
            true
        }

        assertNull(decision)
        assertEquals(0, reads)
    }

    @Test
    fun `same cached regex engine follows false true false flag changes`() {
        val compiled = mutableMapOf<String, List<Pattern>>()
        val groups = mutableMapOf<Pattern, List<String>>()
        val enabled = AtomicBoolean(false)

        fun processTickle(): Boolean {
            val allowed = checkNotNull(
                TickleIntentCompatibilityHooks.liveTickleDecision(
                    "Tickle",
                    enabled::get,
                ),
            )
            if (allowed) {
                TickleIntentCompatibilityHooks.ensureTickleRegexes(compiled, groups)
            }
            return allowed
        }

        assertFalse(processTickle())
        assertFalse(compiled.containsKey("Tickle"))

        enabled.set(true)
        assertTrue(processTickle())
        assertEquals(3, checkNotNull(compiled["Tickle"]).size)

        enabled.set(false)
        assertFalse(processTickle())
        // A cached entry is harmless because the live gate short-circuits it.
        assertEquals(3, checkNotNull(compiled["Tickle"]).size)
    }

    @Test
    fun `regex repair is idempotent and preserves every other entry`() {
        val weather = Pattern.compile("what is the weather")
        val compiled = mutableMapOf<String, List<Pattern>>(
            "Weather" to listOf(weather),
        )
        val groups = mutableMapOf<Pattern, List<String>>(
            weather to listOf("Location"),
        )

        assertTrue(
            TickleIntentCompatibilityHooks.ensureTickleRegexes(compiled, groups),
        )
        val firstTicklePatterns = checkNotNull(compiled["Tickle"])
        assertEquals(
            listOf("tickle my fancy", "tickle tickle tickle", "tickle"),
            firstTicklePatterns.map(Pattern::pattern),
        )
        assertSame(weather, checkNotNull(compiled["Weather"]).single())
        assertEquals(listOf("Location"), groups[weather])
        assertTrue(firstTicklePatterns.all { groups[it].isNullOrEmpty() })

        assertFalse(
            TickleIntentCompatibilityHooks.ensureTickleRegexes(compiled, groups),
        )
        val secondTicklePatterns = checkNotNull(compiled["Tickle"])
        firstTicklePatterns.indices.forEach { index ->
            assertSame(firstTicklePatterns[index], secondTicklePatterns[index])
        }
        assertEquals(2, compiled.size)
        assertEquals(4, groups.size)
    }

    @Test
    fun `simultaneous regex repairs add one copy of each pattern`() {
        val compiled = mutableMapOf<String, List<Pattern>>()
        val groups = mutableMapOf<Pattern, List<String>>()
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(8)
        val futures = List(32) {
            executor.submit {
                start.await()
                TickleIntentCompatibilityHooks.ensureTickleRegexes(compiled, groups)
            }
        }

        start.countDown()
        futures.forEach { it.get(5, TimeUnit.SECONDS) }
        executor.shutdown()
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))

        val patterns = checkNotNull(compiled["Tickle"])
        assertEquals(3, patterns.size)
        assertEquals(3, patterns.map(Pattern::pattern).toSet().size)
        assertEquals(3, groups.size)
        assertTrue(patterns.all(groups::containsKey))
    }

    @Test
    fun `schema repair is synchronized and adds tickle once`() {
        val lock = Any()
        val present = AtomicBoolean(false)
        val adds = AtomicInteger(0)
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(8)
        val futures = List(32) {
            executor.submit {
                start.await()
                TickleIntentCompatibilityHooks.ensureTickleSchema(
                    lock,
                    present::get,
                ) {
                    adds.incrementAndGet()
                    present.set(true)
                }
            }
        }

        start.countDown()
        futures.forEach { it.get(5, TimeUnit.SECONDS) }
        executor.shutdown()
        assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
        assertTrue(present.get())
        assertEquals(1, adds.get())
    }

    @Test
    fun `source binds only the verified stock tickle contracts`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/TickleIntentCompatibilityHooks.kt",
        ).readText()
        val ironman = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/IronmanHooks.kt",
        ).readText()

        assertTrue(source.contains("humaneinternal.system.intent.interpreters.regex.RegexIntentEngine"))
        assertTrue(source.contains("\"process\","))
        assertTrue(source.contains("\"compiledRegexes\""))
        assertTrue(source.contains("\"groupNamesByRegex\""))
        assertTrue(source.contains("humaneinternal.system.utils.ActionUtils"))
        assertTrue(source.contains("\"isValidAction\""))
        assertTrue(source.contains("humaneinternal.system.concierge.JsonResolver"))
        assertTrue(source.contains("humaneinternal.system.concierge.SchemaCatalog"))
        assertTrue(source.contains("\"mSchemaCatalog\""))
        assertTrue(source.contains("\"containsSchema\""))
        assertTrue(source.contains("humaneinternal.system.intent.actions.tickle.TickleAction"))
        assertTrue(source.contains("\"THE_TICKLE\""))
        assertTrue(ironman.contains("TickleIntentCompatibilityHooks.install(cl)"))

        assertFalse(source.contains("setServerFlags"))
        assertFalse(source.contains("sendBroadcast"))
        assertFalse(source.contains("SharedPreferences"))
        assertFalse(source.contains("android.provider.Settings"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
