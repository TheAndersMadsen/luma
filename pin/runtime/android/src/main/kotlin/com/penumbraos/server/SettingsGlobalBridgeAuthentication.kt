package com.penumbraos.server

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Derives a capability used only by the native Settings.Global bridge. */
internal object SettingsGlobalBridgeAuthentication {
    const val TOKEN_ENVIRONMENT_VARIABLE = "PENUMBRA_SETTINGS_GLOBAL_BRIDGE_TOKEN"

    private const val HMAC_ALGORITHM = "HmacSHA256"
    private const val DERIVED_TOKEN_CHARS = 64
    private val DOMAIN =
        "penumbra/settings-global-bridge/control/v1\u0000"
            .toByteArray(StandardCharsets.US_ASCII)

    fun deriveToken(esimBridgeToken: String): String {
        val installSecret = EsimBridgeAuthentication.requireValidToken(esimBridgeToken)
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(SecretKeySpec(decodeHex(installSecret), HMAC_ALGORITHM))
        return mac.doFinal(DOMAIN).toHex()
    }

    fun requireValidDerivedToken(token: String): String {
        check(token.length == DERIVED_TOKEN_CHARS && token.all { it in '0'..'9' || it in 'a'..'f' }) {
            "Settings.Global bridge token must be 32 bytes encoded as lowercase hexadecimal"
        }
        return token
    }

    fun tokensMatch(expected: String, presented: String): Boolean {
        val validatedExpected = requireValidDerivedToken(expected)
        if (presented.length != DERIVED_TOKEN_CHARS ||
            presented.any { it !in '0'..'9' && it !in 'a'..'f' }
        ) {
            return false
        }
        return MessageDigest.isEqual(
            validatedExpected.toByteArray(StandardCharsets.US_ASCII),
            presented.toByteArray(StandardCharsets.US_ASCII),
        )
    }

    private fun decodeHex(value: String): ByteArray = ByteArray(value.length / 2) { index ->
        value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }

    private fun ByteArray.toHex(): String =
        joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
