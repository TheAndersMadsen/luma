package com.penumbraos.hook.injector

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.os.Process
import android.util.Log
import java.io.File

internal object StandaloneDockCpuBrokerProtocol {
    const val DESCRIPTOR = "com.penumbraos.hook.injector.StandaloneDockCpuBroker"
    const val TRANSACTION_PROMOTE_CALLER = IBinder.FIRST_CALL_TRANSACTION
}

internal object StandaloneDockCpuBrokerPolicy {
    const val SHELL_UID = 2000
    const val REQUIRED_CPU = 7

    fun mayPromote(callingUid: Int, callingPid: Int): Boolean =
        callingUid == SHELL_UID && callingPid > 0

    fun allowsRequiredCpu(value: String, requiredCpu: Int = REQUIRED_CPU): Boolean {
        if (requiredCpu < 0 || value.isBlank()) return false
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

/**
 * Luma-owned (INFERRED) fixed cpuset handoff for the detached UID-2000 root
 * runner. The caller supplies neither a PID nor a profile: Binder supplies the
 * exact caller identity, and the service applies Android's restricted process
 * group before proving CPU 7 is kernel-visible to that same PID. On this exact
 * firmware, that profile is the reviewed 0-7 cpuset. The foreground/default
 * profile excludes CPU 7.
 */
class StandaloneDockCpuBrokerService : Service() {
    companion object {
        private const val TAG = "LumaRootCpuBroker"
        // AOSP android.os.Process.THREAD_GROUP_RESTRICTED on Android 12.
        private const val THREAD_GROUP_RESTRICTED = 7
    }

    private val binder = object : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            if (code != StandaloneDockCpuBrokerProtocol.TRANSACTION_PROMOTE_CALLER) {
                return super.onTransact(code, data, reply, flags)
            }
            data.enforceInterface(StandaloneDockCpuBrokerProtocol.DESCRIPTOR)
            val uid = getCallingUid()
            val pid = getCallingPid()
            if (!StandaloneDockCpuBrokerPolicy.mayPromote(uid, pid)) {
                throw SecurityException("root runner cpuset promotion is limited to Shell")
            }

            val approved = promoteAndVerify(pid)
            reply?.writeNoException()
            reply?.writeInt(if (approved) 1 else 0)
            return true
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    private fun promoteAndVerify(pid: Int): Boolean = try {
        Process::class.java.getDeclaredMethod(
            "setProcessGroup",
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        ).apply { isAccessible = true }.invoke(null, pid, THREAD_GROUP_RESTRICTED)
        val allowed = File("/proc/$pid/status").useLines { lines ->
            lines.firstOrNull { it.startsWith("Cpus_allowed_list:") }
                ?.substringAfter(':')
                ?.trim()
        }.orEmpty()
        val approved = StandaloneDockCpuBrokerPolicy.allowsRequiredCpu(allowed)
        if (!approved) {
            Log.e(TAG, "Shell cpuset promotion did not expose required CPU")
        }
        approved
    } catch (error: Throwable) {
        Log.e(TAG, "Shell cpuset promotion failed", error)
        false
    }
}
