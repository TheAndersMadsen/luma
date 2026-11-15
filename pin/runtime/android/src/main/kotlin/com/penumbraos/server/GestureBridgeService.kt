package com.penumbraos.server

import android.app.ActivityManager
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.os.SystemClock
import com.penumbraos.stockaibus.contract.TierASymbols
import dev.luma.gestures.GestureObservation

/** INFERRED: the exact stock launcher process may publish bounded diagnostics. */
class GestureBridgeService : Service() {
    override fun onBind(intent: Intent?): IBinder = object : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            val launcher = TierASymbols.Packages.SYSTEM_NAVIGATION
            val expectedUid = runCatching { packageManager.getPackageUid(launcher, 0) }.getOrNull()
                ?: throw SecurityException("Launcher unavailable")
            val processes = getSystemService(ActivityManager::class.java)?.runningAppProcesses.orEmpty()
                .map { it.pid to it.processName }
            if (!GestureCallerAdmission.allowed(getCallingUid(), getCallingPid(), expectedUid, launcher, processes)) {
                throw SecurityException("Launcher process required")
            }
            if (code == INTERFACE_TRANSACTION) { reply?.writeString(GestureObservation.DESCRIPTOR); return true }
            // A synchronous call preserves the sender PID; one-way Binder calls
            // can report PID 0 and cannot prove this shared-UID process boundary.
            require(code == GestureObservation.TRANSACTION_REPORT && flags and FLAG_ONEWAY == 0 && reply != null)
            require(data.dataSize() <= GestureObservation.MAX_BYTES * 2 + 256)
            data.enforceInterface(GestureObservation.DESCRIPTOR)
            val raw = requireNotNull(data.readString())
            val copyId = data.readString()
            require(data.dataAvail() == 0)
            val now = SystemClock.elapsedRealtime()
            observations.record(raw, now)
            if (copyId != null) {
                val sample = observations.read(now)
                if (sample?.getBoolean("eligible") == true && sample.getBoolean("projectable") && now - sample.getLong("elapsed_ms") <= 250) clips.copy(copyId, now)
            }
            reply.writeNoException()
            reply.writeString(clips.read(now)?.toString())
            return true
        }
    }

    companion object {
        internal val observations = GestureObservations()
        internal val clips = ClipSessions()
    }
}

internal object GestureCallerAdmission {
    // Stock launcher shares UID 1000 with other services. UID alone is not admission.
    fun allowed(uid: Int, pid: Int, expectedUid: Int, launcher: String, processes: List<Pair<Int, String>>): Boolean =
        uid == expectedUid && pid > 0 && processes.singleOrNull { it.first == pid }?.second == launcher
}
