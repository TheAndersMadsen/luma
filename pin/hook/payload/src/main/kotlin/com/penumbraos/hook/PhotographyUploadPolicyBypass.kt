package com.penumbraos.hook

import android.util.Log

/**
 * Select stock Photography's connected-network policy for device-local captures.
 *
 * `PhotographyWorkScheduler.scheduleAssetUploadWorkWithDelay` uses its force
 * argument for two independent decisions: the WorkManager tag/DAO query and
 * the network constraints. Promoting an ordinary capture to `forceUpload=true`
 * therefore creates `AssetForceUploadWorkTag`, whose worker queries only rows
 * already marked `shouldForceUpload=true` and skips ordinary captures.
 *
 * Keep the force argument unchanged. Instead, set Photography's local
 * `uploadOnWifiAndPower` policy to false before the stock scheduler builds its
 * request. Its ordinary `false` branch then retains `AssetUploadWorkTag` and
 * the ordinary DAO query while using `NetworkType.CONNECTED` instead of the
 * unmetered/battery/charge-pad constraints. WorkManager, retry handling, gRPC
 * UploadFile, HTTP PUT, and gRPC UploadComplete remain stock.
 */
object PhotographyUploadPolicyBypass {

    private const val TAG = "PenumbraHook"
    private const val SCHEDULER_CLASS = "worker.PhotographyWorkScheduler"
    private const val CONFIG_CLASS = "humaneinternal.system.config.PhotographyConfig"

    /**
     * §19.2 hardening: the original stock `uploadOnWifiAndPower` value is captured
     * once on first use and restored after each stock scheduler call so the hook
     * does not permanently rewrite shared configuration state.
     */
    @Volatile
    private var originalUploadOnWifiAndPower: Boolean? = null
    private val originalLock = Any()

    fun install(cl: ClassLoader) {
        val schedulerClass = try {
            cl.loadClass(SCHEDULER_CLASS)
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $SCHEDULER_CLASS not found, skipping asset upload policy bypass")
            return
        }

        val schedulerConfigField = try {
            schedulerClass.getDeclaredField("mConfig").also { it.isAccessible = true }
        } catch (t: Throwable) {
            Log.e(TAG, "  Could not resolve PhotographyWorkScheduler.mConfig: ${t.message}")
            return
        }
        val uploadPolicyField = try {
            cl.loadClass(CONFIG_CLASS)
                .getDeclaredField("uploadOnWifiAndPower")
                .also { it.isAccessible = true }
        } catch (t: Throwable) {
            Log.e(TAG, "  Could not resolve PhotographyConfig.uploadOnWifiAndPower: ${t.message}")
            return
        }

        HookUtils.hookMethodBefore(
            schedulerClass,
            "scheduleAssetUploadWorkWithDelay",
            arrayOf(
                Boolean::class.javaPrimitiveType!!,
                Long::class.javaPrimitiveType!!,
            ),
        ) { param ->
            val requestedForceUpload = param.args.getOrNull(0) as? Boolean
            if (requestedForceUpload == null) {
                Log.e(TAG, "  Photography asset upload policy received an invalid force flag")
                return@hookMethodBefore
            }

            try {
                val config = schedulerConfigField.get(param.thisObject)
                    ?: throw IllegalStateException("mConfig was null")
                val configuredUploadOnWifiAndPower = uploadPolicyField.getBoolean(config)

                // §19.2 hardening: remember the stock value the first time we see it
                // so we can restore it after the call completes.
                synchronized(originalLock) {
                    if (originalUploadOnWifiAndPower == null) {
                        originalUploadOnWifiAndPower = configuredUploadOnWifiAndPower
                    }
                }

                val policy = schedulingPolicy(
                    requestedForceUpload = requestedForceUpload,
                    configuredUploadOnWifiAndPower = configuredUploadOnWifiAndPower,
                    uploadsToDeviceLocalServer = true,
                )
                check(policy.forceUpload == requestedForceUpload) {
                    "device-local policy must preserve forceUpload"
                }

                // Deliberately do not write param.args[0]: it controls the tag and DAO query.
                if (policy.uploadOnWifiAndPower != configuredUploadOnWifiAndPower) {
                    uploadPolicyField.setBoolean(config, policy.uploadOnWifiAndPower)
                    val appliedUploadOnWifiAndPower = uploadPolicyField.getBoolean(config)
                    check(appliedUploadOnWifiAndPower == policy.uploadOnWifiAndPower) {
                        "uploadOnWifiAndPower reflection write did not persist"
                    }
                    Log.w(
                        TAG,
                        "  Photography upload policy applied: forceUpload preserved=" +
                            "$requestedForceUpload, uploadOnWifiAndPower=$appliedUploadOnWifiAndPower",
                    )
                }
            } catch (t: Throwable) {
                // Leave the scheduler arguments untouched rather than disrupting capture.
                Log.e(TAG, "  Could not apply Photography asset upload policy: ${t.message}")
            }
        }

        // §19.2 hardening: restore the original stock policy after the call so we do
        // not leak a mutated value into subsequent non-Penumbra scheduling decisions.
        HookUtils.hookMethodAfter(
            schedulerClass,
            "scheduleAssetUploadWorkWithDelay",
            arrayOf(
                Boolean::class.javaPrimitiveType!!,
                Long::class.javaPrimitiveType!!,
            ),
        ) { param ->
            val saved = originalUploadOnWifiAndPower
            if (saved == null) return@hookMethodAfter
            try {
                val config = schedulerConfigField.get(param.thisObject) ?: return@hookMethodAfter
                val current = uploadPolicyField.getBoolean(config)
                if (current != saved) {
                    uploadPolicyField.setBoolean(config, saved)
                    Log.w(TAG, "  Photography upload policy restored: uploadOnWifiAndPower=$saved")
                }
            } catch (t: Throwable) {
                Log.e(TAG, "  Could not restore Photography upload policy: ${t.message}")
            }
        }
    }

    internal data class AssetUploadSchedulingPolicy(
        val forceUpload: Boolean,
        val uploadOnWifiAndPower: Boolean,
    )

    /** Preserve tag/query selection and relax only the device-local constraint policy. */
    internal fun schedulingPolicy(
        requestedForceUpload: Boolean,
        configuredUploadOnWifiAndPower: Boolean,
        uploadsToDeviceLocalServer: Boolean,
    ): AssetUploadSchedulingPolicy = AssetUploadSchedulingPolicy(
        forceUpload = requestedForceUpload,
        uploadOnWifiAndPower = if (uploadsToDeviceLocalServer) {
            false
        } else {
            configuredUploadOnWifiAndPower
        },
    )
}
