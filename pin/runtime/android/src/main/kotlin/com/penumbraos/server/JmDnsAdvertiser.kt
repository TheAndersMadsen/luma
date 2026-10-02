package com.penumbraos.server

import android.net.Network
import android.util.Log
import java.net.InetAddress
import java.util.concurrent.Executors
import javax.jmdns.JmDNS
import javax.jmdns.ServiceInfo

/** Advertises the authenticated dashboard on the active Wi-Fi interface. */
class JmDnsAdvertiser {

    companion object {
        private const val TAG = "PenumbraServer"
        private const val SERVICE_TYPE = "_penumbra._tcp.local."
        private const val HOSTNAME = "penumbra"
        private const val VERSION = "1"
    }

    private data class Registration(
        val network: Network,
        val bindAddress: InetAddress,
        val port: Int,
        val displayName: String,
    )

    private val lock = Any()
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "penumbra-jmdns").apply { isDaemon = true }
    }

    @Volatile
    private var jmdns: JmDNS? = null

    @Volatile
    private var serviceInfo: ServiceInfo? = null

    @Volatile
    private var registration: Registration? = null

    /**
     * Re-register whenever Wi-Fi address, dashboard port, or display name
     * changes. A null address withdraws any stale advertisement.
     */
    fun refresh(network: Network?, bindAddress: InetAddress?, port: Int, displayName: String) {
        executor.execute {
            synchronized(lock) {
                val requested = if (network != null && bindAddress != null) {
                    Registration(network, bindAddress, port, displayName)
                } else {
                    null
                }
                if (requested != null && requested == registration && jmdns != null) {
                    return@synchronized
                }

                stopLocked()
                if (requested == null) return@synchronized

                try {
                    val instance = JmDNS.create(requested.bindAddress, HOSTNAME)
                    val info = ServiceInfo.create(
                        SERVICE_TYPE,
                        requested.displayName,
                        requested.port,
                        "path=/ version=$VERSION",
                    )
                    instance.registerService(info)
                    jmdns = instance
                    serviceInfo = info
                    registration = requested
                    Log.w(TAG, "Registered authenticated dashboard mDNS service")
                } catch (_: Throwable) {
                    stopLocked()
                    Log.w(TAG, "Failed to register dashboard mDNS service")
                }
            }
        }
    }

    fun stop() {
        executor.execute {
            synchronized(lock) {
                stopLocked()
            }
        }
    }

    private fun stopLocked() {
        val instance = jmdns
        val info = serviceInfo
        if (instance != null) {
            try {
                if (info != null) instance.unregisterService(info)
            } catch (_: Throwable) {
                Log.w(TAG, "Failed to unregister dashboard mDNS service")
            }
            try {
                instance.close()
            } catch (_: Throwable) {
                Log.w(TAG, "Failed to close dashboard mDNS service")
            }
        }
        jmdns = null
        serviceInfo = null
        registration = null
    }
}
