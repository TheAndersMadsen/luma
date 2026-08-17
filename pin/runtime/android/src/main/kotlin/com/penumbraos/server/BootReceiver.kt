package com.penumbraos.server

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PenumbraServer"
    }

    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

            Log.w(TAG, "BOOT_COMPLETED received, starting foreground service")
            ServerService.start(context)
            // Always-on injected-package presence observation; restoration
            // stays inert unless the operator has explicitly enabled and
            // digest-pinned it (see InjectedPackageRecovery).
            InjectedPackageRecovery.scheduleBootCheck(context)
        } catch (t: Throwable) {
            Log.e(TAG, "BootReceiver.onReceive failed", t)
        }
    }
}
