package com.penumbraos.server

import android.Manifest
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.Locale

private const val USB_MAINTENANCE_ROOT_UID = 0
private const val USB_MAINTENANCE_SYSTEM_UID = 1000
private const val USB_MAINTENANCE_SHELL_UID = 2000

internal fun isTrustedUsbMaintenanceUid(uid: Int): Boolean =
    uid == USB_MAINTENANCE_ROOT_UID ||
        uid == USB_MAINTENANCE_SYSTEM_UID ||
        uid == USB_MAINTENANCE_SHELL_UID

internal data class UsbMaintenanceStartOutcome(
    val status: Int,
    val ok: Boolean,
)

internal fun usbMaintenanceStartOutcome(status: Int): UsbMaintenanceStartOutcome =
    UsbMaintenanceStartOutcome(status = status, ok = status in 200..299)

internal fun isValidUsbMaintenanceStartRequest(arg: String?, hasExtras: Boolean): Boolean =
    arg == null && !hasExtras

/**
 * A deliberately narrow ADB maintenance surface for firmware where SELinux
 * prevents forwarding the localabstract HTTP bridge. It supports only the
 * settings GET/PUT operations plus fixed body-free START and RESTART_RUNTIME
 * operations, and never accepts a destination or credential.
 */
class UsbMaintenanceProvider : ContentProvider() {
    companion object {
        const val AUTHORITY = "com.penumbraos.server.maintenance"
        const val METHOD_START = "START"
        const val METHOD_RESTART_RUNTIME = "RESTART_RUNTIME"

        private const val SETTINGS_PATH = "/api/settings"
        private const val LOOPBACK_HOST = "127.0.0.1"
        private const val CONNECT_TIMEOUT_MS = 5_000
        // A failed durable settings commit can include three bounded broker
        // attempts followed by a three-attempt compensating rollback. Keep
        // this recovery-only proxy above that 31-second transaction bound so
        // it cannot report an ambiguous timeout while the server is settling.
        private const val READ_TIMEOUT_MS = 40_000
        private const val MAX_RESPONSE_HEADER_BYTES = 32 * 1024
        private const val MAX_RESPONSE_HEADER_COUNT = 100
        private const val MAX_RESPONSE_LINE_BYTES = 8 * 1024
        private const val MAX_RESPONSE_HEADER_NAME_BYTES = 256
        private const val MAX_RESPONSE_BYTES = 256 * 1024
        private const val SERVER_START_RETRY_COUNT = 24
        private const val SERVER_START_RETRY_DELAY_MS = 250L
    }

    override fun onCreate(): Boolean = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        enforceMaintenanceCaller()
        if (method == METHOD_START) return startServer(arg, extras)
        if (method == METHOD_RESTART_RUNTIME) return restartRuntime(arg, extras)
        if (extras != null && !extras.isEmpty) return result(400, errorBody("invalid request"))

        val requestBody = when (method) {
            "GET" -> {
                if (arg != null && arg.isNotEmpty() && arg != SETTINGS_PATH) {
                    return result(400, errorBody("invalid request"))
                }
                null
            }
            "PUT" -> try {
                UsbMaintenanceRequestSecurity.decodeUpdateArgument(arg)
            } catch (_: IllegalArgumentException) {
                return result(400, errorBody("invalid update"))
            }
            else -> return result(405, errorBody("method not allowed"))
        }

        val appContext = context?.applicationContext
            ?: return result(503, errorBody("maintenance unavailable"))
        val configPath = try {
            BootstrapConfig.ensureCanonicalConfig(appContext)
        } catch (_: Exception) {
            return result(503, errorBody("maintenance unavailable"))
        }
        val adminToken = try {
            BootstrapConfig.readEffectiveAdminToken(configPath)
        } catch (_: Exception) {
            return result(503, errorBody("maintenance unavailable"))
        }
        val port = try {
            BootstrapConfig.readEffectiveHttpPort(configPath)
        } catch (_: Exception) {
            return result(503, errorBody("maintenance unavailable"))
        }

        // Package replacement can leave the new APK installed without a
        // BOOT_COMPLETED delivery. Starting from this same-UID provider makes
        // the recovery surface self-contained. A bounded retry covers native
        // server startup without weakening the HTTP authentication boundary.
        try {
            ServerService.start(appContext)
        } catch (_: Exception) {
            return result(503, errorBody("maintenance unavailable"))
        }

        var response = result(502, errorBody("upstream unavailable"))
        repeat(SERVER_START_RETRY_COUNT) { attempt ->
            response = proxySettings(method, requestBody, port, adminToken)
            val waitingForStartup =
                response.getInt("status") == 502 &&
                    response.getString("body") == errorBody("upstream unavailable")
            if (!waitingForStartup) return response
            if (attempt + 1 < SERVER_START_RETRY_COUNT) {
                try {
                    Thread.sleep(SERVER_START_RETRY_DELAY_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return result(503, errorBody("maintenance unavailable"))
                }
            }
        }
        return response
    }

    private fun startServer(arg: String?, extras: Bundle?): Bundle {
        if (!isValidUsbMaintenanceStartRequest(arg, extras != null && !extras.isEmpty)) {
            return statusOnlyResult(400)
        }
        val appContext = context?.applicationContext ?: return statusOnlyResult(503)
        val configPath = try {
            BootstrapConfig.ensureCanonicalConfig(appContext)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }
        val adminToken = try {
            BootstrapConfig.readEffectiveAdminToken(configPath)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }
        val port = try {
            BootstrapConfig.readEffectiveHttpPort(configPath)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }

        try {
            ServerService.start(appContext)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }

        var status = 502
        repeat(SERVER_START_RETRY_COUNT) { attempt ->
            val response = proxySettings("GET", null, port, adminToken)
            status = response.getInt("status")
            val waitingForStartup =
                status == 502 &&
                    response.getString("body") == errorBody("upstream unavailable")
            if (!waitingForStartup) return statusOnlyResult(status)
            if (attempt + 1 < SERVER_START_RETRY_COUNT) {
                try {
                    Thread.sleep(SERVER_START_RETRY_DELAY_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return statusOnlyResult(503)
                }
            }
        }
        return statusOnlyResult(status)
    }

    private fun restartRuntime(arg: String?, extras: Bundle?): Bundle {
        if (!isValidUsbMaintenanceStartRequest(arg, extras != null && !extras.isEmpty)) {
            return statusOnlyResult(400)
        }
        val appContext = context?.applicationContext ?: return statusOnlyResult(503)
        val configPath = try {
            BootstrapConfig.ensureCanonicalConfig(appContext)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }
        val adminToken = try {
            BootstrapConfig.readEffectiveAdminToken(configPath)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }
        val port = try {
            BootstrapConfig.readEffectiveHttpPort(configPath)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }
        if (!ServerRuntime.restart()) return statusOnlyResult(503)
        try {
            // Activation can add the status endpoint after this service's first
            // start. Re-entering its idempotent start path also starts the
            // reporter against that newly committed configuration.
            ServerService.start(appContext)
        } catch (_: Exception) {
            return statusOnlyResult(503)
        }

        var status = 502
        repeat(SERVER_START_RETRY_COUNT) { attempt ->
            val response = proxySettings("GET", null, port, adminToken)
            status = response.getInt("status")
            val waitingForStartup =
                status == 502 &&
                    response.getString("body") == errorBody("upstream unavailable")
            if (!waitingForStartup) return statusOnlyResult(status)
            if (attempt + 1 < SERVER_START_RETRY_COUNT) {
                try {
                    Thread.sleep(SERVER_START_RETRY_DELAY_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return statusOnlyResult(503)
                }
            }
        }
        return statusOnlyResult(status)
    }

    private fun enforceMaintenanceCaller() {
        val callerContext = context ?: throw SecurityException("Maintenance provider unavailable")
        callerContext.enforceCallingPermission(
            Manifest.permission.DUMP,
            "USB maintenance requires android.permission.DUMP",
        )
        if (!isTrustedUsbMaintenanceUid(Binder.getCallingUid())) {
            throw SecurityException("Caller is not authorized for USB maintenance")
        }
    }

    private fun proxySettings(
        method: String,
        requestBody: ByteArray?,
        port: Int,
        adminToken: String,
    ): Bundle {
        return try {
            val response = Socket().use { socket ->
                socket.tcpNoDelay = true
                socket.soTimeout = READ_TIMEOUT_MS
                socket.connect(InetSocketAddress(LOOPBACK_HOST, port), CONNECT_TIMEOUT_MS)

                val bodyLength = requestBody?.size ?: 0
                val requestHeaders = buildString {
                    append(method).append(' ').append(SETTINGS_PATH).append(" HTTP/1.1\r\n")
                    append("Host: ").append(LOOPBACK_HOST).append(':').append(port).append("\r\n")
                    append("Accept: application/json\r\n")
                    append("Authorization: Bearer ").append(adminToken).append("\r\n")
                    append("Content-Length: ").append(bodyLength).append("\r\n")
                    if (requestBody != null) append("Content-Type: application/json\r\n")
                    append("Connection: close\r\n\r\n")
                }.toByteArray(StandardCharsets.US_ASCII)

                socket.getOutputStream().apply {
                    write(requestHeaders)
                    if (requestBody != null) write(requestBody)
                    flush()
                }
                // Deliberately NOT half-closing the write side here. The
                // upstream treats a read EOF on an in-flight request as a
                // client disconnect and drops the response instead of writing
                // it, which a GET wins by finishing in ~2 ms but a settings PUT
                // loses: it persists the config, spends ~200 ms in the durable
                // commit, and then finds the connection already abandoned. The
                // symptom was every PUT, including a no-op `{}`, retrying 24
                // times and returning 502 while the write had actually landed.
                // `Content-Length` frames the request and the strict reader
                // consumes exactly `Content-Length` response bytes, so neither
                // side needs a half-close to find its end; `use {}` closes the
                // socket.
                readStrictResponse(socket.getInputStream())
            }
            val requestSecrets = requestBody?.let {
                UsbMaintenanceJson.collectSensitiveStrings(decodeUtf8(it))
            }.orEmpty()
            val redacted = UsbMaintenanceJson.redactResponse(
                response.body,
                requestSecrets + adminToken,
            )
            result(response.status, redacted)
        } catch (_: SocketTimeoutException) {
            result(504, errorBody("upstream timeout"))
        } catch (_: ResponseTooLargeException) {
            result(502, errorBody("upstream response too large"))
        } catch (_: Exception) {
            result(502, errorBody("upstream unavailable"))
        }
    }

    private fun readStrictResponse(input: InputStream): StrictHttpResponse {
        val headerBytes = readHeaderBlock(input)
        val headerText = headerBytes.toString(StandardCharsets.ISO_8859_1)
        if (!headerText.endsWith("\r\n\r\n")) throw InvalidUpstreamResponseException()
        val lines = headerText.dropLast(4).split("\r\n")
        val statusLine = lines.firstOrNull() ?: throw InvalidUpstreamResponseException()
        if (statusLine.toByteArray(StandardCharsets.ISO_8859_1).size > MAX_RESPONSE_LINE_BYTES) {
            throw InvalidUpstreamResponseException()
        }
        val statusMatch = Regex("HTTP/1\\.[01] ([0-9]{3})(?: [\\x20-\\x7e]*)?")
            .matchEntire(statusLine)
            ?: throw InvalidUpstreamResponseException()
        val status = statusMatch.groupValues[1].toInt()
        if (status !in 100..599) throw InvalidUpstreamResponseException()

        var contentLength: Int? = null
        var headerCount = 0
        for (line in lines.drop(1)) {
            headerCount += 1
            if (headerCount > MAX_RESPONSE_HEADER_COUNT ||
                line.isEmpty() ||
                line.first() == ' ' ||
                line.first() == '\t' ||
                line.toByteArray(StandardCharsets.ISO_8859_1).size > MAX_RESPONSE_LINE_BYTES
            ) {
                throw InvalidUpstreamResponseException()
            }
            val colon = line.indexOf(':')
            if (colon !in 1..MAX_RESPONSE_HEADER_NAME_BYTES) {
                throw InvalidUpstreamResponseException()
            }
            val name = line.substring(0, colon)
            val value = line.substring(colon + 1)
            if (!name.all(::isHttpTokenCharacter) ||
                !value.all { it == '\t' || it.code in 0x20..0x7e }
            ) {
                throw InvalidUpstreamResponseException()
            }
            when (name.lowercase(Locale.ROOT)) {
                "content-length" -> {
                    if (contentLength != null) throw InvalidUpstreamResponseException()
                    val normalized = value.trim()
                    if (normalized.isEmpty() || !normalized.all(Char::isDigit)) {
                        throw InvalidUpstreamResponseException()
                    }
                    val parsed = normalized.toLongOrNull()
                        ?: throw InvalidUpstreamResponseException()
                    if (parsed > MAX_RESPONSE_BYTES) throw ResponseTooLargeException()
                    contentLength = parsed.toInt()
                }
                "transfer-encoding", "content-encoding" ->
                    throw InvalidUpstreamResponseException()
            }
        }

        val exactLength = contentLength ?: throw InvalidUpstreamResponseException()
        return StrictHttpResponse(status, readExactly(input, exactLength))
    }

    private fun readHeaderBlock(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val terminator = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        var matched = 0
        while (output.size() < MAX_RESPONSE_HEADER_BYTES) {
            val next = input.read()
            if (next == -1) throw InvalidUpstreamResponseException()
            output.write(next)
            val byte = next.toByte()
            matched = if (byte == terminator[matched]) {
                matched + 1
            } else if (byte == terminator[0]) {
                1
            } else {
                0
            }
            if (matched == terminator.size) return output.toByteArray()
        }
        throw InvalidUpstreamResponseException()
    }

    private fun readExactly(input: InputStream, length: Int): ByteArray {
        val body = ByteArray(length)
        var offset = 0
        while (offset < body.size) {
            val count = input.read(body, offset, body.size - offset)
            if (count == -1) throw InvalidUpstreamResponseException()
            offset += count
        }
        return body
    }

    private fun isHttpTokenCharacter(character: Char): Boolean =
        character.code < 0x80 &&
            (character.isLetterOrDigit() || character in "!#$%&'*+-.^_`|~")

    private fun result(status: Int, body: String): Bundle = Bundle().apply {
        putInt("status", status)
        putBoolean("ok", status in 200..299)
        putString("body", body)
    }

    private fun statusOnlyResult(status: Int): Bundle {
        val outcome = usbMaintenanceStartOutcome(status)
        return Bundle().apply {
            putInt("status", outcome.status)
            putBoolean("ok", outcome.ok)
        }
    }

    private fun errorBody(message: String): String =
        JSONObject().put("error", message).toString()

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = throw UnsupportedOperationException()

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? =
        throw UnsupportedOperationException()

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = throw UnsupportedOperationException()

    private data class StrictHttpResponse(val status: Int, val body: ByteArray)

    private class InvalidUpstreamResponseException : Exception()
    private class ResponseTooLargeException : Exception()
}

internal object UsbMaintenanceRequestSecurity {
    private const val MAX_UPDATE_BYTES = 256 * 1024
    private const val MAX_JSON_DEPTH = 64
    private const val MAX_ENCODED_BYTES = (MAX_UPDATE_BYTES * 4 + 2) / 3

    fun decodeUpdateArgument(encoded: String?): ByteArray {
        require(!encoded.isNullOrEmpty() && encoded.length <= MAX_ENCODED_BYTES)
        require(encoded.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        require(encoded.length % 4 != 1)
        val decoded = try {
            Base64.getUrlDecoder().decode(encoded)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("Invalid base64url")
        }
        require(decoded.isNotEmpty() && decoded.size <= MAX_UPDATE_BYTES)
        val json = decodeUtf8(decoded)
        require(json.firstOrNull { !it.isWhitespace() } == '{')
        require(json.lastOrNull { !it.isWhitespace() } == '}')
        requireJsonDepth(json)
        val tokener = JSONTokener(json)
        require(tokener.nextValue() is JSONObject && tokener.nextClean().code == 0)
        return decoded
    }

    private fun requireJsonDepth(json: String) {
        var depth = 0
        var inString = false
        var escaped = false
        for (character in json) {
            if (inString) {
                when {
                    escaped -> escaped = false
                    character == '\\' -> escaped = true
                    character == '"' -> inString = false
                }
                continue
            }
            when (character) {
                '"' -> inString = true
                '{', '[' -> {
                    depth += 1
                    require(depth <= MAX_JSON_DEPTH)
                }
                '}', ']' -> depth -= 1
            }
            require(depth >= 0)
        }
        require(!inString && depth == 0)
    }
}

private object UsbMaintenanceJson {
    private const val MAX_JSON_DEPTH = 64
    private const val REDACTED = "[REDACTED]"

    fun collectSensitiveStrings(json: String): Set<String> = try {
        val tokener = JSONTokener(json)
        val value = tokener.nextValue()
        if (tokener.nextClean().code != 0) emptySet() else buildSet {
            collect(value, null, 0, this)
        }
    } catch (_: Exception) {
        emptySet()
    }

    fun redactResponse(bytes: ByteArray, secrets: Set<String>): String {
        if (bytes.isEmpty()) return ""
        return try {
            val text = decodeUtf8(bytes)
            val tokener = JSONTokener(text)
            val value = tokener.nextValue()
            if (tokener.nextClean().code != 0) throw IllegalArgumentException()
            stringify(redact(value, null, secrets.filter(String::isNotEmpty), 0))
        } catch (_: Exception) {
            JSONObject().put("error", "upstream response omitted").toString()
        }
    }

    private fun collect(value: Any?, key: String?, depth: Int, output: MutableSet<String>) {
        require(depth <= MAX_JSON_DEPTH)
        when (value) {
            is JSONObject -> value.keys().forEach { childKey ->
                collect(value.opt(childKey), childKey, depth + 1, output)
            }
            is JSONArray -> for (index in 0 until value.length()) {
                collect(value.opt(index), key, depth + 1, output)
            }
            is String -> if (key != null && isSensitiveKey(key) && value.isNotEmpty()) {
                output += value
            }
        }
    }

    private fun redact(value: Any?, key: String?, secrets: List<String>, depth: Int): Any {
        require(depth <= MAX_JSON_DEPTH)
        if (key != null && isSensitiveKey(key)) return REDACTED
        return when (value) {
            null, JSONObject.NULL -> JSONObject.NULL
            is JSONObject -> JSONObject().also { output ->
                value.keys().forEach { childKey ->
                    output.put(childKey, redact(value.opt(childKey), childKey, secrets, depth + 1))
                }
            }
            is JSONArray -> JSONArray().also { output ->
                for (index in 0 until value.length()) {
                    output.put(redact(value.opt(index), null, secrets, depth + 1))
                }
            }
            is String -> secrets.fold(value) { redacted, secret -> redacted.replace(secret, REDACTED) }
            else -> value
        }
    }

    private fun isSensitiveKey(key: String): Boolean {
        val normalized = key.lowercase(Locale.ROOT).filter(Char::isLetterOrDigit)
        if (normalized.startsWith("has") || normalized == "admintokenauth") return false
        return listOf(
            "token",
            "secret",
            "password",
            "credential",
            "authorization",
            "apikey",
            "subscriptionkey",
            "privatekey",
            "activationcode",
        ).any(normalized::contains)
    }

    private fun stringify(value: Any): String = when (value) {
        is JSONObject, is JSONArray -> value.toString()
        JSONObject.NULL -> "null"
        is String -> JSONObject.quote(value)
        is Number, is Boolean -> value.toString()
        else -> throw IllegalArgumentException("Unsupported JSON value")
    }
}

private fun decodeUtf8(bytes: ByteArray): String =
    StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
