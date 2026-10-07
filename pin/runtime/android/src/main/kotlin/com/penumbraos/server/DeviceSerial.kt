package com.penumbraos.server

import android.os.Build
import java.util.Locale

/**
 * INFERRED: Luma management identity, not a stock wire API. Resolve in Android,
 * where Build.getSerial() can use the framework service when property reads
 * are denied to system_app. Never substitute a caller's claimed serial.
 */
internal object DeviceSerial {
    private const val ENVIRONMENT_VARIABLE = "LUMA_DEVICE_SERIAL"

    fun read(): String? = resolve(
        { name ->
            Class.forName("android.os.SystemProperties")
                .getMethod("get", String::class.java)
                .invoke(null, name) as? String ?: ""
        },
        { Build.getSerial() },
    )

    internal fun resolve(property: (String) -> String, framework: () -> String): String? {
        for (name in listOf("ro.serialno", "ro.boot.serialno")) {
            canonical(runCatching { property(name) }.getOrNull())?.let { return it }
        }
        return canonical(runCatching { framework() }.getOrNull())
    }

    fun exportTo(environment: MutableMap<String, String>, serial: String?) {
        // Do not retain a stale identity inherited from the launch environment.
        environment.remove(ENVIRONMENT_VARIABLE)
        canonical(serial)?.let { environment[ENVIRONMENT_VARIABLE] = it }
    }

    private fun canonical(value: String?): String? {
        val serial = value?.trim() ?: return null
        if (serial.isEmpty() || serial.length > 128 ||
            serial.any { it !in 'a'..'z' && it !in 'A'..'Z' && it !in '0'..'9' && it != '-' && it != '_' }
        ) return null
        return serial.uppercase(Locale.ROOT).takeUnless { it == "UNKNOWN" || it == "NULL" }
    }
}
