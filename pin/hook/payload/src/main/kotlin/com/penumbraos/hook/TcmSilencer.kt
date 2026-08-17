package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * Prevents Qualcomm's TcmIdleTimerMonitor from loading tcmclient.jar and
 * starting the TcmReceiver socket thread.
 *
 * Qualcomm patches OkHttp's ConnectionPool to create a TcmIdleTimerMonitor
 * on construction. That monitor reflectively loads /system/framework/tcmclient.jar,
 * which starts a thread that repeatedly tries to connect to /dev/socket/tcm.
 * In processes without the SELinux permission to write to that socket, this
 * produces an avc: denied audit log every ~1 second.
 *
 * This hook no-ops the TcmIdleTimerMonitor constructor so the classloading
 * and socket connection never happen. TcmIdleTimerMonitor is on the boot
 * classpath (in the ART APEX's modified okhttp.jar), so it's accessible
 * from any process.
 */
object TcmSilencer {

    private const val TAG = "PenumbraHook"

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing TCM silencer...")

        try {
            val timerMonitorClass = Class.forName("com.android.okhttp.TcmIdleTimerMonitor")
            val connectionPoolClass = Class.forName("com.android.okhttp.ConnectionPool")
            val constructor = timerMonitorClass.getDeclaredConstructor(connectionPoolClass)
            constructor.isAccessible = true

            XposedBridge.hookMethod(constructor, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    // Short-circuit: prevent the constructor body from running.
                    // This stops it from loading tcmclient.jar via PathClassLoader
                    // and starting the TcmReceiver socket thread.
                    param.result = null
                    Log.w(TAG, "  TcmIdleTimerMonitor constructor suppressed")
                }
            })
            Log.w(TAG, "  Hooked TcmIdleTimerMonitor constructor")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook TcmIdleTimerMonitor: ${t.message}")
        }
    }
}
