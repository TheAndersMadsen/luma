package com.penumbraos.hook

import java.util.WeakHashMap

/**
 * Tracks temporary attenuation independently for each concrete player.
 *
 * The first duck saves the player's own gain, duplicate ducks are no-ops, and
 * one matching unduck restores the saved gain. This mirrors stock's boolean
 * AudioFocusManager duck state. If stock code explicitly changes the gain
 * while ducked, that newer value wins.
 */
internal class PlayerLocalDuckingState(
    private val duckMultiplier: Float = DEFAULT_DUCK_MULTIPLIER,
) {
    private data class DuckState(
        val originalVolume: Float,
        val duckedVolume: Float,
    )

    private val lock = Any()
    private val states = WeakHashMap<Any, DuckState>()

    init {
        require(duckMultiplier.isFinite() && duckMultiplier in 0.0f..1.0f)
    }

    /** Returns false only when the current local gain is not safe to change. */
    fun duck(
        player: Any,
        readVolume: () -> Float,
        writeVolume: (Float) -> Unit,
    ): Boolean = synchronized(lock) {
        val currentState = states[player]
        if (currentState != null) {
            return@synchronized true
        }

        val originalVolume = readVolume()
        if (!isValidVolume(originalVolume)) return@synchronized false

        val duckedVolume = originalVolume * duckMultiplier
        writeVolume(duckedVolume)
        states[player] = DuckState(
            originalVolume = originalVolume,
            duckedVolume = duckedVolume,
        )
        true
    }

    /** Returns false for an unmatched unduck and never changes the local gain. */
    fun unduck(
        player: Any,
        readVolume: () -> Float,
        writeVolume: (Float) -> Unit,
    ): Boolean = synchronized(lock) {
        val currentState = states[player] ?: return@synchronized false
        val currentVolume = readVolume()
        if (
            isValidVolume(currentVolume) &&
            currentVolume == currentState.duckedVolume
        ) {
            writeVolume(currentState.originalVolume)
        }
        // Keep the state until a required restore write has succeeded. A
        // transient player failure can then be retried by the next focus-gain
        // callback instead of stranding this reusable player at ducked gain.
        states.remove(player)
        true
    }

    /** Discards state only for an abandoned instance that will never be reused. */
    fun clear(player: Any): Boolean = synchronized(lock) {
        states.remove(player) != null
    }

    private fun isValidVolume(volume: Float): Boolean =
        volume.isFinite() && volume in 0.0f..1.0f

    private companion object {
        const val DEFAULT_DUCK_MULTIPLIER = 0.2f
    }
}
