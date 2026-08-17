package com.penumbraos.server

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols

object EsimController {

    private const val TAG = "PenumbraEsimController"
    private const val LPA_PACKAGE = TierASymbols.Packages.ESIM_LPA
    private const val FACTORY_SERVICE_CLASS = TierASymbols.Packages.ESIM_LPA + ".factoryService"
    internal const val BRIDGE_AUTH_TOKEN_EXTRA = "penumbra_bridge_auth_token"
    internal const val OPERATION_TOKEN_EXTRA = "penumbra_operation_token"

    internal fun requestExtras(
        requestId: String,
        operationToken: String,
        iccid: String?,
        activationCode: String?,
        nickname: String?,
        source: String,
        bridgeAuthToken: String,
    ): Map<String, String> = buildMap {
        put("penumbra_source", source)
        put("penumbra_request_id", requestId)
        put(OPERATION_TOKEN_EXTRA, operationToken)
        put(
            BRIDGE_AUTH_TOKEN_EXTRA,
            EsimBridgeAuthentication.requireValidToken(bridgeAuthToken),
        )
        if (iccid != null) put("iccid", iccid)
        if (activationCode != null) put("activationCode", activationCode)
        if (nickname != null) put("Nickname", nickname)
    }

    fun dispatch(
        context: Context,
        requestId: String,
        operationToken: String,
        lpaAction: String,
        iccid: String? = null,
        activationCode: String? = null,
        nickname: String? = null,
        source: String = "server",
        bridgeAuthToken: String,
    ) {
        val intent = Intent().apply {
            component = ComponentName(LPA_PACKAGE, FACTORY_SERVICE_CLASS)
            action = lpaAction
            requestExtras(
                requestId = requestId,
                operationToken = operationToken,
                iccid = iccid,
                activationCode = activationCode,
                nickname = nickname,
                source = source,
                bridgeAuthToken = bridgeAuthToken,
            ).forEach(::putExtra)
        }

        Log.w(
            TAG,
            "Dispatching LPA action=${intent.action} " +
                "iccidProvided=${iccid != null} " +
                "activationCodeProvided=${activationCode != null} " +
                "nicknameProvided=${nickname != null}",
        )
        val componentName = checkNotNull(context.startService(intent)) {
            "Stock LPA service rejected the request"
        }
        Log.w(TAG, "startService returned: $componentName")
    }
}
