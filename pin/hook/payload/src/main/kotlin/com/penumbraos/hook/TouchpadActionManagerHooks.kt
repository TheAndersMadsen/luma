package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * Work around boot race condition between TouchpadActionManager and SystemModeService.
 *
 * At boot, CentralService.onCreate() creates AppController on a background thread,
 * which constructs TouchpadActionManager, which calls systemModeService.getMode()
 * via Binder IPC. If SystemModeService.onUserUnlocked() hasn't completed yet
 * getMode() throws:
 *
 *   IllegalStateException: Attempted to use SystemModeService before initialization
 */
object TouchpadActionManagerHooks {

    private const val TAG = "PenumbraHook"
    private const val TARGET_CLASS = "humaneinternal.system.gesture.TouchpadActionManager"
    private const val TIMEOUT_MS = 10_000L
    private const val POLL_INTERVAL_MS = 100L

    @Volatile
    private var installed = false

    fun install(cl: ClassLoader) {
        if (installed) return

        val targetClass = try {
            cl.loadClass(TARGET_CLASS)
        } catch (e: ClassNotFoundException) {
            Log.w(TAG, "  $TARGET_CLASS not found, skipping")
            return
        }

        val constructor = try {
            targetClass.getDeclaredConstructors().firstOrNull { it.parameterCount == 4 }
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to find constructor: ${t.message}")
            return
        }

        if (constructor == null) {
            Log.w(TAG, "  4-arg constructor not found")
            return
        }

        constructor.isAccessible = true

        XposedBridge.hookMethod(constructor, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                waitForSystemModeService(param)
            }
        })

        installed = true
        Log.w(TAG, "  Hooked TouchpadActionManager constructor. Waiting for SystemModeService init")
    }

    /**
     * Poll ISystemModeService.checkInitialized() until it returns true or timeout.
     *
     * The service object is at param.args[2] (nullable ISystemModeService).
     * If the method doesn't exist on the AIDL proxy, we fall through silently.
     */
    private fun waitForSystemModeService(param: XC_MethodHook.MethodHookParam) {
        val service = param.args.getOrNull(2) ?: return

        val checkMethod = runCatching {
            service.javaClass.getMethod("checkInitialized")
        }.getOrNull()

        if (checkMethod == null) {
            Log.w(TAG, "  ISystemModeService.checkInitialized() not found on proxy — letting constructor proceed")
            return
        }

        val deadline = System.currentTimeMillis() + TIMEOUT_MS

        while (System.currentTimeMillis() < deadline) {
            val ready = runCatching {
                checkMethod.invoke(service) as? Boolean ?: false
            }.getOrElse { false }

            if (ready) {
                Log.w(TAG, "  SystemModeService initialized")
                return
            }

            try {
                Thread.sleep(POLL_INTERVAL_MS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.w(TAG, "  Poll interrupted")
                return
            }
        }

        Log.w(TAG, "  SystemModeService not initialized within ${TIMEOUT_MS}ms. Proceeding anyway (may crash)")
    }
}
