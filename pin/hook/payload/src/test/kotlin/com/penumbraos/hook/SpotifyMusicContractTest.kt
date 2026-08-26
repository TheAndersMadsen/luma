package com.penumbraos.hook

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigInteger

class SpotifyMusicContractTest {
    @Test
    fun `named track resolution requests only the rank one candidate`() {
        assertEquals(1, SpotifyMusicContract.MAX_NAMED_TRACK_ITEMS)
    }

    @Test
    fun `loopback endpoint paths match the on-device service contract`() {
        assertEquals(
            "http://127.0.0.1:8080/internal/spotify/query",
            SpotifyMusicContract.QUERY_URL,
        )
        assertEquals(
            "http://127.0.0.1:8080/internal/spotify/playback",
            SpotifyMusicContract.PLAYBACK_URL,
        )
        assertEquals(
            "http://127.0.0.1:8080/internal/spotify/save",
            SpotifyMusicContract.SAVE_URL,
        )
    }

    @Test
    fun `query request uses exact wire names and preserves ids`() {
        val payload = SpotifyMusicContract.encodeQueryRequest(
            SpotifyMusicContract.QueryRequest(
                kind = "ids",
                ids = listOf("4uLU6hMCjMI75M1A2tKUQC", "0VjIjW4GlUZAMYd2vXMi3b"),
                limit = 10,
            ),
        )

        val json = JSONObject(payload)
        assertEquals("ids", json.getString("kind"))
        assertFalse(json.has("primary"))
        assertFalse(json.has("secondary"))
        assertEquals(10, json.getInt("limit"))
        assertEquals("4uLU6hMCjMI75M1A2tKUQC", json.getJSONArray("ids").getString(0))
        assertEquals("0VjIjW4GlUZAMYd2vXMi3b", json.getJSONArray("ids").getString(1))
    }

    @Test
    fun `query request omits absent optional operands`() {
        val json = JSONObject(
            SpotifyMusicContract.encodeQueryRequest(
                SpotifyMusicContract.QueryRequest(kind = "favorites"),
            ),
        )

        assertFalse(json.has("primary"))
        assertFalse(json.has("secondary"))
        assertFalse(json.has("ids"))
    }

    @Test
    fun `query kinds match the Rust bridge allowlist exactly`() {
        val accepted = listOf(
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
        accepted.forEach { kind ->
            val json = JSONObject(
                SpotifyMusicContract.encodeQueryRequest(
                    SpotifyMusicContract.QueryRequest(kind = kind),
                ),
            )
            assertEquals(kind, json.getString("kind"))
        }

        listOf("favorite_tracks", "featured_playlist", "generated_playlist", "track_ids")
            .forEach { kind ->
                assertFails {
                    SpotifyMusicContract.encodeQueryRequest(
                        SpotifyMusicContract.QueryRequest(kind = kind),
                    )
                }
            }
    }

    @Test
    fun `album artist and generated queries preserve positional meaning`() {
        val album = JSONObject(
            SpotifyMusicContract.encodeQueryRequest(
                SpotifyMusicContract.QueryRequest(
                    kind = "album_artist",
                    primary = "Discovery",
                    secondary = "Daft Punk",
                ),
            ),
        )
        assertEquals("Discovery", album.getString("primary"))
        assertEquals("Daft Punk", album.getString("secondary"))

        val generated = JSONObject(
            SpotifyMusicContract.encodeQueryRequest(
                SpotifyMusicContract.QueryRequest(
                    kind = "generated",
                    primary = "Song title",
                    secondary = "Artist one Artist two",
                    limit = 1,
                ),
            ),
        )
        assertEquals("generated", generated.getString("kind"))
        assertEquals("Song title", generated.getString("primary"))
        assertEquals("Artist one Artist two", generated.getString("secondary"))
        assertEquals(1, generated.getInt("limit"))
    }

    @Test
    fun `query request rejects invalid limits and oversized ids`() {
        assertFails {
            SpotifyMusicContract.encodeQueryRequest(
                SpotifyMusicContract.QueryRequest(kind = "track", limit = 0),
            )
        }
        assertFails {
            SpotifyMusicContract.encodeQueryRequest(
                SpotifyMusicContract.QueryRequest(kind = "track", limit = 101),
            )
        }
        assertFails {
            SpotifyMusicContract.encodeQueryRequest(
                SpotifyMusicContract.QueryRequest(
                    kind = "ids",
                    ids = List(101) { "4uLU6hMCjMI75M1A2tKUQC" },
                ),
            )
        }
        assertFails {
            SpotifyMusicContract.encodeQueryRequest(
                SpotifyMusicContract.QueryRequest(kind = "track_ids"),
            )
        }
    }

    @Test
    fun `query response maps complete track and collection metadata`() {
        val response = SpotifyMusicContract.parseQueryResponse(
            """
            {
              "items": [{
                "id": "4uLU6hMCjMI75M1A2tKUQC",
                "title": "Harder, Better, Faster, Stronger",
                "artists": ["Daft Punk", "Guest"],
                "album": "Discovery",
                "duration_ms": 224693,
                "track_number": 4,
                "disc_number": 1,
                "explicit": false,
                "ignored_future_field": "ok"
              }],
              "collection_name": "Robot Rock",
              "is_user_playlist": true
            }
            """.trimIndent(),
        )

        assertEquals("Robot Rock", response.collectionName)
        assertTrue(response.isUserPlaylist)
        assertEquals(
            SpotifyMusicContract.Track(
                id = "4uLU6hMCjMI75M1A2tKUQC",
                title = "Harder, Better, Faster, Stronger",
                artists = listOf("Daft Punk", "Guest"),
                album = "Discovery",
                durationMs = 224_693,
                trackNumber = 4,
                discNumber = 1,
                explicit = false,
            ),
            response.items.single(),
        )
    }

    @Test
    fun `empty query response is valid and metadata defaults safely`() {
        val response = SpotifyMusicContract.parseQueryResponse("{\"items\":[]}")

        assertTrue(response.items.isEmpty())
        assertNull(response.collectionName)
        assertFalse(response.isUserPlaylist)
    }

    @Test
    fun `blank album is accepted but core identity fields are not`() {
        val valid = validTrackJson().put("album", "")
        assertEquals("", parseSingle(valid).album)

        assertFails { parseSingle(validTrackJson().put("id", "")) }
        assertFails { parseSingle(validTrackJson().put("title", "")) }
        assertFails { parseSingle(validTrackJson().put("artists", emptyList<String>())) }
    }

    @Test
    fun `track strings and booleans are strict`() {
        assertFails { parseSingle(validTrackJson().put("id", 123)) }
        assertFails { parseSingle(validTrackJson().put("artists", listOf(123))) }
        assertFails { parseSingle(validTrackJson().put("explicit", "false")) }
        assertFails {
            SpotifyMusicContract.parseQueryResponse(
                "{\"items\":[],\"collection_name\":12}",
            )
        }
        assertFails {
            SpotifyMusicContract.parseQueryResponse(
                "{\"items\":[],\"is_user_playlist\":\"false\"}",
            )
        }
    }

    @Test
    fun `numeric track fields require exact in-range integers`() {
        listOf(
            validTrackJson().put("duration_ms", -1),
            validTrackJson().put("duration_ms", 1.5),
            validTrackJson().put("duration_ms", "12"),
            validTrackJson().put("duration_ms", BigInteger("9223372036854775808")),
            validTrackJson().put("track_number", -1),
            validTrackJson().put("track_number", 1.25),
            validTrackJson().put("track_number", 2_147_483_648L),
            validTrackJson().put("disc_number", -1),
            validTrackJson().put("disc_number", 1.25),
            validTrackJson().put("disc_number", 2_147_483_648L),
        ).forEach { malformed -> assertFails { parseSingle(malformed) } }

        val exact = parseSingle(
            validTrackJson()
                .put("duration_ms", 1_234L)
                .put("track_number", 2)
                .put("disc_number", 1),
        )
        assertEquals(1_234L, exact.durationMs)
    }

    @Test
    fun `one malformed item rejects the whole collection`() {
        val malformed = validTrackJson().apply { remove("title") }
        val root = JSONObject()
            .put("items", listOf(validTrackJson(), malformed))

        assertFails { SpotifyMusicContract.parseQueryResponse(root.toString()) }
    }

    @Test
    fun `collection size is bounded`() {
        val root = JSONObject().put("items", List(101) { validTrackJson() })
        assertFails { SpotifyMusicContract.parseQueryResponse(root.toString()) }
    }

    @Test
    fun `playback request emits exact id and duration`() {
        val json = JSONObject(
            SpotifyMusicContract.encodePlaybackRequest("4uLU6hMCjMI75M1A2tKUQC", 224_693),
        )

        assertEquals(2, json.length())
        assertEquals("4uLU6hMCjMI75M1A2tKUQC", json.getString("id"))
        assertEquals(224_693L, json.getLong("duration_ms"))

        assertFails {
            SpotifyMusicContract.encodePlaybackRequest("spotify:track:abc", 224_693)
        }
        assertFails {
            SpotifyMusicContract.encodePlaybackRequest("4uLU6hMCjMI75M1A2tKUQC", 999)
        }
        assertFails {
            SpotifyMusicContract.encodePlaybackRequest("4uLU6hMCjMI75M1A2tKUQC", 1_800_001)
        }
    }

    @Test
    fun `playback response accepts explicit loopback http only`() {
        assertEquals(
            "http://127.0.0.1:8081/audio/abc",
            SpotifyMusicContract.parsePlaybackResponse(
                "{\"url\":\"http://127.0.0.1:8081/audio/abc\"}",
            ),
        )
        assertEquals(
            "http://[::1]:8081/audio/abc",
            SpotifyMusicContract.parsePlaybackResponse(
                "{\"url\":\"http://[::1]:8081/audio/abc\"}",
            ),
        )

        listOf(
            "https://center.example.test/api/music-gateway/stream/${"a".repeat(43)}",
            "https://r1.googlevideo.com/videoplayback?id=fixture",
            "https://127.0.0.1:8081/audio/abc",
            "http://localhost:8081/audio/abc",
            "http://example.com:8081/audio/abc",
            "http://127.0.0.1/audio/abc",
            "file:///tmp/audio",
            "http://user@127.0.0.1:8081/audio/abc",
        ).forEach { url ->
            assertFails {
                SpotifyMusicContract.parsePlaybackResponse(
                    JSONObject().put("url", url).toString(),
                )
            }
        }
    }

    @Test
    fun `save contract uses strict boolean`() {
        assertEquals(
            "4uLU6hMCjMI75M1A2tKUQC",
            JSONObject(SpotifyMusicContract.encodeSaveRequest("4uLU6hMCjMI75M1A2tKUQC"))
                .getString("id"),
        )
        assertTrue(SpotifyMusicContract.parseSaveResponse("{\"ok\":true}"))
        assertFalse(SpotifyMusicContract.parseSaveResponse("{\"ok\":false}"))
        assertFails { SpotifyMusicContract.parseSaveResponse("{\"ok\":\"true\"}") }
        assertFails { SpotifyMusicContract.parseSaveResponse("{}") }
    }

    private fun validTrackJson(): JSONObject = JSONObject()
        .put("id", "4uLU6hMCjMI75M1A2tKUQC")
        .put("title", "Song")
        .put("artists", listOf("Artist"))
        .put("album", "Album")
        .put("duration_ms", 180_000)
        .put("track_number", 1)
        .put("disc_number", 1)
        .put("explicit", false)

    private fun parseSingle(track: JSONObject): SpotifyMusicContract.Track =
        SpotifyMusicContract.parseQueryResponse(
            JSONObject().put("items", listOf(track)).toString(),
        ).items.single()

    private inline fun assertFails(block: () -> Unit) {
        try {
            block()
            fail("Expected operation to reject malformed input")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }
}
