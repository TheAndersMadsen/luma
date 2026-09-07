package dk.andersmadsen.cosmos.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Keeps the process in the foreground tier while the owner wants the room
 * joined, so the connection survives the screen turning off. The service owns
 * only its quiet notification; the connection itself lives in the application.
 */
class SessionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watching: Job? = null
    private var watchingForeground: Job? = null
    private val manager get() = getSystemService(NotificationManager::class.java)
    private val controller get() = (application as CosmosApplication).controller
    /**
     * On a television the room is joined over whatever is playing, so this
     * service also holds the window that draws there. It exists exactly as long
     * as the connection does, which is exactly as long as anything could arrive.
     */
    private var overlay: TvOverlayWindow? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.session_channel), NotificationManager.IMPORTANCE_LOW).apply {
            description = getString(R.string.session_channel_body)
            setShowBadge(false)
        })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android 14+ requires the declared special-use type; earlier releases take the manifest's.
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(controller.state.value.sessionStatus(), false), type)
        if (!controller.state.value.connectionWanted) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (overlay == null && controller.platform == "android_tv") {
            overlay = TvOverlayWindow(this).also(TvOverlayWindow::open)
        }
        if (watching == null) watching = scope.launch {
            controller.state.map { it.sessionStatus() to it.awaitsForeground() }.distinctUntilChanged()
                .collect { (status, waiting) -> manager.notify(NOTIFICATION_ID, notification(status, waiting)) }
        }
        // Returning from the television's settings is the moment the owner's grant
        // can have changed, and this app's own screen coming back is when it hears.
        if (watchingForeground == null) watchingForeground = scope.launch {
            controller.appForeground.collect { overlay?.refresh() }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        overlay?.close()
        overlay = null
        scope.cancel()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    /**
     * [waiting] means a private card is held for this device: the text says only
     * that something is ready (never what), and opening the app receives it.
     */
    private fun notification(status: SessionStatus, waiting: Boolean): Notification {
        // Reuses the running task so the tap lands on the screen already holding the reply.
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val disconnect = PendingIntent.getBroadcast(this, 1,
            Intent(this, DisconnectReceiver::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF27E6DF.toInt())
            .setContentTitle(getString(R.string.app_name))
            // Never the reply itself, and never who or what it is about: one sentence and a way in.
            .setContentText(getString(when {
                waiting -> R.string.notification_waiting
                status == SessionStatus.CONNECTED -> R.string.notification_connected
                status == SessionStatus.RECONNECTING -> R.string.notification_reconnecting
                else -> R.string.notification_disconnected
            }))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, getString(R.string.session_disconnect), disconnect)
            .build()
    }

    /** The notification's Disconnect action; a receiver needs no foreground-start allowance. */
    class DisconnectReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == ACTION_DISCONNECT) (context.applicationContext as CosmosApplication).controller.disconnect()
        }
    }

    companion object {
        private const val TAG = "Cosmos"
        private const val CHANNEL = "session"
        private const val NOTIFICATION_ID = 1
        const val ACTION_DISCONNECT = "dk.andersmadsen.cosmos.android.DISCONNECT"

        /** Starts the service when a connection becomes wanted and stops it when it no longer is. */
        fun setWanted(context: Context, wanted: Boolean) {
            val intent = Intent(context, SessionService::class.java)
            if (!wanted) {
                context.stopService(intent)
                return
            }
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (error: IllegalStateException) {
                // Only a background start is refused; the connection still runs while the app is open.
                Log.w(TAG, "session service could not start", error)
            } catch (error: SecurityException) {
                Log.w(TAG, "session service could not start", error)
            }
        }
    }
}
