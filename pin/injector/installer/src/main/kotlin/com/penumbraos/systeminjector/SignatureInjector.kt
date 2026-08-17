package com.penumbraos.systeminjector

import com.penumbraos.systeminjector.common.PackagesXmlPatcher
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Injects a package entry into packages.xml so PMS recognizes a new system UID app.
 */
object SignatureInjector {

    data class PackageInjection(
        val packageName: String,
        val codePath: String,
        val sharedUserId: Int = 1000,
        val primaryCpuAbi: String? = null,
        val replaceExisting: Boolean = false,
    )

    /**
     * Inject a package into packages.xml and write packages-backup.xml.
     *
     * @param packageName The package name to inject (e.g. "com.example.myapp")
     * @param codePath The path where the APK is installed (e.g. "/data/app/~~hash/com.example.myapp-xxx")
     * @param sharedUserId The shared UID to assign
     * @param primaryCpuAbi The primary CPU ABI (e.g. "arm64-v8a") if native libs are present, null otherwise
     */
    fun inject(packageName: String, codePath: String, sharedUserId: Int = 1000, primaryCpuAbi: String? = null) {
        injectBatch(
            listOf(
                PackageInjection(
                    packageName = packageName,
                    codePath = codePath,
                    sharedUserId = sharedUserId,
                    primaryCpuAbi = primaryCpuAbi,
                )
            )
        )
    }

    /**
     * Inject multiple packages into packages.xml and write packages-backup.xml.
     */
    fun injectBatch(packageInjections: List<PackageInjection>) {
        require(packageInjections.isNotEmpty()) { "No packages requested for injection" }

        val abxData = File("/data/system/packages.xml").readBytes()
        val xmlText = abx2xml(abxData)

        check(xmlText.isNotEmpty()) { "ABX conversion produced empty output" }

        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(xmlText.byteInputStream())
        check(document.documentElement.nodeName == "packages") {
            "packages.xml root element is '${document.documentElement.nodeName}', expected 'packages'"
        }

        for (packageInjection in packageInjections) {
            PackagesXmlPatcher.insertPackage(
                document = document,
                packageName = packageInjection.packageName,
                codePath = packageInjection.codePath,
                sharedUserId = packageInjection.sharedUserId,
                primaryCpuAbi = packageInjection.primaryCpuAbi,
                replaceExisting = packageInjection.replaceExisting,
            )
        }

        val outputBytes = PackagesXmlPatcher.serializeAndValidate(document)

        val backupFile = File("/data/system/packages-backup.xml")
        val tempFile = File(backupFile.parentFile, ".packages-backup.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(tempFile).use { output ->
                output.write(outputBytes)
                output.fd.sync()
            }
            Files.move(
                tempFile.toPath(),
                backupFile.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } finally {
            if (tempFile.exists()) tempFile.delete()
        }
    }
}
