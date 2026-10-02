package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TickleRealDataHooksTest {
    private class ConstructorFixture {
        constructor(value: String)
        constructor(value: String, count: Int)
    }

    private open class ViewFixture {
        fun childViews(): List<Any> = emptyList()
    }

    private class WeatherViewFixture : ViewFixture()

    @Test
    fun `exact constructor resolution does not depend on declaration order`() {
        val constructor = HookUtils.findExactConstructor(
            ConstructorFixture::class.java,
            arrayOf(String::class.java, Int::class.javaPrimitiveType!!),
        )

        assertArrayEquals(
            arrayOf(String::class.java, Int::class.javaPrimitiveType!!),
            constructor.parameterTypes,
        )
        assertThrows(NoSuchMethodException::class.java) {
            HookUtils.findExactConstructor(
                ConstructorFixture::class.java,
                arrayOf(Int::class.javaPrimitiveType!!, String::class.java),
            )
        }
    }

    @Test
    fun `tickle hooks bind only the verified display constructor signatures`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/TickleRealDataHooks.kt",
        ).readText()

        assertTrue(
            source.contains(
                "arrayOf(String::class.java, String::class.java, String::class.java)",
            ),
        )
        assertTrue(
            Regex(
                """val constructorTypes: Array<Class<\*>> = arrayOf\(\s*""" +
                    """String::class\.java,\s*Array<String>::class\.java,\s*""" +
                    """IntArray::class\.java,\s*\)""",
            ).containsMatchIn(source),
        )
        assertEquals(2, Regex("HookUtils\\.hookConstructorBefore\\(").findAll(source).count())
        assertEquals(1, Regex("HookUtils\\.hookConstructorAfter\\(").findAll(source).count())
        assertFalse(source.contains(".constructors[0]"))
    }

    @Test
    fun `tickle real data never skips the stock pin screen`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/TickleRealDataHooks.kt",
        ).readText()

        assertFalse(source.contains("PinCodeView"))
        assertFalse(source.contains("PincodeInteractor"))
        assertFalse(source.contains("mInteractor"))
        assertFalse(source.contains("Auto-navigated"))
        assertFalse(source.contains("PinCodeView.<init>"))
    }

    @Test
    fun `weather refresh resolves inherited view API and updates narrated backing values`() {
        val childViews = WeatherViewFixture::class.java.getMethod("childViews")
        assertEquals(ViewFixture::class.java, childViews.declaringClass)

        val temperatures = arrayOf("--°", "--°", "--°")
        assertTrue(replaceWeatherTemperatures(temperatures, "21°C"))
        assertArrayEquals(arrayOf("21°C", "21°C", "21°C"), temperatures)
        assertFalse(replaceWeatherTemperatures(arrayOf("--°", "--°"), "21°C"))
        assertFalse(replaceWeatherTemperatures(arrayOf(1, 2, 3), "21°C"))

        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/TickleRealDataHooks.kt",
        ).readText()
        assertTrue(source.contains("view.javaClass.getMethod(\"childViews\")"))
        assertFalse(source.contains("superclass.superclass"))
        assertTrue(source.contains("getDeclaredField(\"mTemperatures\")"))
        assertTrue(source.contains("getDeclaredMethod(\"weatherIcon\""))
        assertTrue(source.contains(".apply { isAccessible = true }"))
        assertTrue(source.contains("\"setImage\""))
        assertFalse(source.contains("iconView != null && image != null"))
        assertTrue(source.contains("pendingViews.forEach"))
        assertTrue(source.contains("fullyUpdatedDays == 3"))
        assertTrue(source.contains("Weather presentation partially updated"))
        assertTrue(source.contains("WEATHER_FETCH_TIMEOUT_MS = 15_000L"))
        assertTrue(source.contains("handler.postDelayed("))
        assertTrue(source.contains("generation != weatherFetchGeneration"))
        assertTrue(source.contains("abortWeatherFetch(generation)"))
    }

    @Test
    fun `delayed weather response updates all bounded identity tracked views`() {
        val pending = PendingWeatherViews(capacity = 3)
        val first = String(charArrayOf('v', 'i', 'e', 'w'))
        val equalButDistinct = String(charArrayOf('v', 'i', 'e', 'w'))
        val third = Any()

        pending.add(first)
        pending.add(first)
        pending.add(equalButDistinct)
        pending.add(third)
        assertEquals(3, pending.size())

        val delayedBatch = pending.drain()
        assertEquals(3, delayedBatch.size)
        assertSame(first, delayedBatch[0])
        assertSame(equalButDistinct, delayedBatch[1])
        assertSame(third, delayedBatch[2])
        assertEquals(0, pending.size())

        val evicted = Any()
        pending.add(first)
        pending.add(equalButDistinct)
        pending.add(third)
        pending.add(evicted)
        val boundedBatch = pending.drain()
        assertEquals(3, boundedBatch.size)
        assertSame(equalButDistinct, boundedBatch[0])
        assertSame(evicted, boundedBatch[2])
    }

    @Test
    fun `weather temperature selection rejects non finite and converts finite fallback`() {
        assertEquals(21.5, selectWeatherTemperature(70.0, 21.5, true)!!, 0.0001)
        assertEquals(20.0, selectWeatherTemperature(68.0, Double.NaN, true)!!, 0.0001)
        assertEquals(68.0, selectWeatherTemperature(68.0, 20.0, false)!!, 0.0001)
        assertEquals(68.0, selectWeatherTemperature(Double.NaN, 20.0, false)!!, 0.0001)
        assertEquals(null, selectWeatherTemperature(Double.NaN, Double.POSITIVE_INFINITY, true))
        assertEquals(null, selectWeatherTemperature(Double.MAX_VALUE, null, false))
        assertEquals(68.0, selectWeatherTemperature(Double.MAX_VALUE, 20.0, false)!!, 0.0001)

        val cached = CachedWeather(68.0, 20.0, 4)
        assertEquals(RenderedWeather(20, "°C", 4), renderWeather(cached, true))
        assertEquals(RenderedWeather(68, "°F", 4), renderWeather(cached, false))
    }

    @Test
    fun `install accounting is fail open duplicate safe and content free`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/TickleRealDataHooks.kt",
        ).readText()

        assertTrue(source.contains("@Synchronized\n    fun install"))
        // UI hooks are deferred to ExperienceApplication.onCreate and installed
        // from the app's own classloader, because instantiateApplication runs
        // before the Tickle UI dex resolves. `installComplete` gates the onCreate
        // hook; `uiHooksInstalled` gates the deferred UI-hook install.
        assertTrue(source.contains("if (installComplete) return"))
        assertTrue(source.contains("installUiHooks(application?.classLoader ?: cl"))
        assertTrue(source.contains("if (uiHooksInstalled) return"))
        assertTrue(source.contains("results.all { it }"))
        assertTrue(source.contains("attempt < MAX_UI_HOOK_ATTEMPTS"))
        // Per-group idempotency: a retry never double-hooks an already-hooked class.
        assertTrue(source.contains("if (dateTimeHookInstalled) return@installBoundary true"))
        assertTrue(source.contains("if (weatherHookInstalled) return@installBoundary true"))
        assertTrue(source.contains("weatherHooksActive.set(fullyInstalled)"))
        assertTrue(source.contains("if (!weatherHooksActive.get())"))
        assertTrue(source.contains("val beforeInstalled = afterInstalled &&"))
        assertFalse(source.contains("location=\$location"))
        assertFalse(source.contains("time=\$time"))
        assertFalse(source.contains("date=\$date"))
        assertFalse(source.contains("temp=\$displayTemp"))
        assertFalse(source.contains("temp=\$cachedTemp"))
        assertFalse(source.contains("\${error}"))
        assertFalse(source.contains("Weather fetch failed:"))
        assertFalse(source.contains(", e)"))
        assertFalse(source.contains(", t)"))

        // Non-Tickle experience processes share ExperienceApplication, so the
        // onCreate callback fires in every experience pid. A one-shot
        // HomeInteractor probe gates the retry loop so we skip immediately
        // (with a debug log) instead of exhausting 60 retries and logging
        // misleading errors in food/contacts/music/settings processes.
        assertTrue(source.contains("humane.experience.tickle.ui.home.HomeInteractor"))
        assertTrue(source.contains("not the Tickle process"))
        assertTrue(source.contains("skipping UI hooks"))

        val failureHandler = source
            .substringAfter("\"handleFailure\" -> {")
            .substringBefore("weatherFetchInProgress = false")
        assertFalse(failureHandler.contains("args"))
        assertTrue(failureHandler.contains("Weather fetch failed"))
    }

    @Test
    fun `world clock city drives its own timezone so cards do not collapse`() {
        // The stock home bakes three world-clock DateTimeView cards
        // (HomeController: "San Francisco", "Oslo", "New York") each with a
        // hardcoded stale demo time. The city must drive the timezone so each
        // card shows its OWN live wall-clock. The prior hook called
        // getRealDateTime() once and passed the device's local time to every
        // card, collapsing all three into one.
        val sf = mapCityToTimeZone("San Francisco")
        val oslo = mapCityToTimeZone("Oslo")
        val ny = mapCityToTimeZone("New York")
        assertEquals("America/Los_Angeles", sf?.id)
        assertEquals("Europe/Oslo", oslo?.id)
        assertEquals("America/New_York", ny?.id)
        assertNull(mapCityToTimeZone("Copenhagen"))

        // Each zone yields a wall-clock time. The three never collide at any
        // instant because their UTC offsets are pairwise unequal (LA vs NY 3h,
        // NY vs Oslo 5-6h, LA vs Oslo 8-9h, even across DST transitions), so
        // HH:mm can never match across them -- exactly the per-city
        // distinctness the world clock needs and the prior bug destroyed.
        val sfTime = formatDateTime(sf!!).first
        val osloTime = formatDateTime(oslo!!).first
        val nyTime = formatDateTime(ny!!).first
        assertTrue(sfTime.matches(Regex("\\d{2}:\\d{2}")))
        assertTrue(osloTime.matches(Regex("\\d{2}:\\d{2}")))
        assertTrue(nyTime.matches(Regex("\\d{2}:\\d{2}")))
        assertNotEquals(sfTime, osloTime)
        assertNotEquals(osloTime, nyTime)
        assertNotEquals(sfTime, nyTime)
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
