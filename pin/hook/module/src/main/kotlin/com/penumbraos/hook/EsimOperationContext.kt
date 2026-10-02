package com.penumbraos.hook

import java.util.concurrent.atomic.AtomicReference

data class EsimOperationSnapshot(
    val action: String,
    val requestId: String,
    val operationToken: String,
    val iccid: String?,
    val nickname: String?,
    val source: String?,
    val bridgeAuthToken: String,
    val activationCodeProvided: Boolean,
) {
    private val downloadIccidRef = AtomicReference<String?>(null)

    var downloadIccid: String?
        get() = downloadIccidRef.get()
        set(value) = downloadIccidRef.set(value)
}

object EsimOperationContext {

    private val current = AtomicReference<EsimOperationSnapshot?>(null)

    fun begin(
        action: String?,
        requestId: String?,
        operationToken: String?,
        iccid: String?,
        nickname: String?,
        source: String?,
        bridgeAuthToken: String?,
        activationCodeProvided: Boolean,
    ): EsimOperationSnapshot? {
        if (action.isNullOrBlank() || requestId.isNullOrBlank() || operationToken.isNullOrBlank() ||
            bridgeAuthToken.isNullOrBlank()
        ) {
            current.set(null)
            return null
        }
        return EsimOperationSnapshot(
            action = action,
            requestId = requestId,
            operationToken = operationToken,
            iccid = iccid,
            nickname = nickname,
            source = source,
            bridgeAuthToken = bridgeAuthToken,
            activationCodeProvided = activationCodeProvided,
        ).also(current::set)
    }

    fun snapshot(): EsimOperationSnapshot? = current.get()

    fun clear() {
        current.set(null)
    }
}
