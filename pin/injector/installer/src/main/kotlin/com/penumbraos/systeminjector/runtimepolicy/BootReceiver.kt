package com.penumbraos.systeminjector.runtimepolicy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "RuntimePolicy"
    }

    override fun onReceive(context: Context, intent: Intent) {
        try {
            handleReceive(context, intent)
        } catch (t: Throwable) {
            Log.e(TAG, "BootReceiver failed", t)
        }
    }

    private fun handleReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_LOCKED_BOOT_COMPLETED && action != Intent.ACTION_BOOT_COMPLETED) {
            return
        }

        Log.w(TAG, "BootReceiver triggered by $action")
        LaunchPolicyInstaller.refreshPolicies(context)
    }
}
