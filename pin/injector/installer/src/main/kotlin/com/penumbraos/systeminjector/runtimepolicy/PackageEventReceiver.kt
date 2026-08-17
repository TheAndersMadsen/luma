package com.penumbraos.systeminjector.runtimepolicy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

class PackageEventReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "RuntimePolicy"
    }

    override fun onReceive(context: Context, intent: Intent) {
        try {
            handleReceive(context, intent)
        } catch (t: Throwable) {
            Log.e(TAG, "PackageEventReceiver failed", t)
        }
    }

    private fun handleReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_PACKAGE_REMOVED && action != Intent.ACTION_PACKAGE_FULLY_REMOVED) {
            return
        }

        val packageName = parsePackageName(intent.data)
        if (packageName.isNullOrBlank()) {
            Log.w(TAG, "Package event missing package name for $action")
            return
        }

        if (action == Intent.ACTION_PACKAGE_REMOVED) {
            val replacing = intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)
            if (replacing) {
                Log.w(TAG, "Ignoring PACKAGE_REMOVED during replace for $packageName")
                return
            }
        }

        PolicyRegistry.removeTrackedPackage(context, packageName)
    }

    private fun parsePackageName(uri: Uri?): String? {
        return uri?.schemeSpecificPart
    }
}
