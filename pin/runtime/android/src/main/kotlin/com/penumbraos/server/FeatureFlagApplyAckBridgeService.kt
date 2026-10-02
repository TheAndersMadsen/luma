package com.penumbraos.server

import android.app.Service
import android.app.ActivityManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * Receives a bounded in-memory receipt only from Ironman's exact main process.
 * The hook emits it after FeatureFlagManager.setServerFlags returns and exact
 * typed read-back through the stock Binder cache succeeds.
 */
class FeatureFlagApplyAckBridgeService : Service() {
    private val binder = FeatureFlagApplyAckBinder()

    override fun onBind(intent: Intent?): IBinder = binder

    private inner class FeatureFlagApplyAckBinder : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            enforceIronmanCaller()
            if (code == INTERFACE_TRANSACTION) {
                requireNotNull(reply).writeString(FeatureFlagApplyAckProtocol.DESCRIPTOR)
                return true
            }
            if (code != FeatureFlagApplyAckProtocol.TRANSACTION_RECORD_APPLIED ||
                flags and FLAG_ONEWAY != 0 || reply == null
            ) throw SecurityException("Unsupported feature-flag acknowledgement transaction")

            data.enforceInterface(FeatureFlagApplyAckProtocol.DESCRIPTOR)
            val assignmentSetHash = data.readString().orEmpty()
            val assignmentCount = data.readInt()
            require(data.dataAvail() == 0) {
                "Unexpected feature-flag acknowledgement data"
            }
            val receipt = FeatureFlagApplyAckRepository.record(
                assignmentSetHash,
                assignmentCount,
                System.currentTimeMillis(),
            )
            reply.writeNoException()
            reply.writeLong(receipt.sequence)
            return true
        }
    }

    private fun enforceIronmanCaller() {
        val callingUid = Binder.getCallingUid()
        val callingPid = Binder.getCallingPid()
        val expectedUid = try {
            packageManager.getPackageUid(FeatureFlagApplyAckProtocol.IRONMAN_PACKAGE, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            throw SecurityException("Authorized Ironman caller is unavailable")
        }
        val packages = packageManager.getPackagesForUid(callingUid).orEmpty().toSet()
        val processes = (getSystemService(ActivityManager::class.java)?.runningAppProcesses)
            .orEmpty()
            .map { process ->
                FeatureFlagApplyAckProcessIdentity(
                    pid = process.pid,
                    uid = process.uid,
                    processName = process.processName,
                )
            }
        if (!FeatureFlagApplyAckCallerAdmission.isAuthorized(
                callingUid,
                expectedUid,
                packages,
                callingPid,
                processes,
            )
        ) throw SecurityException("Caller is not authorized for feature-flag acknowledgement")
    }
}

internal data class FeatureFlagApplyAckProcessIdentity(
    val pid: Int,
    val uid: Int,
    val processName: String?,
)

internal object FeatureFlagApplyAckCallerAdmission {
    fun isAuthorized(
        callingUid: Int,
        expectedUid: Int,
        packagesForUid: Set<String>,
        callingPid: Int,
        processes: List<FeatureFlagApplyAckProcessIdentity>,
    ): Boolean {
        if (callingUid != expectedUid ||
            packagesForUid != setOf(FeatureFlagApplyAckProtocol.IRONMAN_PACKAGE)
        ) return false
        val process = processes.singleOrNull { candidate ->
            candidate.pid == callingPid && candidate.uid == callingUid
        } ?: return false
        return process.processName == FeatureFlagApplyAckProtocol.IRONMAN_PACKAGE
    }
}

internal object FeatureFlagApplyAckProtocol {
    const val DESCRIPTOR = TierASymbols.Binder.PenumbraFeatureFlagApplyAck.DESCRIPTOR
    const val IRONMAN_PACKAGE = TierASymbols.Packages.IRONMAN
    const val TRANSACTION_RECORD_APPLIED =
        TierASymbols.Binder.PenumbraFeatureFlagApplyAck.TRANSACTION_RECORD_APPLIED
    const val MAX_ASSIGNMENTS = 256
    const val SHA256_HEX_CHARS = 64

    fun validate(
        assignmentSetHash: String,
        assignmentCount: Int,
        appliedAtUnixMs: Long,
    ) {
        require(assignmentSetHash.length == SHA256_HEX_CHARS &&
            assignmentSetHash.all { it in '0'..'9' || it in 'a'..'f' }) {
            "Feature-flag assignment hash is invalid"
        }
        require(assignmentCount in 1..MAX_ASSIGNMENTS) {
            "Feature-flag assignment count is invalid"
        }
        require(appliedAtUnixMs > 0L) { "Feature-flag acknowledgement time is invalid" }
    }
}

internal data class FeatureFlagApplyReceipt(
    val sequence: Long,
    val assignmentSetHash: String,
    val assignmentCount: Int,
    val appliedAtUnixMs: Long,
)

/** Process-private, non-persistent receipt. A server restart resets its sequence. */
internal object FeatureFlagApplyAckRepository {
    private var sequence = 0L
    private var latest: FeatureFlagApplyReceipt? = null

    @Synchronized
    fun record(
        assignmentSetHash: String,
        assignmentCount: Int,
        appliedAtUnixMs: Long,
    ): FeatureFlagApplyReceipt {
        FeatureFlagApplyAckProtocol.validate(
            assignmentSetHash,
            assignmentCount,
            appliedAtUnixMs,
        )
        check(sequence < Long.MAX_VALUE) { "Feature-flag acknowledgement sequence exhausted" }
        sequence++
        return FeatureFlagApplyReceipt(
            sequence,
            assignmentSetHash,
            assignmentCount,
            appliedAtUnixMs,
        ).also { latest = it }
    }

    @Synchronized
    fun latest(): FeatureFlagApplyReceipt? = latest?.copy()

    /** A new native child creates a new delivery-evidence session. */
    @Synchronized
    fun clearForRuntimeRestart() {
        sequence = 0L
        latest = null
    }

    @Synchronized
    internal fun clearForTest() = clearForRuntimeRestart()
}
