package com.penumbraos.server

import android.content.Context
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.nio.file.LinkOption
import java.nio.file.Files
import java.nio.charset.StandardCharsets
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** Fixed paths and environment for the bundled, loopback-only Codex runtime. */
internal object CodexOnDeviceRuntime {

    private const val EXECUTABLE_NAME = "libcodex_app_server.so"
    private const val HOME_DIRECTORY_NAME = "codex"
    private const val TMP_DIRECTORY_NAME = "codex"
    private const val ANDROID_CA_DIRECTORY = "/system/etc/security/cacerts"
    private const val CA_BUNDLE_NAME = "android-ca-bundle.pem"
    private const val MAX_CA_CERTIFICATE_COUNT = 512
    private const val MAX_CA_CERTIFICATE_BYTES = 64 * 1024L
    private const val MAX_CA_BUNDLE_BYTES = 2 * 1024 * 1024L
    private val LOCAL_BRIDGE_TOKEN_DOMAIN =
        "penumbra/codex-local-bridge/v1\u0000".toByteArray(StandardCharsets.US_ASCII)

    const val LOOPBACK_BRIDGE_URL = "http://127.0.0.1:8765"

    fun configure(
        context: Context,
        environment: MutableMap<String, String>,
        deviceSecret: String,
        dashscopeApiKey: String? = null,
    ) {
        val executable = File(context.applicationInfo.nativeLibraryDir, EXECUTABLE_NAME)
        require(executable.isFile && executable.canExecute()) {
            "Codex app-server executable is unavailable"
        }

        val home = ensurePrivateDirectory(File(context.filesDir, HOME_DIRECTORY_NAME))
        val temporary = ensurePrivateDirectory(File(context.cacheDir, TMP_DIRECTORY_NAME))
        val caDirectory = File(ANDROID_CA_DIRECTORY)
        require(caDirectory.isDirectory && !Files.isSymbolicLink(caDirectory.toPath())) {
            "Android CA directory is unavailable"
        }
        val caBundle = generatePrivateCaBundle(caDirectory, home)

        environment["PENUMBRA_CODEX_APP_SERVER"] = executable.absolutePath
        environment["PENUMBRA_CODEX_HOME"] = home.absolutePath
        environment["PENUMBRA_CODEX_TMPDIR"] = temporary.absolutePath
        environment["PENUMBRA_CODEX_CA_CERTIFICATE"] = caBundle.absolutePath
        // Config resolution already treats this as an operator-owned override.
        // Point only the Codex provider at the in-process loopback bridge; all
        // other outbound providers keep their normal Android networking path.
        environment["CODEX_BRIDGE_URL"] = LOOPBACK_BRIDGE_URL
        environment["CODEX_BRIDGE_TOKEN"] = deriveLocalBridgeToken(deviceSecret)

        // Inject DashScope API key for Qwen model-provider when configured.
        // The key is never logged and flows write-only into the child environment.
        if (!dashscopeApiKey.isNullOrEmpty()) {
            environment["DASHSCOPE_API_KEY"] = dashscopeApiKey
        }
    }

    private fun ensurePrivateDirectory(directory: File): File {
        if (directory.exists() || Files.isSymbolicLink(directory.toPath())) {
            require(directory.isDirectory && !Files.isSymbolicLink(directory.toPath())) {
                "Invalid Codex runtime directory"
            }
        } else {
            require(directory.mkdirs()) { "Failed to create Codex runtime directory" }
        }
        Os.chmod(directory.absolutePath, 0b111000000)
        return directory
    }

    private fun generatePrivateCaBundle(caDirectory: File, home: File): File {
        val certificateFiles = caDirectory.listFiles()
            ?.filter { candidate ->
                Files.isRegularFile(candidate.toPath(), LinkOption.NOFOLLOW_LINKS)
            }
            ?.sortedBy { it.name }
            .orEmpty()
        require(certificateFiles.isNotEmpty()) { "Android CA directory is empty" }
        require(certificateFiles.size <= MAX_CA_CERTIFICATE_COUNT) {
            "Android CA directory contains too many certificates"
        }

        val certificates = certificateFiles.map { certificate ->
            require(!Files.isSymbolicLink(certificate.toPath())) {
                "Android CA certificate cannot be a symbolic link"
            }
            require(certificate.length() in 1..MAX_CA_CERTIFICATE_BYTES) {
                "Android CA certificate has an invalid size"
            }
            val bytes = certificate.readBytes()
            require(bytes.none { it == 0.toByte() }) {
                "Android CA certificate contains invalid data"
            }
            val pem = bytes.toString(StandardCharsets.US_ASCII)
            require(
                pem.contains("-----BEGIN CERTIFICATE-----") &&
                    pem.contains("-----END CERTIFICATE-----"),
            ) {
                "Android CA certificate is not PEM encoded"
            }
            bytes
        }

        val totalBytes = certificates.fold(0L) { total, certificate ->
            Math.addExact(total, certificate.size.toLong() + 1L)
        }
        require(totalBytes <= MAX_CA_BUNDLE_BYTES) { "Android CA bundle is too large" }

        val destination = File(home, CA_BUNDLE_NAME)
        if (destination.exists() || Files.isSymbolicLink(destination.toPath())) {
            require(destination.isFile && !Files.isSymbolicLink(destination.toPath())) {
                "Invalid Codex CA bundle path"
            }
        }

        val temporary = File.createTempFile(".android-ca-bundle-", ".tmp", home)
        try {
            Os.chmod(temporary.absolutePath, 0b110000000)
            FileOutputStream(temporary).use { output ->
                certificates.forEach { certificate ->
                    output.write(certificate)
                    if (certificate.last() != '\n'.code.toByte()) {
                        output.write('\n'.code)
                    }
                }
                output.fd.sync()
            }
            Files.move(
                temporary.toPath(),
                destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            Os.chmod(destination.absolutePath, 0b110000000)
            fsyncDirectory(home)
        } finally {
            if (temporary.exists()) {
                temporary.delete()
            }
        }
        return destination
    }

    private fun fsyncDirectory(directory: File) {
        val descriptor = Os.open(
            directory.absolutePath,
            OsConstants.O_RDONLY or OsConstants.O_CLOEXEC,
            0,
        )
        try {
            Os.fsync(descriptor)
        } finally {
            Os.close(descriptor)
        }
    }

    internal fun deriveLocalBridgeToken(deviceSecret: String): String {
        val validated = EsimBridgeAuthentication.requireValidToken(deviceSecret)
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(LOCAL_BRIDGE_TOKEN_DOMAIN)
        return digest.digest(validated.toByteArray(StandardCharsets.US_ASCII))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }
}
