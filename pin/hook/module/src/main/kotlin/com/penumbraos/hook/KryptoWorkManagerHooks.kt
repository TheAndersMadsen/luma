package com.penumbraos.hook

import android.content.Context
import android.util.Log

/** Repairs the stock Krypto worker bootstrap only while its Luma transport is active. */
internal object KryptoWorkManagerHooks {
    private const val TAG = "LumaCompatibility"
    private const val SYSTEM_JOB_SERVICE =
        "androidx.work.impl.background.systemjob.SystemJobService"
    private const val WORK_MANAGER = "androidx.work.WorkManager"
    private const val WORK_CONFIGURATION = "androidx.work.Configuration"
    private const val KRYPTO_WORK_CONFIGURATION =
        "humaneinternal.system.krypto.config.KryptoWorkConfiguration"

    fun install(cl: ClassLoader) {
        val systemJobService = try {
            cl.loadClass(SYSTEM_JOB_SERVICE)
        } catch (error: Throwable) {
            Log.e(TAG, "  Krypto WorkManager repair unavailable: ${error.javaClass.simpleName}")
            return
        }

        // Stock KryptoService.onCreate and RebootReceiver.onReceive initialize
        // WorkManager, but KryptoService is declared in :krypto while stock
        // SystemJobService.onCreate runs in the default process. If the boot
        // receiver process exits before JobScheduler relaunches that service,
        // its mWorkManagerImpl remains null and onStartJob requests a retry.
        // Initialize immediately before the stock onCreate so its listener and
        // scheduling path remain authoritative.
        HookUtils.hookMethodBefore(
            systemJobService,
            "onCreate",
            emptyArray(),
        ) { param ->
            val context = param.thisObject as? Context ?: return@hookMethodBefore
            try {
                initializeIfNeeded(context, cl)
            } catch (error: Throwable) {
                // Firmware drift must leave the stock callback intact.
                Log.e(
                    TAG,
                    "  Krypto WorkManager repair failed open: ${error.javaClass.simpleName}",
                )
            }
        }
    }

    private fun initializeIfNeeded(context: Context, cl: ClassLoader) {
        val remoteEnabled = CosmosRemoteTransport.isEnabled()
        if (!remoteEnabled) return

        val workManager = cl.loadClass(WORK_MANAGER)
        val initialized = workManager
            .getMethod("isInitialized")
            .invoke(null) as? Boolean
            ?: error("WorkManager.isInitialized returned no Boolean")
        if (
            !shouldInitializeWorkManager(
                remoteEnabled = remoteEnabled,
                workManagerInitialized = initialized,
            )
        ) {
            return
        }

        val configurationClass = cl.loadClass(WORK_CONFIGURATION)
        val configuration = cl.loadClass(KRYPTO_WORK_CONFIGURATION)
            .getMethod("getConfig")
            .invoke(null)
            ?: error("KryptoWorkConfiguration.getConfig returned null")
        workManager.getMethod(
            "initialize",
            Context::class.java,
            configurationClass,
        ).invoke(null, context.applicationContext, configuration)
        Log.w(TAG, "  Initialized stock Krypto WorkManager in its JobService process")
    }

    internal fun shouldInitializeWorkManager(
        remoteEnabled: Boolean,
        workManagerInitialized: Boolean,
    ): Boolean = remoteEnabled && !workManagerInitialized
}
