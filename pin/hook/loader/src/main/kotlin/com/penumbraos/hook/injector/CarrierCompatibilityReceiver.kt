package com.penumbraos.hook.injector

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Rechecks replacement-carrier compatibility after every relevant lifecycle event. */
class CarrierCompatibilityReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in SUPPORTED_ACTIONS) return

        val pendingResult = try {
            goAsync()
        } catch (error: Throwable) {
            Log.e(TAG, "Could not start carrier compatibility work", error)
            return
        }
        try {
            Thread(
                {
                    try {
                        val result = synchronized(CarrierCompatibility.workLock) {
                            CarrierCompatibility.repair(context)
                        }
                        logResult(result)
                    } catch (error: Throwable) {
                        Log.e(TAG, "Carrier compatibility work failed", error)
                    } finally {
                        pendingResult.finish()
                    }
                },
                "PenumbraCarrierCompatibility",
            ).start()
        } catch (error: Throwable) {
            Log.e(TAG, "Could not launch carrier compatibility worker", error)
            pendingResult.finish()
        }
    }

    companion object {
        private const val TAG = "PenumbraCarrier"
        private val SUPPORTED_ACTIONS = setOf(
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_BOOT_COMPLETED,
            "android.telephony.action.CARRIER_CONFIG_CHANGED",
            "android.intent.action.SIM_STATE_CHANGED",
        )

        internal fun logResult(result: CarrierCompatibility.Result) {
            when (result) {
                CarrierCompatibility.Result.NoActiveSubscription ->
                    Log.w(TAG, "Carrier compatibility deferred until a subscription is active")
                CarrierCompatibility.Result.EffectiveConfigUnavailable ->
                    Log.w(TAG, "Carrier compatibility deferred until configuration is available")
                CarrierCompatibility.Result.AlreadyCompatible ->
                    Log.w(TAG, "Carrier compatibility already active")
                is CarrierCompatibility.Result.Applied ->
                    Log.w(TAG, "Carrier compatibility restored (${result.changedValueCount} values)")
                is CarrierCompatibility.Result.Failed ->
                    Log.e(TAG, "Carrier compatibility repair failed", result.error)
            }
        }
    }
}
