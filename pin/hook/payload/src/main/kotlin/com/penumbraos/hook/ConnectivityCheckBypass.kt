package com.penumbraos.hook

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log

/**
 * Replace Humane's custom connectivity check with Android's existing network validation state.
 *
 * Humane's [humaneinternal.system.network.NetworkUtils.validateNetworkConnection]
 * does an HTTP GET to `http://connectivity-check.<env>.humane.cloud` and expects
 * a 204. That host is dead, so it always returns FAILURE, which makes
 * [humaneinternal.system.network.NetworkMonitor.getWifiInternetCheckStatus]
 * report not-connected and the home screen show the offline banner even when
 * the device is online.
 *
 * Android already validates networks in the framework and exposes the result via
 * [NetworkCapabilities.NET_CAPABILITY_VALIDATED]. Reuse that state instead of
 * issuing duplicate captive-portal probes from every Humane UI poll.
 */
object ConnectivityCheckBypass {

    private const val TAG = "PenumbraHook"

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var lastLoggedStatus: String? = null

    fun install(cl: ClassLoader) {
        // Keep the exact-host resolver as a fallback for firmware where the
        // NetworkUtils hook seam is absent. Once this bypass is installed,
        // Android's validated network state owns the verdict in every mode.
        CosmosRemoteTransport.installNetworkDnsResolver()
        val networkUtilsClassName = "humaneinternal.system.network.NetworkUtils"
        val networkUtilsClass = try {
            cl.loadClass(networkUtilsClassName)
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $networkUtilsClassName not found, skipping connectivity check bypass")
            return
        }

        val resultEnumClass = try {
            cl.loadClass("$networkUtilsClassName\$NetworkRequestResult")
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $networkUtilsClassName\$NetworkRequestResult not found, skipping")
            return
        }

        // Pre-resolve Humane's NetworkRequestResult enum values once.
        // Later hooks return these literal enum objects based on Android's current capabilities.
        val connectedEnumValue = enumValue(resultEnumClass, "CONNECTED") ?: return
        val failureEnumValue = enumValue(resultEnumClass, "FAILURE") ?: return
        val walledGardenEnumValue = enumValue(resultEnumClass, "WALLED_GARDEN") ?: return

        hookNetworkUtilsContextCapture(networkUtilsClass)
        hookValidateNetworkConnection(networkUtilsClass, connectedEnumValue, failureEnumValue, walledGardenEnumValue)
        hookNetworkMonitor(cl, connectedEnumValue)

        Log.w(TAG, "  Connectivity check now uses Android NetworkCapabilities")
    }

    private fun hookNetworkUtilsContextCapture(networkUtilsClass: Class<*>) {
        HookUtils.hookMethodBefore(
            networkUtilsClass,
            "validateWifiConnection",
            arrayOf(Context::class.java),
        ) { param ->
            captureContext(param.args.getOrNull(0) as? Context, "NetworkUtils.validateWifiConnection")
        }
    }

    private fun hookValidateNetworkConnection(
        networkUtilsClass: Class<*>,
        connectedEnumValue: Enum<*>,
        failureEnumValue: Enum<*>,
        walledGardenEnumValue: Enum<*>,
    ) {
        HookUtils.hookMethodBefore(
            networkUtilsClass,
            "validateNetworkConnection",
            arrayOf(Network::class.java),
        ) { param ->
            val network = param.args[0] as? Network
            param.result = if (network == null) {
                logStatusChange("FAILURE(null network)")
                failureEnumValue
            } else {
                classifyNetwork(network, connectedEnumValue, failureEnumValue, walledGardenEnumValue)
            }
        }
    }

    private fun hookNetworkMonitor(cl: ClassLoader, connectedEnumValue: Enum<*>) {
        val networkMonitorClassName = "humaneinternal.system.network.NetworkMonitor"
        val networkMonitorClass = try {
            cl.loadClass(networkMonitorClassName)
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $networkMonitorClassName not found, skipping NetworkMonitor hooks")
            return
        }

        HookUtils.hookMethodBefore(
            networkMonitorClass,
            "getSharedInstance",
            arrayOf(Context::class.java),
        ) { param ->
            captureContext(param.args.getOrNull(0) as? Context, "NetworkMonitor.getSharedInstance")
        }

        HookUtils.hookMethodAfter(
            networkMonitorClass,
            "getWifiInternetCheckStatus",
            emptyArray(),
        ) { param ->
            if (networkMonitorHasValidatedWifi(param.thisObject)) {
                param.result = connectedEnumValue
                logStatusChange("CONNECTED")
            }
        }
    }

    private fun enumValue(enumClass: Class<*>, name: String): Enum<*>? {
        return try {
            val valueOf = enumClass.getDeclaredMethod("valueOf", String::class.java)
            valueOf.invoke(null, name) as? Enum<*>
        } catch (t: Throwable) {
            Log.e(TAG, "  Could not resolve NetworkRequestResult.$name: ${t.message}")
            null
        }
    }

    private fun classifyNetwork(
        network: Network,
        connectedEnumValue: Enum<*>,
        failureEnumValue: Enum<*>,
        walledGardenEnumValue: Enum<*>,
    ): Enum<*> {
        val connectivityManager = connectivityManager()
        if (connectivityManager == null) {
            logStatusChange("FAILURE(no ConnectivityManager)")
            return failureEnumValue
        }

        val capabilities = runCatching { connectivityManager.getNetworkCapabilities(network) }
            .getOrNull()
            ?: runCatching { connectivityManager.getNetworkCapabilities(connectivityManager.activeNetwork) }
                .getOrNull()
        if (capabilities == null) {
            logStatusChange("FAILURE(no capabilities)")
            return failureEnumValue
        }

        return when {
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> {
                logStatusChange("CONNECTED")
                connectedEnumValue
            }
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL) -> {
                logStatusChange("WALLED_GARDEN")
                walledGardenEnumValue
            }
            else -> {
                logStatusChange("FAILURE(unvalidated)")
                failureEnumValue
            }
        }
    }

    private fun connectivityManager(): ConnectivityManager? {
        val context = appContext ?: return null
        return runCatching {
            context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        }.getOrNull()
    }

    private fun captureContext(context: Context?, source: String) {
        if (context == null) return
        val captured = context.applicationContext ?: context
        if (appContext === captured) return
        appContext = captured
        Log.w(TAG, "  Captured connectivity context from $source")
    }

    private fun networkMonitorHasValidatedWifi(networkMonitor: Any?): Boolean {
        if (networkMonitor == null) return false
        return try {
            val hasInternetMethod = networkMonitor.javaClass.getDeclaredMethod("hasInternet")
            hasInternetMethod.isAccessible = true
            val hasInternet = hasInternetMethod.invoke(networkMonitor) as? Boolean ?: false
            if (!hasInternet) return false

            val connectionTypeMethod = networkMonitor.javaClass.getDeclaredMethod("getCurrentConnectionType")
            connectionTypeMethod.isAccessible = true
            val connectionType = connectionTypeMethod.invoke(networkMonitor)
            val connectionTypeName = (connectionType as? Enum<*>)?.name ?: connectionType?.toString()
            connectionTypeName == "WIFI"
        } catch (t: Throwable) {
            Log.w(TAG, "NetworkMonitor status check failed: ${t.javaClass.simpleName}: ${t.message}")
            false
        }
    }

    private fun logStatusChange(status: String) {
        if (lastLoggedStatus == status) return
        lastLoggedStatus = status
        Log.w(TAG, "Connectivity status via Android capabilities: $status")
    }
}
