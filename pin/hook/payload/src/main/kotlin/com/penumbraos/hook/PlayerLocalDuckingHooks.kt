package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.lang.reflect.Modifier

/**
 * Replaces the stock music player's route-wide duck callbacks with local gain.
 *
 * Ironman's NarratorImpl.playPCMBytes()/tellUserIn() request focus through
 * AiMicFocusManager and their completion lambdas abandon it; that stock
 * ownership remains untouched. The installed firmware has no concrete Ironman
 * duck/unduck override. The only concrete faulty endpoints are the two methods
 * validated below on the music MediaPlayer.
 */
internal object PlayerLocalDuckingHooks {
    private const val TAG = "PenumbraHook"
    private const val PLAYER_CLASS = "humane.experience.music.playback.MediaPlayer"
    private const val FORWARDING_CLASS =
        "humane.experience.music.playback.MediaPlayerForwarding"
    private const val FOCUS_PLAYER_INTERFACE = "humane.system.IAudioFocusPlayer"

    private val duckingState = PlayerLocalDuckingState()

    @Volatile
    private var installed = false

    private data class MusicShape(
        val playerClass: Class<*>,
        val forwardingClass: Class<*>,
        val forwardingPlayer: Field,
        val getVolume: Method,
        val setVolume: Method,
        val duck: Method,
        val unduck: Method,
        val stop: Method,
    )

    @Synchronized
    fun installMusic(classLoader: ClassLoader) {
        if (installed) return

        // Resolve and validate every member before installing the first hook.
        val shape = resolveMusicShape(classLoader)
        val unhooks = mutableListOf<XC_MethodHook.Unhook>()
        try {
            unhooks += XposedBridge.hookMethod(shape.duck, duckHook(shape))
            unhooks += XposedBridge.hookMethod(shape.unduck, unduckHook(shape))
            unhooks += XposedBridge.hookMethod(shape.stop, stopHook(shape))
            installed = true
            Log.w(TAG, "  Music ducking now uses player-local gain")
        } catch (error: Throwable) {
            unhooks.asReversed().forEach { unhook ->
                runCatching { unhook.unhook() }
            }
            throw error
        }
    }

    private fun resolveMusicShape(classLoader: ClassLoader): MusicShape {
        val playerClass = classLoader.loadClass(PLAYER_CLASS)
        val forwardingClass = classLoader.loadClass(FORWARDING_CLASS)
        val focusPlayerInterface = classLoader.loadClass(FOCUS_PLAYER_INTERFACE)
        require(playerClass.interfaces.any { it === focusPlayerInterface }) {
            "$PLAYER_CLASS no longer directly implements $FOCUS_PLAYER_INTERFACE"
        }

        val forwardingPlayer = playerClass.getDeclaredField("mForwardingPlayer").apply {
            require(declaringClass === playerClass && type === forwardingClass)
            require(!Modifier.isStatic(modifiers))
            isAccessible = true
        }
        val getVolume = forwardingClass.getMethod("getVolume").apply {
            require(parameterCount == 0 && returnType == java.lang.Float.TYPE)
            require(!Modifier.isStatic(modifiers))
            isAccessible = true
        }
        val setVolume = forwardingClass.getMethod("setVolume", java.lang.Float.TYPE).apply {
            require(returnType == Void.TYPE && !Modifier.isStatic(modifiers))
            isAccessible = true
        }

        return MusicShape(
            playerClass = playerClass,
            forwardingClass = forwardingClass,
            forwardingPlayer = forwardingPlayer,
            getVolume = getVolume,
            setVolume = setVolume,
            duck = exactInstanceVoid(playerClass, "duckOnAudioFocusChange"),
            unduck = exactInstanceVoid(playerClass, "unduckOnAudioFocusChange"),
            // MediaPlayer.stop() can return without stopping when focus
            // abandonment fails. Its forwarding stop is the exact boundary
            // that proves the reusable player is actually being stopped.
            stop = exactInstanceVoid(forwardingClass, "stop"),
        )
    }

    private fun exactInstanceVoid(owner: Class<*>, name: String): Method =
        owner.getDeclaredMethod(name).apply {
            require(declaringClass === owner)
            require(parameterCount == 0 && returnType == Void.TYPE)
            require(!Modifier.isStatic(modifiers))
            isAccessible = true
        }

    private fun duckHook(shape: MusicShape) = object : XC_MethodHook() {
        override fun beforeHookedMethod(param: MethodHookParam) {
            val player = param.thisObject
            runCatching {
                val forwardingPlayer = resolveForwardingPlayer(shape, player)
                duckingState.duck(
                    player = forwardingPlayer,
                    readVolume = { readVolume(shape, forwardingPlayer) },
                    writeVolume = { volume -> writeVolume(shape, forwardingPlayer, volume) },
                )
            }.onFailure { error ->
                Log.e(TAG, "Player-local duck failed closed", error)
            }

            // Always suppress the faulty stock endpoint, including on failure.
            param.result = null
        }
    }

    private fun unduckHook(shape: MusicShape) = object : XC_MethodHook() {
        override fun beforeHookedMethod(param: MethodHookParam) {
            val player = param.thisObject
            runCatching {
                val forwardingPlayer = resolveForwardingPlayer(shape, player)
                duckingState.unduck(
                    player = forwardingPlayer,
                    readVolume = { readVolume(shape, forwardingPlayer) },
                    writeVolume = { volume -> writeVolume(shape, forwardingPlayer, volume) },
                )
            }.onFailure { error ->
                Log.e(TAG, "Player-local unduck failed closed", error)
            }

            // An unmatched unduck is also a no-op, never a route-wide increase.
            param.result = null
        }
    }

    private fun stopHook(shape: MusicShape) = object : XC_MethodHook() {
        override fun beforeHookedMethod(param: MethodHookParam) {
            val forwardingPlayer = param.thisObject
            runCatching {
                // stop() leaves this ExoPlayer instance reusable and does not
                // reset its local volume. Restore only the gain we wrote; an
                // explicit newer local gain remains authoritative.
                duckingState.unduck(
                    player = forwardingPlayer,
                    readVolume = { readVolume(shape, forwardingPlayer) },
                    writeVolume = { volume -> writeVolume(shape, forwardingPlayer, volume) },
                )
            }.onFailure { error ->
                Log.e(TAG, "Player-local stop restore failed closed", error)
            }
        }
    }

    private fun resolveForwardingPlayer(shape: MusicShape, player: Any): Any {
        require(shape.playerClass.isInstance(player))
        val forwardingPlayer = shape.forwardingPlayer.get(player)
        require(shape.forwardingClass.isInstance(forwardingPlayer))
        return forwardingPlayer
    }

    private fun readVolume(shape: MusicShape, forwardingPlayer: Any): Float {
        require(shape.forwardingClass.isInstance(forwardingPlayer))
        return shape.getVolume.invoke(forwardingPlayer) as Float
    }

    private fun writeVolume(shape: MusicShape, forwardingPlayer: Any, volume: Float) {
        require(shape.forwardingClass.isInstance(forwardingPlayer))
        shape.setVolume.invoke(forwardingPlayer, volume)
    }
}
