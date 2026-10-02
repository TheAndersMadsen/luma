package com.penumbraos.server

import com.penumbraos.stockaibus.contract.StockSymbols
import java.io.File
import java.util.Properties
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * Exact membership guard for the stock package-visibility allowlist.
 *
 * Tier-A package values are generated as build-time manifest placeholders, but
 * `<queries>` still requires one XML element per package. This test resolves
 * those generated placeholders and requires the manifest's non-Penumbra
 * membership to equal [StockSymbols.serverQueriedPackages] exactly. Adding or
 * removing a package on only one side therefore fails the build.
 *
 * Known, deliberate gap recorded rather than silently fixed here:
 * `humane.experience.tickle` is a live dispatch target
 * ([DeviceActionDispatcher.StockAction.TICKLE]) but has NO `<queries>` entry.
 * Adding one changes runtime package visibility, so it is tracked as a
 * follow-up. [tickleIsDispatchedToButNotDeclaredInQueries] pins the gap so it
 * cannot be forgotten and cannot change unnoticed.
 */
class StockManifestParityTest {
    @Test
    fun manifestQueriesMatchTheCentralizedStockAllowlistExactly() {
        assertEquals(StockSymbols.serverQueriedPackages, stockQueriedPackages())
    }

    @Test
    fun everyQueriedPackageIsEitherPenumbraOwnedOrACentralizedStockSymbol() {
        val declared = queriedPackages()
        assertTrue("Manifest declares no <queries> packages", declared.isNotEmpty())
        val unaccounted = declared.filterNot { name ->
            name.startsWith("com.penumbraos.") || name in StockSymbols.serverQueriedPackages
        }
        assertEquals(emptyList<String>(), unaccounted)
    }

    @Test
    fun tickleIsDispatchedToButNotDeclaredInQueries() {
        // Documented defect, not an assertion that the gap is correct: the
        // dispatch table and the visibility allowlist disagree. If someone adds
        // the <queries> entry, this test fails and forces a deliberate decision
        // about the runtime visibility change.
        assertEquals(
            StockSymbols.Tickle.PACKAGE,
            DeviceActionDispatcher.StockAction.TICKLE.targetPackage,
        )
        assertTrue(StockSymbols.Tickle.PACKAGE !in queriedPackages())
        assertTrue(StockSymbols.Tickle.PACKAGE !in StockSymbols.serverQueriedPackages)
    }

    private fun stockQueriedPackages(): Set<String> =
        queriedPackages().filterNot { it.startsWith("com.penumbraos.") }.toSet()

    private fun queriedPackages(): List<String> {
        val document = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
        }.newDocumentBuilder().parse(sourceFile("src/main/AndroidManifest.xml"))

        val queries = document.getElementsByTagName("queries")
        assertEquals("Expected exactly one <queries> block", 1, queries.length)
        val packages = (queries.item(0) as Element).getElementsByTagName("package")
        return (0 until packages.length).map { index ->
            TierAManifestTestPlaceholders.resolve(
                (packages.item(index) as Element).getAttributeNS(ANDROID_NAMESPACE, "name"),
            )
        }
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("runtime/android", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }

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
