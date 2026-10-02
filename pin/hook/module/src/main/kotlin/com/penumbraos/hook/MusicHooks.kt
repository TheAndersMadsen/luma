package com.penumbraos.hook

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Parcel
import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.lang.reflect.Constructor
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.net.URLEncoder
import java.util.Collections
import java.util.Optional
import java.util.WeakHashMap
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import com.penumbraos.ipc.contract.PenumbraIpcContract
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * Correct only the two retired-provider-labelled fallbacks reached because the
 * collection queries implement Humane's interface through a proxy rather than
 * extending the retired Tidal query classes.
 */
internal fun rewriteMusicInterstitialNarration(text: String): String = when (text) {
    "featured playlist on tidal, up next." -> "featured playlist, up next."
    "your collection on tidal, up next." -> "your collection, up next."
    else -> text
}

/**
 * Provider-neutral implementation at the stock music provider boundary.
 *
 * The rest of the Humane music experience remains untouched: native intent
 * routing still selects a [MediaCollectionQuery], MediaManager still owns the
 * queue, and the stock ExoPlayer still consumes [MediaItem.PlaybackInfo]. Only
 * the retired Tidal provider is replaced. Network/auth work is delegated to the
 * Penumbra loopback service so provider credentials never enter this APK.
 *
 * There are deliberately no compile-time references to Humane or RxJava types.
 * The Compatibility Layer APK is loaded into several processes which do not contain them. All
 * target types are resolved from the music process classloader at runtime.
 */
object MusicHooks {
    private const val TAG = "LumaCompatibility"

    private const val BIND_TIMEOUT_MS = 5_000L
    private const val MAX_RESPONSE_BYTES = 1_048_576

    private const val BRIDGE_PACKAGE = "com.penumbraos.server"
    private const val BRIDGE_CLASS = "com.penumbraos.server.SpotifyBridgeService"
    private const val BRIDGE_DESCRIPTOR = TierASymbols.Binder.PenumbraSpotify.DESCRIPTOR
    private const val TRANSACTION_QUERY = PenumbraIpcContract.Spotify.TRANSACTION_QUERY
    private const val TRANSACTION_PLAYBACK = PenumbraIpcContract.Spotify.TRANSACTION_PLAYBACK
    private const val TRANSACTION_SAVE = PenumbraIpcContract.Spotify.TRANSACTION_SAVE

    private const val AUTH_MESSAGE =
        "Music is not connected. Connect your music service in Center."
    private const val UNAVAILABLE_MESSAGE =
        "Music is unavailable. Check your music service in Center."

    @Volatile
    private var installed = false
    private lateinit var cl: ClassLoader

    private lateinit var mediaItemClass: Class<*>
    private lateinit var playbackInfoClass: Class<*>
    private lateinit var collectionQueryClass: Class<*>
    private lateinit var mediaItemCollectionConstructor: Constructor<*>
    private lateinit var saveResponseClass: Class<*>
    private lateinit var saveResponseConstructor: Constructor<*>

    private lateinit var singleClass: Class<*>
    private lateinit var schedulerClass: Class<*>
    private lateinit var functionClass: Class<*>
    private lateinit var ioScheduler: Any
    private lateinit var mainScheduler: Any

    private var stockTrackClass: Class<*>? = null
    private var gson: Any? = null
    private var gsonFromJson: Method? = null
    @Volatile
    private var gsonFallbackLogged = false

    private data class SpotifyItemState(
        val id: String,
        val durationMs: Long,
        val title: String,
        val artists: List<String>,
    )

    private val spotifyItems = Collections.synchronizedMap(WeakHashMap<Any, SpotifyItemState>())
    private val failedSaveResponses = Collections.synchronizedMap(WeakHashMap<Any, Boolean>())

    @Synchronized
    fun install(classLoader: ClassLoader) {
        if (installed) return
        cl = classLoader

        try {
            PlayerLocalDuckingHooks.installMusic(cl)
            resolveTargetTypes()
            val provider = cl.loadClass("humane.experience.music.provider.tidal.TidalProvider")
            installLoopbackCleartextPolicy()
            installTidalFailClosed()
            installProviderHooks(provider)
            installStockModelHooks()
            installMusicInterstitialNarrationHook()

            installed = true
            Log.w(TAG, "MusicHooks installed (stock music pipeline, Center provider gateway)")
        } catch (error: Throwable) {
            Log.e(TAG, "MusicHooks install failed: ${error.javaClass.simpleName}: ${error.message}", error)
        }
    }

    /**
     * The stock Tidal app disallows cleartext globally. Penumbra deliberately
     * serves only a loopback control/stream endpoint, so permit those two literal
     * hosts without weakening the policy for LAN or internet destinations.
     */
    private fun installLoopbackCleartextPolicy() {
        runCatching {
            val policy = cl.loadClass("android.security.NetworkSecurityPolicy")
            val hostCheck = policy.getDeclaredMethod(
                "isCleartextTrafficPermitted",
                String::class.java,
            ).apply { isAccessible = true }
            XposedBridge.hookMethod(hostCheck, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    when (param.args.getOrNull(0) as? String) {
                        "127.0.0.1", "::1", "[::1]" -> param.result = true
                    }
                }
            })
            Log.w(TAG, "  Permitted cleartext for Spotify loopback hosts only")
        }.onFailure {
            Log.w(TAG, "  Loopback cleartext policy hook unavailable: ${it.javaClass.simpleName}")
        }
    }

    private fun resolveTargetTypes() {
        mediaItemClass = cl.loadClass("humane.experience.music.MediaItem")
        playbackInfoClass = cl.loadClass("humane.experience.music.MediaItem\$PlaybackInfo")
        collectionQueryClass = cl.loadClass("humane.experience.music.MediaCollectionQuery")
        mediaItemCollectionConstructor =
            cl.loadClass("humane.experience.music.MediaItemCollection")
                .getConstructor(List::class.java)

        saveResponseClass =
            cl.loadClass("humane.experience.music.provider.tidal.models.post.SaveTrackPostResponse")
        saveResponseConstructor = saveResponseClass.getDeclaredConstructor().apply { isAccessible = true }

        singleClass = cl.loadClass("io.reactivex.rxjava3.core.Single")
        schedulerClass = cl.loadClass("io.reactivex.rxjava3.core.Scheduler")
        functionClass = cl.loadClass("io.reactivex.rxjava3.functions.Function")
        ioScheduler =
            cl.loadClass("io.reactivex.rxjava3.schedulers.Schedulers")
                .getMethod("io")
                .invoke(null)!!
        mainScheduler =
            cl.loadClass("io.reactivex.rxjava3.android.schedulers.AndroidSchedulers")
                .getMethod("mainThread")
                .invoke(null)!!

        stockTrackClass = runCatching {
            cl.loadClass("humane.experience.music.provider.tidal.models.Track")
        }.getOrNull()

        runCatching {
            val gsonClass = cl.loadClass("com.google.gson.Gson")
            gson = gsonClass.getConstructor().newInstance()
            gsonFromJson = gsonClass.getMethod("fromJson", String::class.java, Class::class.java)
        }.onFailure {
            Log.w(TAG, "  Stock Gson unavailable; Spotify items will use MediaItem proxies")
        }
    }

    /**
     * A missed/new provider method must never escape to Tidal. Provider hooks are
     * the primary boundary. These lower-level guards are the fail-closed backstop.
     */
    private fun installTidalFailClosed() {
        runCatching {
            val manager = cl.loadClass("humane.experience.music.provider.tidal.auth.TidalUserManager")
            manager.declaredMethods
                .filter { it.name == "initialize" }
                .forEach { method ->
                    method.isAccessible = true
                    XposedBridge.hookMethod(method, object : XC_MethodHook() {
                        override fun beforeHookedMethod(param: MethodHookParam) {
                            param.result = null
                        }
                    })
                }
            Log.w(TAG, "  Disabled Tidal user-manager initialization")
        }.onFailure {
            Log.w(TAG, "  TidalUserManager guard unavailable: ${it.javaClass.simpleName}")
        }

        runCatching {
            val client = cl.loadClass("humane.experience.music.provider.tidal.TidalHttpClient")
            val networkNames = setOf("get", "post", "put", "delete", "execute")
            var guarded = 0
            client.declaredMethods
                .filter { it.name in networkNames }
                .forEach { method ->
                    method.isAccessible = true
                    XposedBridge.hookMethod(method, object : XC_MethodHook() {
                        override fun beforeHookedMethod(param: MethodHookParam) {
                            param.throwable = IOException("Tidal is disabled; Spotify bridge only")
                        }
                    })
                    guarded++
                }
            Log.w(TAG, "  Guarded $guarded Tidal HTTP entry points")
        }.onFailure {
            Log.w(TAG, "  TidalHttpClient guard unavailable: ${it.javaClass.simpleName}")
        }
    }

    private fun installProviderHooks(provider: Class<*>) {
        hookQuery(provider, "queryFavoriteTracks", emptyArray()) {
            query("favorites")
        }
        hookQuery(provider, "queryFeaturedPlaylist", emptyArray()) {
            query("featured")
        }
        hookStringQuery(provider, "queryRadioWithTrackId", "radio")
        hookStringQuery(provider, "queryRecommendationsWithTrackId", "recommendations")
        hookStringQuery(provider, "queryTopHits", "top_hits")
        hookTwoStringQuery(provider, "queryTopHitsWithArtistName", "top_hits")
        hookTwoStringQuery(
            provider,
            "queryWithAlbumAndArtistName",
            "album_artist",
            albumQuery = true,
        )
        hookStringQuery(provider, "queryWithAlbumId", "album_id", albumQuery = true)
        hookStringQuery(provider, "queryWithAlbumName", "album", albumQuery = true)
        hookStringQuery(provider, "queryWithArtistName", "artist")
        hookStringQuery(provider, "queryWithGenreName", "genre")
        hookStringQuery(provider, "queryWithPlaylistName", "playlist")
        hookStringQuery(
            provider,
            "queryWithTrackName",
            "track",
            limit = SpotifyMusicContract.MAX_NAMED_TRACK_ITEMS,
        )

        hookQuery(provider, "queryWithTrackIds", arrayOf(List::class.java)) { args ->
            @Suppress("UNCHECKED_CAST")
            val values = (args.getOrNull(0) as? List<*>)
                ?.map { it as? String ?: "" }
                ?.take(SpotifyMusicContract.MAX_QUERY_ITEMS)
                ?.toList()
                ?: emptyList()
            query("ids", ids = values.map(::normalizeSpotifyId))
        }

        hookQuery(provider, "queryWithGeneratedPlaylist", arrayOf(singleClass)) { args ->
            buildGeneratedPlaylistQuery(args.getOrNull(0))
        }

        hookRequired(
            provider,
            "playbackInfoForMediaItem",
            arrayOf(mediaItemClass),
        ) { param ->
            val item = param.args.getOrNull(0)
            param.result = ioThenMain(Callable { resolvePlayback(item) })
        }

        hookRequired(
            provider,
            "saveTrackToLibrary",
            arrayOf(String::class.java),
        ) { param ->
            val id = (param.args.getOrNull(0) as? String)?.let(::normalizeSpotifyId) ?: ""
            param.result = ioThenMain(Callable { saveTrack(id) })
        }
    }

    private fun hookStringQuery(
        provider: Class<*>,
        methodName: String,
        kind: String,
        limit: Int = SpotifyMusicContract.MAX_QUERY_ITEMS,
        albumQuery: Boolean = false,
    ) {
        hookQuery(provider, methodName, arrayOf(String::class.java)) { args ->
            query(
                kind = kind,
                primary = args.getOrNull(0) as? String ?: "",
                limit = limit,
                albumQuery = albumQuery,
            )
        }
    }

    private fun hookTwoStringQuery(
        provider: Class<*>,
        methodName: String,
        kind: String,
        albumQuery: Boolean = false,
    ) {
        hookQuery(
            provider,
            methodName,
            arrayOf(String::class.java, String::class.java),
        ) { args ->
            query(
                kind = kind,
                primary = args.getOrNull(0) as? String ?: "",
                secondary = args.getOrNull(1) as? String ?: "",
                albumQuery = albumQuery,
            )
        }
    }

    private fun hookQuery(
        provider: Class<*>,
        methodName: String,
        parameterTypes: Array<Class<*>>,
        replacement: (Array<Any?>) -> Any,
    ) {
        hookRequired(provider, methodName, parameterTypes) { param ->
            @Suppress("UNCHECKED_CAST")
            val args = (param.args ?: emptyArray<Any?>()) as Array<Any?>
            param.result = replacement(args)
        }
    }

    private fun hookRequired(
        owner: Class<*>,
        name: String,
        parameterTypes: Array<Class<*>>,
        before: (XC_MethodHook.MethodHookParam) -> Unit,
    ) {
        val method = owner.getDeclaredMethod(name, *parameterTypes).apply { isAccessible = true }
        XposedBridge.hookMethod(method, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                before(param)
            }
        })
        Log.w(TAG, "  Hooked ${owner.simpleName}.$name")
    }

    private fun query(
        kind: String,
        primary: String? = null,
        secondary: String? = null,
        ids: List<String>? = null,
        limit: Int = SpotifyMusicContract.MAX_QUERY_ITEMS,
        albumQuery: Boolean = false,
    ): Any = buildCollectionQuery(
        SpotifyMusicContract.QueryRequest(
            kind = kind,
            primary = primary,
            secondary = secondary,
            ids = ids?.toList(),
            limit = limit,
        ),
        albumQuery,
    )

    private fun buildCollectionQuery(
        request: SpotifyMusicContract.QueryRequest,
        albumQuery: Boolean,
    ): Any = Proxy.newProxyInstance(
        collectionQueryClass.classLoader,
        arrayOf(collectionQueryClass),
        InvocationHandler { proxy, method, args ->
            when (method.name) {
                "collection" -> ioThenMain(Callable { fetchCollection(request) })
                "isAlbumQuery" -> albumQuery
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.getOrNull(0)
                "toString" -> "SpotifyCollectionQuery(${request.kind})"
                else -> defaultValue(method.returnType)
            }
        },
    )

    /** Resolve each stock AI-DJ descriptor through the `generated` query kind. */
    private fun buildGeneratedPlaylistQuery(sourceSingle: Any?): Any =
        Proxy.newProxyInstance(
            collectionQueryClass.classLoader,
            arrayOf(collectionQueryClass),
            InvocationHandler { proxy, method, args ->
                when (method.name) {
                    "collection" -> generatedCollectionSingle(sourceSingle)
                    "isAlbumQuery" -> false
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === args?.getOrNull(0)
                    "toString" -> "SpotifyGeneratedPlaylistQuery"
                    else -> defaultValue(method.returnType)
                }
            },
        )

    private fun generatedCollectionSingle(sourceSingle: Any?): Any {
        if (sourceSingle == null) {
            return ioThenMain(Callable<Any> { throw spotifyUnavailable() })
        }

        val function = Proxy.newProxyInstance(
            functionClass.classLoader,
            arrayOf(functionClass),
            InvocationHandler { proxy, method, args ->
                when (method.name) {
                    "apply" -> {
                        val playlist = args?.getOrNull(0)
                        ioThenMain(Callable { fetchGeneratedCollection(playlist) })
                    }
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === args?.getOrNull(0)
                    "toString" -> "SpotifyGeneratedPlaylistMapper"
                    else -> defaultValue(method.returnType)
                }
            },
        )
        val flatMapped = singleClass.getMethod("flatMap", functionClass)
            .invoke(sourceSingle, function)!!
        return singleObserveOnMain(flatMapped)
    }

    private fun generatedDescriptors(playlist: Any?): List<SpotifyMusicContract.QueryRequest> {
        if (playlist == null) throw spotifyUnavailable()
        val hasError = callNoArg(playlist, "hasError") as? Boolean ?: true
        if (hasError) throw spotifyUnavailable()

        // Stock TidalSmartPlaylistCollectionQuery.collection (its collection
        // lambda) falls back to album, then artist, when hasNoResults is true.
        // Keep those existing catalog queries instead of returning an empty queue.
        if (callNoArg(playlist, "hasNoResults") == true) {
            val album = (callNoArg(playlist, "album") as? String)?.takeIf { it.isNotBlank() }
            val artist = (callNoArg(playlist, "artist") as? String)?.takeIf { it.isNotBlank() }
            if (album != null) {
                return listOf(SpotifyMusicContract.QueryRequest(
                    kind = if (artist != null) "album_artist" else "album",
                    primary = album,
                    secondary = artist,
                ))
            }
            if (artist != null) {
                return listOf(SpotifyMusicContract.QueryRequest(kind = "artist", primary = artist))
            }
        }

        @Suppress("UNCHECKED_CAST")
        val tracks = callNoArg(playlist, "tracks") as? List<Any?> ?: emptyList()
        return tracks.take(SpotifyMusicContract.MAX_GENERATED_ITEMS).map { track ->
            if (track == null) throw spotifyUnavailable()
            val title = callNoArg(track, "title") as? String ?: throw spotifyUnavailable()
            @Suppress("UNCHECKED_CAST")
            val artists = callNoArg(track, "artists") as? List<*>
                ?: throw spotifyUnavailable()
            SpotifyMusicContract.QueryRequest(
                kind = "generated",
                primary = title,
                secondary = artists.map { it as? String ?: "" }
                    .filter { it.isNotBlank() }
                    .joinToString(" ")
                    .takeIf { it.isNotBlank() },
                limit = 1,
            )
        }
    }

    private fun fetchGeneratedCollection(playlist: Any?): Any {
        return try {
            val items = generatedDescriptors(playlist).flatMap { request ->
                fetchResponse(request).items.map(::buildMediaItem)
            }
            Log.w(TAG, "  Spotify generated: ${items.size} stock queue item(s)")
            mediaItemCollectionConstructor.newInstance(items)
        } catch (error: Throwable) {
            throw translateBackendFailure("generated query", error)
        }
    }

    private fun fetchCollection(request: SpotifyMusicContract.QueryRequest): Any {
        return try {
            val response = fetchResponse(request)
            val items = response.items.map(::buildMediaItem)
            Log.w(TAG, "  Spotify ${request.kind}: ${items.size} stock queue item(s)")
            mediaItemCollectionConstructor.newInstance(items)
        } catch (error: Throwable) {
            throw translateBackendFailure(
                TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_QUERY,
                error,
            )
        }
    }

    private fun fetchResponse(
        request: SpotifyMusicContract.QueryRequest,
    ): SpotifyMusicContract.QueryResponse {
        val payload = postJson(
            SpotifyMusicContract.QUERY_URL,
            SpotifyMusicContract.encodeQueryRequest(request),
        )
        return SpotifyMusicContract.parseQueryResponse(payload)
    }

    private fun resolvePlayback(item: Any?): Any {
        return try {
            if (item == null) throw IllegalArgumentException("Missing media item")
            val id = (callInterface(item, "getId") as? String)?.let(::normalizeSpotifyId)
                ?: throw IllegalArgumentException("Missing media item id")
            val state = spotifyItems[item]
            val durationMs = state?.durationMs ?: run {
                val seconds = (callInterface(item, "getDuration") as? Number)?.toLong() ?: 0L
                seconds.coerceAtLeast(0L).coerceAtMost(Long.MAX_VALUE / 1_000L) * 1_000L
            }
            val payload = postJson(
                SpotifyMusicContract.PLAYBACK_URL,
                SpotifyMusicContract.encodePlaybackRequest(id, durationMs),
            )
            buildPlaybackInfo(SpotifyMusicContract.parsePlaybackResponse(payload))
        } catch (error: Throwable) {
            throw translateBackendFailure(
                TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_PLAYBACK,
                error,
            )
        }
    }

    private fun saveTrack(id: String): Any {
        return try {
            val payload = postJson(
                SpotifyMusicContract.SAVE_URL,
                SpotifyMusicContract.encodeSaveRequest(id),
            )
            val ok = SpotifyMusicContract.parseSaveResponse(payload)
            val response = saveResponseConstructor.newInstance()
            if (!ok) failedSaveResponses[response] = true
            response
        } catch (error: Throwable) {
            throw translateBackendFailure(
                TierASymbols.Binder.PenumbraSpotify.WIRE_NAME_SAVE,
                error,
            )
        }
    }

    private fun installStockModelHooks() {
        stockTrackClass?.let { trackClass ->
            // §19.2 Music hardening: pin each hook to its exact stock signature
            // instead of hookAllMethods, which would match every overload by name.
            HookUtils.hookMethodBefore(
                trackClass,
                "shareableURL",
                emptyArray(),
            ) { param ->
                val state = spotifyItems[param.thisObject] ?: return@hookMethodBefore
                param.result = providerShareUrl(state.id)
            }.also {
                if (!it) Log.w(TAG, "  Track.shareableURL hook unavailable")
            }

            HookUtils.hookMethodBefore(
                trackClass,
                "emitNotableEvent",
                // Stock Track.emitNotableEvent(TrackNotableEventType, String),
                // invoked by MediaManager.emitNotableEvent. INFERRED Luma policy:
                // suppress obsolete TIDAL events only for our mapped tracks.
                arrayOf(
                    cl.loadClass("humane.ui.notableevents.TrackNotableEvent\$TrackNotableEventType"),
                    String::class.java,
                ),
            ) { param ->
                if (spotifyItems.containsKey(param.thisObject)) param.result = null
            }.also {
                if (!it) Log.w(TAG, "  Track.emitNotableEvent hook unavailable")
            }
        }

        HookUtils.hookMethodBefore(
            saveResponseClass,
            "isSuccess",
            emptyArray(),
        ) { param ->
            if (failedSaveResponses.containsKey(param.thisObject)) param.result = false
        }.also {
            if (!it) Log.w(TAG, "  SaveTrackPostResponse.isSuccess hook unavailable")
        }
    }

    /**
     * Stock continues to own the live feature-flag read and whether narration
     * occurs. This hook only fixes the obsolete provider label after a covered
     * stock handler has already chosen its exact fallback sentence.
     *
     * §19.2 Music hardening: pin to the exact single-String speak overload and
     * a known literal rewrite rather than hookAllMethods on NarratorAccess.speak.
     */
    private fun installMusicInterstitialNarrationHook() {
        runCatching {
            val narratorAccess = cl.loadClass("humane.system.NarratorAccess")
            val ok = HookUtils.hookMethodBefore(
                narratorAccess,
                "speak",
                arrayOf(String::class.java),
            ) { param ->
                val original = param.args.getOrNull(0) as? String ?: return@hookMethodBefore
                val corrected = rewriteMusicInterstitialNarration(original)
                if (corrected != original) param.args[0] = corrected
            }
            check(ok) { "NarratorAccess.speak(String) was not found" }
            Log.w(TAG, "  Removed obsolete provider labels from stock music interstitials")
        }.onFailure {
            Log.w(
                TAG,
                "  Music interstitial narration hook unavailable: ${it.javaClass.simpleName}",
            )
        }
    }

    private fun buildMediaItem(track: SpotifyMusicContract.Track): Any {
        buildStockTrack(track)?.let { stock ->
            spotifyItems[stock] = track.state()
            return stock
        }

        var collectionIndex = 0
        var shuffleIndex = 0
        val proxy = Proxy.newProxyInstance(
            mediaItemClass.classLoader,
            arrayOf(mediaItemClass),
            InvocationHandler { self, method, args ->
                when (method.name) {
                    "getId" -> track.id
                    "getTitle", "getDisplayTitle", "logString" -> track.title
                    "getArtistNames" -> track.artists
                    "getAlbumName" -> track.album
                    "getDuration" -> durationSeconds(track.durationMs)
                    "getDurationMillis" -> track.durationMs
                    "getTrackNumber" -> track.trackNumber
                    "getVolumeNumber" -> if (track.discNumber > 0) {
                        Optional.of(track.discNumber)
                    } else {
                        Optional.empty<Int>()
                    }
                    "explicit" -> track.explicit
                    "getAudioQuality", "getVersion" -> Optional.empty<Any>()
                    "collectionIndex" -> collectionIndex
                    "setCollectionIndex" -> {
                        collectionIndex = (args?.getOrNull(0) as? Number)?.toInt() ?: 0
                        null
                    }
                    "shuffleIndex" -> shuffleIndex
                    "setShuffleIndex" -> {
                        shuffleIndex = (args?.getOrNull(0) as? Number)?.toInt() ?: 0
                        null
                    }
                    "emitNotableEvent" -> null
                    "shareableURL" -> providerShareUrl(track.id)
                    "hashCode" -> System.identityHashCode(self)
                    "equals" -> self === args?.getOrNull(0)
                    "toString" -> "SpotifyMediaItem(${track.title})"
                    else -> defaultValue(method.returnType)
                }
            },
        )
        spotifyItems[proxy] = track.state()
        return proxy
    }

    /** Prefer a genuine stock Track so all downstream stock type checks keep working. */
    private fun buildStockTrack(track: SpotifyMusicContract.Track): Any? {
        val trackClass = stockTrackClass ?: return null
        val targetGson = gson ?: return null
        val fromJson = gsonFromJson ?: return null
        return try {
            val artists = JSONArray()
            track.artists.forEachIndexed { index, name ->
                artists.put(
                    JSONObject()
                        .put("id", "spotify-artist-$index-${name.hashCode()}")
                        .put("name", name)
                        .put("type", "MAIN"),
                )
            }
            val albumArtist = if (artists.length() > 0) artists.getJSONObject(0) else JSONObject()
            val seconds = durationSeconds(track.durationMs)
            val json = JSONObject()
                .put("id", track.id)
                .put("title", track.title)
                .put("duration", seconds)
                .put("trackNumber", track.trackNumber)
                .put("volumeNumber", track.discNumber)
                .put("version", "")
                .put("explicit", track.explicit)
                .put("audioQuality", "HIGH")
                .put("allowStreaming", true)
                .put("streamReady", true)
                .put("url", providerShareUrl(track.id))
                .put("isrc", "")
                .put("artist", albumArtist)
                .put("artists", artists)
                .put(
                    "album",
                    JSONObject()
                        .put("id", "spotify-album-${track.album.hashCode()}")
                        .put("title", track.album)
                        .put("cover", "")
                        .put("vibrantColor", "")
                        .put("url", "")
                        .put("artist", albumArtist)
                        .put("artists", artists),
                )
            val result = fromJson.invoke(targetGson, json.toString(), trackClass) ?: return null
            if (!trackClass.isInstance(result)) return null
            if (callInterface(result, "getId") != track.id) return null
            if (callInterface(result, "getTitle") != track.title) return null
            @Suppress("UNCHECKED_CAST")
            val names = callInterface(result, "getArtistNames") as? List<*>
            if (names.isNullOrEmpty()) return null
            result
        } catch (error: Throwable) {
            if (!gsonFallbackLogged) {
                gsonFallbackLogged = true
                Log.w(
                    TAG,
                    "  Stock Track mapping unavailable; using MediaItem proxies: " +
                        error.javaClass.simpleName,
                )
            }
            null
        }
    }

    private fun buildPlaybackInfo(url: String): Any = Proxy.newProxyInstance(
        playbackInfoClass.classLoader,
        arrayOf(playbackInfoClass),
        InvocationHandler { proxy, method, args ->
            when (method.name) {
                "playbackUri" -> url
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.getOrNull(0)
                "toString" -> "MusicPlaybackInfo(loopback)"
                else -> defaultValue(method.returnType)
            }
        },
    )

    private fun SpotifyMusicContract.Track.state() = SpotifyItemState(
        id = id,
        durationMs = durationMs,
        title = title,
        artists = artists.toList(),
    )

    private fun durationSeconds(durationMs: Long): Int =
        if (durationMs <= 0L) {
            0
        } else {
            ((durationMs + 999L) / 1_000L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        }

    private fun providerShareUrl(id: String): String {
        val normalized = normalizeSpotifyId(id)
        val separator = normalized.indexOf(':')
        val candidate = if (separator > 0) normalized.substring(0, separator) else ""
        val provider = candidate.takeIf { it in setOf("youtube_music", "tidal", "apple_music") }
            ?: "spotify"
        val providerId = if (provider == "spotify") normalized else normalized.substring(separator + 1)
        val encoded = URLEncoder.encode(providerId, "UTF-8").replace("+", "%20")
        return when (provider) {
            "youtube_music" -> "https://music.youtube.com/watch?v=$encoded"
            "tidal" -> "https://listen.tidal.com/track/$encoded"
            "apple_music" -> "https://music.apple.com/song/$encoded"
            else -> "https://open.spotify.com/track/$encoded"
        }
    }

    private fun normalizeSpotifyId(value: String): String {
        val trimmed = value.trim()
        if (trimmed.startsWith("spotify:track:")) return trimmed.removePrefix("spotify:track:")
        if (trimmed.startsWith("https://open.spotify.com/track/")) {
            return trimmed.removePrefix("https://open.spotify.com/track/")
                .substringBefore('?')
                .substringBefore('/')
        }
        return trimmed
    }

    private fun callNoArg(receiver: Any, name: String): Any? =
        receiver.javaClass.getMethod(name).invoke(receiver)

    private fun callInterface(receiver: Any, name: String): Any? {
        val method = mediaItemClass.methods.firstOrNull {
            it.name == name && it.parameterTypes.isEmpty()
        } ?: receiver.javaClass.methods.firstOrNull {
            it.name == name && it.parameterTypes.isEmpty()
        } ?: throw NoSuchMethodException(name)
        return method.invoke(receiver)
    }

    // ---- UID-authenticated Binder bridge ----

    private class BackendStatusException(val status: Int) : IOException("HTTP $status")

    private fun postJson(endpoint: String, body: String): String {
        val transaction = when (endpoint) {
            SpotifyMusicContract.QUERY_URL -> TRANSACTION_QUERY
            SpotifyMusicContract.PLAYBACK_URL -> TRANSACTION_PLAYBACK
            SpotifyMusicContract.SAVE_URL -> TRANSACTION_SAVE
            else -> throw IOException("Unsupported Spotify bridge endpoint")
        }
        require(body.toByteArray(Charsets.UTF_8).size <= 32 * 1024) {
            "Spotify bridge request is too large"
        }

        val context = currentApplication()
            ?: throw IOException("Spotify bridge context is unavailable")
        val connected = CountDownLatch(1)
        var remote: IBinder? = null
        var disconnected = false
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                remote = service
                connected.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                disconnected = true
                connected.countDown()
            }

            override fun onNullBinding(name: ComponentName?) {
                disconnected = true
                connected.countDown()
            }
        }
        var bound = false
        try {
            val intent = Intent().setComponent(ComponentName(BRIDGE_PACKAGE, BRIDGE_CLASS))
            bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
            if (!bound || !connected.await(BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw IOException("Spotify bridge connection timed out")
            }
            val binder = remote
            if (disconnected || binder == null || !binder.isBinderAlive) {
                throw IOException("Spotify bridge is unavailable")
            }

            val data = Parcel.obtain()
            val reply = Parcel.obtain()
            val result = try {
                data.writeInterfaceToken(BRIDGE_DESCRIPTOR)
                data.writeString(body)
                if (!binder.transact(transaction, data, reply, 0)) {
                    throw IOException("Spotify bridge rejected the request")
                }
                reply.readException()
                val status = reply.readInt()
                val response = reply.readString().orEmpty()
                if (response.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                    throw IOException("Spotify bridge response is too large")
                }
                status to response
            } finally {
                data.recycle()
                reply.recycle()
            }
            val (status, response) = result
            if (status !in 200..299) throw BackendStatusException(status)
            return response
        } finally {
            if (bound) runCatching { context.unbindService(connection) }
        }
    }

    private fun currentApplication(): Context? = runCatching {
        Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Context
    }.getOrNull()

    private fun translateBackendFailure(operation: String, original: Throwable): Throwable {
        val error = unwrap(original)
        if (isStockMusicException(error)) return error
        Log.w(TAG, "  Music $operation failed: ${error.javaClass.simpleName}")
        return if (error is BackendStatusException && error.status in setOf(401, 403)) {
            spotifyAuthRequired()
        } else {
            spotifyUnavailable()
        }
    }

    private fun unwrap(error: Throwable): Throwable {
        var current = error
        repeat(4) {
            val next = when (current) {
                is java.lang.reflect.InvocationTargetException -> current.targetException
                else -> current.cause
            }
            if (next == null || next === current) return current
            current = next
        }
        return current
    }

    private fun isStockMusicException(error: Throwable): Boolean =
        error.javaClass.name.startsWith("util.exception.MusicProvider")

    private fun spotifyAuthRequired(): Throwable = stockException(
        "util.exception.MusicProviderTokenNotFoundException",
        AUTH_MESSAGE,
    )

    private fun spotifyUnavailable(): Throwable = stockException(
        "util.exception.MusicProviderStreamingException",
        UNAVAILABLE_MESSAGE,
    )

    private fun stockException(className: String, message: String): Throwable =
        runCatching {
            cl.loadClass(className)
                .getConstructor(String::class.java)
                .newInstance(message) as Throwable
        }.getOrElse { IOException(message) }

    // ---- RxJava through the target classloader ----

    private fun singleFromCallable(callable: Callable<*>): Any =
        singleClass.getMethod("fromCallable", Callable::class.java)
            .invoke(null, callable)!!

    private fun singleSubscribeOnIo(single: Any): Any =
        singleClass.getMethod("subscribeOn", schedulerClass)
            .invoke(single, ioScheduler)!!

    private fun singleObserveOnMain(single: Any): Any =
        singleClass.getMethod("observeOn", schedulerClass)
            .invoke(single, mainScheduler)!!

    private fun ioThenMain(callable: Callable<*>): Any =
        singleObserveOnMain(singleSubscribeOnIo(singleFromCallable(callable)))

    private fun defaultValue(type: Class<*>): Any? = when (type) {
        java.lang.Boolean.TYPE -> false
        java.lang.Byte.TYPE -> 0.toByte()
        java.lang.Short.TYPE -> 0.toShort()
        java.lang.Character.TYPE -> '\u0000'
        java.lang.Integer.TYPE -> 0
        java.lang.Long.TYPE -> 0L
        java.lang.Float.TYPE -> 0f
        java.lang.Double.TYPE -> 0.0
        else -> null
    }
}
