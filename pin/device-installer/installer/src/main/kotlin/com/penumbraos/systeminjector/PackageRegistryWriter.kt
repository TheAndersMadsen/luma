package com.penumbraos.systeminjector

import com.penumbraos.systeminjector.common.PackagesXmlPatcher
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Writes a package entry to packages.xml so Package Manager recognizes a Luma device app.
 */
object PackageRegistryWriter {

    data class Registration(
        val packageName: String,
        val codePath: String,
        val sharedUserId: Int = 1000,
        val primaryCpuAbi: String? = null,
        val replaceExisting: Boolean = false,
    )

    /**
     * Write the complete package batch to packages.xml and packages-backup.xml.
     */
    fun writeBatch(registrations: List<Registration>) {
        require(registrations.isNotEmpty()) { "No packages requested for registration" }

        val abxData = File("/data/system/packages.xml").readBytes()
        val xmlText = abx2xml(abxData)

        check(xmlText.isNotEmpty()) { "ABX conversion produced empty output" }

        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(xmlText.byteInputStream())
        check(document.documentElement.nodeName == "packages") {
            "packages.xml root element is '${document.documentElement.nodeName}', expected 'packages'"
        }

        for (registration in registrations) {
            PackagesXmlPatcher.insertPackage(
                document = document,
                packageName = registration.packageName,
                codePath = registration.codePath,
                sharedUserId = registration.sharedUserId,
                primaryCpuAbi = registration.primaryCpuAbi,
                replaceExisting = registration.replaceExisting,
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
