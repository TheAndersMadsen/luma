package com.penumbraos.hook

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.math.BigDecimal
import java.math.BigInteger
import java.net.URI

/**
 * Wire contract between the injected stock music experience and Penumbra's
 * loopback Spotify service.
 *
 * This file deliberately contains no Android or Humane types. Keeping the
 * boundary small makes malformed loopback responses fail closed and lets the
 * JSON mapping run in ordinary JVM tests.
 */
internal object SpotifyMusicContract {
    const val QUERY_URL = "http://127.0.0.1:8080/internal/spotify/query"
    const val PLAYBACK_URL = "http://127.0.0.1:8080/internal/spotify/playback"
    const val SAVE_URL = "http://127.0.0.1:8080/internal/spotify/save"
    // Spotify's current Search API is capped at 10, but stock collection
    // queries (albums, playlists, favorites, radio queues) are not searches.
    // Keep a larger bounded envelope so the stock MediaItemCollection does not
    // truncate every collection to the Search limit.
    const val MAX_SEARCH_ITEMS = 10
    const val MAX_QUERY_ITEMS = 100
    const val MAX_NAMED_TRACK_ITEMS = 1
    const val MAX_GENERATED_ITEMS = 10
    const val MAX_ARTISTS_PER_TRACK = 16

    private const val MAX_TEXT_LENGTH = 4_096
    private const val MAX_QUERY_TEXT_LENGTH = 256
    private const val MIN_TRACK_DURATION_MS = 1_000L
    private const val MAX_TRACK_DURATION_MS = 30L * 60L * 1_000L
    private val SUPPORTED_QUERY_KINDS = setOf(
        "track",
        "top_hits",
        "artist",
        "album",
        "album_artist",
        "album_id",
        "genre",
        "playlist",
        "featured",
        "favorites",
        "radio",
        "recommendations",
        "generated",
        "ids",
    )

    data class QueryRequest(
        val kind: String,
        val primary: String? = null,
        val secondary: String? = null,
        val ids: List<String>? = null,
        val limit: Int = MAX_QUERY_ITEMS,
    )

    data class Track(
        val id: String,
        val title: String,
        val artists: List<String>,
        val album: String,
        val durationMs: Long,
        val trackNumber: Int,
        val discNumber: Int,
        val explicit: Boolean,
    )

    data class QueryResponse(
        val items: List<Track>,
        val collectionName: String?,
        val isUserPlaylist: Boolean,
    )

    fun encodeQueryRequest(request: QueryRequest): String {
        require(request.kind.isNotBlank()) { "Spotify query kind cannot be blank" }
        require(request.kind in SUPPORTED_QUERY_KINDS) { "Unsupported Spotify query kind" }
        require(request.limit in 1..MAX_QUERY_ITEMS) {
            "Spotify query limit must be between 1 and $MAX_QUERY_ITEMS"
        }

        return JSONObject().apply {
            put("kind", boundedQueryText("kind", request.kind))
            request.primary?.let { put("primary", boundedQueryText("primary", it)) }
            request.secondary?.let { put("secondary", boundedQueryText("secondary", it)) }
            request.ids?.let { values ->
                require(values.size <= MAX_QUERY_ITEMS) { "Too many Spotify query ids" }
                put(
                    "ids",
                    JSONArray().apply {
                        values.forEach { put(requireMusicId(it)) }
                    },
                )
            }
            put("limit", request.limit)
        }.toString()
    }

    fun encodePlaybackRequest(id: String, durationMs: Long): String {
        require(durationMs in MIN_TRACK_DURATION_MS..MAX_TRACK_DURATION_MS) {
            "Spotify playback duration is invalid"
        }
        return JSONObject()
            .put("id", requireMusicId(id))
            .put("duration_ms", durationMs)
            .toString()
    }

    fun encodeSaveRequest(id: String): String =
        JSONObject().put("id", requireMusicId(id)).toString()

    fun parseQueryResponse(payload: String): QueryResponse {
        val root = parseRoot(payload)
        val itemsJson = root.requiredArray("items")
        require(itemsJson.length() <= MAX_QUERY_ITEMS) { "Spotify response has too many items" }

        val items = ArrayList<Track>(itemsJson.length())
        for (index in 0 until itemsJson.length()) {
            val item = itemsJson.optJSONObject(index)
                ?: throw IllegalArgumentException("Spotify item $index must be an object")
            items += parseTrack(item, index)
        }

        return QueryResponse(
            items = items,
            collectionName = root.optionalString("collection_name"),
            isUserPlaylist = root.optionalBoolean("is_user_playlist") ?: false,
        )
    }

    fun parsePlaybackResponse(payload: String): String {
        val url = boundedText("url", parseRoot(payload).requiredString("url"))
        requireLoopbackPlaybackUrl(url)
        return url
    }

    fun parseSaveResponse(payload: String): Boolean =
        parseRoot(payload).requiredBoolean("ok")

    private fun parseTrack(item: JSONObject, index: Int): Track {
        val artistsJson = item.requiredArray("artists")
        require(artistsJson.length() in 1..MAX_ARTISTS_PER_TRACK) {
            "Spotify item $index must have between 1 and $MAX_ARTISTS_PER_TRACK artists"
        }
        val artists = ArrayList<String>(artistsJson.length())
        for (artistIndex in 0 until artistsJson.length()) {
            val artist = artistsJson.opt(artistIndex) as? String
                ?: throw IllegalArgumentException(
                    "Spotify item $index artist $artistIndex must be a string",
                )
            require(artist.isNotBlank()) { "Spotify item $index has a blank artist" }
            artists += boundedText("artist", artist)
        }

        val durationMs = item.requiredLong("duration_ms")
        require(durationMs in MIN_TRACK_DURATION_MS..MAX_TRACK_DURATION_MS) {
            "Spotify item $index has an invalid duration"
        }
        val trackNumber = item.requiredInt("track_number")
        val discNumber = item.requiredInt("disc_number")
        require(trackNumber >= 0) { "Spotify item $index has a negative track number" }
        require(discNumber >= 0) { "Spotify item $index has a negative disc number" }

        return Track(
            id = requireMusicId(item.requiredString("id")),
            title = boundedText("title", item.requiredString("title")),
            artists = artists,
            album = boundedText(
                "album",
                item.requiredString("album", allowBlank = true),
                allowBlank = true,
            ),
            durationMs = durationMs,
            trackNumber = trackNumber,
            discNumber = discNumber,
            explicit = item.requiredBoolean("explicit"),
        )
    }

    private fun parseRoot(payload: String): JSONObject {
        require(payload.toByteArray(Charsets.UTF_8).size <= 1_048_576) {
            "Spotify response is too large"
        }
        return try {
            JSONObject(payload)
        } catch (error: JSONException) {
            throw IllegalArgumentException("Spotify response is not valid JSON", error)
        }
    }

    private fun requireLoopbackPlaybackUrl(value: String) {
        val uri = try {
            URI(value)
        } catch (error: Exception) {
            throw IllegalArgumentException("Spotify playback URL is invalid", error)
        }
        require(uri.userInfo == null) { "Spotify playback URL cannot contain user info" }
        val loopback = uri.scheme == "http" && uri.port in 1..65_535 &&
            (uri.host == "127.0.0.1" || uri.host == "::1" || uri.host == "[::1]")
        val gateway = uri.scheme == "https" && uri.host?.isNotBlank() == true && uri.port == -1 &&
            uri.rawQuery == null && uri.rawFragment == null &&
            Regex("^/api/music-gateway/stream/[A-Za-z0-9_-]{43}$").matches(uri.rawPath.orEmpty())
        require(loopback || gateway) {
            "Music playback URL must be loopback or an opaque Center stream"
        }
    }

    private fun boundedText(name: String, value: String, allowBlank: Boolean = false): String {
        if (!allowBlank) require(value.isNotBlank()) { "Spotify $name cannot be blank" }
        require(value.length <= MAX_TEXT_LENGTH) { "Spotify $name is too long" }
        return value
    }

    private fun boundedQueryText(name: String, value: String): String {
        require(value.isNotBlank()) { "Spotify $name cannot be blank" }
        require(value.toByteArray(Charsets.UTF_8).size <= MAX_QUERY_TEXT_LENGTH) {
            "Spotify $name is too long"
        }
        require(value.none { it.isISOControl() }) {
            "Spotify $name contains control characters"
        }
        return value
    }

    private fun requireMusicId(value: String): String {
        val spotify = value.length == 22 && value.all(Char::isLetterOrDigit)
        val separator = value.indexOf(':')
        val provider = if (separator > 0) value.substring(0, separator) else ""
        val opaque = separator > 0 && value.length <= 320 &&
            provider in setOf("youtube_music", "tidal", "apple_music") &&
            value.substring(separator + 1).isNotEmpty() &&
            value.substring(separator + 1).all { it.isLetterOrDigit() || it == '-' || it == '_' }
        require(spotify || opaque) { "Music track id is invalid" }
        return value
    }

    private fun JSONObject.requiredArray(name: String): JSONArray =
        optJSONArray(name) ?: throw IllegalArgumentException("Spotify response is missing $name")

    private fun JSONObject.requiredString(name: String, allowBlank: Boolean = false): String {
        if (!has(name) || isNull(name)) {
            throw IllegalArgumentException("Spotify response is missing $name")
        }
        val value = opt(name) as? String
            ?: throw IllegalArgumentException("Spotify response field $name must be a string")
        if (!allowBlank) {
            require(value.isNotBlank()) { "Spotify response field $name cannot be blank" }
        }
        return value
    }

    private fun JSONObject.optionalString(name: String): String? {
        if (!has(name) || isNull(name)) return null
        val value = opt(name) as? String
            ?: throw IllegalArgumentException("Spotify response field $name must be a string")
        return boundedText(name, value, allowBlank = true)
    }

    private fun JSONObject.requiredBoolean(name: String): Boolean {
        if (!has(name) || isNull(name) || opt(name) !is Boolean) {
            throw IllegalArgumentException("Spotify response field $name must be a boolean")
        }
        return getBoolean(name)
    }

    private fun JSONObject.optionalBoolean(name: String): Boolean? {
        if (!has(name) || isNull(name)) return null
        require(opt(name) is Boolean) { "Spotify response field $name must be a boolean" }
        return getBoolean(name)
    }

    private fun JSONObject.requiredLong(name: String): Long {
        val value = opt(name)
        if (value !is Number) {
            throw IllegalArgumentException("Spotify response field $name must be a number")
        }
        return try {
            when (value) {
                is Byte -> value.toLong()
                is Short -> value.toLong()
                is Int -> value.toLong()
                is Long -> value
                is BigInteger -> value.longValueExact()
                is BigDecimal -> value.longValueExact()
                is Float -> {
                    require(value.isFinite())
                    BigDecimal(value.toString()).longValueExact()
                }
                is Double -> {
                    require(value.isFinite())
                    BigDecimal(value.toString()).longValueExact()
                }
                else -> BigDecimal(value.toString()).longValueExact()
            }
        } catch (error: Exception) {
            throw IllegalArgumentException(
                "Spotify response field $name must be an exact integer",
                error,
            )
        }
    }

    private fun JSONObject.requiredInt(name: String): Int {
        val value = requiredLong(name)
        require(value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
            "Spotify response field $name is outside the integer range"
        }
        return value.toInt()
    }
}
