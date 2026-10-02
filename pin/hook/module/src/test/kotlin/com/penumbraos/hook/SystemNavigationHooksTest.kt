package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemNavigationHooksTest {

    @Test
    fun `lqm startup fallback suppresses only the two stock binding failures`() {
        assertTrue(
            SystemNavigationHooks.shouldSuppressLqmStartupFailure(
                IllegalStateException("Error binding to LQM Service!"),
            ),
        )
        assertTrue(
            SystemNavigationHooks.shouldSuppressLqmStartupFailure(
                IllegalStateException("Error getting LQM Service interface stub!"),
            ),
        )
        assertFalse(
            SystemNavigationHooks.shouldSuppressLqmStartupFailure(
                IllegalStateException("unexpected LQM failure"),
            ),
        )
        assertFalse(
            SystemNavigationHooks.shouldSuppressLqmStartupFailure(
                RuntimeException("Error binding to LQM Service!"),
            ),
        )
    }

    @Test
    fun `weather display selects the requested truthful protobuf field`() {
        assertEquals(
            18.5,
            SystemNavigationHooks.weatherDisplayTemperature(65.3, 18.5, useCelsius = true),
            0.0,
        )
        assertEquals(
            65.3,
            SystemNavigationHooks.weatherDisplayTemperature(65.3, 18.5, useCelsius = false),
            0.0,
        )
        assertEquals(
            65.3,
            SystemNavigationHooks.weatherDisplayTemperature(
                65.3,
                Double.NaN,
                useCelsius = true,
            ),
            0.0,
        )
    }

    @Test
    fun `provider failure uses a truthful unavailable message instead of offline`() {
        assertEquals(
            "Nearby is temporarily unavailable.",
            SystemNavigationHooks.nearbyProviderUnavailableMessage("ERROR_FROM_SERVER"),
        )

        listOf(
            "NO_GPS_LOCK_AVAILABLE_WITH_WIFI",
            "NO_GPS_LOCK_AVAILABLE_NO_WIFI",
            "ERROR_CONNECTION_TIMEOUT",
            "DATA_READY_FOR_UI",
            "NO_PLACES_FOUND",
        ).forEach { state ->
            assertNull(SystemNavigationHooks.nearbyProviderUnavailableMessage(state))
        }
        assertNull(SystemNavigationHooks.nearbyProviderUnavailableMessage(null))
    }

    @Test
    fun `nearby fallback accepts only recent non-future fixes`() {
        val nowElapsed = 36_000_000_000_000L
        val nowWall = 1_720_000_000_000L

        assertTrue(
            SystemNavigationHooks.isNearbyFallbackFresh(
                nowElapsedRealtimeNanos = nowElapsed,
                nowWallMillis = nowWall,
                locationElapsedRealtimeNanos = nowElapsed - 30_000_000_000L,
                locationWallMillis = nowWall - 30_000L,
            ),
        )
        assertTrue(
            SystemNavigationHooks.isNearbyFallbackFresh(
                nowElapsedRealtimeNanos = 0L,
                nowWallMillis = nowWall,
                locationElapsedRealtimeNanos = 0L,
                locationWallMillis = nowWall - 30_000L,
            ),
        )
        assertFalse(
            SystemNavigationHooks.isNearbyFallbackFresh(
                nowElapsedRealtimeNanos = 0L,
                nowWallMillis = nowWall,
                locationElapsedRealtimeNanos = 0L,
                locationWallMillis = nowWall - 3 * 60 * 60 * 1000L,
            ),
        )
        assertFalse(
            SystemNavigationHooks.isNearbyFallbackFresh(
                nowElapsedRealtimeNanos = 0L,
                nowWallMillis = nowWall,
                locationElapsedRealtimeNanos = 0L,
                locationWallMillis = nowWall + 120_000L,
            ),
        )
    }
}
