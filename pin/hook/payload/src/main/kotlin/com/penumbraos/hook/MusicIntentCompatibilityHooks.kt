package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * Deterministic aliases for stock music actions that Humane's small on-device
 * Seq2Seq/NER model recognizes unreliably.
 *
 * The most important case is "play <track> by <artist>". Stock only has a
 * regex for the more formal "play the song <track> by the artist <artist>";
 * the natural form falls to NER and is discarded when any named token scores
 * below its hard confidence threshold. We intercept the clear natural form at
 * the orchestrator boundary and return a normal PlayMusic action with both
 * native slots populated.
 */
object MusicIntentCompatibilityHooks {
    private const val TAG = "PenumbraHook"

    internal data class NativeMusicAction(
        val name: String,
        val inputs: Map<String, String> = emptyMap(),
    )

    private val politePrefix = "(?:(?:can|could|would|will)\\s+you\\s+|please\\s+)*"
    private val trackByArtist = Regex(
        "^$politePrefix(?:play|put\\s+on|listen\\s+to)\\s+(.+)\\s+by\\s+(.+)$",
        RegexOption.IGNORE_CASE,
    )

    private val reservedTrackPrefixes = listOf(
        "album ",
        "the album ",
        "artist ",
        "the artist ",
        "genre ",
        "the genre ",
        "playlist ",
        "the playlist ",
        "my playlist ",
        "music by ",
        "music from ",
        "some ",
    )
    private val contextualArtistReferences = setOf(
        "this artist",
        "that artist",
        "the artist",
        "them",
        "their",
    )
    private val contextualTrackReferences = setOf(
        "the most popular song",
        "the most popular track",
        "most popular song",
        "most popular track",
        "the biggest song",
        "the biggest track",
        "biggest song",
        "biggest track",
        "the top song",
        "the top track",
        "top song",
        "top track",
    )
    private val rankedMusicSelection = Regex(
        "\\b(?:most\\s+(?:popular|viral|controversial|streamed|played|famous|successful|" +
            "influential|underrated)|best|top|biggest|greatest|hottest|viral|controversial|" +
            "trending)\\s+(?:song|songs|track|tracks|music|album|albums|playlist|playlists|" +
            "hit|hits)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val timeBoundMusicSelection = Regex(
        "\\b(?:from|in|of|released\\s+in)\\s+(?:19|20)\\d{2}\\b",
        RegexOption.IGNORE_CASE,
    )
    private val currentMusicSelection = Regex(
        "\\b(?:latest|current|newest|trending|right\\s+now)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val musicNoun = Regex(
        "\\b(?:song|songs|track|tracks|music|album|albums|playlist|playlists|hit|hits)\\b",
        RegexOption.IGNORE_CASE,
    )
    private val researchThenPlay = Regex(
        "^(?:please\\s+)?(?:look\\s+up|lookup|research|search(?:\\s+for)?|find(?:\\s+out)?)\\b.*" +
            "\\b(?:play|put\\s+on|listen\\s+to)\\b",
        RegexOption.IGNORE_CASE,
    )

    private val pause = Regex(
        "^$politePrefix(?:pause|stop)(?:\\s+(?:the\\s+)?(?:music|song|track|playback))?$",
        RegexOption.IGNORE_CASE,
    )
    private val resume = Regex(
        "^$politePrefix(?:resume|continue)(?:\\s+(?:the\\s+)?(?:music|song|track|playback))?$",
        RegexOption.IGNORE_CASE,
    )
    private val next = Regex(
        "^$politePrefix(?:next(?:\\s+(?:song|track))?|skip(?:\\s+(?:this|the|current))?(?:\\s+(?:song|track))?)$",
        RegexOption.IGNORE_CASE,
    )
    private val previous = Regex(
        "^$politePrefix(?:previous(?:\\s+(?:song|track))?|go\\s+back(?:\\s+to)?(?:\\s+(?:the|that))?(?:\\s+previous)?(?:\\s+(?:song|track))?)$",
        RegexOption.IGNORE_CASE,
    )
    private val restart = Regex(
        "^$politePrefix(?:restart|replay|start\\s+over)(?:\\s+(?:this|the|current))?(?:\\s+(?:song|track))?$",
        RegexOption.IGNORE_CASE,
    )

    fun install(classLoader: ClassLoader) {
        try {
            val orchestratorClass = classLoader.loadClass(
                "humaneinternal.system.intent.interpreters.InterpreterOrchestrator",
            )
            val eventsClass = classLoader.loadClass("humaneinternal.system.intent.EventsSnapshot")
            val situationClass = classLoader.loadClass(
                "humaneinternal.system.intent.situation.Situation",
            )
            val interpret = orchestratorClass.getDeclaredMethod(
                "interpret",
                eventsClass,
                situationClass,
            ).apply { isAccessible = true }

            XposedBridge.hookMethod(interpret, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        val utterance = currentUtterance(param.args.getOrNull(0)) ?: return
                        val action = parse(utterance) ?: return
                        val events = NativeActionEvents.create(
                            classLoader,
                            action.name,
                            action.inputs,
                        ) ?: return
                        param.result = events
                        Log.w(
                            TAG,
                            "${TierASymbols.OperationalMarkers.MUSIC_INTENT_COMPATIBILITY_EMITTED} " +
                                action.name,
                        )
                    } catch (error: Throwable) {
                        Log.e(
                            TAG,
                            "Music intent compatibility failed: " +
                                "${error.javaClass.simpleName}: ${error.message}",
                        )
                    }
                }
            })
            Log.w(TAG, "  MusicIntentCompatibilityHooks installed")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "MusicIntentCompatibilityHooks install failed: " +
                    "${error.javaClass.simpleName}: ${error.message}",
            )
        }
        installStockPredictionGuards(classLoader)
    }

    /**
     * Stock accepts the triggering model before remote Synapse. Its PlayMusic
     * NER keeps only an artist and discards ranking/year qualifiers, while the
     * wider autocomplete radius can also turn unrelated speech into PauseMusic.
     * Keep exact catalog requests and transport controls local, but let those
     * lossy predictions fall through to the normal Cosmos interpreter.
     */
    private fun installStockPredictionGuards(classLoader: ClassLoader) {
        try {
            val predictionClass = classLoader.loadClass(
                "humaneinternal.system.intent.TriggeringPrediction",
            )
            val parsePrediction = predictionClass.getDeclaredMethod(
                "parseTriggeringPrediction",
                String::class.java,
                String::class.java,
            ).apply { isAccessible = true }
            val getTriggerIntent = predictionClass.getMethod("getTriggerIntent")
            val minDistanceField = predictionClass.getDeclaredField("minDistance")
                .apply { isAccessible = true }
            val strictRadiusField = predictionClass.getDeclaredField("strict_radius")
                .apply { isAccessible = true }

            XposedBridge.hookMethod(parsePrediction, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    try {
                        val prediction = param.result ?: return
                        val triggerIntent = getTriggerIntent.invoke(prediction) as? String ?: return
                        val utterance = param.args.getOrNull(1) as? String ?: return
                        val minDistance = (minDistanceField.get(prediction) as? Number)
                            ?.toDouble() ?: return
                        val strictRadius = (strictRadiusField.get(prediction) as? Number)
                            ?.toDouble() ?: return
                        if (
                            shouldSuppressStockPrediction(
                                triggerIntent,
                                minDistance,
                                strictRadius,
                                utterance,
                            )
                        ) {
                            param.result = null
                            Log.w(TAG, "Suppressed stock music prediction that requires Cosmos")
                        }
                    } catch (error: Throwable) {
                        Log.e(
                            TAG,
                            "Loose PauseMusic guard failed: ${error.javaClass.simpleName}",
                        )
                    }
                }
            })
            Log.w(TAG, "  Stock music prediction guards installed")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "Stock music prediction guards install failed: " +
                    "${error.javaClass.simpleName}: ${error.message}",
            )
        }
    }

    internal fun shouldSuppressStockPrediction(
        triggerIntent: String,
        minDistance: Double,
        strictRadius: Double,
        utterance: String,
    ): Boolean {
        val playIntent = triggerIntent == "Play" ||
            isNativeIntent(triggerIntent, TierASymbols.NativeActions.PLAY_MUSIC)
        if (playIntent && requiresCosmosMusicPlanning(utterance)) {
            return true
        }

        val pauseIntent = isNativeIntent(triggerIntent, TierASymbols.NativeActions.PAUSE_MUSIC)
        if (
            !pauseIntent ||
            !minDistance.isFinite() ||
            !strictRadius.isFinite() ||
            strictRadius < 0.0 ||
            minDistance <= strictRadius
        ) {
            return false
        }
        return parse(utterance)?.name != TierASymbols.NativeActions.PAUSE_MUSIC
    }

    private fun requiresCosmosMusicPlanning(rawUtterance: String): Boolean {
        if (parse(rawUtterance)?.name == TierASymbols.NativeActions.PLAY_MUSIC) {
            return false
        }
        val utterance = rawUtterance
            .trim()
            .trimEnd('.', '?', '!')
            .replace(Regex("\\s+"), " ")
        if (!musicNoun.containsMatchIn(utterance)) return false

        return rankedMusicSelection.containsMatchIn(utterance) ||
            timeBoundMusicSelection.containsMatchIn(utterance) ||
            currentMusicSelection.containsMatchIn(utterance) ||
            researchThenPlay.containsMatchIn(utterance)
    }

    private fun isNativeIntent(value: String, action: String): Boolean =
        value == action || value.startsWith("{\"$action\":")

    internal fun parse(rawUtterance: String): NativeMusicAction? {
        val utterance = rawUtterance
            .trim()
            .trimEnd('.', '?', '!')
            .replace(Regex("\\s+"), " ")
        if (utterance.isEmpty()) return null

        trackByArtist.matchEntire(utterance)?.let { match ->
            val track = stripTrackLabel(match.groupValues[1])
            val artist = stripArtistLabel(match.groupValues[2])
            if (
                track.isNotEmpty() &&
                artist.isNotEmpty() &&
                reservedTrackPrefixes.none { track.lowercase().startsWith(it) } &&
                track.lowercase() !in contextualTrackReferences &&
                artist.lowercase() !in contextualArtistReferences
            ) {
                return NativeMusicAction(
                    name = TierASymbols.NativeActions.PLAY_MUSIC,
                    inputs = linkedMapOf("Track" to track, "Artist" to artist),
                )
            }
        }

        return when {
            pause.matches(utterance) ->
                NativeMusicAction(TierASymbols.NativeActions.PAUSE_MUSIC)
            resume.matches(utterance) ->
                NativeMusicAction(TierASymbols.NativeActions.RESUME_MUSIC)
            next.matches(utterance) ->
                NativeMusicAction(TierASymbols.NativeActions.NEXT_TRACK)
            previous.matches(utterance) ->
                NativeMusicAction(TierASymbols.NativeActions.PREVIOUS_TRACK)
            restart.matches(utterance) ->
                NativeMusicAction(TierASymbols.NativeActions.RESTART_TRACK)
            else -> null
        }
    }

    private fun stripTrackLabel(value: String): String = value.trim().replace(
        Regex("^(?:the\\s+)?(?:song|track)\\s+", RegexOption.IGNORE_CASE),
        "",
    ).trim()

    private fun stripArtistLabel(value: String): String = value.trim().replace(
        Regex(
            "^(?:the\\s+)?(?:artist|band|musician)\\s+",
            RegexOption.IGNORE_CASE,
        ),
        "",
    ).trim()

    private fun currentUtterance(events: Any?): String? {
        return try {
            val current = events?.javaClass?.getMethod("getCurrent")?.invoke(events)
                ?: return null
            val hasUserRequest = current.javaClass.getMethod("hasUserRequest")
                .invoke(current) as? Boolean ?: false
            if (!hasUserRequest) return null
            val request = current.javaClass.getMethod("getUserRequest").invoke(current)
                ?: return null
            request.javaClass.getMethod("getRequest").invoke(request) as? String
        } catch (_: Throwable) {
            null
        }
    }
}
