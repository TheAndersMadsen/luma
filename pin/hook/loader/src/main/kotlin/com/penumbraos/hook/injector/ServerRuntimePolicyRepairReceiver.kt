package com.penumbraos.hook.injector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserManager
import android.util.Log

/**
 * Restores the Server's transient PackageState seInfo after an in-place update.
 *
 * Package Manager rebuilds the package state during `adb install -r`, which
 * drops the in-memory override installed at boot. The updater explicitly calls
 * this fixed DUMP-protected component because Android 12L suppresses the
 * implicit PACKAGE_REPLACED manifest delivery. The receiver is deliberately
 * pinned to the one eligible package and exposes no package-name input.
 */
class ServerRuntimePolicyRepairReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PenumbraInjector"
        internal const val ACTION_REPAIR_SERVER_RUNTIME_POLICY =
            "com.penumbraos.hook.REPAIR_SERVER_RUNTIME_POLICY"
        private const val WORKER_NAME = "PenumbraServerPolicyRepair"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val trigger = ServerRuntimePolicyRepairTrigger.classify(
            action = intent.action,
            packageName = intent.data?.schemeSpecificPart,
        ) ?: return

        val pendingResult = try {
            goAsync()
        } catch (error: Throwable) {
            Log.e(TAG, "Server runtime policy repair goAsync failed", error)
            return
        }

        try {
            Thread(
                {
                    try {
                        repairAvailableStorage(context.applicationContext, trigger)
                    } catch (error: Throwable) {
                        // This code is hosted by system_server. Never allow a
                        // recovery failure to escape its worker thread.
                        Log.e(TAG, "Server runtime policy repair worker failed", error)
                    } finally {
                        pendingResult.finish()
                    }
                },
                WORKER_NAME,
            ).start()
        } catch (error: Throwable) {
            Log.e(TAG, "Server runtime policy repair worker failed to start", error)
            pendingResult.finish()
        }
    }

    private fun repairAvailableStorage(
        context: Context,
        trigger: ServerRuntimePolicyRepairTrigger.Trigger,
    ) {
        Log.w(TAG, "Server runtime policy repair triggered by $trigger")
        repairPhase(context, ServerRuntimePolicyRepair.StoragePhase.DEVICE_ENCRYPTED)

        val userUnlocked = try {
            context.getSystemService(UserManager::class.java)?.isUserUnlocked == true
        } catch (error: Throwable) {
            Log.e(TAG, "Unable to determine user-unlocked state; skipping CE repair", error)
            false
        }
        if (userUnlocked) {
            repairPhase(context, ServerRuntimePolicyRepair.StoragePhase.CREDENTIAL_ENCRYPTED)
        } else {
            Log.w(TAG, "User is locked; CE server runtime policy repair deferred to boot")
        }
    }

    private fun repairPhase(
        context: Context,
        storagePhase: ServerRuntimePolicyRepair.StoragePhase,
    ) {
        when (val repair = ServerRuntimePolicyRepair.repair(context, storagePhase)) {
            is ServerRuntimePolicyRepair.Result.Applied -> Log.w(
                TAG,
                "Server runtime policy repaired: overrideChanged=${repair.overrideChanged}, " +
                    "storagePhase=${repair.storagePhase}, " +
                    "flags=0x${repair.appDataFlags.toString(16)}, " +
                    "targetSdk=${repair.targetSdkVersion}",
            )
            ServerRuntimePolicyRepair.Result.PackageMissing ->
                Log.w(TAG, "Server runtime policy repair skipped: package missing")
            is ServerRuntimePolicyRepair.Result.NotEligible -> Log.e(
                TAG,
                "Server runtime policy repair rejected: sharedUserId=${repair.sharedUserId}, " +
                    "uid=${repair.appUid ?: -1}",
            )
            is ServerRuntimePolicyRepair.Result.Failed ->
                Log.e(TAG, "Server runtime policy repair failed: ${repair.message}", repair.error)
        }
    }
}

internal object ServerRuntimePolicyRepairTrigger {
    enum class Trigger {
        MANUAL_DUMP,
    }

    fun classify(action: String?, packageName: String?): Trigger? = when {
        action == ServerRuntimePolicyRepairReceiver.ACTION_REPAIR_SERVER_RUNTIME_POLICY &&
            packageName == null -> Trigger.MANUAL_DUMP
        else -> null
    }
}
