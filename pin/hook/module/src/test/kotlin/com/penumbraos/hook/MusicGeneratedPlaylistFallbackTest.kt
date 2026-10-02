package com.penumbraos.hook

import org.junit.Assert.assertEquals
import org.junit.Test

class MusicGeneratedPlaylistFallbackTest {
    // Isolated stock-boundary failures: album/artist hints vanish when a
    // SmartPlaylist has no track descriptors, or album loses priority over
    // artist. These public fixture methods match recovered SmartPlaylist.
    class Playlist(private val albumName: String?, private val artistName: String?) {
        fun hasError() = false
        fun hasNoResults() = true
        fun album() = albumName
        fun artist() = artistName
        fun tracks(): List<Any> = emptyList()
    }

    private fun requests(playlist: Playlist): List<*> =
        MusicHooks::class.java.getDeclaredMethod("generatedDescriptors", Any::class.java)
            .apply { isAccessible = true }
            .invoke(MusicHooks, playlist) as List<*>

    @Test
    fun noTrackDescriptorsUseStockAlbumAndArtistFallback() {
        val requests = requests(Playlist("Demon Days", "Gorillaz"))
        assertEquals("Stock album fallback must produce one existing catalog query", 1, requests.size)
        val request = requests.single() as SpotifyMusicContract.QueryRequest
        assertEquals("album_artist", request.kind)
        assertEquals("Demon Days", request.primary)
        assertEquals("Gorillaz", request.secondary)
    }

    @Test
    fun noTrackDescriptorsUseStockArtistWhenAlbumIsBlank() {
        val requests = requests(Playlist("  ", "Gorillaz"))
        assertEquals("Stock artist fallback must produce one existing catalog query", 1, requests.size)
        val request = requests.single() as SpotifyMusicContract.QueryRequest
        assertEquals("artist", request.kind)
        assertEquals("Gorillaz", request.primary)
    }
}
