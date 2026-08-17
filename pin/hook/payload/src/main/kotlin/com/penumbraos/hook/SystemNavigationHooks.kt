package com.penumbraos.hook

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import kotlin.math.roundToInt

/**
 * Hooks for the system navigation experience APK (package: humane.experience.systemnavigation).
 */
object SystemNavigationHooks {

    private const val TAG = "PenumbraHook"
    private const val HOME_INTERACTOR =
        "humane.experience.systemnavigation.home.HomeInteractor"
    private const val NEARBY_LOADING_STATE =
        "humane.experience.systemnavigation.nearby.NearbyManager\$NearbyLoadingState"
    private const val SERVER_ERROR = "ERROR_FROM_SERVER"
    private const val PROVIDER_UNAVAILABLE_MESSAGE = "Nearby is temporarily unavailable."
    private const val HAS_GPS_LOCK = "HAS_GPS_LOCK"
    private const val MAX_FALLBACK_LOCATION_AGE_MS = 2 * 60 * 60 * 1000L
    private const val MAX_CLOCK_SKEW_MS = 60_000L
    private const val WEATHER_CELSIUS_SETTING =
        TierASymbols.FeatureFlags.PenumbraSettingsGlobal.WEATHER_CELSIUS
    private const val LQM_BINDING_FAILURE = "Error binding to LQM Service!"
    private const val LQM_INTERFACE_FAILURE = "Error getting LQM Service interface stub!"

    @Volatile
    private var lastWeatherCelsiusPreference: Boolean? = null

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing system navigation hooks...")

        TcmSilencer.install(cl)

        installLqmStartupFallback(cl)

        ConnectivityCheckBypass.install(cl)

        installNearbyLocationFallback(cl)

        installNearbyServerErrorPresentation(cl)

        installNearbyTrace(cl)

        installWeatherTemperatureUnit(cl)

        Log.w(TAG, "System navigation hooks installed")
    }

    /**
     * System Navigation's HomeController already treats a null LQM manager as a
     * supported fallback and uses NetworkMonitor for cellular signal strength.
     * During boot, however, LqmServiceManager.getInstance() throws before it can
     * return null when Qualcomm's binder has not registered yet, crashing the
     * whole experience. Convert only those two stock startup failures into the
     * existing null path; every unrelated exception remains fatal and visible.
     */
    private fun installLqmStartupFallback(cl: ClassLoader) {
        try {
            val manager = Class.forName("humane.system.LqmServiceManager", false, cl)
            HookUtils.hookMethodAfter(
                manager,
                "getInstance",
                arrayOf(Context::class.java),
            ) { param ->
                val failure = param.throwable ?: return@hookMethodAfter
                if (!shouldSuppressLqmStartupFailure(failure)) return@hookMethodAfter
                param.throwable = null
                param.result = null
                Log.w(TAG, "  LQM binder unavailable at startup; using stock signal fallback")
            }
            Log.w(TAG, "  Installed LQM startup fallback")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to install LQM startup fallback: ${t.message}")
        }
    }

    internal fun shouldSuppressLqmStartupFailure(failure: Throwable): Boolean =
        failure is IllegalStateException &&
            (failure.message == LQM_BINDING_FAILURE || failure.message == LQM_INTERFACE_FAILURE)

    /**
     * Stock firmware always calls WeatherResponse.getTemperatureFahrenheit(),
     * even though the response also contains Celsius, and then renders only a
     * neutral degree symbol. Select the truthful protobuf field at that narrow
     * UI boundary according to the authenticated dashboard preference.
     */
    private fun installWeatherTemperatureUnit(cl: ClassLoader) {
        try {
            val responseClass = Class.forName(
                TierASymbols.ProtoKids.WEATHER_RESPONSE,
                false,
                cl,
            )
            val getCelsius = responseClass.getDeclaredMethod("getTemperatureCelsius").apply {
                isAccessible = true
            }
            HookUtils.hookMethodAfter(
                responseClass,
                "getTemperatureFahrenheit",
                emptyArray(),
            ) { param ->
                val fahrenheit = param.result as? Double ?: return@hookMethodAfter
                val celsius = runCatching {
                    getCelsius.invoke(param.thisObject) as? Double
                }.getOrNull() ?: return@hookMethodAfter
                param.result = weatherDisplayTemperature(
                    fahrenheit = fahrenheit,
                    celsius = celsius,
                    useCelsius = weatherCelsiusPreference(),
                )
            }

            // WeatherModel caches the already-converted integer for 15 minutes.
            // Drop only that in-memory cache when the unit changes so the next
            // stock request immediately rebuilds it with the selected field.
            val weatherAccess = Class.forName(
                "humane.experience.systemnavigation.weather.WeatherAccess",
                false,
                cl,
            )
            HookUtils.hookMethodBefore(
                weatherAccess,
                "getValidCachedWeatherIfAvailable",
                emptyArray(),
            ) { param ->
                val current = weatherCelsiusPreference()
                val previous = lastWeatherCelsiusPreference
                lastWeatherCelsiusPreference = current
                if (previous == null || previous == current) return@hookMethodBefore
                runCatching {
                    weatherAccess.getDeclaredField("mLastWeatherFetchedTs").apply {
                        isAccessible = true
                    }.set(param.thisObject, null)
                    weatherAccess.getDeclaredField("mMostRecentWeather").apply {
                        isAccessible = true
                    }.set(param.thisObject, null)
                }.onFailure {
                    Log.w(TAG, "  Weather cache invalidation failed: ${it.javaClass.simpleName}")
                }
                Log.w(TAG, "  Weather temperature unit changed; invalidated stock cache")
            }
            Log.w(TAG, "  Stock weather view follows the dashboard temperature unit")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to install weather temperature-unit hook: ${t.message}")
        }
    }

    private fun weatherCelsiusPreference(): Boolean = try {
        val context = Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Context
        if (context == null) true else {
            Settings.Global.getInt(context.contentResolver, WEATHER_CELSIUS_SETTING, 1) != 0
        }
    } catch (_: Throwable) {
        true
    }

    internal fun weatherDisplayTemperature(
        fahrenheit: Double,
        celsius: Double,
        useCelsius: Boolean,
    ): Double = if (useCelsius && celsius.isFinite()) celsius else fahrenheit

    /**
     * Nearby's stock launcher waits only 4.5 seconds for HumaneLocationManager,
     * then refuses to send the search when that wrapper labels an otherwise
     * usable Android fix as stale. The framework LocationManager retains the
     * same on-device GPS/fused fixes. Reuse a recent one before the stock
     * callback times out, and again after its last-known lookup if it overwrote
     * the field with null/stale data.
     *
     * Coordinates never leave this process here. The unchanged stock flow
     * still constructs and sends the consent-gated NearbySearch request.
     */
    private fun installNearbyLocationFallback(cl: ClassLoader) {
        try {
            val nearbyManager = Class.forName(
                "humane.experience.systemnavigation.nearby.NearbyManager",
                false,
                cl,
            )
            val callbackClass = Class.forName(
                "humane.location.IHumaneLocationCallback",
                false,
                cl,
            )

            HookUtils.hookMethodBefore(
                nearbyManager,
                "getLocation",
                arrayOf(callbackClass),
            ) { param ->
                try {
                    val fallback = recentFrameworkLocation(param.thisObject)
                        ?: return@hookMethodBefore
                    applyNearbyLocation(param.thisObject, fallback, setReadyState = false)
                    val callback = param.args.firstOrNull() ?: return@hookMethodBefore
                    callbackClass.getMethod("onLocationChanged").invoke(callback)
                    // The callback re-enters getLastKnownLocation; its after-hook
                    // below restores the same fix if Humane's wrapper returns stale.
                    param.result = null
                    Log.w(TAG, "  Nearby used recent Android location fallback")
                } catch (t: Throwable) {
                    Log.w(TAG, "  Nearby pre-request location fallback failed: ${t.message}")
                }
            }

            HookUtils.hookMethodAfter(
                nearbyManager,
                "getLastKnownLocation",
                emptyArray(),
            ) { param ->
                try {
                    val currentField = nearbyManager.getDeclaredField("mCurrentLocation").apply {
                        isAccessible = true
                    }
                    val staleField = nearbyManager.getDeclaredField("mLocationStaleFlag").apply {
                        isAccessible = true
                    }
                    val current = currentField.get(param.thisObject) as? Location
                    val stale = staleField.getBoolean(param.thisObject)
                    if (current != null && !stale) return@hookMethodAfter

                    val fallback = recentFrameworkLocation(param.thisObject)
                        ?: return@hookMethodAfter
                    applyNearbyLocation(param.thisObject, fallback, setReadyState = true)
                    Log.w(
                        TAG,
                        "  Nearby replaced null/stale Humane location with recent Android fix",
                    )
                } catch (t: Throwable) {
                    Log.w(TAG, "  Nearby post-request location fallback failed: ${t.message}")
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to install Nearby location fallback: ${t.message}")
        }
    }

    private fun recentFrameworkLocation(nearbyManager: Any?): Location? {
        if (nearbyManager == null) return null
        return try {
            val contextField = nearbyManager.javaClass.getDeclaredField("mContext").apply {
                isAccessible = true
            }
            val context = contextField.get(nearbyManager) as? Context ?: return null
            val hasFineLocation =
                context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED
            val hasCoarseLocation =
                context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED
            if (!hasFineLocation && !hasCoarseLocation) return null
            val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                ?: return null
            val nowElapsed = SystemClock.elapsedRealtimeNanos()
            val nowWall = System.currentTimeMillis()

            manager.getProviders(true)
                .mapNotNull { provider -> runCatching { manager.getLastKnownLocation(provider) }.getOrNull() }
                .filter { location ->
                    location.latitude.isFinite() &&
                        location.longitude.isFinite() &&
                        location.latitude in -90.0..90.0 &&
                        location.longitude in -180.0..180.0 &&
                        isNearbyFallbackFresh(
                            nowElapsedRealtimeNanos = nowElapsed,
                            nowWallMillis = nowWall,
                            locationElapsedRealtimeNanos = location.elapsedRealtimeNanos,
                            locationWallMillis = location.time,
                        )
                }
                .maxWithOrNull(
                    compareBy<Location> { it.elapsedRealtimeNanos }
                        .thenByDescending { if (it.hasAccuracy()) it.accuracy else Float.MAX_VALUE },
                )
                ?.let(::Location)
        } catch (t: Throwable) {
            Log.w(TAG, "  Nearby Android location fallback unavailable: ${t.message}")
            null
        }
    }

    private fun applyNearbyLocation(
        nearbyManager: Any,
        location: Location,
        setReadyState: Boolean,
    ) {
        val cls = nearbyManager.javaClass
        cls.getDeclaredField("mCurrentLocation").apply { isAccessible = true }
            .set(nearbyManager, location)
        cls.getDeclaredField("mLocationStaleFlag").apply { isAccessible = true }
            .setBoolean(nearbyManager, false)
        cls.getDeclaredField("mLocationAccuracy").apply { isAccessible = true }
            .setInt(
                nearbyManager,
                if (location.hasAccuracy()) location.accuracy.roundToInt().coerceAtLeast(1) else 0,
            )

        if (!setReadyState) return
        val loadingStateClass = Class.forName(NEARBY_LOADING_STATE, false, cls.classLoader)
        val ready = loadingStateClass.enumConstants
            ?.firstOrNull { (it as? Enum<*>)?.name == HAS_GPS_LOCK }
            ?: return
        cls.getDeclaredMethod("setLoadingState", loadingStateClass).apply { isAccessible = true }
            .invoke(nearbyManager, ready)
    }

    internal fun isNearbyFallbackFresh(
        nowElapsedRealtimeNanos: Long,
        nowWallMillis: Long,
        locationElapsedRealtimeNanos: Long,
        locationWallMillis: Long,
    ): Boolean {
        val ageMillis = if (
            nowElapsedRealtimeNanos > 0L &&
            locationElapsedRealtimeNanos > 0L &&
            locationElapsedRealtimeNanos <= nowElapsedRealtimeNanos
        ) {
            (nowElapsedRealtimeNanos - locationElapsedRealtimeNanos) / 1_000_000L
        } else {
            val wallAge = nowWallMillis - locationWallMillis
            if (wallAge < -MAX_CLOCK_SKEW_MS) return false
            wallAge.coerceAtLeast(0L)
        }
        return ageMillis <= MAX_FALLBACK_LOCATION_AGE_MS
    }

    private fun installNearbyServerErrorPresentation(cl: ClassLoader) {
        try {
            val homeInteractor = Class.forName(HOME_INTERACTOR, false, cl)
            val nearbyStateClass = Class.forName(NEARBY_LOADING_STATE, false, cl)
            val interactorClass = Class.forName("humane.ui.graph.Interactor", false, cl)
            val transitionClass = Class.forName(
                "humane.ui.graph.transition.NodeCrossfadeTransition",
                false,
                cl,
            )
            val transitionInterface = Class.forName(
                "humane.ui.graph.transition.NodeViewTransition",
                false,
                cl,
            )
            val emptyInteractorClass = Class.forName(
                "humane.experience.systemnavigation.nearby.nearbyempty.NearbyEmptyInteractor",
                false,
                cl,
            )
            val emptyInteractorConstructor = emptyInteractorClass.getConstructor(String::class.java)
            val transitionConstructor = transitionClass.getConstructor()
            val navigate = interactorClass.getMethod(
                "navigate",
                interactorClass,
                transitionInterface,
            )

            HookUtils.hookMethodBefore(
                homeInteractor,
                "onNearbyLoadingStateChanged",
                arrayOf(nearbyStateClass),
            ) { param ->
                val current = param.args.firstOrNull() as? Enum<*>
                val message = nearbyProviderUnavailableMessage(current?.name)
                    ?: return@hookMethodBefore
                runCatching {
                    val emptyInteractor = emptyInteractorConstructor.newInstance(message)
                    val transition = transitionConstructor.newInstance()
                    navigate.invoke(param.thisObject, emptyInteractor, transition)
                    param.result = null
                }.onSuccess {
                    Log.w(TAG, "  Nearby provider failure shown as temporarily unavailable")
                }.onFailure {
                    Log.e(TAG, "  Nearby provider-error presentation failed: ${it.message}")
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to install Nearby server-error presentation hook: ${t.message}")
        }
    }

    internal fun nearbyProviderUnavailableMessage(stateName: String?): String? =
        if (stateName == SERVER_ERROR) PROVIDER_UNAVAILABLE_MESSAGE else null

    /** State/result-count tracing for the user-driven projector QA pass. */
    private fun installNearbyTrace(cl: ClassLoader) {
        try {
            val nearbyManager = Class.forName(
                "humane.experience.systemnavigation.nearby.NearbyManager",
                false,
                cl,
            )
            val nearbyStateClass = Class.forName(NEARBY_LOADING_STATE, false, cl)
            HookUtils.hookMethodAfter(
                nearbyManager,
                "setLoadingState",
                arrayOf(nearbyStateClass),
            ) { param ->
                val state = (param.args.firstOrNull() as? Enum<*>)?.name ?: "unknown"
                Log.w("PenumbraNearbyTrace", "state=$state")
            }

            val responseClass = Class.forName(
                TierASymbols.ProtoKids.NEARBY_SEARCH_RESPONSE,
                false,
                cl,
            )
            HookUtils.hookMethodAfter(
                nearbyManager,
                "handleNearbyData",
                arrayOf(responseClass),
            ) { param ->
                val response = param.args.firstOrNull()
                val count = runCatching {
                    responseClass.getMethod("getNearbyPlacesCount").invoke(response) as? Int
                }.getOrNull() ?: -1
                Log.w("PenumbraNearbyTrace", "response_count=$count")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "  Nearby trace unavailable: ${t.javaClass.simpleName}")
        }
    }
}
