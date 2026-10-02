package com.penumbraos.hook

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Parcel
import android.util.Log
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

internal object StandaloneDockCpuPromotionPolicy {
    private const val REQUIRED_CPU = 7

    fun mayLaunch(brokerApproved: Boolean, allowedCpuList: String): Boolean =
        brokerApproved && allowsCpu(allowedCpuList, REQUIRED_CPU)

    private fun allowsCpu(value: String, requiredCpu: Int): Boolean {
        if (value.isBlank()) return false
        var found = false
        for (rawPart in value.split(',')) {
            val part = rawPart.trim()
            if (part.isEmpty()) return false
            val bounds = part.split('-')
            if (bounds.size !in 1..2 || bounds.any { token ->
                    token.isEmpty() || token.any { !it.isDigit() }
                }
            ) {
                return false
            }
            val start = bounds[0].toIntOrNull() ?: return false
            val end = if (bounds.size == 2) bounds[1].toIntOrNull() ?: return false else start
            if (start < 0 || end < start) return false
            if (requiredCpu in start..end) found = true
        }
        return found
    }
}

/** Fixed, UID-checked Binder handshake with Compatibility Loader. */
internal object StandaloneDockCpuPromotion {
    private const val TAG = "LumaRootCpuPromotion"
    private const val LOADER_PACKAGE = "com.penumbraos.hook.injector"
    private const val SERVICE_CLASS =
        "com.penumbraos.hook.injector.StandaloneDockCpuBrokerService"
    private const val DESCRIPTOR =
        "com.penumbraos.hook.injector.StandaloneDockCpuBroker"
    private const val TRANSACTION_PROMOTE_CALLER = IBinder.FIRST_CALL_TRANSACTION
    private const val TIMEOUT_SECONDS = 15L

    fun promote(context: Context): Boolean {
        val completed = CountDownLatch(1)
        var brokerApproved = false
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                brokerApproved = service?.let(::transact) == true
                completed.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                completed.countDown()
            }

            override fun onBindingDied(name: ComponentName?) {
                completed.countDown()
            }

            override fun onNullBinding(name: ComponentName?) {
                completed.countDown()
            }
        }
        val intent = Intent().setComponent(ComponentName(LOADER_PACKAGE, SERVICE_CLASS))
        val bound = try {
            context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        } catch (error: Throwable) {
            Log.e(TAG, "CPU broker bind failed", error)
            false
        }
        if (!bound) return false

        try {
            if (!completed.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) return false
        } finally {
            runCatching { context.unbindService(connection) }
        }
        val allowed = File("/proc/self/status").useLines { lines ->
            lines.firstOrNull { it.startsWith("Cpus_allowed_list:") }
                ?.substringAfter(':')
                ?.trim()
        }.orEmpty()
        return StandaloneDockCpuPromotionPolicy.mayLaunch(brokerApproved, allowed)
    }

    private fun transact(service: IBinder): Boolean {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInterfaceToken(DESCRIPTOR)
            if (!service.transact(TRANSACTION_PROMOTE_CALLER, data, reply, 0)) return false
            reply.readException()
            reply.readInt() == 1
        } catch (error: Throwable) {
            Log.e(TAG, "CPU broker transaction failed", error)
            false
        } finally {
            reply.recycle()
            data.recycle()
        }
    }
}
