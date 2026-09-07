package dk.andersmadsen.cosmos.android.action

/**
 * The owner's media provider ids, and the applications this build knows how to
 * ask. The runtime sends a provider id it took from the owner's own policy; the
 * package name is never on the wire and never comes from a model.
 *
 * A provider with no application installed here has no handler, which is a
 * refusal and never a silent nothing.
 */
object MediaProviders {
    /** Television packages first: this list is only ever used on the TV. */
    private val PACKAGES = mapOf(
        "youtube" to listOf("com.google.android.youtube.tv", "com.google.android.youtube"),
        "netflix" to listOf("com.netflix.ninja", "com.netflix.mediaclient"),
        "spotify" to listOf("com.spotify.tv.android", "com.spotify.music"),
        "plex" to listOf("com.plexapp.android"),
        "disney" to listOf("com.disney.disneyplus"),
    )

    fun packages(provider: String): List<String> = PACKAGES[provider].orEmpty()

    /** Every provider this build could ever play, for the owner's own reading. */
    fun known(): Set<String> = PACKAGES.keys
}
