package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the stock Settings QR scanner and LPA hand-off contract recovered
 * from Settings SHA-256 82adcaed56bab130d6a35cd2f54e15303807c4ac0da463d5747f0d391ce88661.
 */
class EsimQrScannerParityContractTest {
    @Test
    fun `installed settings re-reads the live qr gate at each controller refresh boundary`() {
        assertEquals(
            "humane.experience.settings.ui.cellular.CellSettingsViewController",
            installed.consumerClass,
        )
        assertEquals("getBoolValue", installed.getter)
        assertEquals("ESIM_QR_SCANNER_FLAG", installed.feature)
        assertEquals(
            setOf(ReadBoundary.CONTROLLER_CONSTRUCTION, ReadBoundary.CELLULAR_DATA_UPDATE),
            installed.readBoundaries,
        )
        assertEquals(2, installed.readCountAtConstruction)
        assertEquals(1, installed.readCountPerDataUpdate)
        assertTrue(installed.reloadsViewModelAfterDataUpdateRead)
        assertTrue(installed.cachesValueForItemPress)
        assertFalse(installed.registersFlagChangeObserver)

        // An already-open page updates on its next cellular data callback or
        // page re-entry. A flag-only write does not require a process restart.
        assertTrue(installed.openPageNeedsDataUpdateOrReentry)
        assertFalse(installed.requiresProcessRestart)
    }

    @Test
    fun `registry preserves the installed true default and live refresh metadata`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("\"esim_qr_scanner_enabled\"")
            .substringBefore("FeatureFlagSpec {\n        key: \"tickle\"")

        assertTrue(spec.contains("Shows the eSIM QR scanner entry in stock cellular settings."))
        assertTrue(spec.contains("true,\n        false"))
        assertTrue(installed.firmwareDefault)
        assertFalse(installed.requiresProcessRestart)
    }

    @Test
    fun `stock settings remains sole owner of qr scanner flag gating`() {
        val settingsInstaller = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/SettingsHooks.kt",
        ).readText()
        val compatibilitySources = listOf(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/EsimSettingsHooks.kt",
            "hook/payload/src/main/kotlin/com/penumbraos/hook/EsimLpaHooks.kt",
            "runtime/android/src/main/kotlin/com/penumbraos/server/EsimController.kt",
            "runtime/core/src/api.rs",
            "runtime/core/src/esim.rs",
        ).map(::repoFile).map(File::readText)

        // §19.3: EsimSettingsHooks is DISABLED (lax QR handler crosses cellular trust
        // boundary). The installer must NOT call it live; the disabled reference is
        // preserved for audit traceability.
        assertFalse(
            "EsimSettingsHooks.install(cl) must remain disabled per ghidra §19.3",
            settingsInstaller.contains("EsimSettingsHooks.install(cl)") &&
                !settingsInstaller.contains("// EsimSettingsHooks.install(cl)"),
        )
        compatibilitySources.forEach { source ->
            assertFalse(source.contains("ESIM_QR_SCANNER_FLAG"))
            assertFalse(source.contains("esim_qr_scanner_enabled"))
        }
    }

    @Test
    fun `settings compatibility parser preserves the complete stock qr payload`() {
        val hook = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/EsimSettingsHooks.kt",
        ).readText()

        assertTrue(hook.contains("EsimScanInteractor\\\$EsimResultParser"))
        assertTrue(hook.contains("getDeclaredMethod(\"parse\", resultClass)"))
        assertTrue(hook.contains("""Regex("(?i)^LPA:1\\$.+\\$.+$")"""))
        assertTrue(hook.contains("getMassagedText.invoke(null, result) as? String"))
        assertTrue(hook.contains("parsedResultCtor.newInstance(interactor, massagedText, 0.toShort())"))
    }

    @Test
    fun `center bridge preserves the stock lpa action and activation code extra`() {
        val rustApi = repoFile("runtime/core/src/api/esim.rs").readText()
        val controller = repoFile(
            "runtime/android/src/main/kotlin/com/penumbraos/server/EsimController.kt",
        ).readText()
        val lpaHook = repoFile(
            "hook/payload/src/main/kotlin/com/penumbraos/hook/EsimLpaHooks.kt",
        ).readText()

        assertTrue(
            rustApi.contains("humane.connectivity.esimlpa.downloadVerifyAndEnableProfile"),
        )
        assertTrue(rustApi.contains("serde_json::json!({ \"activationCode\": body.activation_code })"))
        assertTrue(controller.contains("action = lpaAction"))
        assertTrue(controller.contains("put(\"activationCode\", activationCode)"))
        assertTrue(lpaHook.contains("intent.removeExtra(BRIDGE_AUTH_TOKEN_EXTRA)"))
        assertTrue(lpaHook.contains("intent.hasExtra(\"activationCode\")"))
        assertFalse(lpaHook.contains("intent.removeExtra(\"activationCode\")"))
    }

    private enum class ReadBoundary {
        CONTROLLER_CONSTRUCTION,
        CELLULAR_DATA_UPDATE,
    }

    private data class InstalledEsimQrScannerContract(
        val consumerClass: String,
        val getter: String,
        val feature: String,
        val readBoundaries: Set<ReadBoundary>,
        val readCountAtConstruction: Int,
        val readCountPerDataUpdate: Int,
        val reloadsViewModelAfterDataUpdateRead: Boolean,
        val cachesValueForItemPress: Boolean,
        val registersFlagChangeObserver: Boolean,
        val openPageNeedsDataUpdateOrReentry: Boolean,
        val requiresProcessRestart: Boolean,
        val firmwareDefault: Boolean,
    )

    private val installed = InstalledEsimQrScannerContract(
        consumerClass = "humane.experience.settings.ui.cellular.CellSettingsViewController",
        getter = "getBoolValue",
        feature = "ESIM_QR_SCANNER_FLAG",
        readBoundaries = setOf(
            ReadBoundary.CONTROLLER_CONSTRUCTION,
            ReadBoundary.CELLULAR_DATA_UPDATE,
        ),
        readCountAtConstruction = 2,
        readCountPerDataUpdate = 1,
        reloadsViewModelAfterDataUpdateRead = true,
        cachesValueForItemPress = true,
        registersFlagChangeObserver = false,
        openPageNeedsDataUpdateOrReentry = true,
        requiresProcessRestart = false,
        firmwareDefault = true,
    )

    private fun repoFile(relativePath: String): File {
        val candidates = listOf(
            File(relativePath),
            File("..", relativePath),
            File("../..", relativePath),
        )
        return candidates.firstOrNull { it.exists() }
            ?: throw AssertionError("Missing repository contract path: $relativePath")
    }
}
