package com.penumbraos.server

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.net.Inet4Address
import java.net.InetAddress

class ServerService : Service() {

    companion object {
        private const val TAG = "PenumbraServer"
        private const val CHANNEL_ID = "penumbra_server"
        private const val CHANNEL_NAME = "Luma Device Services"
        private const val NOTIFICATION_ID = 1001
        private const val MULTICAST_LOCK_TAG = "penumbra-jmdns"

        fun start(context: Context) {
            val intent = Intent(context, ServerService::class.java)
            context.startForegroundService(intent)
        }
    }

    private lateinit var advertiser: JmDnsAdvertiser
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var esimBridgeToken: String
    private lateinit var deviceStatusReporter: DeviceStatusReporter
    private var settingsGlobalBridgeReady = false
    private var multicastLock: WifiManager.MulticastLock? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val wifiAddresses = mutableMapOf<Network, InetAddress?>()

    @Volatile
    private var runtimeRunning = false

    private val wifiCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            mainHandler.post { updateWifiNetwork(network, null) }
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            mainHandler.post { updateWifiNetwork(network, linkProperties) }
        }

        override fun onLost(network: Network) {
            mainHandler.post {
                wifiAddresses.remove(network)
                refreshAdvertisement()
            }
        }
    }

    @Volatile
    private var advertisedConfig: BootstrapConfig.AdvertisedConfig? = null

    override fun onCreate() {
        super.onCreate()
        // Package Manager can recreate this package's CE directory before the
        // injected runtime seInfo override is restored. Recover the last
        // committed system-owned snapshot before reading any private token or
        // configuration.
        PersistentConfigVaultClient.restoreIfAvailable(applicationContext)
        runCatching { runFitnessHistoryRetentionMaintenance(filesDir) }
            .onFailure { Log.w(TAG, "Fitness history startup retention failed", it) }
        createNotificationChannel()
        startForegroundCompat()

        acquireMulticastLock()
        esimBridgeToken = EsimBridgeAuthentication.ensureToken(applicationContext.filesDir)
        // A service instance can be recreated while this process remains alive.
        // Keep the bridge unavailable until onStartCommand validates the current
        // canonical server endpoint.
        SpotifyBridgeRuntime.clear()
        EsimSocketServer.start(esimBridgeToken)
        EsimBridgeServer.start(applicationContext, esimBridgeToken)
        settingsGlobalBridgeReady =
            SettingsGlobalBridgeServer.start(applicationContext, esimBridgeToken)

        advertiser = JmDnsAdvertiser()
        connectivityManager =
            applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        deviceStatusReporter = DeviceStatusReporter(applicationContext)
        registerWifiCallback()

        ServerRuntime.setStateListener { running ->
            mainHandler.post {
                runtimeRunning = running
                refreshAdvertisement()
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            // The native child carries the Settings.Global capability. Never
            // launch it unless this exact Java process already owns the fixed
            // loopback listener. A pre-bound local imposter can cause only a
            // fail-closed startup error, not receive the reusable capability.
            settingsGlobalBridgeReady = settingsGlobalBridgeReady ||
                SettingsGlobalBridgeServer.start(applicationContext, esimBridgeToken)
            check(settingsGlobalBridgeReady && SettingsGlobalBridgeServer.isReady()) {
                "authenticated Settings.Global bridge is unavailable"
            }
            val configPath = BootstrapConfig.ensureCanonicalConfig(applicationContext)
            val httpPort = BootstrapConfig.readEffectiveHttpPort(configPath)
            // Seed the vault on first install and make completed Android-side
            // migrations durable before the native runtime is exposed.
            PersistentConfigVaultClient.commit(applicationContext)
            advertisedConfig = BootstrapConfig.readAdvertisedConfig(configPath)
            CenterUsbBridge.start(configPath)
            SpotifyBridgeRuntime.configure(esimBridgeToken, httpPort)
            ServerRuntime.start(applicationContext, configPath, esimBridgeToken)
            deviceStatusReporter.start()
            updateNotification("On-device server running")
        } catch (t: Throwable) {
            SpotifyBridgeRuntime.clear()
            CenterUsbBridge.stop()
            try {
                ServerRuntime.stop()
            } catch (_: Throwable) {
            }
            Log.e(TAG, "Failed to start server runtime", t)
            updateNotification("On-device server failed to start")
        }
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            connectivityManager.unregisterNetworkCallback(wifiCallback)
        } catch (_: Throwable) {
        }
        wifiAddresses.clear()
        deviceStatusReporter.stop()
        runtimeRunning = false
        try {
            advertiser.stop()
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to stop advertiser", t)
        }
        try {
            ServerRuntime.setStateListener(null)
            ServerRuntime.stop()
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to stop runtime cleanly", t)
        }
        CenterUsbBridge.stop()
        EsimBridgeServer.stop()
        SettingsGlobalBridgeServer.stop()
        EsimSocketServer.stop()
        SpotifyBridgeRuntime.clear()
        releaseMulticastLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerWifiCallback() {
        try {
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build()
            connectivityManager.registerNetworkCallback(request, wifiCallback)
        } catch (_: Throwable) {
            Log.w(TAG, "Failed to monitor Wi-Fi for dashboard discovery")
        }
    }

    private fun updateWifiNetwork(network: Network, supplied: LinkProperties?) {
        val linkProperties = supplied ?: connectivityManager.getLinkProperties(network)
        wifiAddresses[network] = linkProperties?.linkAddresses
            ?.asSequence()
            ?.map { it.address }
            ?.filterIsInstance<Inet4Address>()
            ?.firstOrNull {
                !it.isLoopbackAddress && !it.isLinkLocalAddress && !it.isAnyLocalAddress
            }
        refreshAdvertisement()
        deviceStatusReporter.reportSoon()
    }

    private fun refreshAdvertisement() {
        val config = advertisedConfig
        if (!runtimeRunning || config == null || !config.lanDashboardEnabled) {
            advertiser.stop()
            return
        }

        val activeWifi = wifiAddresses.entries.firstOrNull { it.value != null }
        advertiser.refresh(
            activeWifi?.key,
            activeWifi?.value,
            config.httpPort,
            config.displayName,
        )
    }

    private fun acquireMulticastLock() {
        try {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val lock = wifi.createMulticastLock(MULTICAST_LOCK_TAG).apply {
                setReferenceCounted(false)
                acquire()
            }
            multicastLock = lock
            Log.w(TAG, "Acquired Wi-Fi multicast lock")
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to acquire multicast lock", t)
        }
    }

    private fun releaseMulticastLock() {
        try {
            multicastLock?.let {
                if (it.isHeld) it.release()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to release multicast lock", t)
        }
        multicastLock = null
    }

    private fun startForegroundCompat() {
        startForeground(NOTIFICATION_ID, buildNotification("Starting on-device server"))
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Foreground service for Luma"
            setShowBadge(false)
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Luma Device Services")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }
}
