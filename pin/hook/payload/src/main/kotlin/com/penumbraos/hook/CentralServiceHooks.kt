package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * Work around boot race between CentralService and AppController initialization.
 *
 * At boot, CentralService.onCreate() posts AppController.initializeIfNeeded() to
 * AsyncUtils.poolExecutor (background thread). Inside the AppController constructor,
 * another task is posted to the same pool that calls:
 *
 *   AiBridge.installAiBus() -> AiBrainService$AIBrain.installAiBus()
 *     -> startUpAI() -> publishAiBrainInterfaces()
 *       -> CentralService$1.publishInterfaces()
 *
 * publishInterfaces() then accesses CentralService.this.mAppController.
 * If the AppController constructor hasn't returned yet, mAppController is null,
 * causing:
 *
 *   java.lang.NullPointerException:
 *     Attempt to invoke virtual method 'void AppController.updateInterfaces(CentralInterfaces)'
 *     on a null object reference
 *
 * This hook waits (up to TIMEOUT_MS) on the Binder thread for mAppController
 * to become non-null before letting publishInterfaces proceed.
 */
object CentralServiceHooks {

    private const val TAG = "PenumbraHook"
    private const val TARGET_CLASS = "humaneinternal.system.CentralService\$1"
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

        val centralInterfacesClass = try {
            cl.loadClass("humaneinternal.system.CentralInterfaces")
        } catch (e: ClassNotFoundException) {
            Log.w(TAG, "  humaneinternal.system.CentralInterfaces not found, skipping")
            return
        }

        val publishMethod = try {
            targetClass.getMethod("publishInterfaces", centralInterfacesClass)
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to find publishInterfaces method: ${t.message}")
            return
        }

        XposedBridge.hookMethod(publishMethod, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                waitForAppController(param)
            }
        })

        installed = true
        Log.w(TAG, "  Hooked CentralService\$1.publishInterfaces(). Waiting for AppController init")
    }

    /**
     * Access CentralService.this$0 (the enclosing CentralService instance) via
     * the synthetic field on the anonymous inner class, then poll mAppController
     * until it's non-null or timeout.
     *
     * This runs on the Binder thread. The pool thread constructing AppController
     * typically finishes within a few hundred ms.
     */
    private fun waitForAppController(param: XC_MethodHook.MethodHookParam) {
        // Synthetic field on anonymous inner class pointing to enclosing instance
        val outerField = try {
            param.thisObject.javaClass.getDeclaredField("this\$0")
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to access this\$0 field: ${t.message}")
            return
        }
        outerField.isAccessible = true

        val centralService = try {
            outerField.get(param.thisObject)
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to get CentralService instance: ${t.message}")
            return
        }

        val appControllerField = try {
            centralService.javaClass.getDeclaredField("mAppController")
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to access mAppController field: ${t.message}")
            return
        }
        appControllerField.isAccessible = true

        // Already initialized; error scenario did not occur
        if (appControllerField.get(centralService) != null) return

        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        Log.w(TAG, "  mAppController is null — waiting up to ${TIMEOUT_MS}ms for AppController init to complete")

        while (System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(POLL_INTERVAL_MS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.w(TAG, "  Poll interrupted")
                return
            }

            if (appControllerField.get(centralService) != null) {
                Log.w(TAG, "  mAppController initialized")
                return
            }
        }

        Log.w(TAG, "  mAppController not initialized within ${TIMEOUT_MS}ms. Proceeding anyway")
    }
}
