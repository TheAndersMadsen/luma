package com.penumbraos.server.stockaibus

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.ByteArrayOutputStream

/** Exact plaintext-in-EncryptedData wrapper used by the local Rust adapter. */
internal object StockAiBusProtoCodec {
    const val MAX_MESSAGE_BYTES = 8 * 1024 * 1024
    const val UNDERSTAND_REQUEST_KID = TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_REQUEST
    const val LOCATION_KID = TierASymbols.ProtoKids.LOCATION_ENVELOPE
    const val UNDERSTAND_RESPONSE_KID = TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_RESPONSE
    const val NEARBY_REQUEST_KID = TierASymbols.ProtoKids.NEARBY_SEARCH_REQUEST
    const val NEARBY_RESPONSE_KID = TierASymbols.ProtoKids.NEARBY_SEARCH_RESPONSE

    data class UnderstandRequest(val request: ByteArray, val location: ByteArray?)

    fun encodeEncryptedUnderstandRequest(request: ByteArray, location: ByteArray?): ByteArray {
        require(request.isNotEmpty() && request.size <= MAX_MESSAGE_BYTES) {
            "Invalid stock Understand request size"
        }
        if (location != null) {
            require(location.isNotEmpty() && location.size <= MAX_MESSAGE_BYTES) {
                "Invalid stock location envelope size"
            }
        }
        return message {
            writeBytes(1, encryptedData(UNDERSTAND_REQUEST_KID, request))
            if (location != null) writeBytes(2, encryptedData(LOCATION_KID, location))
        }
    }

    fun decodeEncryptedUnderstandRequest(encoded: ByteArray): UnderstandRequest {
        val fields = readLengthDelimitedFields(encoded, setOf(1, 2))
        val request = fields[1]?.singleOrNull()
            ?: throw IllegalArgumentException("Encrypted Understand request is missing request data")
        val locationFields = fields[2].orEmpty()
        require(locationFields.size <= 1) { "Encrypted Understand request repeated location data" }
        return UnderstandRequest(
            request = decodeEncryptedData(request, UNDERSTAND_REQUEST_KID),
            location = locationFields.singleOrNull()?.let { decodeEncryptedData(it, LOCATION_KID) },
        )
    }

    fun encodeEncryptedUnderstandResponse(response: ByteArray): ByteArray {
        require(response.isNotEmpty() && response.size <= MAX_MESSAGE_BYTES) {
            "Invalid stock Understand response size"
        }
        return message {
            writeBytes(1, encryptedData(UNDERSTAND_RESPONSE_KID, response))
        }
    }

    fun decodeEncryptedUnderstandResponse(encoded: ByteArray): ByteArray {
        val response = readLengthDelimitedFields(encoded, setOf(1))[1]?.singleOrNull()
            ?: throw IllegalArgumentException("Encrypted Understand response is missing response data")
        return decodeEncryptedData(response, UNDERSTAND_RESPONSE_KID)
    }

    fun encodeEncryptedNearbyRequest(request: ByteArray): ByteArray {
        require(request.isNotEmpty() && request.size <= MAX_MESSAGE_BYTES) {
            "Invalid stock Nearby request size"
        }
        return message {
            writeBytes(1, encryptedData(NEARBY_REQUEST_KID, request))
        }
    }

    internal fun decodeEncryptedNearbyRequest(encoded: ByteArray): ByteArray {
        val request = readLengthDelimitedFields(encoded, setOf(1))[1]?.singleOrNull()
            ?: throw IllegalArgumentException("Encrypted Nearby request is missing request data")
        return decodeEncryptedData(request, NEARBY_REQUEST_KID)
    }

    internal fun encodeEncryptedNearbyResponse(response: ByteArray): ByteArray {
        require(response.isNotEmpty() && response.size <= MAX_MESSAGE_BYTES) {
            "Invalid stock Nearby response size"
        }
        return message {
            writeBytes(1, encryptedData(NEARBY_RESPONSE_KID, response))
        }
    }

    fun decodeEncryptedNearbyResponse(encoded: ByteArray): ByteArray {
        val response = readLengthDelimitedFields(encoded, setOf(1))[1]?.singleOrNull()
            ?: throw IllegalArgumentException("Encrypted Nearby response is missing response data")
        return decodeEncryptedData(response, NEARBY_RESPONSE_KID)
    }

    private fun encryptedData(kid: String, payload: ByteArray): ByteArray = message {
        writeBytes(1, message { writeString(1, kid) })
        writeBytes(2, payload)
    }

    private fun decodeEncryptedData(encoded: ByteArray, expectedKid: String): ByteArray {
        val fields = readLengthDelimitedFields(encoded, setOf(1, 2))
        val information = fields[1]?.singleOrNull()
            ?: throw IllegalArgumentException("EncryptedData is missing encryption information")
        val informationFields = readLengthDelimitedFields(information, setOf(1))
        val kidBytes = informationFields[1]?.singleOrNull()
            ?: throw IllegalArgumentException("EncryptedData is missing KID")
        val kid = kidBytes.toString(Charsets.UTF_8)
        require(kid == expectedKid) { "EncryptedData KID does not match the stock contract" }
        val payload = fields[2]?.singleOrNull()
            ?: throw IllegalArgumentException("EncryptedData is missing payload bytes")
        require(payload.isNotEmpty() && payload.size <= MAX_MESSAGE_BYTES) {
            "EncryptedData payload is outside bounds"
        }
        return payload
    }

    private fun readLengthDelimitedFields(
        encoded: ByteArray,
        acceptedFields: Set<Int>,
    ): Map<Int, List<ByteArray>> {
        require(encoded.size <= MAX_MESSAGE_BYTES) { "Protobuf message is too large" }
        val reader = Reader(encoded)
        val values = mutableMapOf<Int, MutableList<ByteArray>>()
        while (!reader.exhausted()) {
            val tag = reader.readVarint().toInt()
            require(tag != 0) { "Invalid protobuf tag" }
            val field = tag ushr 3
            val wireType = tag and 7
            if (field in acceptedFields) {
                require(wireType == WIRE_LENGTH_DELIMITED) {
                    "Stock protobuf field has an unexpected wire type"
                }
                values.getOrPut(field, ::mutableListOf).add(reader.readBytes())
            } else {
                reader.skip(wireType)
            }
        }
        return values
    }

    private inline fun message(block: Writer.() -> Unit): ByteArray =
        Writer().apply(block).toByteArray()

    private class Writer {
        private val output = ByteArrayOutputStream()

        fun writeString(field: Int, value: String) = writeBytes(field, value.toByteArray(Charsets.UTF_8))

        fun writeBytes(field: Int, value: ByteArray) {
            require(field > 0)
            require(value.size <= MAX_MESSAGE_BYTES)
            writeVarint(((field shl 3) or WIRE_LENGTH_DELIMITED).toLong())
            writeVarint(value.size.toLong())
            output.write(value)
        }

        private fun writeVarint(value: Long) {
            var remaining = value
            while (remaining and -128L != 0L) {
                output.write(((remaining and 0x7f) or 0x80).toInt())
                remaining = remaining ushr 7
            }
            output.write(remaining.toInt())
        }

        fun toByteArray(): ByteArray = output.toByteArray().also {
            require(it.size <= MAX_MESSAGE_BYTES) { "Encoded protobuf message is too large" }
        }
    }

    private class Reader(private val input: ByteArray) {
        private var offset = 0

        fun exhausted(): Boolean = offset == input.size

        fun readVarint(): Long {
            var result = 0L
            for (shift in 0 until 64 step 7) {
                require(offset < input.size) { "Truncated protobuf varint" }
                val byte = input[offset++].toInt() and 0xff
                result = result or ((byte and 0x7f).toLong() shl shift)
                if (byte and 0x80 == 0) return result
            }
            throw IllegalArgumentException("Protobuf varint is too long")
        }

        fun readBytes(): ByteArray {
            val length = readVarint()
            require(length in 0..MAX_MESSAGE_BYTES.toLong()) {
                "Protobuf field length is outside bounds"
            }
            val end = offset.toLong() + length
            require(end <= input.size.toLong()) { "Truncated protobuf bytes field" }
            return input.copyOfRange(offset, end.toInt()).also { offset = end.toInt() }
        }

        fun skip(wireType: Int) {
            when (wireType) {
                WIRE_VARINT -> readVarint()
                WIRE_FIXED_64 -> skipBytes(8)
                WIRE_LENGTH_DELIMITED -> skipBytes(readVarint().toInt())
                WIRE_FIXED_32 -> skipBytes(4)
                else -> throw IllegalArgumentException("Unsupported protobuf wire type")
            }
        }

        private fun skipBytes(length: Int) {
            require(length >= 0 && offset.toLong() + length <= input.size.toLong()) {
                "Truncated protobuf field"
            }
            offset += length
        }
    }

    private const val WIRE_VARINT = 0
    private const val WIRE_FIXED_64 = 1
    private const val WIRE_LENGTH_DELIMITED = 2
    private const val WIRE_FIXED_32 = 5
}
