package com.penumbraos.hook

/**
 * Reserved entry point for streaming progress-cue compatibility.
 *
 * This hook is intentionally inert. Stock's interstitial path logs generated
 * cue prose before narration, while progress cues must be spoken and discarded.
 * Forwarding streamed server turns into that path would also make cue delivery
 * depend on process-global run state. Until stock has a verified run-scoped,
 * non-persisting delivery path, the safe behavior is to leave the stream
 * untouched and emit no cue.
 *
 * [install] remains callable so the hook registry does not need a separate
 * compatibility branch.
 */
object StreamingInterstitialCueHooks {
    @Suppress("UNUSED_PARAMETER")
    fun install(classLoader: ClassLoader) = Unit
}
