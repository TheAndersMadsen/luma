package com.penumbraos.hook

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Parcel
import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.io.IOException
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import com.penumbraos.ipc.contract.PenumbraIpcContract
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * Reports a receipt only after the stock feature-flag manager has synchronously
 * handed a complete gRPC snapshot to FeatureFlagService and exact read-back
 * confirms that every assignment is effective through the same Binder cache.
 *
 * The receipt contains only the stable digest already used by Penumbra's gRPC
 * service plus a count. It travels over an explicit Binder service that admits
 * only Ironman's exact UID/package/process. No credential is shared with the
 * injected process and no broadcast or external-storage bridge is involved.
 */
object FeatureFlagApplyAckHooks {
    private const val TAG = "LumaCompatibility"
    private const val SYNC_WORKER =
        "humaneinternal.system.featureflag.FeatureFlagSyncWorker"
    private const val RESPONSE_CLASS = "humane.featureflags.DeviceFeatureFlagResponse"
    private const val MANAGER_CLASS = "humaneinternal.featureflag.FeatureFlagManager"
    private const val BRIDGE_PACKAGE = "com.penumbraos.server"
    private const val BRIDGE_CLASS =
        "com.penumbraos.server.FeatureFlagApplyAckBridgeService"
    private const val BRIDGE_DESCRIPTOR =
        TierASymbols.Binder.PenumbraFeatureFlagApplyAck.DESCRIPTOR
    private const val TRANSACTION_RECORD_APPLIED =
        PenumbraIpcContract.FeatureFlagApplyAck.TRANSACTION_RECORD_APPLIED
    private const val BIND_TIMEOUT_MS = 3_000L

    private val pendingSnapshots = Collections.synchronizedMap(
        WeakHashMap<Any, PendingSnapshot>(),
    )
    private val publisher = ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(8),
        ThreadPoolExecutor.DiscardOldestPolicy(),
    )
    private val applyLock = ReentrantLock()

    fun install(classLoader: ClassLoader) {
        try {
            val responseClass = classLoader.loadClass(RESPONSE_CLASS)
            val workerClass = classLoader.loadClass(SYNC_WORKER)
            val convert = workerClass.getDeclaredMethod(
                "convertFeatureFlagAssignments",
                responseClass,
            ).apply { isAccessible = true }
            XposedBridge.hookMethod(convert, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) return
                    val converted = param.result as? Set<*> ?: return
                    val snapshot = snapshotFrom(param.args.getOrNull(0), converted) ?: return
                    pendingSnapshots[converted] = snapshot
                }
            })

            val managerClass = classLoader.loadClass(MANAGER_CLASS)
            val setServerFlags = managerClass.getDeclaredMethod(
                "setServerFlags",
                Set::class.java,
            ).apply { isAccessible = true }
            XposedBridge.hookMethod(setServerFlags, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    applyLock.lock()
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    try {
                        if (param.throwable != null) return
                        val assignments = param.args.getOrNull(0) ?: return
                        val snapshot = pendingSnapshots.remove(assignments) ?: return
                        if (!exactReadBack(param.thisObject, snapshot.assignments)) {
                            Log.w(TAG, "  Feature-flag apply acknowledgement withheld: read-back mismatch")
                            return
                        }
                        // Publish synchronously while every setServerFlags call in this
                        // process is serialized by applyLock. The Binder connection
                        // callback runs on [publisher], so this remains safe even when
                        // stock invokes setServerFlags on its main thread.
                        publish(snapshot)
                    } finally {
                        applyLock.unlock()
                    }
                }
            })
            Log.w(TAG, "  FeatureFlagApplyAckHooks installed on stock sync/cache path")
        } catch (error: Throwable) {
            Log.e(TAG, "  FeatureFlagApplyAckHooks install failed: ${error.javaClass.simpleName}")
        }
    }

    private fun snapshotFrom(response: Any?, converted: Set<*>): PendingSnapshot? = runCatching {
        if (response == null || converted.isEmpty()) return null
        val raw = response.javaClass.getMethod("getAssignmentList").invoke(response) as? List<*>
            ?: return null
        if (raw.size != converted.size || raw.size !in 1..MAX_ASSIGNMENTS) return null

        val encoded = raw.map { value ->
            value ?: return null
            val name = value.javaClass.getMethod("getFlagName").invoke(value) as? String
                ?: return null
            val id = value.javaClass.getMethod("getFlagId").invoke(value) as? String
                ?: return null
            val bytes = value.javaClass.getMethod("toByteArray").invoke(value) as? ByteArray
                ?: return null
            EncodedAssignment(name, id, bytes)
        }
        val hash = stableAssignmentSetHash(encoded) ?: return null
        val local = converted.map { assignment ->
            assignment ?: return null
            localAssignment(assignment) ?: return null
        }
        if (local.map(AppliedAssignment::key).toSet().size != local.size) return null
        PendingSnapshot(hash, local)
    }.getOrNull()

    private fun exactReadBack(manager: Any?, expected: List<AppliedAssignment>): Boolean {
        if (manager == null) return false
        val getter = runCatching {
            manager.javaClass.getMethod("getFlagAssignment", String::class.java)
        }.getOrNull() ?: return false
        return appliedAssignmentsMatch(expected) { key ->
            runCatching { getter.invoke(manager, key) }
                .getOrNull()
                ?.let(::localAssignment)
        }
    }

    private fun localAssignment(value: Any): AppliedAssignment? = runCatching {
        val type = value.javaClass
        val key = type.getField("key").get(value) as? String ?: return null
        val encodedValue = type.getField("value").get(value) as? String ?: return null
        val valueType = (type.getField("type").get(value) as? Byte) ?: return null
        AppliedAssignment(key, valueType, encodedValue)
    }.getOrNull()

    private fun publish(snapshot: PendingSnapshot) {
        val context = currentApplication() ?: return
        val connected = CountDownLatch(1)
        var remote: IBinder? = null
        var disconnected = false
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                remote = service
                connected.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                disconnected = true
                connected.countDown()
            }

            override fun onNullBinding(name: ComponentName?) {
                disconnected = true
                connected.countDown()
            }
        }
        var bound = false
        try {
            bound = context.bindService(
                Intent().setComponent(ComponentName(BRIDGE_PACKAGE, BRIDGE_CLASS)),
                Context.BIND_AUTO_CREATE,
                publisher,
                connection,
            )
            if (!bound || !connected.await(BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw IOException("Feature-flag acknowledgement bridge timed out")
            }
            val binder = remote
            if (disconnected || binder == null || !binder.isBinderAlive) {
                throw IOException("Feature-flag acknowledgement bridge is unavailable")
            }
            val data = Parcel.obtain()
            val reply = Parcel.obtain()
            try {
                data.writeInterfaceToken(BRIDGE_DESCRIPTOR)
                data.writeString(snapshot.assignmentSetHash)
                data.writeInt(snapshot.assignments.size)
                if (!binder.transact(TRANSACTION_RECORD_APPLIED, data, reply, 0)) {
                    throw IOException("Feature-flag acknowledgement bridge rejected receipt")
                }
                reply.readException()
                if (reply.readLong() <= 0L) {
                    throw IOException("Feature-flag acknowledgement bridge returned invalid sequence")
                }
            } finally {
                data.recycle()
                reply.recycle()
            }
            Log.i(TAG, "  Stock feature-flag cache application acknowledged")
        } catch (error: Throwable) {
            Log.w(TAG, "  Feature-flag apply receipt failed: ${error.javaClass.simpleName}")
        } finally {
            if (bound) runCatching { context.unbindService(connection) }
        }
    }

    private fun currentApplication(): Context? = runCatching {
        Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Context
    }.getOrNull()?.applicationContext

    internal data class EncodedAssignment(
        val flagName: String,
        val flagId: String,
        val protobuf: ByteArray,
    )

    internal data class AppliedAssignment(
        val key: String,
        val type: Byte,
        val value: String,
    )

    private data class PendingSnapshot(
        val assignmentSetHash: String,
        val assignments: List<AppliedAssignment>,
    )

    internal fun stableAssignmentSetHash(assignments: List<EncodedAssignment>): String? {
        if (assignments.size !in 1..MAX_ASSIGNMENTS) return null
        if (assignments.any {
                it.flagName.isBlank() || it.flagName.length > MAX_FLAG_NAME_CHARS ||
                    it.flagId.length > MAX_FLAG_ID_CHARS ||
                    it.protobuf.isEmpty() || it.protobuf.size > MAX_PROTO_BYTES
            }
        ) return null
        if (assignments.map(EncodedAssignment::flagName).toSet().size != assignments.size) {
            return null
        }

        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(longBytes(assignments.size.toLong()))
        assignments.sortedWith(compareBy(EncodedAssignment::flagName, EncodedAssignment::flagId))
            .forEach { assignment ->
                digest.update(longBytes(assignment.protobuf.size.toLong()))
                digest.update(assignment.protobuf)
            }
        return digest.digest().joinToString("") { byte ->
            HEX[(byte.toInt() ushr 4) and 0x0f].toString() + HEX[byte.toInt() and 0x0f]
        }
    }

    internal fun appliedAssignmentsMatch(
        expected: List<AppliedAssignment>,
        read: (String) -> AppliedAssignment?,
    ): Boolean = expected.isNotEmpty() &&
        expected.map(AppliedAssignment::key).toSet().size == expected.size &&
        expected.all { assignment -> read(assignment.key) == assignment }

    private fun longBytes(value: Long): ByteArray =
        ByteBuffer.allocate(java.lang.Long.BYTES).putLong(value).array()

    private const val MAX_ASSIGNMENTS = 256
    private const val MAX_FLAG_NAME_CHARS = 256
    private const val MAX_FLAG_ID_CHARS = 256
    private const val MAX_PROTO_BYTES = 16 * 1024
    private const val HEX = "0123456789abcdef"
}
