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
import java.lang.reflect.Method
import java.security.MessageDigest
import java.util.LinkedHashSet
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import com.penumbraos.ipc.contract.PenumbraIpcContract
import com.penumbraos.stockaibus.contract.StockSymbols
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * Emits a diagnostic receipt only after the stock Messages store has inserted
 * an outgoing DELIVERED message successfully. It does not participate in sending
 * and cannot turn a pending or failed message into a successful one.
 * Export is deliberately best-effort and bounded. It is not a durable delivery
 * queue and a failed bridge call is not retried without a later stock event.
 */
object MessageStatusHooks {
    private const val TAG = "LumaCompatibility"
    private const val BRIDGE_PACKAGE = "com.penumbraos.server"
    private const val BRIDGE_CLASS = "com.penumbraos.server.MessageStatusBridgeService"
    private const val BRIDGE_DESCRIPTOR =
        TierASymbols.Binder.PenumbraMessageStatus.DESCRIPTOR
    private const val TRANSACTION_RECORD_DELIVERED =
        PenumbraIpcContract.MessageStatus.TRANSACTION_RECORD_DELIVERED
    private const val DELIVERED_STATE = 2L
    private const val BIND_TIMEOUT_MS = 3_000L
    private const val MAX_PUBLISHED_DELIVERIES = 128
    internal const val MAX_BODY_CHARS = 480
    internal const val MAX_RECIPIENTS = 16
    internal const val MAX_RECIPIENT_CHARS = 64

    private val exporter = ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(32),
        ThreadPoolExecutor.DiscardOldestPolicy(),
    )
    private val publishedDeliveries = PublishedDeliveries(MAX_PUBLISHED_DELIVERIES)

    fun install(classLoader: ClassLoader) {
        try {
            val storeClass = classLoader.loadClass(
                StockSymbols.Messages.PERSISTENT_MESSAGE_STORE_CLASS,
            )
            val messageClass = classLoader.loadClass("humane.experience.messages.model.Message")
            val conversationClass = classLoader.loadClass(
                "humane.experience.messages.model.Conversation",
            )
            val addMessage = storeClass.getDeclaredMethod(
                "addMessage",
                messageClass,
                conversationClass,
            ).apply { isAccessible = true }
            check(addMessage.returnType == Long::class.javaPrimitiveType)
            val getMessageForId = storeClass.getDeclaredMethod(
                "getMessageForID",
                Long::class.javaPrimitiveType!!,
            ).apply { isAccessible = true }
            check(getMessageForId.returnType == messageClass)
            val getConversationById = storeClass.getDeclaredMethod(
                "getConversationById",
                Long::class.javaPrimitiveType!!,
            ).apply { isAccessible = true }
            check(getConversationById.returnType == conversationClass)
            XposedBridge.hookMethod(addMessage, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable != null) return
                    val store = param.thisObject ?: return
                    val candidate = deliveredInsertCandidate(
                        result = param.result,
                        message = param.args.getOrNull(0),
                        conversation = param.args.getOrNull(1),
                    ) ?: return
                    exporter.execute {
                        val record = resolveCommittedRecord(
                            store,
                            candidate.identity.messageId,
                            getMessageForId,
                            getConversationById,
                        ) ?: return@execute
                        if (!candidate.matches(record)) return@execute
                        publishedDeliveries.publishOnce(record.identity()) { publish(record) }
                    }
                }
            })
            Log.w(TAG, "  MessageStatusHooks installed on stock delivered-message insert")
        } catch (error: Throwable) {
            Log.e(TAG, "  MessageStatusHooks install failed: ${error.javaClass.simpleName}")
        }
    }

    internal fun deliveredInsertCandidate(
        result: Any?,
        message: Any?,
        conversation: Any?,
    ): DeliveredCandidate? =
        runCatching {
            val messageId = result as? Long ?: return null
            if (messageId < 0) return null
            if (message == null || conversation == null) return null
            val conversationId = (call(conversation, "id") as? Number)?.toLong() ?: return null
            if (conversationId < 0) return null
            val sender = call(message, "sender") ?: return null
            if (call(sender, "isMe") as? Boolean != true) return null
            val state = call(message, "state") ?: return null
            val stateValue = (call(state, "value") as? Number)?.toLong() ?: return null
            if (stateValue != DELIVERED_STATE) return null
            val body = call(message, "body") as? String ?: return null
            if (body.isBlank() || body.length > MAX_BODY_CHARS) return null
            val timestamp = (call(message, "timestampMillis") as? Number)?.toLong() ?: return null
            if (timestamp <= 0) return null
            val recipientValues =
                call(conversation, "participantAddressesWithoutHost") as? List<*> ?: return null
            val recipients = boundedRecipients(recipientValues) ?: return null
            DeliveredCandidate(
                DeliveredIdentity(
                    messageId = messageId,
                    conversationId = conversationId,
                    timestampMs = timestamp,
                    state = stateValue,
                    payloadFingerprint = deliveredPayloadFingerprint(body, recipients),
                ),
            )
        }.getOrNull()

    internal fun resolveCommittedRecord(
        store: Any,
        messageId: Long,
        getMessageForId: Method,
        getConversationById: Method,
    ): DeliveredRecord? = runCatching {
        val message = getMessageForId.invoke(store, messageId) ?: return null
        val conversationId = (call(message, "conversationId") as? Number)?.toLong() ?: return null
        if (conversationId < 0) return null
        val conversation = getConversationById.invoke(store, conversationId) ?: return null
        extractRecord(messageId, message, conversation)
    }.getOrNull()

    internal fun extractRecord(id: Any?, message: Any?, conversation: Any?): DeliveredRecord? {
        if (message == null || conversation == null) return null
        return runCatching {
            val messageId = (id as? Number)?.toLong()?.takeIf { it >= 0 } ?: return null
            val storedMessageId = (call(message, "id") as? Number)?.toLong() ?: return null
            if (storedMessageId != messageId) return null
            val conversationId = (call(message, "conversationId") as? Number)?.toLong() ?: return null
            val storedConversationId = (call(conversation, "id") as? Number)?.toLong() ?: return null
            if (conversationId < 0 || storedConversationId != conversationId) return null
            val sender = call(message, "sender") ?: return null
            if (call(sender, "isMe") as? Boolean != true) return null
            val state = call(message, "state") ?: return null
            val stateValue = (call(state, "value") as? Number)?.toLong() ?: return null
            if (stateValue != DELIVERED_STATE) return null
            val body = call(message, "body") as? String ?: return null
            if (body.isBlank() || body.length > MAX_BODY_CHARS) return null
            val timestamp = (call(message, "timestampMillis") as? Number)?.toLong() ?: return null
            if (timestamp <= 0) return null
            val recipientValues =
                call(conversation, "participantAddressesWithoutHost") as? List<*> ?: return null
            val recipients = boundedRecipients(recipientValues) ?: return null
            DeliveredRecord(
                messageId = messageId,
                conversationId = conversationId,
                timestampMs = timestamp,
                state = stateValue,
                body = body,
                recipients = recipients,
            )
        }.getOrNull()
    }

    private fun boundedRecipients(values: List<*>): List<String>? {
        if (values.size !in 1..MAX_RECIPIENTS || values.any { it !is String }) return null
        val recipients = values.map { it as String }.distinct()
        if (recipients.any { recipient ->
                recipient.isBlank() ||
                    recipient.length > MAX_RECIPIENT_CHARS ||
                    recipient.any(Char::isISOControl)
            }
        ) return null
        return recipients
    }

    internal fun deliveredPayloadFingerprint(body: String, recipients: List<String>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        fun updateFramed(value: String) {
            val bytes = value.toByteArray(Charsets.UTF_8)
            digest.update((bytes.size ushr 24).toByte())
            digest.update((bytes.size ushr 16).toByte())
            digest.update((bytes.size ushr 8).toByte())
            digest.update(bytes.size.toByte())
            digest.update(bytes)
        }
        updateFramed(body)
        recipients.sorted().forEach(::updateFramed)
        return digest.digest().joinToString(separator = "") { byte -> "%02x".format(byte) }
    }

    private fun publish(record: DeliveredRecord): Boolean {
        val context = currentApplication() ?: return false
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
                connection,
                Context.BIND_AUTO_CREATE,
            )
            if (!bound || !connected.await(BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw IOException("Message status bridge connection timed out")
            }
            val binder = remote
            if (disconnected || binder == null || !binder.isBinderAlive) {
                throw IOException("Message status bridge is unavailable")
            }
            val data = Parcel.obtain()
            val reply = Parcel.obtain()
            try {
                data.writeInterfaceToken(BRIDGE_DESCRIPTOR)
                data.writeLong(record.messageId)
                data.writeLong(record.timestampMs)
                data.writeLong(record.state)
                data.writeString(record.body)
                data.writeInt(record.recipients.size)
                record.recipients.forEach(data::writeString)
                if (!binder.transact(TRANSACTION_RECORD_DELIVERED, data, reply, 0)) {
                    throw IOException("Message status bridge rejected receipt")
                }
                reply.readException()
                if (reply.readInt() != 1) throw IOException("Message status bridge rejected receipt")
            } finally {
                data.recycle()
                reply.recycle()
            }
            Log.i(TAG, "  Stock delivered-message receipt verified in-process")
            return true
        } catch (error: Throwable) {
            Log.w(TAG, "  Message status receipt failed: ${error.javaClass.simpleName}")
            return false
        } finally {
            if (bound) runCatching { context.unbindService(connection) }
        }
    }

    private fun currentApplication(): Context? = runCatching {
        Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Context
    }.getOrNull()?.applicationContext

    private fun call(instance: Any, name: String): Any? =
        findMethod(instance.javaClass, name)?.invoke(instance)

    private fun findMethod(type: Class<*>, name: String): Method? {
        var current: Class<*>? = type
        while (current != null) {
            current.declaredMethods.firstOrNull {
                it.name == name && it.parameterTypes.isEmpty()
            }?.let { method ->
                method.isAccessible = true
                return method
            }
            current = current.superclass
        }
        return null
    }

    internal data class DeliveredRecord(
        val messageId: Long,
        val conversationId: Long,
        val timestampMs: Long,
        val state: Long,
        val body: String,
        val recipients: List<String>,
    ) {
        fun identity(): DeliveredIdentity = DeliveredIdentity(
            messageId = messageId,
            conversationId = conversationId,
            timestampMs = timestampMs,
            state = state,
            payloadFingerprint = deliveredPayloadFingerprint(body, recipients),
        )
    }

    internal data class DeliveredCandidate(val identity: DeliveredIdentity) {
        fun matches(record: DeliveredRecord): Boolean = identity == record.identity()
    }

    internal data class DeliveredIdentity(
        val messageId: Long,
        val conversationId: Long,
        val timestampMs: Long,
        val state: Long,
        val payloadFingerprint: String,
    )

    /** Tracks confirmed bridge successes only. This class does not schedule retries. */
    internal class PublishedDeliveries(private val capacity: Int) {
        init {
            require(capacity > 0)
        }

        private val deliveries = LinkedHashSet<DeliveredIdentity>()

        @Synchronized
        fun contains(identity: DeliveredIdentity): Boolean = identity in deliveries

        @Synchronized
        fun publishOnce(identity: DeliveredIdentity, publisher: () -> Boolean): Boolean {
            if (identity in deliveries || !publisher()) return false
            deliveries.remove(identity)
            deliveries.add(identity)
            while (deliveries.size > capacity) {
                val oldest = deliveries.iterator()
                oldest.next()
                oldest.remove()
            }
            return true
        }
    }
}
