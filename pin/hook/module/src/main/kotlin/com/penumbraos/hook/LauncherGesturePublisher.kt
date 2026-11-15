package com.penumbraos.hook

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Parcel
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import dev.luma.gestures.ClipSnapshot
import dev.luma.gestures.GestureObservation
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Latest-only diagnostics on a worker; a slow inspector never stalls stock UI. */
internal class LauncherGesturePublisher(private val onClip: (ClipSnapshot?) -> Unit) {
    @Volatile private var remote: IBinder? = null
    private var context: Context? = null
    private var retryAt = 0L
    private val main = Handler(Looper.getMainLooper())
    private val pendingCopy = AtomicReference<String?>(null)
    private val worker = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue(1),
        { task -> Thread(task, "luma-gesture-observation").apply { isDaemon = true } },
        ThreadPoolExecutor.DiscardOldestPolicy()).apply { allowCoreThreadTimeOut(true) }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) { remote = service }
        override fun onServiceDisconnected(name: ComponentName?) { remote = null }
        override fun onBindingDied(name: ComponentName?) { close() }
        override fun onNullBinding(name: ComponentName?) { close() }
    }

    fun open(value: Context) {
        if (context != null || SystemClock.elapsedRealtime() < retryAt) return
        val app = value.applicationContext
        context = app
        if (!runCatching { app.bindService(Intent().setComponent(ComponentName("com.penumbraos.server",
                GestureObservation.SERVICE_CLASS)), connection, Context.BIND_AUTO_CREATE) }.getOrDefault(false)) {
            context = null
            retryAt = SystemClock.elapsedRealtime() + 2_000
        }
    }

    fun close() {
        remote = null
        pendingCopy.set(null)
        worker.queue.clear()
        context?.let { runCatching { it.unbindService(connection) } }
        context = null
    }

    fun publish(observation: GestureObservation) {
        val binder = remote ?: return
        val raw = observation.toJson().toString()
        worker.execute {
            if (remote !== binder) return@execute
            val data = Parcel.obtain()
            val reply = Parcel.obtain()
            try {
                data.writeInterfaceToken(GestureObservation.DESCRIPTOR)
                data.writeString(raw)
                val copyId = pendingCopy.get()
                data.writeString(copyId)
                // Synchronous on this worker preserves calling PID at the
                // shared system UID boundary. No waits on the launcher thread.
                check(binder.transact(GestureObservation.TRANSACTION_REPORT, data, reply, 0))
                reply.readException()
                val clip = reply.readString()?.let { ClipSnapshot.parse(JSONObject(it)) }
                if (copyId != null && (clip?.article?.id != copyId || clip.phase != "ready")) pendingCopy.compareAndSet(copyId, null)
                main.post { if (remote === binder) onClip(clip) }
            } catch (_: Exception) {
                main.post { if (remote === binder) { close(); retryAt = SystemClock.elapsedRealtime() + 2_000 } }
            }
            finally { reply.recycle(); data.recycle() }
        }
    }

    fun copy(id: String) { pendingCopy.set(id) }
    fun cancelCopy() { pendingCopy.set(null) }
}
