package com.penumbraos.server

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.util.Log
import java.net.URL
import java.security.KeyStore
import java.security.Signature
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reports the small, non-secret status projection used by restored .Center.
 *
 * This is a Penumbra addition, not a recovered Humane API. Reports are signed by
 * the existing non-exportable DeviceAttestation key, so the backend can bind the
 * snapshot to the paired Pin without embedding another bearer secret. Wi-Fi
 * passwords are never read or transmitted.
 */
internal class DeviceStatusReporter(private val context: Context) {
    companion object {
        private const val TAG = "DeviceStatusReporter"
        private const val SUCCESS_INTERVAL_MS = 5 * 60 * 1000L
        private const val RETRY_INTERVAL_MS = 60 * 1000L
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 10_000
    }

    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var stopped = false
    @Volatile private var inFlight = false

    private val tick = object : Runnable {
        override fun run() {
            if (stopped || inFlight) return
            val endpoint = configuredEndpoint() ?: return
            inFlight = true
            Thread({
                val succeeded = runCatching { reportOnce(endpoint) }
                    .onFailure { Log.w(TAG, "Status report failed (${it.javaClass.simpleName})") }
                    .getOrDefault(false)
                inFlight = false
                if (!stopped && configuredEndpoint() != null) {
                    handler.postDelayed(this, if (succeeded) SUCCESS_INTERVAL_MS else RETRY_INTERVAL_MS)
                }
            }, "penumbra-device-status").start()
        }
    }

    fun start() {
        stopped = false
        handler.removeCallbacks(tick)
        if (configuredEndpoint() != null) handler.post(tick)
    }

    fun reportSoon() {
        if (stopped || configuredEndpoint() == null) return
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, 2_000)
    }

    fun stop() {
        stopped = true
        handler.removeCallbacks(tick)
    }

    private fun reportOnce(endpoint: String): Boolean {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey(CosmosIdentityProvider.KEY_ALIAS, null) ?: return false
        val certificate = store.getCertificate(CosmosIdentityProvider.KEY_ALIAS) as? X509Certificate
            ?: return false
        val payload = buildPayload().toString()
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(key as java.security.PrivateKey)
            update(payload.toByteArray(Charsets.UTF_8))
            sign()
        }
        val body = JSONObject()
            .put("payload", payload)
            .put("certificate_der", Base64.encodeToString(certificate.encoded, Base64.NO_WRAP))
            .put("signature_der", Base64.encodeToString(signature, Base64.NO_WRAP))
            .toString()

        val connection = (URL(endpoint).openConnection() as HttpsURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            doOutput = true
            setFixedLengthStreamingMode(body.toByteArray(Charsets.UTF_8).size)
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("User-Agent", "PenumbraOS-DeviceStatus/1")
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            connection.responseCode in 200..299
        } finally {
            connection.disconnect()
        }
    }

    private fun buildPayload(): JSONObject {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val percent = if (level >= 0 && scale > 0) (level * 100 / scale).coerceIn(0, 100) else 0
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL

        return JSONObject()
            .put("device_id", readSystemProperty("ro.boot.deviceid").lowercase())
            .put("serial_number", serialNumber())
            .put("firmware_version", readSystemProperty("ro.build.version.incremental"))
            .put("os_version", "Android ${Build.VERSION.RELEASE} (${Build.ID})")
            .put("battery_percent", percent)
            .put("battery_charging", charging)
            .put("reported_at_epoch", System.currentTimeMillis() / 1000L)
            .put("wifi_networks", wifiNetworks())
    }

    @Suppress("DEPRECATION")
    private fun wifiNetworks(): JSONArray {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val connectedSsid = unquote(wifi.connectionInfo?.ssid.orEmpty())
        val result = JSONArray()
        val seen = linkedSetOf<String>()
        for (network in wifi.configuredNetworks.orEmpty()) {
            val ssid = unquote(network.SSID.orEmpty())
            if (ssid.isBlank() || !seen.add(ssid)) continue
            result.put(
                JSONObject()
                    .put("ssid", ssid)
                    .put("authorization_type", authorizationType(network))
                    .put("connected", ssid == connectedSsid),
            )
        }
        if (connectedSsid.isNotBlank() && seen.add(connectedSsid)) {
            result.put(
                JSONObject()
                    .put("ssid", connectedSsid)
                    .put("authorization_type", "Unknown")
                    .put("connected", true),
            )
        }
        return result
    }

    @Suppress("DEPRECATION")
    private fun authorizationType(network: WifiConfiguration): String = when {
        network.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.SAE) -> "WPA3 Personal"
        network.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.WPA_PSK) -> "WPA/WPA2 Personal"
        network.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.WPA_EAP) ||
            network.allowedKeyManagement.get(WifiConfiguration.KeyMgmt.IEEE8021X) -> "Enterprise"
        network.wepKeys?.any { !it.isNullOrBlank() } == true -> "WEP"
        else -> "Open"
    }

    private fun unquote(value: String): String =
        value.removePrefix("\"").removeSuffix("\"").takeUnless { it == "<unknown ssid>" }.orEmpty()

    private fun serialNumber(): String {
        val property = readSystemProperty("ro.serialno")
            .ifBlank { readSystemProperty("ro.boot.serialno") }
        if (property.isNotBlank()) return property
        return runCatching { Build.getSerial() }.getOrDefault("")
    }

    private fun configuredEndpoint(): String? {
        if (Settings.Global.getString(
                context.contentResolver,
                CosmosActivationContract.REMOTE_MODE_SETTING,
            ) != "1"
        ) return null
        val stored = Settings.Global.getString(
            context.contentResolver,
            CosmosActivationContract.DEVICE_STATUS_ENDPOINT_SETTING,
        ) ?: return null
        return runCatching { CosmosActivationContract.canonicalDeviceStatusEndpoint(stored) }
            .getOrNull()
    }

    private fun readSystemProperty(name: String): String =
        Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java)
            .invoke(null, name) as? String ?: ""
}
