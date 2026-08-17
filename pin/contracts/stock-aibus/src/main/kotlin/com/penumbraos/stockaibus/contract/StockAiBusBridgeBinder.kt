package com.penumbraos.stockaibus.contract

import android.os.Binder
import android.os.IBinder
import android.os.Parcel

/**
 * Non-installed Binder skeleton for the future local `IAiBusBridge` adapter.
 *
 * It already enforces descriptor, caller authorization, synchronous stock call
 * semantics, and the versioned transaction table. Method-specific parcel
 * decoding and transport dispatch are supplied by [TransactionHandler] during
 * the next migration slice.
 */
class StockAiBusBridgeBinder(
    private val callerAuthorized: () -> Boolean,
    private val handler: TransactionHandler,
) : Binder() {
    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == INTERFACE_TRANSACTION) {
            requireNotNull(reply) { "IAiBusBridge interface query requires a reply" }
            reply.writeString(StockAiBusContract.DESCRIPTOR)
            return true
        }

        val transaction = StockAiBusContract.transaction(code) ?: return false
        if (!callerAuthorized()) {
            throw SecurityException("Caller is not authorized for the local AI Bus bridge")
        }
        if (flags and IBinder.FLAG_ONEWAY != 0 || reply == null) {
            throw SecurityException("Stock IAiBusBridge transactions are synchronous Binder calls")
        }

        data.enforceInterface(StockAiBusContract.DESCRIPTOR)
        return handler.handle(transaction, data, reply)
    }

    fun interface TransactionHandler {
        fun handle(transaction: Transaction, data: Parcel, reply: Parcel): Boolean
    }
}
