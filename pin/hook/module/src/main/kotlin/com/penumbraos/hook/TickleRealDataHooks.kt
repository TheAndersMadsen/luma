package com.penumbraos.hook

import android.content.Context
import android.location.Geocoder
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
import com.penumbraos.stockaibus.contract.TierASymbols
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.atomic.AtomicBoolean

private const val MIN_DISPLAY_TEMPERATURE = -200.0
private const val MAX_DISPLAY_TEMPERATURE = 300.0

internal fun replaceWeatherTemperatures(values: Any?, displayTemperature: String): Boolean {
    val temperatures = values as? Array<*> ?: return false
    if (temperatures.size < 3 || temperatures.any { it !is String }) return false

    temperatures.indices.forEach { index ->
        java.lang.reflect.Array.set(temperatures, index, displayTemperature)
    }
    return true
}

internal fun selectWeatherTemperature(
    temperatureFahrenheit: Double?,
    temperatureCelsius: Double?,
    useCelsius: Boolean,
): Double? {
    fun bounded(value: Double?): Double? = value?.takeIf {
        it.isFinite() && it in MIN_DISPLAY_TEMPERATURE..MAX_DISPLAY_TEMPERATURE
    }
    return if (useCelsius) {
        bounded(temperatureCelsius) ?:
            bounded(temperatureFahrenheit?.let { (it - 32.0) * 5.0 / 9.0 })
    } else {
        bounded(temperatureFahrenheit) ?:
            bounded(temperatureCelsius?.let { (it * 9.0 / 5.0) + 32.0 })
    }
}

internal data class CachedWeather(
    val temperatureFahrenheit: Double?,
    val temperatureCelsius: Double?,
    val icon: Int,
)

internal data class RenderedWeather(val temperature: Int, val unit: String, val icon: Int)

internal fun renderWeather(cached: CachedWeather, useCelsius: Boolean): RenderedWeather? {
    val selected = selectWeatherTemperature(
        temperatureFahrenheit = cached.temperatureFahrenheit,
        temperatureCelsius = cached.temperatureCelsius,
        useCelsius = useCelsius,
    ) ?: return null
    return RenderedWeather(
        temperature = Math.round(selected).toInt(),
        unit = if (useCelsius) "°C" else "°F",
        icon = cached.icon,
    )
}

internal class PendingWeatherViews(private val capacity: Int) {
    init {
        require(capacity > 0)
    }

    private val views = ArrayList<Any>(capacity)

    fun add(view: Any) {
        if (views.any { it === view }) return
        if (views.size == capacity) views.removeAt(0)
        views.add(view)
    }

    fun drain(): List<Any> = views.toList().also { views.clear() }

    fun size(): Int = views.size
}

/**
 * Map a stock Tickle world-clock city to its IANA timezone. The stock home
 * (HomeController.createView) bakes three DateTimeView cards -- "San
 * Francisco", "Oslo", "New York" -- each with a hardcoded stale demo time.
 * The city drives the timezone so the constructor hook can inject each
 * city's OWN live wall-clock instead of the device's local time, which the
 * prior hook computed once and passed to every card, collapsing all three.
 *
 * Pure and Android-free so the hook module's plain-JUnit tests can pin the
 * city -> timezone contract. An unknown city returns null so the hook falls
 * back to the device default (the prior behaviour) rather than guessing.
 */
internal fun mapCityToTimeZone(city: String): TimeZone? = when (city) {
    "San Francisco" -> TimeZone.getTimeZone("America/Los_Angeles")
    "Oslo" -> TimeZone.getTimeZone("Europe/Oslo")
    "New York" -> TimeZone.getTimeZone("America/New_York")
    else -> null
}

/**
 * Format the current wall-clock in [timeZone] as (time, date) in the same
 * shapes the stock DateTimeView expects: "HH:mm" and "EEEE MMMM d". The
 * SimpleDateFormat timeZone MUST be set to [timeZone] -- a Date is just UTC
 * millis, so without it the format renders the device's local zone and every
 * city collapses to one time (the original defect).
 */
internal fun formatDateTime(timeZone: TimeZone): Pair<String, String> {
    val calendar = Calendar.getInstance(timeZone)
    val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault())
    timeFormat.timeZone = timeZone
    val dateFormat = SimpleDateFormat("EEEE MMMM d", Locale.getDefault())
    dateFormat.timeZone = timeZone
    return timeFormat.format(calendar.time) to dateFormat.format(calendar.time)
}

/**
 * Hooks to replace hardcoded demo data in Tickle experience with real data.
 *
 * Reuses the same weather provider infrastructure that the stock
 * systemnavigation launcher uses:
 * - ExperienceAiAccess.getWeather() → IPC to PenumbraServer → WeatherResponse
 * - Same weather icon codes as WeatherAccess.weatherIcon()
 * - Same temperature unit conversion as SystemNavigationHooks
 */
object TickleRealDataHooks {
    private const val TAG = "LumaCompatibility"
    private const val WEATHER_CELSIUS_SETTING =
        TierASymbols.FeatureFlags.PenumbraSettingsGlobal.WEATHER_CELSIUS
    // The UI hooks are installed from ExperienceApplication.onCreate and retried
    // on the main handler until the Tickle UI dex resolves. The home is behind
    // gesture PIN entry (renders many seconds later), so this window comfortably
    // precedes the first DateTimeView/WeatherView construction. ~15s total.
    private const val MAX_UI_HOOK_ATTEMPTS = 60
    private const val UI_HOOK_RETRY_MS = 250L
    private const val MAX_PENDING_WEATHER_VIEWS = 8
    private const val WEATHER_FETCH_TIMEOUT_MS = 15_000L

    /**
     * Retry-until-complete guards. `TickleHooks.install` fires from BOTH the
     * shared `ExperienceApplication` trigger (early, before the Tickle UI classes
     * load) and the `HomeInteractor` trigger (when the home renders, classes
     * present). The early attempt cannot hook DateTimeView/WeatherView, those
     * classes are not loaded yet, so it must NOT permanently block the later
     * attempt that can. `installComplete` blocks re-entry only once every group
     * has installed. Each group is separately idempotent so a retry never
     * double-hooks a class. This was the live defect: the early attempt set a
     * permanent "attempted" flag, the demo cards (San Francisco/Oslo/New York)
     * were never replaced, and the home showed hardcoded data.
     *
     * The `attempt` parameter tracks retry progress so we only log on the first
     * failure (to surface real issues early) and the final failure (to confirm
     * the classes never resolved). Intermediate retries are silent to avoid
     * log spam, ClassNotFoundException is expected while waiting for the UI
     * dex to load.
     */
    @Volatile
    private var installComplete = false
    @Volatile
    private var uiHooksInstalled = false
    private var appContextHookInstalled = false
    private var dateTimeHookInstalled = false
    private var weatherHookInstalled = false

    @Volatile
    private var appContext: Context? = null

    // Cache raw provider values so a live unit-setting change cannot relabel a
    // previously converted number with the wrong unit.
    @Volatile
    private var cachedWeather: CachedWeather? = null

    @Volatile
    private var weatherFetchInProgress = false

    private val weatherStateLock = Any()
    private val pendingWeatherViews = PendingWeatherViews(MAX_PENDING_WEATHER_VIEWS)
    private var weatherFetchGeneration = 0L

    private val handler = Handler(Looper.getMainLooper())

    @Synchronized
    fun install(cl: ClassLoader) {
        if (installComplete) return

        // The factory calls this from AppComponentFactory.instantiateApplication,
        // which runs BEFORE the app is fully initialised: the Tickle UI dex is not
        // yet on the classloader, so DateTimeView/WeatherView cannot be hooked
        // here and their groups always failed, the live defect that left the home
        // showing hardcoded demo cards (San Francisco/Oslo/New York). So install
        // ONLY the ExperienceApplication.onCreate hook now. onCreate fires after
        // the app is initialised. From its callback we capture appContext AND
        // install the UI constructor hooks using the running app's own
        // classloader, which does have the UI classes.
        //
        // The ExperienceApplication probe also matches every non-Tickle
        // experience process (food/contacts/music/settings) because they all
        // share that base class. installUiHooks() gates itself on a
        // HomeInteractor probe so those pids skip with one debug log instead
        // of exhausting 60 retries and emitting misleading errors.
        val ok = installBoundary("ExperienceApplication.onCreate", attempt = 0, maxAttempts = 0) {
            if (appContextHookInstalled) return@installBoundary true
            val appClass = cl.loadClass(StockSymbols.ExperienceRuntime.EXPERIENCE_APPLICATION_CLASS)
            HookUtils.hookMethodAfter(appClass, "onCreate", emptyArray()) { param ->
                val application = param.thisObject as? android.app.Application
                appContext = application?.applicationContext
                Log.i(
                    TAG,
                    "  TickleRealDataHooks: Captured appContext: ${appContext != null}",
                )
                installUiHooks(application?.classLoader ?: cl, attempt = 0)
            }
            appContextHookInstalled = true
            true
        }
        if (ok) installComplete = true
    }

    /**
     * Install the DateTimeView/WeatherView constructor hooks from the app's own
     * classloader, retried on the main handler until the UI classes resolve.
     *
     * Called from ExperienceApplication.onCreate (see [install]). The home is
     * gated behind gesture PIN entry, so it renders many seconds after onCreate,
     * far longer than this bounded retry window, which guarantees the hooks land
     * before the first DateTimeView/WeatherView is ever constructed.
     *
     * Non-Tickle experience processes (food/contacts/music/settings/etc.) share
     * the `ExperienceApplication` base class, so this callback fires in every
     * experience pid, not just Tickle. Those processes don't contain the Tickle
     * UI dex, so a one-shot probe for `HomeInteractor` gates the retry loop:
     * when the probe misses we return immediately with a single debug log
     * instead of burning 60 retries × 250 ms and logging a misleading error.
     * The `HomeInteractor` probe matches the existing HookComponentFactory
     * entry so we stay consistent with how the Tickle process is identified.
     */
    @Synchronized
    private fun installUiHooks(cl: ClassLoader, attempt: Int) {
        if (uiHooksInstalled) return

        // One-shot Tickle probe on the first attempt only. The retry path
        // re-enters here with attempt > 0 after the probe already succeeded,
        // so we must not re-probe (and risk short-circuiting a legitimate
        // retry if the probe class resolves differently from the hook target).
        if (attempt == 0) {
            val isTickleProcess = try {
                cl.loadClass("humane.experience.tickle.ui.home.HomeInteractor")
                true
            } catch (_: ClassNotFoundException) {
                false
            }
            if (!isTickleProcess) {
                Log.d(
                    TAG,
                    "  TickleRealDataHooks: not the Tickle process " +
                        "(HomeInteractor absent); skipping UI hooks",
                )
                // Mark complete so the shared ExperienceApplication probe
                // doesn't re-enter install() from another experience pid
                // and start another doomed retry cycle.
                uiHooksInstalled = true
                return
            }
        }

        val results = listOf(
            installBoundary("DateTimeView.<init>", attempt, MAX_UI_HOOK_ATTEMPTS) {
                if (dateTimeHookInstalled) return@installBoundary true
                val dateTimeViewClass =
                    cl.loadClass("humane.experience.tickle.ui.home.DateTimeView")
                HookUtils.hookConstructorBefore(
                    dateTimeViewClass,
                    arrayOf(String::class.java, String::class.java, String::class.java),
                ) { param ->
                    // The stock home bakes three world-clock cards
                    // (HomeController: "San Francisco", "Oslo", "New York"),
                    // each with a hardcoded stale demo time. The first
                    // constructor arg is the city, so it drives the timezone
                    // and each card shows ITS OWN live wall-clock -- not the
                    // device's local time, which the prior hook computed once
                    // and passed to every card, collapsing all three into one.
                    // Keep the stock city label (args[0]) so the card reads the
                    // city whose time it shows. Only the stale demo time/date
                    // are replaced. An unknown city falls back to the device
                    // default (the prior behaviour).
                    val city = param.args[0] as? String
                    val timeZone = city?.let { mapCityToTimeZone(it) } ?: TimeZone.getDefault()
                    val (time, date) = formatDateTime(timeZone)
                    param.args[1] = time
                    param.args[2] = date
                    Log.i(TAG, "  TickleRealDataHooks: DateTimeView arguments updated")
                }
                dateTimeHookInstalled = true
                true
            },

            installBoundary("WeatherView.<init>", attempt, MAX_UI_HOOK_ATTEMPTS) {
                if (weatherHookInstalled) return@installBoundary true
                val weatherViewClass =
                    cl.loadClass("humane.experience.tickle.ui.home.WeatherView")

                // Pre-load the weather response classes
                val experiencePrivateClass = cl.loadClass("humane.experience.ExperiencePrivate")
                val experienceAiAccessClass = cl.loadClass("humane.system.ExperienceAiAccess")
                val weatherCompletionHandlerClass =
                    cl.loadClass(
                        "humane.system.ExperienceAiAccess\$WeatherCompletionHandler",
                    )
                val weatherResponseClass =
                    cl.loadClass(TierASymbols.ProtoKids.WEATHER_RESPONSE)

                val constructorTypes: Array<Class<*>> = arrayOf(
                    String::class.java,
                    Array<String>::class.java,
                    IntArray::class.java,
                )
                val weatherHooksActive = AtomicBoolean(false)
                val afterInstalled = HookUtils.hookConstructorAfter(
                    weatherViewClass,
                    constructorTypes,
                ) { param ->
                    if (!weatherHooksActive.get()) return@hookConstructorAfter
                    if (param.throwable != null) return@hookConstructorAfter
                    val weatherView = param.thisObject ?: return@hookConstructorAfter
                    val registration = registerWeatherView(weatherView)
                    if (registration.cached != null) {
                        queueWeatherViewUpdate(weatherView, registration.cached)
                    } else if (
                        registration.fetchGeneration != null &&
                        scheduleWeatherFetchTimeout(registration.fetchGeneration)
                    ) {
                        fetchWeatherAsync(
                            experiencePrivateClass,
                            experienceAiAccessClass,
                            weatherCompletionHandlerClass,
                            weatherResponseClass,
                            registration.fetchGeneration,
                        )
                    }
                }
                val beforeInstalled = afterInstalled &&
                    HookUtils.hookConstructorBefore(
                        weatherViewClass,
                        constructorTypes,
                    ) { param ->
                        if (!weatherHooksActive.get()) return@hookConstructorBefore
                        val context = appContext ?: return@hookConstructorBefore
                        val location = getCityName(context, TimeZone.getDefault())

                        // Replace location with real city name
                        param.args[0] = location

                        // If we already have cached weather, render it in the
                        // unit selected at this exact construction.
                        val rendered = cachedWeather?.let { renderWeather(it, useCelsius()) }
                        if (rendered != null) {
                            val display = "${rendered.temperature}${rendered.unit}"
                            param.args[1] = arrayOf(display, display, display)
                            param.args[2] = intArrayOf(
                                rendered.icon,
                                rendered.icon,
                                rendered.icon,
                            )
                            Log.i(TAG, "  TickleRealDataHooks: WeatherView using cached weather")
                            return@hookConstructorBefore
                        }

                        // Show placeholder initially, fetch real weather async.
                        param.args[1] = arrayOf("--°", "--°", "--°")
                        param.args[2] = intArrayOf(1, 1, 1)
                    }
                val fullyInstalled = afterInstalled && beforeInstalled
                weatherHooksActive.set(fullyInstalled)
                if (fullyInstalled) weatherHookInstalled = true
                fullyInstalled
            },
        )

        if (results.all { it }) {
            uiHooksInstalled = true
            Log.i(
                TAG,
                "  TickleRealDataHooks: UI hooks installed on attempt $attempt " +
                    "(using ExperienceAiAccess weather provider)",
            )
        } else if (attempt < MAX_UI_HOOK_ATTEMPTS) {
            // UI dex not resolvable yet. Retry shortly. Cheap and idempotent.
            handler.postDelayed({ installUiHooks(cl, attempt + 1) }, UI_HOOK_RETRY_MS)
        } else {
            Log.e(
                TAG,
                "  TickleRealDataHooks: UI hooks did not resolve after $attempt attempts " +
                    "(not the Tickle process, or class layout changed)",
            )
        }
    }

    private inline fun installBoundary(
        name: String,
        attempt: Int,
        maxAttempts: Int,
        install: () -> Boolean,
    ): Boolean {
        return try {
            install()
        } catch (_: Throwable) {
            // Log on the final attempt (attempt == maxAttempts) to confirm failure.
            // For retried calls (maxAttempts > 0), also log a warning on the first
            // attempt to surface issues early. Intermediate retries are silent,
            // ClassNotFoundException is expected while waiting for the UI dex.
            when {
                attempt == maxAttempts -> Log.e(
                    TAG,
                    "  TickleRealDataHooks: Failed to install $name after " +
                        "${maxAttempts + 1} attempts (class layout changed or not Tickle process)",
                )
                attempt == 0 -> Log.w(
                    TAG,
                    "  TickleRealDataHooks: Initial install attempt failed for $name " +
                        "(will retry)",
                )
            }
            false
        }
    }

    /**
     * Fetch weather from PenumbraServer via ExperienceAiAccess.getWeather() IPC.
     * This is the same provider that systemnavigation's WeatherAccess uses.
     * When the response comes back, update the WeatherView with real data.
     */
    private fun fetchWeatherAsync(
        experiencePrivateClass: Class<*>,
        experienceAiAccessClass: Class<*>,
        weatherCompletionHandlerClass: Class<*>,
        weatherResponseClass: Class<*>,
        generation: Long,
    ) {
        try {
            val experienceAiAccess = experiencePrivateClass
                .getMethod("experienceAiAccess")
                .invoke(null) ?: run {
                Log.w(TAG, "  TickleRealDataHooks: ExperienceAiAccess not initialized")
                abortWeatherFetch(generation)
                return
            }

            // Create a WeatherCompletionHandler using a dynamic proxy
            val completionHandler = java.lang.reflect.Proxy.newProxyInstance(
                weatherCompletionHandlerClass.classLoader,
                arrayOf(weatherCompletionHandlerClass)
            ) { _, method, args ->
                when (method.name) {
                    "handleResponse" -> {
                        val response = args?.firstOrNull()
                        if (response == null) {
                            abortWeatherFetch(generation)
                            return@newProxyInstance null
                        }
                        try {
                            val getTempF = weatherResponseClass.getMethod("getTemperatureFahrenheit")
                            val getTempC = weatherResponseClass.getMethod("getTemperatureCelsius")
                            val getIcon = weatherResponseClass.getMethod("getWeatherIcon")

                            val tempF = getTempF.invoke(response) as? Double
                            val tempC = getTempC.invoke(response) as? Double
                            val icon = getIcon.invoke(response) as? Int ?: 1

                            val weather = CachedWeather(
                                temperatureFahrenheit = tempF,
                                temperatureCelsius = tempC,
                                icon = icon,
                            )
                            renderWeather(weather, useCelsius())
                                ?: throw IllegalStateException("Missing usable temperature")

                            val pendingViews = completeWeatherFetch(generation, weather)
                                ?: return@newProxyInstance null
                            Log.i(TAG, "  TickleRealDataHooks: Received weather response")

                            // Update every placeholder view built while the one
                            // bounded provider request was pending.
                            val updateQueued = handler.post {
                                val rendered = renderWeather(weather, useCelsius())
                                if (rendered == null) {
                                    Log.w(TAG, "  TickleRealDataHooks: Cached weather unavailable")
                                    return@post
                                }
                                pendingViews.forEach { weatherView ->
                                    updateWeatherView(
                                        weatherView,
                                        rendered.temperature,
                                        rendered.unit,
                                        rendered.icon,
                                    )
                                }
                            }
                            if (!updateQueued) {
                                Log.w(TAG, "  TickleRealDataHooks: Weather view update queue unavailable")
                            }
                        } catch (_: Throwable) {
                            Log.e(TAG, "  TickleRealDataHooks: Failed to parse weather response")
                            abortWeatherFetch(generation)
                        }
                    }
                    "handleFailure" -> {
                        // ExperienceAiAccess forwards provider/server error prose here.
                        // Record only bounded status. Never persist that payload.
                        if (abortWeatherFetch(generation)) {
                            Log.w(TAG, "  TickleRealDataHooks: Weather fetch failed")
                        }
                    }
                }
                null
            }

            // Call ExperienceAiAccess.getWeather(handler)
            val getWeatherMethod = experienceAiAccessClass.getMethod("getWeather", weatherCompletionHandlerClass)
            getWeatherMethod.invoke(experienceAiAccess, completionHandler)

            Log.i(TAG, "  TickleRealDataHooks: Fetching weather from PenumbraServer...")
        } catch (_: Throwable) {
            Log.e(TAG, "  TickleRealDataHooks: Failed to call getWeather")
            abortWeatherFetch(generation)
        }
    }

    private data class WeatherViewRegistration(
        val cached: CachedWeather? = null,
        val fetchGeneration: Long? = null,
    )

    private fun registerWeatherView(view: Any): WeatherViewRegistration =
        synchronized(weatherStateLock) {
            cachedWeather?.let { cached ->
                return@synchronized WeatherViewRegistration(cached = cached)
            }

            pendingWeatherViews.add(view)
            if (weatherFetchInProgress) {
                return@synchronized WeatherViewRegistration()
            }
            weatherFetchInProgress = true
            weatherFetchGeneration = if (weatherFetchGeneration == Long.MAX_VALUE) {
                1L
            } else {
                weatherFetchGeneration + 1L
            }
            WeatherViewRegistration(fetchGeneration = weatherFetchGeneration)
        }

    private fun completeWeatherFetch(
        generation: Long,
        weather: CachedWeather,
    ): List<Any>? =
        synchronized(weatherStateLock) {
            if (!weatherFetchInProgress || generation != weatherFetchGeneration) {
                return@synchronized null
            }
            cachedWeather = weather
            weatherFetchInProgress = false
            pendingWeatherViews.drain()
        }

    private fun abortWeatherFetch(generation: Long): Boolean =
        synchronized(weatherStateLock) {
            if (!weatherFetchInProgress || generation != weatherFetchGeneration) {
                return@synchronized false
            }
            weatherFetchInProgress = false
            pendingWeatherViews.drain()
            true
        }

    private fun scheduleWeatherFetchTimeout(generation: Long): Boolean {
        val queued = handler.postDelayed(
            {
                if (abortWeatherFetch(generation)) {
                    Log.w(TAG, "  TickleRealDataHooks: Weather fetch timed out")
                }
            },
            WEATHER_FETCH_TIMEOUT_MS,
        )
        if (!queued) {
            abortWeatherFetch(generation)
            Log.w(TAG, "  TickleRealDataHooks: Weather timeout queue unavailable")
        }
        return queued
    }

    private fun queueWeatherViewUpdate(view: Any, weather: CachedWeather) {
        if (!handler.post {
                val rendered = renderWeather(weather, useCelsius()) ?: return@post
                updateWeatherView(view, rendered.temperature, rendered.unit, rendered.icon)
            }
        ) {
            Log.w(TAG, "  TickleRealDataHooks: Weather view update queue unavailable")
        }
    }

    /**
     * Update a WeatherView's child LabelViews with real weather data.
     * The WeatherView hierarchy is:
     *   WeatherView
     *     LabelView (location)
     *     WeatherDayView (now)  → LabelView (time) + ImageView (icon) + LabelView (temp)
     *     WeatherDayView (today) → same structure
     *     WeatherDayView (tomorrow) → same structure
     */
    private fun updateWeatherView(view: Any, temp: Int, unit: String, icon: Int) {
        try {
            val displayTemperature = "$temp$unit"
            val childViewsMethod = view.javaClass.getMethod("childViews")
            val temperaturesField =
                view.javaClass.getDeclaredField("mTemperatures").apply { isAccessible = true }
            if (!replaceWeatherTemperatures(temperaturesField.get(view), displayTemperature)) {
                Log.w(TAG, "  TickleRealDataHooks: Weather backing state unavailable")
                return
            }
            val weatherIconMethod =
                view.javaClass
                    .getDeclaredMethod("weatherIcon", Int::class.javaPrimitiveType!!)
                    .apply { isAccessible = true }
            val children = childViewsMethod.invoke(view) as? List<*> ?: run {
                Log.w(TAG, "  TickleRealDataHooks: Weather presentation unavailable")
                return
            }

            // children[0] = location LabelView
            // children[1] = WeatherDayView (now)
            // children[2] = WeatherDayView (today)
            // children[3] = WeatherDayView (tomorrow)
            var fullyUpdatedDays = 0
            for (i in 1..3) {
                val dayView = children.getOrNull(i) ?: continue
                // WeatherDayView has children: LabelView (time), ImageView (icon), LabelView (temp)
                val dayChildren = childViewsMethod.invoke(dayView) as? List<*> ?: continue
                val iconView = dayChildren.getOrNull(1)
                val tempLabel = dayChildren.getOrNull(2) ?: continue
                try {
                    val setStringMethod = tempLabel.javaClass.getMethod("setString", String::class.java)
                    setStringMethod.invoke(tempLabel, displayTemperature)

                    val image = weatherIconMethod.invoke(view, icon)
                    if (iconView != null) {
                        val setImageMethod =
                            iconView.javaClass.getMethod("setImage", weatherIconMethod.returnType)
                        setImageMethod.invoke(iconView, image)
                        fullyUpdatedDays += 1
                    }
                } catch (_: Throwable) {
                    Log.w(TAG, "  TickleRealDataHooks: Failed to update weather day")
                }
            }

            if (fullyUpdatedDays == 3) {
                Log.i(TAG, "  TickleRealDataHooks: Weather presentation updated")
            } else {
                Log.w(
                    TAG,
                    "  TickleRealDataHooks: Weather presentation partially updated " +
                        "($fullyUpdatedDays/3 days)",
                )
            }
        } catch (_: Throwable) {
            Log.e(TAG, "  TickleRealDataHooks: Failed to update WeatherView")
        }
    }

    private fun useCelsius(): Boolean = try {
        val context = appContext ?: return true
        Settings.Global.getInt(context.contentResolver, WEATHER_CELSIUS_SETTING, 1) != 0
    } catch (_: Throwable) {
        true
    }

    @Suppress("DEPRECATION")
    private fun getCityName(context: Context, timeZone: TimeZone): String {
        try {
            val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            val location = locationManager?.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                ?: locationManager?.getLastKnownLocation(LocationManager.GPS_PROVIDER)

            if (location != null) {
                val geocoder = Geocoder(context, Locale.getDefault())
                val addresses = geocoder.getFromLocation(location.latitude, location.longitude, 1)
                val city = addresses?.firstOrNull()?.locality
                if (city != null) {
                    return city
                }
            }
        } catch (e: SecurityException) {
            // Location permission can be revoked at runtime even though the
            // manifest declares it. Caught explicitly rather than only by the
            // Throwable branch below: behaviour is the same fall-through, but
            // lint's MissingPermission check cannot see SecurityException
            // handling through a broad catch, and this is the sole finding
            // blocking :hook:module:lintDebug.
        } catch (e: Throwable) {
            // Fall through to timezone-based name
        }

        val tzId = timeZone.id
        return tzId.substringAfterLast("/").replace("_", " ")
    }
}
