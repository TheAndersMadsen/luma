package com.penumbraos.server

import android.os.IBinder
import java.util.Base64

/** Longest ADB public-key line this surface accepts, characters. */
internal const val MAX_ADB_PUBLIC_KEY_LINE_CHARS = 2048

/** ADB public keys are RSA key blobs. This bounds the decoded blob, bytes. */
private const val MIN_ADB_PUBLIC_KEY_BYTES = 256
private const val MAX_ADB_PUBLIC_KEY_BYTES = 1024

/**
 * The ADB protocol's public-key line: one standard-base64 blob, optionally
 * followed by a space and a printable comment (`<base64> user@host`).
 *
 * This is the exact string adbd sends the framework for confirmation
 * (`com.android.server.adb.AdbDebuggingManager` receives `PK<key>` over the
 * `adbd` socket and fingerprints the first whitespace-separated field), so it
 * is the exact string a confirmation must hand back.
 */
internal fun validAdbPublicKeyLine(value: String): String? {
    val line = value.trim()
    if (line.isEmpty() || line.length > MAX_ADB_PUBLIC_KEY_LINE_CHARS) return null
    if (line.any { it.code < 0x20 || it.code == 0x7F || it.code > 0x7E }) return null
    val separator = line.indexOf(' ')
    val encoded = if (separator == -1) line else line.substring(0, separator)
    val comment = if (separator == -1) "" else line.substring(separator + 1)
    if (encoded.isEmpty() || encoded.length % 4 != 0) return null
    if (!encoded.all { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' }) return null
    if (comment.contains(' ')) return null
    val decoded = try {
        Base64.getDecoder().decode(encoded)
    } catch (_: IllegalArgumentException) {
        return null
    }
    if (decoded.size !in MIN_ADB_PUBLIC_KEY_BYTES..MAX_ADB_PUBLIC_KEY_BYTES) return null
    return line
}

/** What confirming one staged key decided, with a wearer-usable message. */
internal data class AdbAuthorizationOutcome(
    val ok: Boolean,
    val message: String,
)

/** The device action, abstracted so the decision is testable without Android. */
internal fun interface AdbAuthorizerPort {
    /** Stock "Allow" + "Always allow from this computer" in one confirmation. */
    fun allowAlways(publicKeyLine: String): AdbAuthorizationOutcome
}

/**
 * The gate the Cosmos remote flag provides, applied to one staged key.
 *
 * `remoteGateEnabled` is `penumbra_cosmos_remote_mode == "1"`: Luma guided
 * setup is driving this device. Without it the confirmation is refused before
 * the framework is touched, so this surface can never authorize a stranger's
 * computer on a stock or deactivated Pin.
 */
internal fun confirmAdbPublicKey(
    remoteGateEnabled: Boolean,
    stagedKey: String?,
    authorizer: AdbAuthorizerPort,
): AdbAuthorizationOutcome {
    if (!remoteGateEnabled) {
        return AdbAuthorizationOutcome(false, "Cosmos activation is required")
    }
    if (stagedKey == null) {
        return AdbAuthorizationOutcome(false, "No staged ADB public key")
    }
    return try {
        authorizer.allowAlways(stagedKey)
    } catch (_: Throwable) {
        AdbAuthorizationOutcome(
            false,
            "The Pin's software refused the ADB confirmation",
        )
    }
}

/**
 * The stock confirmation act, performed over the framework binder.
 *
 * Stock evidence (AOSP 12, the Pin's SDK): the "Allow" button of
 * `com.android.systemui.usb.UsbDebuggingActivity` calls
 * `IAdbManager.allowDebugging(alwaysAllow=true, key)` on the `Context.ADB_SERVICE`
 * ("adb") binder; `com.android.server.adb.AdbService.allowDebugging` then lets
 * `AdbDebuggingManager` answer "OK" to adbd and persist the key. This invokes
 * exactly that call. The Humane framework is not in the decompile (no
 * SystemUI/framework sources exist there and nothing decompiled references USB
 * debugging), so whether the stock prompt itself can ever render on this
 * firmware is INFERRED-absent. The owner-observed behavior is that it never
 * appears. The binder call is reflection because `android.debug.IAdbManager`
 * is a hidden API. It never logs the key.
 */
internal class FrameworkAdbAuthorizer : AdbAuthorizerPort {
    override fun allowAlways(publicKeyLine: String): AdbAuthorizationOutcome {
        val binder = getService("adb")
            ?: return AdbAuthorizationOutcome(
                false,
                "The Pin's ADB service is unavailable",
            )
        val manager = asInterface(binder)
        manager.allowDebugging(true, publicKeyLine)
        return AdbAuthorizationOutcome(
            true,
            "The operator's USB debugging key was allowed on this Pin",
        )
    }

    internal fun getService(name: String): IBinder? =
        Class.forName("android.os.ServiceManager")
            .getMethod("getService", String::class.java)
            .invoke(null, name) as? IBinder

    internal fun asInterface(binder: IBinder): Any =
        Class.forName("android.debug.IAdbManager\$Stub")
            .getMethod("asInterface", IBinder::class.java)
            .invoke(null, binder) ?: error("The Pin's ADB service is unavailable")

    private fun Any.allowDebugging(alwaysAllow: Boolean, key: String) {
        javaClass.getMethod(
            "allowDebugging",
            Boolean::class.javaPrimitiveType,
            String::class.java,
        ).invoke(this, alwaysAllow, key)
    }
}
