package com.penumbraos.hook

import java.io.File
import java.util.Properties
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

class HookModuleRegistryTest {
    @Test
    fun aSharedProbeCannotActivateOutsideItsExactPackage() {
        val tickle = HookComponentFactory.HOOK_MODULES.single {
            it.id == "tickle-compatibility"
        }
        val available = { name: String -> name == "humane.experience.ExperienceApplication" }

        assertTrue(tickle.matches("humane.experience.tickle", available))
        assertFalse(tickle.matches("humane.experience.music", available))
        assertFalse(tickle.matches("humane.experience.answers", available))
    }

    @Test
    fun moduleIdentifiersAndPackageProbePairsAreUnique() {
        val modules = HookComponentFactory.HOOK_MODULES
        assertEquals(modules.size, modules.map { it.id }.toSet().size)
        assertEquals(
            modules.size,
            modules.map { it.targetPackage to it.probeClasses }.toSet().size,
        )
    }

    @Test
    fun onboardingUsesOnlyTheCloneTransportModule() {
        val onboarding = HookComponentFactory.HOOK_MODULES.single {
            it.targetPackage == "humane.experience.onboarding"
        }
        assertEquals("onboarding-clone-transport", onboarding.id)
        assertEquals(HookClassification.REQUIRED_TRANSPORT, onboarding.classification)
        assertTrue(
            onboarding.probeClasses.contains(
                "humane.experience.onboarding.OnboardingExperience",
            ),
        )
    }

    @Test
    fun injectorTargetMetadataExactlyMatchesRegisteredPackages() {
        val manifest = parseXml(sourceFile("src/main/AndroidManifest.xml"))
        val metadata = manifest.getElementsByTagName("meta-data")
        val targetEntry = (0 until metadata.length)
            .map { metadata.item(it) as Element }
            .single {
                it.getAttributeNS(ANDROID_NAMESPACE, "name") ==
                    "com.penumbraos.hook.TARGET_PACKAGES"
        }
        val manifestPackages = targetEntry
            .getAttributeNS(ANDROID_NAMESPACE, "value")
            .let(TierAManifestTestPlaceholders::resolve)
            .split(',')
            .map(String::trim)
            .filter(String::isNotEmpty)
            .toSet()
        val registeredPackages = HookComponentFactory.HOOK_MODULES
            .map(HookModuleDescriptor::targetPackage)
            .toSet()

        assertEquals(registeredPackages, manifestPackages)
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/payload", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }

    private fun parseXml(file: File) = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
    }.newDocumentBuilder().parse(file)

    private companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}

internal object TierAManifestTestPlaceholders {
    private val placeholderPattern = Regex("""\$\{([^}]+)}""")

    private val values: Properties by lazy {
        val relativePath = "contracts/tier-a/manifest-placeholders.properties"
        val file = listOf(
            File(relativePath),
            File("../..", relativePath),
        ).firstOrNull(File::isFile)
            ?: throw AssertionError("Missing generated Tier-A manifest placeholders: $relativePath")
        Properties().apply {
            file.inputStream().use { load(it) }
        }
    }

    fun resolve(raw: String): String =
        placeholderPattern.replace(raw) { match ->
            val key = match.groupValues[1]
            values.getProperty(key)
                ?: throw AssertionError("Unknown Tier-A manifest placeholder: $key")
        }
}
