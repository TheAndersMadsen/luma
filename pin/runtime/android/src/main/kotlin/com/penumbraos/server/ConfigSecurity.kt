package com.penumbraos.server

import java.security.SecureRandom

/** Pure config helpers kept separate from Android I/O for security-focused tests. */
internal object ConfigSecurity {
    const val MIN_ADMIN_TOKEN_BYTES = 32
    const val MAX_ADMIN_TOKEN_BYTES = 512

    private const val ADMIN_TOKEN_PATH = "server.admin_token"
    private const val HTTP_BIND_PATH = "server.http_bind_addr"
    private const val PREVIOUS_WILDCARD_BIND = "0.0.0.0:8080"
    private const val SAFE_LOOPBACK_BIND = "127.0.0.1:8080"

    private val writeOnlyPaths = setOf(
        ADMIN_TOKEN_PATH,
        "llm.api_key",
        "weather.pirate_weather_api_key",
        "google_maps.api_key",
        "brave_search.api_key",
        "azure_speech.subscription_key",
        "music.gateway_token",
    )
    private val writeOnlyLeafKeys = writeOnlyPaths.mapTo(mutableSetOf()) { it.substringAfterLast('.') }
    private val managedRootTables = setOf(
        "server",
        "storage",
        "logging",
        "llm",
        "weather",
        "google_maps",
        "brave_search",
        "open_food_facts",
        "azure_speech",
        "openstreetmap",
        "contacts",
        "music",
        "spotify",
        "dev",
        "feature_flags",
    )

    data class AdminTokenMigration(
        val text: String,
        val token: String,
        val changed: Boolean,
    )

    data class TextMigration(
        val text: String,
        val changed: Boolean,
    )

    private enum class MultilineString {
        BASIC,
        LITERAL,
    }

    private data class ScannedLine(
        val raw: String,
        val structuralCode: String,
    )

    private data class LineScan(
        val structuralCode: String,
        val multiline: MultilineString?,
    )

    fun generateAdminToken(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        val digits = "0123456789abcdef"
        return buildString(bytes.size * 2) {
            for (byte in bytes) {
                val value = byte.toInt() and 0xff
                append(digits[value ushr 4])
                append(digits[value and 0x0f])
            }
        }
    }

    fun requireValidAdminToken(token: String): String {
        check(token.length in MIN_ADMIN_TOKEN_BYTES..MAX_ADMIN_TOKEN_BYTES &&
            token.all { it.code in 0x21..0x7e }) {
            "Administration token must be 32-512 visible ASCII characters"
        }
        return token
    }

    fun ensureAdminToken(
        text: String,
        tokenGenerator: () -> String = { generateAdminToken() },
    ): AdminTokenMigration {
        validateManagedTableShapes(text)
        findStringScalar(text, ADMIN_TOKEN_PATH)?.let { existing ->
            return AdminTokenMigration(text, requireValidAdminToken(existing), changed = false)
        }

        val token = requireValidAdminToken(tokenGenerator())
        val scanned = scanTomlLines(text)
        val lines = scanned.mapTo(mutableListOf()) { it.raw }
        val serverHeader = scanned.indexOfFirst { it.structuralCode.trim() == "[server]" }

        if (serverHeader >= 0) {
            lines.add(serverHeader + 1, "admin_token = \"${escapeBasicString(token)}\"")
        } else {
            while (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.lastIndex)
            if (lines.isNotEmpty()) lines += ""
            lines += "[server]"
            lines += "admin_token = \"${escapeBasicString(token)}\""
            lines += ""
        }

        return AdminTokenMigration(lines.joinToString("\n"), token, changed = true)
    }

    /**
     * Shared storage was caller-writable before the private-config migration.
     * Do not propagate any legacy value across that trust boundary: provider URLs,
     * credentials, prompts, paths, gates, and feature flags can all redirect
     * data or change privileged behavior. Create a minimal private replacement
     * whose remaining fields are filled from current safe defaults.
     */
    fun createSafeLegacyReplacement(
        tokenGenerator: () -> String = { generateAdminToken() },
    ): String {
        val token = requireValidAdminToken(tokenGenerator())
        return """
            # Legacy shared-storage values were intentionally not imported.
            [llm]
            provider = "echo"

            [server]
            http_bind_addr = "$SAFE_LOOPBACK_BIND"
            lan_dashboard_enabled = false
            admin_token = "${escapeBasicString(token)}"
        """.trimIndent() + "\n"
    }

    /**
     * Preserve a legacy local overlay privately, except for authentication and
     * the old shipped wildcard bind. Android keeps its admin token in the base
     * private config so the Rust server and USB bridge resolve the same secret.
     */
    fun prepareAndroidLocalOverlay(text: String): TextMigration {
        val tokenMigration = removeAdminToken(text)
        val bindMigration = migrateLegacyWildcardBind(tokenMigration.text)
        return TextMigration(
            bindMigration.text,
            tokenMigration.changed || bindMigration.changed,
        )
    }

    /**
     * Remove secret-bearing device provider settings. Open Food Facts is the
     * deliberate exception: it is keyless, uses the Pin's own network path,
     * and is guarded by an explicit attribution acknowledgement plus the
     * independent stock food gate.
     */
    fun enforceCosmosProviderAuthority(
        text: String,
        addRoutingDefaults: Boolean,
    ): TextMigration {
        validateManagedTableShapes(text)
        val visionConsent = readOptionalBoolean(text, "llm.vision_consent_acknowledged")
        val providerSections = setOf(
            "google_maps",
            "brave_search",
            "azure_speech",
            "openstreetmap",
            "searxng",
            "serpapi",
            "web_search",
        )
        val output = mutableListOf<String>()
        var section = ""
        var discardSection = false

        for (line in scanTomlLines(text)) {
            val code = line.structuralCode.trim()
            val table = parseTableHeader(code)
            if (table != null) {
                section = table
                discardSection = table == "llm" || table.startsWith("llm.") ||
                    table in providerSections
                if (!discardSection) output += line.raw
                continue
            }
            if (discardSection) continue

            val assignment = parseAssignment(code)
            if (section == "weather" && assignment?.first == "pirate_weather_api_key") {
                continue
            }
            output += line.raw
        }

        val preserved = output.joinToString("\n").trimEnd()
        val result = if (addRoutingDefaults) {
            buildString {
                if (preserved.isNotEmpty()) {
                    append(preserved)
                    append("\n\n")
                }
                append("[llm]\n")
                append("provider = \"echo\"\n")
                append("model = \"cosmos-remote\"\n")
                if (visionConsent != null) {
                    append("vision_consent_acknowledged = $visionConsent\n")
                }
                append("\n")
                append("[llm.memory]\n")
                append("enabled = false\n")
            }
        } else {
            buildString {
                if (preserved.isNotEmpty()) {
                    append(preserved)
                    append("\n")
                }
                if (visionConsent != null) {
                    if (isNotEmpty()) append("\n")
                    append("[llm]\n")
                    append("vision_consent_acknowledged = $visionConsent\n")
                }
            }
        }
        return TextMigration(result, result != text)
    }

    fun migrateLegacyWildcardBind(text: String): TextMigration {
        validateManagedTableShapes(text)
        val scanned = scanTomlLines(text)
        val output = mutableListOf<String>()
        var section = ""
        var found = false
        var changed = false

        for (line in scanned) {
            val code = line.structuralCode.trim()
            val tableHeader = parseTableHeader(code)
            if (tableHeader != null) {
                section = tableHeader
                output += line.raw
                continue
            }
            val assignment = parseAssignment(code)
            if (assignment == null) {
                output += line.raw
                continue
            }

            val path = if (section.isEmpty()) assignment.first else "$section.${assignment.first}"
            if (path != HTTP_BIND_PATH) {
                output += line.raw
                continue
            }

            check(!found) { "Duplicate $HTTP_BIND_PATH field" }
            found = true
            if (parseSimpleTomlString(assignment.second) == PREVIOUS_WILDCARD_BIND) {
                val indentation = line.raw.takeWhile(Char::isWhitespace)
                output += "$indentation${HTTP_BIND_PATH.substringAfterLast('.')} = \"$SAFE_LOOPBACK_BIND\""
                changed = true
            } else {
                output += line.raw
            }
        }

        return TextMigration(output.joinToString("\n"), changed)
    }

    fun readAdminToken(text: String): String {
        validateManagedTableShapes(text)
        return requireValidAdminToken(
            checkNotNull(findStringScalar(text, ADMIN_TOKEN_PATH)) {
                "Canonical config is missing server.admin_token"
            },
        )
    }

    fun readOptionalString(text: String, wantedPath: String): String? {
        validateManagedTableShapes(text)
        return findStringScalar(text, wantedPath)
    }

    fun readOptionalBoolean(text: String, wantedPath: String): Boolean? {
        validateManagedTableShapes(text)
        var section = ""
        var found = false
        var result: Boolean? = null

        for (line in scanTomlLines(text)) {
            val code = line.structuralCode.trim()
            val tableHeader = parseTableHeader(code)
            if (tableHeader != null) {
                section = tableHeader
                continue
            }
            val assignment = parseAssignment(code) ?: continue
            val path = if (section.isEmpty()) assignment.first else "$section.${assignment.first}"
            if (path != wantedPath) continue
            check(!found) { "Duplicate $wantedPath field" }
            found = true
            result = when (assignment.second) {
                "true" -> true
                "false" -> false
                else -> error("Config scalar must be a TOML boolean")
            }
        }

        return result
    }

    /** Structural TOML code aligned one-for-one with the input's physical lines. */
    fun structuralCodeByLine(text: String): List<String> =
        scanTomlLines(text).map { it.structuralCode }

    /**
     * Remove every write-only credential before a migration backup is
     * persisted. Config shapes that cannot be scrubbed unambiguously fail
     * closed before any backup is written.
     */
    fun scrubWriteOnlySecretsForBackup(text: String): String {
        validateManagedTableShapes(text)
        val output = mutableListOf<String>()
        var section = ""
        val seen = mutableSetOf<String>()

        for (line in scanTomlLines(text)) {
            val code = line.structuralCode.trim()
            val tableHeader = parseTableHeader(code)
            if (tableHeader != null) {
                section = tableHeader
                output += line.raw
                continue
            }
            val assignment = parseAssignment(code)
            if (assignment == null) {
                output += line.raw
                continue
            }

            val (key, value) = assignment
            val path = if (section.isEmpty()) key else "$section.$key"
            if (path in writeOnlyPaths) {
                check(seen.add(path)) { "Duplicate write-only config field" }
                check(!value.startsWith("\"\"\"") && !value.startsWith("'''")) {
                    "Multiline write-only config fields cannot be backed up safely"
                }
                output += "# $path removed from migration backup"
            } else {
                check(key.substringAfterLast('.') !in writeOnlyLeafKeys) {
                    "Unrecognized write-only config field shape"
                }
                output += line.raw
            }
        }

        return output.joinToString("\n")
    }

    private fun removeAdminToken(text: String): TextMigration {
        validateManagedTableShapes(text)
        val output = mutableListOf<String>()
        var section = ""
        var found = false

        for (line in scanTomlLines(text)) {
            val code = line.structuralCode.trim()
            val tableHeader = parseTableHeader(code)
            if (tableHeader != null) {
                section = tableHeader
                output += line.raw
                continue
            }
            val assignment = parseAssignment(code)
            if (assignment == null) {
                output += line.raw
                continue
            }

            val path = if (section.isEmpty()) assignment.first else "$section.${assignment.first}"
            if (path == ADMIN_TOKEN_PATH) {
                check(!found) { "Duplicate $ADMIN_TOKEN_PATH field" }
                check(!assignment.second.startsWith("\"\"\"") && !assignment.second.startsWith("'''")) {
                    "Multiline administration tokens are not supported"
                }
                found = true
                output += "# $ADMIN_TOKEN_PATH removed during private-config migration"
            } else {
                output += line.raw
            }
        }

        return TextMigration(output.joinToString("\n"), found)
    }

    private fun findStringScalar(text: String, wantedPath: String): String? {
        var section = ""
        var found: String? = null

        for (line in scanTomlLines(text)) {
            val code = line.structuralCode.trim()
            val tableHeader = parseTableHeader(code)
            if (tableHeader != null) {
                section = tableHeader
                continue
            }
            val assignment = parseAssignment(code) ?: continue
            val path = if (section.isEmpty()) assignment.first else "$section.${assignment.first}"
            if (path != wantedPath) continue
            check(found == null) { "Duplicate $wantedPath field" }
            found = parseSimpleTomlString(assignment.second)
        }

        return found
    }

    private fun validateManagedTableShapes(text: String) {
        var section = ""
        for (line in scanTomlLines(text)) {
            val code = line.structuralCode.trim()
            val tableHeader = parseTableHeader(code)
            if (tableHeader != null) {
                section = tableHeader
                continue
            }
            val assignment = parseAssignment(code) ?: continue
            val key = assignment.first
            val value = assignment.second.trimStart()

            if (section.isEmpty()) {
                check(key !in managedRootTables || !value.startsWith('{')) {
                    "Inline managed config tables are not supported"
                }
                check(managedRootTables.none { key.startsWith("$it.") }) {
                    "Dotted managed config fields are not supported"
                }
            }
            if (section == "llm" && key in setOf("tools", "memory")) {
                check(!value.startsWith('{')) { "Inline managed config tables are not supported" }
            }
        }
    }

    private fun scanTomlLines(text: String): List<ScannedLine> {
        var multiline: MultilineString? = null
        return text.split('\n').map { raw ->
            val scan = scanLine(raw, multiline)
            multiline = scan.multiline
            ScannedLine(raw, scan.structuralCode)
        }.also {
            check(multiline == null) { "Unterminated multiline TOML string" }
        }
    }

    private fun scanLine(raw: String, initialMultiline: MultilineString?): LineScan {
        if (initialMultiline != null) {
            val closing = findMultilineClose(raw, 0, initialMultiline)
            return if (closing < 0) {
                LineScan("", initialMultiline)
            } else {
                val trailing = raw.substring(closing + 3).trimStart()
                check(trailing.isEmpty() || trailing.startsWith('#')) {
                    "Unsupported content after multiline TOML string"
                }
                LineScan("", null)
            }
        }

        val code = StringBuilder(raw.length)
        var basic = false
        var literal = false
        var index = 0
        while (index < raw.length) {
            val char = raw[index]
            if (basic && char == '\\') {
                code.append(char)
                index += 1
                check(index < raw.length) { "Invalid TOML string escape" }
                code.append(raw[index])
                index += 1
                continue
            }
            if (!basic && !literal && char == '#') break

            if (!basic && !literal &&
                (raw.startsWith("\"\"\"", index) || raw.startsWith("'''", index))
            ) {
                val kind = if (char == '"') MultilineString.BASIC else MultilineString.LITERAL
                code.append(raw.substring(index))
                val closing = findMultilineClose(raw, index + 3, kind)
                return LineScan(code.toString(), if (closing < 0) kind else null)
            }

            if (!literal && char == '"') basic = !basic
            if (!basic && char == '\'') literal = !literal
            code.append(char)
            index += 1
        }

        check(!basic && !literal) { "Unterminated TOML string" }
        return LineScan(code.toString(), null)
    }

    private fun findMultilineClose(
        raw: String,
        start: Int,
        kind: MultilineString,
    ): Int {
        val delimiter = if (kind == MultilineString.BASIC) "\"\"\"" else "'''"
        var index = start
        while (index <= raw.length - delimiter.length) {
            if (raw.startsWith(delimiter, index)) {
                if (kind == MultilineString.LITERAL || !isEscaped(raw, index)) return index
            }
            index += 1
        }
        return -1
    }

    private fun isEscaped(raw: String, index: Int): Boolean {
        var backslashes = 0
        var cursor = index - 1
        while (cursor >= 0 && raw[cursor] == '\\') {
            backslashes += 1
            cursor -= 1
        }
        return backslashes % 2 == 1
    }

    private fun parseTableHeader(code: String): String? {
        if (!code.startsWith('[')) return null
        check(code.endsWith(']') && !code.startsWith("[[")) { "Unsupported TOML table header" }
        val section = code.substring(1, code.length - 1).trim()
        check(section.isNotEmpty() && section.all { it.isLetterOrDigit() || it in "_- ." }) {
            "Unsupported TOML table header"
        }
        return section.replace(" ", "")
    }

    private fun parseAssignment(code: String): Pair<String, String>? {
        if (code.isEmpty() || code.startsWith('[')) return null
        val equals = indexOfUnquoted(code, '=')
        if (equals <= 0) return null
        val key = code.substring(0, equals).trim()
        check(key.isNotEmpty() && key.all { it.isLetterOrDigit() || it in "_- ." }) {
            "Unsupported TOML key shape"
        }
        return key.replace(" ", "") to code.substring(equals + 1).trim()
    }

    private fun parseSimpleTomlString(value: String): String {
        check(value.length >= 2) { "Config scalar must be a TOML string" }
        if (value.first() == '\'' && value.last() == '\'') {
            return value.substring(1, value.length - 1)
        }
        check(value.first() == '"' && value.last() == '"') {
            "Config scalar must be a TOML string"
        }

        val result = StringBuilder(value.length - 2)
        var index = 1
        while (index < value.lastIndex) {
            val char = value[index++]
            if (char != '\\') {
                result.append(char)
                continue
            }
            check(index < value.lastIndex) { "Invalid config scalar escape" }
            when (val escaped = value[index++]) {
                '"', '\\' -> result.append(escaped)
                else -> error("Unsupported config scalar escape")
            }
        }
        return result.toString()
    }

    private fun escapeBasicString(value: String): String =
        value.replace("\\", "\\\\").replace("\"", "\\\"")

    private fun indexOfUnquoted(value: String, wanted: Char): Int {
        var basic = false
        var literal = false
        var escaped = false
        for (index in value.indices) {
            val char = value[index]
            if (escaped) {
                escaped = false
                continue
            }
            if (basic && char == '\\') {
                escaped = true
                continue
            }
            if (!literal && char == '"') basic = !basic
            if (!basic && char == '\'') literal = !literal
            if (!basic && !literal && char == wanted) return index
        }
        return -1
    }
}
