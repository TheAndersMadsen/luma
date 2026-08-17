package com.penumbraos.stockaibus.contract

import android.os.IBinder
import android.os.Parcel

/** Raw Binder proxy for stock `humane.grpc.IStreamObserver`. */
class StockStreamObserverProxy(private val remote: IBinder) {
    fun onNext(envelope: StockProtoEnvelope) {
        transact(TierASymbols.Binder.StreamObserver.TRANSACTION_ON_NEXT) { parcel ->
            StockParcelableMessageCodec.writeRequiredTypedObject(parcel, envelope)
        }
    }

    fun onError(code: String) {
        require(
            code.length <= MAX_ERROR_CODE_BYTES &&
                code.all { character -> character.isLetterOrDigit() || character == '_' },
        ) {
            "Invalid stock observer error code"
        }
        transact(TierASymbols.Binder.StreamObserver.TRANSACTION_ON_ERROR) { parcel ->
            parcel.writeString(code)
        }
    }

    fun onCompleted() {
        transact(TierASymbols.Binder.StreamObserver.TRANSACTION_ON_COMPLETED) {}
    }

    private inline fun transact(code: Int, writeBody: (Parcel) -> Unit) {
        val data = Parcel.obtain()
        try {
            data.writeInterfaceToken(TierASymbols.Binder.StreamObserver.DESCRIPTOR)
            writeBody(data)
            check(remote.transact(code, data, null, IBinder.FLAG_ONEWAY)) {
                "Stock stream observer rejected transaction"
            }
        } finally {
            data.recycle()
        }
    }

    private companion object {
        const val MAX_ERROR_CODE_BYTES = 64
    }
}
