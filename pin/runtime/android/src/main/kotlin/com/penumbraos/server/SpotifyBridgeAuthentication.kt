package com.penumbraos.server

import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Derives the private native Spotify control credential from the install secret. */
internal object SpotifyBridgeAuthentication {
    const val TOKEN_ENVIRONMENT_VARIABLE = "PENUMBRA_SPOTIFY_BRIDGE_TOKEN"
    const val TOKEN_HEADER = "X-Penumbra-Spotify-Bridge-Token"

    private const val HMAC_ALGORITHM = "HmacSHA256"
    private val DOMAIN =
        "penumbra/spotify-bridge/control/v1\u0000".toByteArray(StandardCharsets.US_ASCII)

    fun deriveToken(esimBridgeToken: String): String {
        val validated = EsimBridgeAuthentication.requireValidToken(esimBridgeToken)
        val key = decodeHex(validated)
        val mac = Mac.getInstance(HMAC_ALGORITHM)
        mac.init(SecretKeySpec(key, HMAC_ALGORITHM))
        return mac.doFinal(DOMAIN).toHex()
    }

    fun requireValidDerivedToken(token: String): String {
        check(token.length == 64 && token.all { it in '0'..'9' || it in 'a'..'f' }) {
            "Spotify bridge token must be 32 bytes encoded as lowercase hexadecimal"
        }
        return token
    }

    private fun decodeHex(value: String): ByteArray = ByteArray(value.length / 2) { index ->
        value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }

    private fun ByteArray.toHex(): String =
        joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
