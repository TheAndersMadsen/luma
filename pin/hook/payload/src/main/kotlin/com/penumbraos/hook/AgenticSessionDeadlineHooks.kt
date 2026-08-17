package com.penumbraos.hook

import android.util.Log
import java.lang.reflect.Modifier

/**
 * Gives a model-directed Synapse turn enough time to complete several
 * model -> tool -> observation iterations through the stock Ai Bus client.
 *
 * The inspected Ironman build exposes [STOCK_TIMEOUT_FIELD] as a mutable
 * public static long and uses it for the Understand gRPC deadline. The two
 * stock wake-lock timeout fields initialize from the same value later during
 * class initialization, so this must run before any other Ironman hook loads
 * interpreter classes.
 *
 * This deliberately refuses an unknown firmware value or field shape. Local
 * actions still return immediately; the larger value is only an upper bound
 * for a remote understanding turn, and the server retains its own smaller
 * cancellation circuit breaker.
 */
object AgenticSessionDeadlineHooks {
    private const val TAG = "PenumbraHook"
    private const val STOCK_AIBUS_CLASS = "humaneinternal.system.aibus.AIBusService"
    private const val STOCK_TIMEOUT_FIELD = "AIMIC_TIMEOUT_MS"

    internal const val AUDITED_IRONMAN_SHA256 =
        "44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e"
    internal const val EXPECTED_STOCK_TIMEOUT_MS = 25_000L
    internal const val AGENTIC_SESSION_TIMEOUT_MS = 90_000L

    internal enum class ApplyResult {
        APPLIED,
        ALREADY_APPLIED,
        UNEXPECTED_FIRMWARE,
        INVALID_FIELD,
    }

    fun install(classLoader: ClassLoader) {
        val serviceClass = try {
            classLoader.loadClass(STOCK_AIBUS_CLASS)
        } catch (error: ClassNotFoundException) {
            Log.w(TAG, "  $STOCK_AIBUS_CLASS not found; keeping stock Ai Bus deadline")
            return
        }

        val result = try {
            applyExactStockField(serviceClass)
        } catch (error: Throwable) {
            Log.e(TAG, "  Failed to extend the stock Ai Bus session deadline", error)
            return
        }

        when (result) {
            ApplyResult.APPLIED -> Log.w(
                TAG,
                "  Extended stock Ai Bus understanding deadline to ${AGENTIC_SESSION_TIMEOUT_MS}ms",
            )

            ApplyResult.ALREADY_APPLIED -> Log.w(
                TAG,
                "  Stock Ai Bus understanding deadline was already extended",
            )

            ApplyResult.UNEXPECTED_FIRMWARE -> Log.e(
                TAG,
                "  Refusing to change an unrecognized stock Ai Bus deadline",
            )

            ApplyResult.INVALID_FIELD -> Log.e(
                TAG,
                "  Refusing to change an incompatible stock Ai Bus deadline field",
            )
        }
    }

    internal fun applyExactStockField(serviceClass: Class<*>): ApplyResult {
        val field = try {
            serviceClass.getDeclaredField(STOCK_TIMEOUT_FIELD)
        } catch (_: NoSuchFieldException) {
            return ApplyResult.INVALID_FIELD
        }
        if (
            field.type != java.lang.Long.TYPE ||
            !Modifier.isStatic(field.modifiers) ||
            Modifier.isFinal(field.modifiers)
        ) {
            return ApplyResult.INVALID_FIELD
        }

        field.isAccessible = true
        return when (field.getLong(null)) {
            AGENTIC_SESSION_TIMEOUT_MS -> ApplyResult.ALREADY_APPLIED
            EXPECTED_STOCK_TIMEOUT_MS -> {
                field.setLong(null, AGENTIC_SESSION_TIMEOUT_MS)
                if (field.getLong(null) == AGENTIC_SESSION_TIMEOUT_MS) {
                    ApplyResult.APPLIED
                } else {
                    ApplyResult.INVALID_FIELD
                }
            }

            else -> ApplyResult.UNEXPECTED_FIRMWARE
        }
    }
}
