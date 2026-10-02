package com.penumbraos.server

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Parcelable
import android.telephony.TelephonyManager
import com.penumbraos.stockaibus.contract.StockSymbols
import com.penumbraos.stockaibus.contract.TierASymbols
import org.json.JSONObject
import java.util.UUID

/**
 * Routes a deliberately small, authenticated test surface through Humane's
 * stock foreground experiences. The target package supplies the Parcelable
 * class, so its wire shape stays identical to the installed stock build.
 */
object DeviceActionDispatcher {
    internal const val MESSAGES_PACKAGE = TierASymbols.Packages.MESSAGES
    internal const val DIALER_PACKAGE = TierASymbols.Packages.DIALER
    internal const val PHOTOGRAPHY_PACKAGE = TierASymbols.Packages.PHOTOGRAPHY
    internal const val MUSIC_PACKAGE = TierASymbols.Packages.MUSIC
    internal const val TICKLE_PACKAGE = TierASymbols.Packages.TICKLE
    internal const val EXPERIENCE_ACTIVITY =
        StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY
    internal const val DIALER_ACTIVITY = TierASymbols.Packages.DIALER + ".DialerActivity"
    internal const val PHOTOGRAPHY_ACTIVITY = "system.PhotographyExperienceActivity"
    internal const val ACTION_INTENT = "humane.intent.action.ACTION"
    internal const val ACTION_EXTRA = "a"
    internal const val MAX_MESSAGE_CHARS = 480
    internal const val MAX_MUSIC_TEXT_CHARS = 200
    internal const val EMERGENCY_CLASSIFICATION_ACTION = "classify_emergency"
    internal const val MAX_MESSAGE_STATUS_LOOKBACK_MS = 10 * 60 * 1_000L
    internal const val MAX_MESSAGE_STATUS_FUTURE_SKEW_MS = 5_000L

    private const val MESSAGING_ACTIONS = "humaneinternal.system.intent.actions.messaging."
    private const val TELEPHONY_ACTIONS = "humaneinternal.system.intent.actions.telephony."
    private const val PHOTOGRAPHY_ACTIONS = "humaneinternal.system.intent.actions.photography."
    private const val MEDIA_ACTIONS = "humaneinternal.system.intent.actions.media."
    private const val TICKLE_ACTIONS = "humaneinternal.system.intent.actions.tickle."

    private const val COMPOSE_MESSAGE_CLASS =
        MESSAGING_ACTIONS + TierASymbols.NativeActions.COMPOSE_MESSAGE + "Action"
    private const val CONFIRM_MESSAGE_CLASS =
        MESSAGING_ACTIONS + TierASymbols.NativeActions.CONFIRM_SEND_MESSAGE + "Action"
    private const val CANCEL_MESSAGE_CLASS =
        MESSAGING_ACTIONS + TierASymbols.NativeActions.CANCEL_SEND_MESSAGE + "Action"
    private const val CALL_PERSON_CLASS =
        TELEPHONY_ACTIONS + TierASymbols.NativeActions.CALL_PERSON + "Action"
    private const val END_CALL_CLASS =
        TELEPHONY_ACTIONS + TierASymbols.NativeActions.END_CALL + "Action"
    private const val CAPTURE_PHOTO_CLASS =
        PHOTOGRAPHY_ACTIONS + TierASymbols.NativeActions.CAPTURE_PHOTOGRAPH + "Action"
    private const val CAPTURE_VIDEO_CLASS =
        PHOTOGRAPHY_ACTIONS + TierASymbols.NativeActions.CAPTURE_VIDEO + "Action"
    private const val STOP_VIDEO_CLASS =
        PHOTOGRAPHY_ACTIONS + TierASymbols.NativeActions.STOP_VIDEO + "Action"
    private const val PLAY_MUSIC_CLASS =
        MEDIA_ACTIONS + TierASymbols.NativeActions.PLAY_MUSIC + "Action"
    private const val TICKLE_ACTION_CLASS =
        TICKLE_ACTIONS + TierASymbols.NativeActions.TICKLE + "Action"

    internal enum class StockAction(
        val wireName: String,
        val targetPackage: String,
        val targetActivity: String,
        val actionClass: String,
    ) {
        COMPOSE_MESSAGE(
            "compose_message",
            MESSAGES_PACKAGE,
            EXPERIENCE_ACTIVITY,
            COMPOSE_MESSAGE_CLASS,
        ),
        CONFIRM_MESSAGE(
            "confirm_message",
            MESSAGES_PACKAGE,
            EXPERIENCE_ACTIVITY,
            CONFIRM_MESSAGE_CLASS,
        ),
        CANCEL_MESSAGE(
            "cancel_message",
            MESSAGES_PACKAGE,
            EXPERIENCE_ACTIVITY,
            CANCEL_MESSAGE_CLASS,
        ),
        CALL_PERSON(
            "call_person",
            DIALER_PACKAGE,
            DIALER_ACTIVITY,
            CALL_PERSON_CLASS,
        ),
        END_CALL(
            "end_call",
            DIALER_PACKAGE,
            DIALER_ACTIVITY,
            END_CALL_CLASS,
        ),
        CAPTURE_PHOTO(
            "capture_photo",
            PHOTOGRAPHY_PACKAGE,
            PHOTOGRAPHY_ACTIVITY,
            CAPTURE_PHOTO_CLASS,
        ),
        CAPTURE_VIDEO(
            "capture_video",
            PHOTOGRAPHY_PACKAGE,
            PHOTOGRAPHY_ACTIVITY,
            CAPTURE_VIDEO_CLASS,
        ),
        STOP_VIDEO(
            "stop_video",
            PHOTOGRAPHY_PACKAGE,
            PHOTOGRAPHY_ACTIVITY,
            STOP_VIDEO_CLASS,
        ),
        PLAY_MUSIC(
            "play_music",
            MUSIC_PACKAGE,
            EXPERIENCE_ACTIVITY,
            PLAY_MUSIC_CLASS,
        ),
        TICKLE(
            "tickle",
            TICKLE_PACKAGE,
            EXPERIENCE_ACTIVITY,
            TICKLE_ACTION_CLASS,
        );

        companion object {
            fun fromWireName(value: String): StockAction? =
                entries.firstOrNull { it.wireName == value }
        }
    }

    fun dispatch(context: Context, actionName: String, payload: JSONObject): JSONObject {
        if (actionName == EMERGENCY_CLASSIFICATION_ACTION) {
            return classifyEmergencyNumber(context, payload)
        }
        val action = StockAction.fromWireName(actionName)
            ?: throw IllegalArgumentException("Unsupported stock action")
        if (action == StockAction.CALL_PERSON) {
            val recipient = payload.optString("recipient").takeIf { it.isNotEmpty() }
                ?: throw IllegalArgumentException("recipient is required")
            requireValidRecipient(recipient)
            requireNonEmergencyRecipient(context, recipient)
        }
        if (action == StockAction.PLAY_MUSIC) {
            requireValidMusicText(payload.optString("track"), "track")
            payload.optString("artist").takeIf(String::isNotEmpty)?.let { artist ->
                requireValidMusicText(artist, "artist")
            }
        }
        val actionId = UUID.randomUUID()
        val parcelable = instantiateAction(context, action, actionId, payload)

        val component = ComponentName(action.targetPackage, action.targetActivity)
        val intent = Intent.makeMainActivity(component).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
            setAction(ACTION_INTENT)
            putExtra(ACTION_EXTRA, parcelable)
        }
        context.startActivity(intent)

        return JSONObject()
            .put("accepted", true)
            .put("action", action.wireName)
            .put("action_id", actionId.toString())
    }

    fun stockMessageStatus(
        _context: Context,
        recipient: String,
        body: String,
        afterMs: Long,
        nowMs: Long = System.currentTimeMillis(),
    ): JSONObject {
        requireValidRecipient(recipient)
        requireValidMessage(body)
        requireValidMessageStatusWindow(afterMs, nowMs)
        // Retain the Context parameter as part of the stable bridge request
        // surface, but never use it to cross the Messages SELinux boundary.
        val record = MessageStatusRepository.status(body, recipient, afterMs, nowMs)
        if (record == null) {
            return JSONObject()
                .put("found", false)
                .put("recipient_matched", false)
        }
        return JSONObject()
            .put("found", true)
            .put("recipient_matched", true)
            .put("message_id", record.messageId)
            .put("timestamp_ms", record.timestampMs)
            .put("state", messageStateName(record.state))
            .put("stock_sent_callback_completed", record.state == 2L)
    }

    internal fun requireValidRecipient(recipient: String) {
        require(recipient.matches(Regex("^\\+[1-9][0-9]{7,14}$"))) {
            "recipient must be an E.164 phone number"
        }
    }

    internal fun requireValidMessage(message: String) {
        require(message.isNotBlank()) { "message must not be blank" }
        require(message.length <= MAX_MESSAGE_CHARS) {
            "message exceeds $MAX_MESSAGE_CHARS characters"
        }
    }

    internal fun requireValidMusicText(value: String, field: String) {
        require(value.isNotBlank()) { "$field must not be blank" }
        require(value.length <= MAX_MUSIC_TEXT_CHARS) {
            "$field exceeds $MAX_MUSIC_TEXT_CHARS characters"
        }
        require(value.none(Char::isISOControl)) { "$field contains control characters" }
    }

    internal fun requireValidMessageStatusWindow(afterMs: Long, nowMs: Long) {
        require(afterMs > 0L) { "after_ms must be positive" }
        require(afterMs <= nowMs + MAX_MESSAGE_STATUS_FUTURE_SKEW_MS) {
            "after_ms is too far in the future"
        }
        require(nowMs - afterMs <= MAX_MESSAGE_STATUS_LOOKBACK_MS) {
            "after_ms is older than the allowed status window"
        }
    }

    internal fun requireNonEmergencyRecipient(context: Context, recipient: String) {
        require(!isEmergencyNumber(context, recipient)) {
            "Emergency calls are not available through diagnostics"
        }
    }

    private fun classifyEmergencyNumber(context: Context, payload: JSONObject): JSONObject {
        val number = payload.optString("number").takeIf { value ->
            value.length in 2..8 && value.all(Char::isDigit)
        } ?: throw IllegalArgumentException("number must contain 2 to 8 digits")
        return JSONObject()
            .put("accepted", true)
            .put("action", EMERGENCY_CLASSIFICATION_ACTION)
            .put("dry_run", true)
            .put("is_emergency", isEmergencyNumber(context, number))
    }

    private fun isEmergencyNumber(context: Context, number: String): Boolean {
        val telephony = context.getSystemService(TelephonyManager::class.java)
            ?: throw IllegalStateException("Telephony service is unavailable")
        return try {
            telephony.isEmergencyNumber(number)
        } catch (failure: Throwable) {
            throw IllegalStateException("Emergency-number classification failed", failure)
        }
    }

    internal fun messageStateName(state: Long): String = when (state) {
        0L -> "unknown"
        1L -> "pending"
        2L -> "delivered_to_carrier"
        3L -> "unread"
        4L -> "read"
        5L -> "error"
        else -> "unknown"
    }

    private fun instantiateAction(
        context: Context,
        action: StockAction,
        actionId: UUID,
        payload: JSONObject,
    ): Parcelable {
        val packageContext = context.createPackageContext(
            action.targetPackage,
            Context.CONTEXT_INCLUDE_CODE or Context.CONTEXT_IGNORE_SECURITY,
        )
        val actionClass = packageContext.classLoader.loadClass(action.actionClass)

        val instance = when (action) {
            StockAction.COMPOSE_MESSAGE -> {
                val recipient = payload.optString("recipient").takeIf { it.isNotEmpty() }
                    ?: throw IllegalArgumentException("recipient is required")
                val message = payload.optString("message").takeIf { it.isNotEmpty() }
                    ?: throw IllegalArgumentException("message is required")
                requireValidRecipient(recipient)
                requireValidMessage(message)
                actionClass
                    .getConstructor(UUID::class.java, String::class.java, String::class.java)
                    .newInstance(actionId, recipient, message)
            }

            StockAction.CALL_PERSON -> {
                val recipient = payload.getString("recipient")
                actionClass
                    .getConstructor(UUID::class.java, String::class.java)
                    .newInstance(actionId, recipient)
            }

            StockAction.PLAY_MUSIC -> {
                val track = payload.getString("track")
                val artist = payload.optString("artist").takeIf(String::isNotEmpty)
                requireValidMusicText(track, "track")
                artist?.let { requireValidMusicText(it, "artist") }
                if (artist == null) {
                    actionClass
                        .getMethod("createWithTrack", UUID::class.java, String::class.java)
                        .invoke(null, actionId, track)
                } else {
                    actionClass
                        .getMethod(
                            "createWithTrackAndArtist",
                            UUID::class.java,
                            String::class.java,
                            String::class.java,
                        )
                        .invoke(null, actionId, track, artist)
                }
            }

            StockAction.CONFIRM_MESSAGE,
            StockAction.CANCEL_MESSAGE,
            StockAction.END_CALL,
            StockAction.CAPTURE_PHOTO,
            StockAction.CAPTURE_VIDEO,
            StockAction.STOP_VIDEO,
            StockAction.TICKLE,
            -> actionClass
                .getConstructor(UUID::class.java)
                .newInstance(actionId)
        }

        return instance as? Parcelable
            ?: throw IllegalStateException("Stock action is not Parcelable")
    }

}
