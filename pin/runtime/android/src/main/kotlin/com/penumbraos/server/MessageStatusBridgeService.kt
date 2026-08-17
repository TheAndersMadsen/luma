package com.penumbraos.server

import android.app.ActivityManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.telephony.PhoneNumberUtils
import com.penumbraos.stockaibus.contract.TierASymbols
import java.util.ArrayDeque

/**
 * Receives a bounded, in-memory success receipt from the injected stock
 * Messages process after PersistentMessageStore commits an outgoing DELIVERED
 * row. This avoids cross-domain reads of the Messages private SQLite database,
 * which SELinux correctly denies even though both APKs use the system UID.
 */
class MessageStatusBridgeService : Service() {
    private val binder = MessageStatusBridgeBinder()

    override fun onBind(intent: Intent?): IBinder = binder

    private inner class MessageStatusBridgeBinder : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            enforceMessagesCaller()
            if (code == INTERFACE_TRANSACTION) {
                requireNotNull(reply).writeString(MessageStatusBridgeProtocol.DESCRIPTOR)
                return true
            }
            if (code != MessageStatusBridgeProtocol.TRANSACTION_RECORD_DELIVERED ||
                flags and FLAG_ONEWAY != 0 || reply == null
            ) throw SecurityException("Unsupported message status bridge transaction")

            data.enforceInterface(MessageStatusBridgeProtocol.DESCRIPTOR)
            val messageId = data.readLong()
            val timestampMs = data.readLong()
            val state = data.readLong()
            val body = data.readString().orEmpty()
            val recipientCount = data.readInt()
            require(recipientCount in 1..MessageStatusBridgeProtocol.MAX_RECIPIENTS) {
                "Message recipient count is invalid"
            }
            val recipients = ArrayList<String>(recipientCount)
            repeat(recipientCount) { recipients += data.readString().orEmpty() }
            require(data.dataAvail() == 0) { "Unexpected message status bridge data" }

            val record = MessageStatusBridgeProtocol.validate(
                MessageStatusRecord(messageId, timestampMs, state, body, recipients),
            )
            MessageStatusRepository.record(record)
            reply.writeNoException()
            reply.writeInt(1)
            return true
        }
    }

    private fun enforceMessagesCaller() {
        val callingUid = Binder.getCallingUid()
        val callingPid = Binder.getCallingPid()
        val expectedUid = try {
            packageManager.getPackageUid(MessageStatusBridgeProtocol.MESSAGES_PACKAGE, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            throw SecurityException("Authorized Messages caller is unavailable")
        }
        val packages = packageManager.getPackagesForUid(callingUid).orEmpty().toSet()
        if (!MessageStatusCallerAdmission.isAuthorized(
                callingUid,
                expectedUid,
                packages,
                readProcessName(callingPid),
            )
        ) throw SecurityException("Caller is not authorized for message status import")
    }

    private fun readProcessName(pid: Int): String? = runCatching {
        val activityManager = getSystemService(ActivityManager::class.java) ?: return@runCatching null
        activityManager.runningAppProcesses
            .orEmpty()
            .asSequence()
            .filter { it.pid == pid }
            .mapNotNull { it.processName?.takeIf(String::isNotBlank) }
            .distinct()
            .singleOrNull()
    }.getOrNull()
}

internal object MessageStatusCallerAdmission {
    fun isAuthorized(
        callingUid: Int,
        expectedUid: Int,
        packages: Set<String>,
        processName: String?,
    ): Boolean = callingUid == expectedUid &&
        MessageStatusBridgeProtocol.MESSAGES_PACKAGE in packages &&
        processName == MessageStatusBridgeProtocol.MESSAGES_PACKAGE
}

internal object MessageStatusBridgeProtocol {
    const val DESCRIPTOR = TierASymbols.Binder.PenumbraMessageStatus.DESCRIPTOR
    const val MESSAGES_PACKAGE = TierASymbols.Packages.MESSAGES
    const val TRANSACTION_RECORD_DELIVERED =
        TierASymbols.Binder.PenumbraMessageStatus.TRANSACTION_RECORD_DELIVERED
    const val MAX_RECIPIENTS = 16
    const val MAX_BODY_CHARS = 480
    const val MAX_RECIPIENT_CHARS = 64
    const val DELIVERED_STATE = 2L

    fun validate(record: MessageStatusRecord): MessageStatusRecord {
        require(record.messageId >= 0) { "Message id is invalid" }
        require(record.timestampMs > 0) { "Message timestamp is invalid" }
        require(record.state == DELIVERED_STATE) { "Only delivered messages may be recorded" }
        require(record.body.isNotBlank() && record.body.length <= MAX_BODY_CHARS) {
            "Message body is invalid"
        }
        require(record.recipients.size in 1..MAX_RECIPIENTS) { "Message recipients are invalid" }
        record.recipients.forEach { recipient ->
            require(recipient.isNotBlank() && recipient.length <= MAX_RECIPIENT_CHARS) {
                "Message recipient is invalid"
            }
            require(recipient.none(Char::isISOControl)) {
                "Message recipient contains control characters"
            }
        }
        return record
    }
}

internal data class MessageStatusRecord(
    val messageId: Long,
    val timestampMs: Long,
    val state: Long,
    val body: String,
    val recipients: List<String>,
)

/** Process-private and deliberately non-persistent diagnostic receipts. */
internal object MessageStatusRepository {
    private const val MAX_RECORDS = 128
    private const val MAX_AGE_MS = 60 * 60 * 1_000L
    private val records = ArrayDeque<MessageStatusRecord>()

    @Synchronized
    fun record(record: MessageStatusRecord) {
        val validated = MessageStatusBridgeProtocol.validate(record)
        purgeExpired(System.currentTimeMillis())
        records.removeAll { it.messageId == validated.messageId }
        records.addFirst(validated.copy(recipients = validated.recipients.toList()))
        while (records.size > MAX_RECORDS) records.removeLast()
    }

    @Synchronized
    fun status(
        body: String,
        expectedRecipient: String,
        afterMs: Long,
        nowMs: Long = System.currentTimeMillis(),
    ): MessageStatusRecord? {
        purgeExpired(nowMs)
        return records.firstOrNull { record ->
            record.body == body &&
                record.timestampMs >= afterMs &&
                recipientMatches(record, expectedRecipient)
        }
    }

    fun recipientMatches(record: MessageStatusRecord, expected: String): Boolean =
        record.recipients.any { actual ->
            actual == expected || runCatching {
                PhoneNumberUtils.compare(actual, expected)
            }.getOrDefault(false)
        }

    @Synchronized
    internal fun clearForTest() {
        records.clear()
    }

    private fun purgeExpired(nowMs: Long) {
        records.removeAll { record ->
            record.timestampMs > nowMs + 5 * 60 * 1_000L || nowMs - record.timestampMs > MAX_AGE_MS
        }
    }
}
