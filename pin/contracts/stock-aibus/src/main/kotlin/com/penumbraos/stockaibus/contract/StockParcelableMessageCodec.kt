package com.penumbraos.stockaibus.contract

import android.os.Parcel

/** Logical contents of stock `humane.grpc.ParcelableMessageLite`. */
class StockProtoEnvelope private constructor(
    val className: String,
    val payload: ByteArray,
) {
    companion object {
        fun create(className: String, payload: ByteArray): StockProtoEnvelope {
            require(StockAiBusContract.isValidProtoClassName(className)) {
                "Invalid stock protobuf class name"
            }
            require(payload.size <= StockParcelableMessageCodec.MAX_PAYLOAD_BYTES) {
                "Stock protobuf payload is too large"
            }
            return StockProtoEnvelope(className, payload.copyOf())
        }
    }
}

/** Exact parcel ordering used by the stock ParcelableMessageLite wrapper. */
object StockParcelableMessageCodec {
    const val MAX_CLASS_NAME_BYTES = 160
    const val MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

    fun readRequiredTypedObject(parcel: Parcel): StockProtoEnvelope {
        return requireNotNull(readOptionalTypedObject(parcel)) {
            "Stock ParcelableMessageLite payload is required"
        }
    }

    fun readOptionalTypedObject(parcel: Parcel): StockProtoEnvelope? {
        if (parcel.readInt() == 0) return null
        if (parcel.readInt() == 0) return null
        val className = requireNotNull(parcel.readString()) {
            "Stock ParcelableMessageLite class name is required"
        }
        val payload = requireNotNull(parcel.createByteArray()) {
            "Stock ParcelableMessageLite bytes are required"
        }
        return StockProtoEnvelope.create(className, payload)
    }

    fun writeRequiredTypedObject(parcel: Parcel, envelope: StockProtoEnvelope) {
        parcel.writeInt(1)
        parcel.writeInt(1)
        parcel.writeString(envelope.className)
        parcel.writeByteArray(envelope.payload)
    }
}
