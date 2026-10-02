package com.penumbraos.systeminjector

import android.util.Log
import com.android.apksig.ApkSigner
import com.android.apksig.ApkVerifier
import com.penumbraos.systeminjector.common.SigningConstants
import com.wind.meditor.core.FileProcesser
import com.wind.meditor.property.AttributeItem
import com.wind.meditor.property.ModificationProperty
import com.wind.meditor.utils.NodeValue
import java.io.File
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec

/**
 * Patches an APK to run as system UID:
 * 1. Adds android:sharedUserId="android.uid.system" to the manifest
 * 2. Re-signs the APK with the embedded PKCS#8 key and X.509 certificate
 * 3. Verifies the signature matches TARGET_CERT_HEX
 */
object ApkPatcher {

    private const val TAG = "ApkPatcher"
    private const val PRIVATE_KEY_ASSET = "abxdroppedapk-private-key.pk8"
    private const val CERTIFICATE_ASSET = "abxdroppedapk-certificate.der"
    private const val KEY_ALIAS = "abxdroppedapk"

    /**
     * Result of a successful patch operation.
     * @param signedApk The path to the signed, patched APK (temp file)
     * @param packageName The package name extracted from the APK
     */
    data class PatchResult(
        val signedApk: File,
        val packageName: String,
        val targetSdkVersion: Int,
    )

    /**
     * Patch an APK to be a system UID app.
     *
     * @param inputApk Path to the original APK
     * @param assetOpener Function to open an asset by name (from Context.assets::open)
     * @param workDir Temporary directory for intermediate files
     * @return PatchResult on success
     * @throws SecurityException if the signed APK's certificate doesn't match TARGET_CERT_HEX
     * @throws Exception on any other failure
     */
    fun patch(
        inputApk: File,
        assetOpener: (String) -> java.io.InputStream,
        workDir: File
    ): PatchResult {
        workDir.mkdirs()

        val packageName = extractPackageName(inputApk)
        val targetSdkVersion = extractTargetSdkVersion(inputApk)
        Log.w(TAG, "Extracted package name: $packageName")
        Log.w(TAG, "Extracted targetSdkVersion: $targetSdkVersion")

        val patchedApk = File(workDir, "patched.apk")
        patchManifest(inputApk, patchedApk)
        Log.w(TAG, "Manifest patched: added sharedUserId")

        val signedApk = File(workDir, "signed.apk")
        sign(patchedApk, signedApk, assetOpener)
        Log.w(TAG, "APK re-signed")

        verify(signedApk)
        Log.w(TAG, "Signature verified: matches TARGET_CERT_HEX")

        // Clean up intermediate file
        patchedApk.delete()

        return PatchResult(signedApk, packageName, targetSdkVersion)
    }

    /**
     * Extract package name using Android framework's PackageParser (hidden API).
     * Available on Android 12 (API 31/32).
     */
    fun extractPackageName(apk: File): String {
        val pkg = parsePackage(apk)
        val packageNameField = pkg.javaClass.getField("packageName")
        return packageNameField.get(pkg) as String
    }

    private fun extractTargetSdkVersion(apk: File): Int {
        val pkg = parsePackage(apk)
        val applicationInfoField = pkg.javaClass.getField("applicationInfo")
        val applicationInfo = applicationInfoField.get(pkg)
            ?: throw IllegalStateException("PackageParser returned null applicationInfo")
        val targetSdkVersionField = applicationInfo.javaClass.getField("targetSdkVersion")
        return targetSdkVersionField.getInt(applicationInfo)
    }

    private fun parsePackage(apk: File): Any {
        @Suppress("DEPRECATION")
        val parserClass = Class.forName("android.content.pm.PackageParser")
        val parser = parserClass.getDeclaredConstructor().newInstance()
        val parseMethod = parserClass.getMethod("parsePackage", File::class.java, Int::class.javaPrimitiveType)
        return parseMethod.invoke(parser, apk, 0)
    }

    /**
     * Patch the APK's manifest to add android:sharedUserId="android.uid.system".
     *
     * Uses ManifestEditor's FileProcesser which:
     * - Re-zips the APK with the modified manifest
     * - Strips existing signature files (META-INF .SF, .RSA, etc.)
     */
    private fun patchManifest(inputApk: File, outputApk: File) {
        val property = ModificationProperty()
            .addManifestAttribute(
                // Note: NodeValue.Manifest.SHARDE_USER_ID is the library's constant (typo is theirs)
                AttributeItem(NodeValue.Manifest.SHARDE_USER_ID, "android.uid.system")
            )

        FileProcesser.processApkFile(
            inputApk.absolutePath,
            outputApk.absolutePath,
            property
        )
    }

    /**
     * Re-sign the APK with v2 signing using standard key/certificate encodings.
     */
    private fun sign(inputApk: File, outputApk: File, assetOpener: (String) -> java.io.InputStream) {
        val privateKeyBytes = assetOpener(PRIVATE_KEY_ASSET).use { it.readBytes() }
        val privateKey = try {
            KeyFactory.getInstance("RSA")
                .generatePrivate(PKCS8EncodedKeySpec(privateKeyBytes)) as PrivateKey
        } finally {
            privateKeyBytes.fill(0)
        }
        val certificate = assetOpener(CERTIFICATE_ASSET).use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        check(privateKey.algorithm == "RSA" && certificate.publicKey.algorithm == "RSA") {
            "Embedded signing material is not RSA"
        }
        val certChain = listOf(certificate)

        val signerConfig = ApkSigner.SignerConfig.Builder(
            KEY_ALIAS,
            privateKey,
            certChain
        ).build()

        val signer = ApkSigner.Builder(listOf(signerConfig))
            .setInputApk(inputApk)
            .setOutputApk(outputApk)
            .setV1SigningEnabled(false)
            .setV2SigningEnabled(true)
            .setV3SigningEnabled(false)
            .build()

        signer.sign()
    }

    /**
     * Verify that the signed APK's certificate matches TARGET_CERT_HEX.
     *
     * @throws SecurityException if the certificate doesn't match
     */
    private fun verify(signedApk: File) {
        val result = ApkVerifier.Builder(signedApk).build().verify()

        if (!result.isVerified) {
            val errors = result.errors.joinToString("; ") { it.toString() }
            throw SecurityException("APK verification failed: $errors")
        }

        val signerCerts = result.signerCertificates
        if (signerCerts.isEmpty()) {
            throw SecurityException("APK has no signer certificates")
        }

        // Get the DER-encoded certificate and convert to hex
        val certHex = signerCerts[0].encoded.joinToString("") { "%02x".format(it) }

        if (certHex != SigningConstants.TARGET_CERT_HEX) {
            throw SecurityException(
                "Certificate mismatch! Expected TARGET_CERT_HEX but got different cert. Aborting"
            )
        }
    }
}
