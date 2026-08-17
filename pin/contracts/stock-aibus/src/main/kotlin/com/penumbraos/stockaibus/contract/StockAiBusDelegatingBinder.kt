package com.penumbraos.stockaibus.contract

import android.os.Binder
import android.os.IBinder
import android.os.Parcel

/**
 * Preserves the original stock bridge while selected transactions migrate to a
 * local Binder implementation. A missing local Binder always delegates to
 * stock; a local Binder that accepted a transaction is never replayed to stock.
 */
class StockAiBusDelegatingBinder(
    private val original: IBinder,
    private val localBinder: () -> IBinder?,
    private val localTransactionCodes: Set<Int>,
) : Binder() {
    init {
        require(localTransactionCodes.isNotEmpty())
        require(localTransactionCodes.all { StockAiBusContract.transaction(it) != null })
    }

    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == INTERFACE_TRANSACTION) {
            requireNotNull(reply) { "IAiBusBridge interface query requires a reply" }
            reply.writeString(StockAiBusContract.DESCRIPTOR)
            return true
        }

        val local = if (code in localTransactionCodes) localBinder() else null
        val target = if (shouldRouteLocal(code, local != null, localTransactionCodes)) {
            requireNotNull(local)
        } else {
            original
        }
        val forwarded = Parcel.obtain()
        return try {
            forwarded.appendFrom(data, 0, data.dataSize())
            forwarded.setDataPosition(0)
            target.transact(code, forwarded, reply, flags)
        } finally {
            forwarded.recycle()
        }
    }

    companion object {
        fun shouldRouteLocal(
            code: Int,
            localAvailable: Boolean,
            localTransactionCodes: Set<Int>,
        ): Boolean = localAvailable && code in localTransactionCodes
    }
}
