package com.penumbraos.hook

import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Null-guards stock contact name getters so one malformed contact cannot crash
 * the assistant on every voice transcript.
 *
 * ## The stock crash
 *
 * `humaneinternal.system.concierge.nec.NameEntityCorrector.createNamedEntity(
 * Contact, NameType)` runs during contact biasing (NER) for every transcript.
 * It dereferences the contact's name with no null check:
 *
 * ```
 * if      (nameType == FIRST_NAME && !contact.getName().getFirstName().isEmpty()) ...
 * else if (nameType == LAST_NAME  && !contact.getName().getLastName().isEmpty())  ...
 * else if (nameType == FULL_NAME  && !contact.getName().getFullName().isEmpty())   ...
 * else if (nameType == NICK_NAME  && !contact.getName().getNickname().isEmpty())   ...
 * ```
 *
 * `humane.system.contacts.Name` backs `getFirstName()`, `getLastName()` and
 * `getNickname()` with raw fields that are **null** (not "") whenever the source
 * contact row/parcel had a null column — e.g. a cosmos-synced contact with a null
 * lastName/nickname. The unguarded `String.isEmpty()` then throws NPE. Because
 * this is stock code *before* the AI-bus call and runs on EVERY transcript, a
 * single such contact silently takes the whole assistant down on every turn
 * (observed stack: createNamedEntity <- recognizeContactNameEntityByNameType <-
 * VoiceResponseHandler <- VoiceController).
 *
 * ## The fix
 *
 * Hook the three raw-field getters and coerce a null result to "". "" is exactly
 * the value stock already treats as "no name of this type" (the
 * `!getX().isEmpty()` branch is simply skipped), so a well-formed contact behaves
 * identically and a poisoned contact is skipped for that name type instead of
 * crashing the pipeline. This coercion also covers the same unguarded
 * dereferences in `NameEntityCorrector.getMaxEditDistanceSimilarity()` and any
 * other caller of these getters.
 *
 * `getFullName()` is intentionally NOT hooked: stock already makes it null-safe by
 * delegating to `Name.combineNames()`, which filters null/empty through
 * `Strings.isNullOrEmpty` and therefore never returns null.
 *
 * All work is wrapped so a resolution failure leaves stock entirely unhooked; a
 * missing class or getter is logged and skipped rather than thrown.
 */
object ContactNameNullSafetyHooks {
    private const val TAG = "PenumbraHook"

    /** `humane.system.contacts.Name` — the declared return type of `Contact.getName()`. */
    internal const val NAME_CLASS = "humane.system.contacts.Name"

    /**
     * The no-argument getters that return a raw nullable backing field.
     * `getFullName()` is excluded because it is already null-safe upstream.
     */
    internal val GUARDED_GETTERS = listOf("getFirstName", "getLastName", "getNickname")

    private val NO_ARGS = emptyArray<Class<*>>()
    private val coercions = AtomicLong(0)

    fun install(classLoader: ClassLoader) {
        val nameClass = try {
            classLoader.loadClass(NAME_CLASS)
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "  ContactNameNullSafetyHooks: $NAME_CLASS unavailable " +
                    "(${error.javaClass.simpleName}); skipping",
            )
            return
        }

        var installed = 0
        for (getter in GUARDED_GETTERS) {
            val hooked = HookUtils.hookMethodAfter(nameClass, getter, NO_ARGS) { param ->
                if (param.result == null) {
                    // Coerce null -> "" so stock's unguarded String.isEmpty() is safe.
                    // "" == coercedName(null) is exactly what stock treats as "no
                    // name of this type", so contact matching is unchanged.
                    param.result = ""
                    logCoercion(getter)
                }
            }
            if (hooked) installed++
        }

        if (installed == GUARDED_GETTERS.size) {
            Log.w(
                TAG,
                "  ContactNameNullSafetyHooks installed " +
                    "(${GUARDED_GETTERS.joinToString()} null-guarded)",
            )
        } else {
            Log.e(
                TAG,
                "  ContactNameNullSafetyHooks partial install: " +
                    "$installed/${GUARDED_GETTERS.size} getters guarded",
            )
        }
    }

    /**
     * The exact coercion the afterHook applies. A null name becomes "" so stock's
     * unguarded [String.isEmpty] cannot throw; any real name is returned unchanged
     * so contact matching behaves exactly as it does for a well-formed contact.
     */
    internal fun coercedName(rawGetterResult: String?): String = rawGetterResult ?: ""

    private fun logCoercion(getter: String) {
        val count = coercions.incrementAndGet()
        // Content-free, bounded: the value is null (no PII); log the first few and
        // then every 100th so a poisoned contact on every turn cannot spam logcat.
        if (count <= 3 || count % 100L == 0L) {
            Log.w(TAG, "  Coerced null contact name to empty (getter=$getter, total=$count)")
        }
    }
}
