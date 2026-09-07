package dk.andersmadsen.cosmos.android.action

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * The component the owner enables in the television's settings so this
 * installation may read active media sessions. It exists for that grant and
 * for nothing else: it reads no notification, keeps no state and posts
 * nothing. Without the grant, playback is unobservable here and every play
 * command reports `unknown`, which is the honest answer.
 */
class PlaybackListenerService : NotificationListenerService() {
    override fun onNotificationPosted(notification: StatusBarNotification?) = Unit
    override fun onNotificationRemoved(notification: StatusBarNotification?) = Unit
}
