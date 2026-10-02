package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the stock network-reset surface recovered from Settings SHA-256
 * 82adcaed56bab130d6a35cd2f54e15303807c4ac0da463d5747f0d391ce88661.
 */
class NetworkResetParityContractTest {
    @Test
    fun `installed about model samples the flag only when that page is constructed`() {
        assertEquals(
            "humane.experience.settings.ui.about.AboutViewController\$AboutViewModelProvider",
            installed.consumerClass,
        )
        assertEquals("getBoolValue", installed.getter)
        assertEquals("NETWORK_RESET_ENABLED", installed.feature)
        assertEquals(setOf(ReadBoundary.ABOUT_MODEL_CONSTRUCTION), installed.readBoundaries)
        assertEquals(1, installed.readCountAtConstruction)
        assertFalse(installed.registersFlagChangeObserver)
        assertFalse(installed.hasRefreshRead)
        assertFalse(installed.flagOnlyUpdateRefreshesOpenAbout)
        assertTrue(installed.reenteringAboutConstructsFreshModel)
        assertFalse(installed.requiresProcessRestart)
        assertFalse(installed.firmwareDefault)
        assertEquals(
            listOf("VERSION", "SERIAL_NO", "CHECK_FOR_UPDATES", "FACTORY_RESET"),
            installed.disabledAboutItems,
        )
        assertEquals(
            listOf(
                "VERSION",
                "SERIAL_NO",
                "CHECK_FOR_UPDATES",
                "NETWORK_RESET",
                "FACTORY_RESET",
            ),
            installed.enabledAboutItems,
        )
        assertTrue(installed.networkResetRowIsPressable)
    }

    @Test
    fun `registry describes page reentry without claiming a process restart`() {
        assertEquals(
            "network_reset_enabled",
            TierASymbols.FeatureFlags.Cloud.NETWORK_RESET_ENABLED,
        )

        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: cloud_keys::NETWORK_RESET_ENABLED", "")
            .substringBefore("key: cloud_keys::SYNAPSE_BIDIRECTIONAL_STREAMING", "")

        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::Bool(false)"))
        assertTrue(spec.contains("re-enter About after changing this flag"))
        assertTrue(spec.contains("never executes a reset by itself"))
        assertTrue(spec.contains("does not revoke a reset submenu or confirmation dialog"))
        assertTrue(spec.contains("restart_recommended: false"))
        assertFalse(spec.contains("restart_recommended: true"))

    }

    @Test
    fun `stock confirmation remains the sole network reset execution boundary`() {
        assertEquals(listOf("reset", "cancel"), installed.confirmationButtons)
        assertEquals("NetworkResetNode.firstButtonPressed", installed.destructiveEntryPoint)
        assertTrue(installed.cancelOnlyNavigatesBack)
        assertFalse(installed.hasPasscodeChallenge)
        assertFalse(installed.rechecksFlagInSubmenuOrConfirmation)
        assertFalse(installed.hasDirectVoiceOrSettingsActionRoute)

        assertEquals(
            listOf("ContentResolver.delete(DEFAULTAPN_URI)"),
            installed.cellularImmediateEffects,
        )
        assertEquals(
            listOf(
                "ConnectivityManager.factoryReset",
                "TelephonyManager.resetSettings",
                "NetworkPolicyManager.factoryReset",
                "TelephonyManager.resetIms",
            ),
            installed.cellularQueuedEffects,
        )
        assertEquals(
            listOf(
                "ConnectivityManager.factoryReset",
                "WifiManager.factoryReset",
                "WifiP2pManager.factoryReset",
                "BluetoothAdapter.factoryReset",
            ),
            installed.wifiAndBluetoothQueuedEffects,
        )
    }

    @Test
    fun `penumbra cannot skip the stock reset confirmation`() {
        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        val androidServerSources = repoFile(
            "runtime/android/src/main/kotlin/com/penumbraos/server",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        val api = repoFile("runtime/core/src/api.rs").readText()

        listOf(
            "NetworkResetNode",
            "NetworkResetUtils",
            "NETWORK_RESET_ENABLED",
            "network_reset_enabled",
        ).forEach { stockContract ->
            assertFalse(hookSources.any { it.readText().contains(stockContract) })
        }
        assertFalse(androidServerSources.any { it.readText().contains("NetworkResetUtils") })
        assertFalse(androidServerSources.any { it.readText().contains("factoryReset(") })
        assertFalse(api.contains("/api/network-reset"))
    }

    private enum class ReadBoundary {
        ABOUT_MODEL_CONSTRUCTION,
    }

    private data class InstalledNetworkResetContract(
        val consumerClass: String,
        val getter: String,
        val feature: String,
        val readBoundaries: Set<ReadBoundary>,
        val readCountAtConstruction: Int,
        val registersFlagChangeObserver: Boolean,
        val hasRefreshRead: Boolean,
        val flagOnlyUpdateRefreshesOpenAbout: Boolean,
        val reenteringAboutConstructsFreshModel: Boolean,
        val requiresProcessRestart: Boolean,
        val firmwareDefault: Boolean,
        val disabledAboutItems: List<String>,
        val enabledAboutItems: List<String>,
        val networkResetRowIsPressable: Boolean,
        val confirmationButtons: List<String>,
        val destructiveEntryPoint: String,
        val cancelOnlyNavigatesBack: Boolean,
        val hasPasscodeChallenge: Boolean,
        val rechecksFlagInSubmenuOrConfirmation: Boolean,
        val hasDirectVoiceOrSettingsActionRoute: Boolean,
        val cellularImmediateEffects: List<String>,
        val cellularQueuedEffects: List<String>,
        val wifiAndBluetoothQueuedEffects: List<String>,
    )

    private val installed = InstalledNetworkResetContract(
        consumerClass =
            "humane.experience.settings.ui.about.AboutViewController\$AboutViewModelProvider",
        getter = "getBoolValue",
        feature = "NETWORK_RESET_ENABLED",
        readBoundaries = setOf(ReadBoundary.ABOUT_MODEL_CONSTRUCTION),
        readCountAtConstruction = 1,
        registersFlagChangeObserver = false,
        hasRefreshRead = false,
        flagOnlyUpdateRefreshesOpenAbout = false,
        reenteringAboutConstructsFreshModel = true,
        requiresProcessRestart = false,
        firmwareDefault = false,
        disabledAboutItems = listOf(
            "VERSION",
            "SERIAL_NO",
            "CHECK_FOR_UPDATES",
            "FACTORY_RESET",
        ),
        enabledAboutItems = listOf(
            "VERSION",
            "SERIAL_NO",
            "CHECK_FOR_UPDATES",
            "NETWORK_RESET",
            "FACTORY_RESET",
        ),
        networkResetRowIsPressable = true,
        confirmationButtons = listOf("reset", "cancel"),
        destructiveEntryPoint = "NetworkResetNode.firstButtonPressed",
        cancelOnlyNavigatesBack = true,
        hasPasscodeChallenge = false,
        rechecksFlagInSubmenuOrConfirmation = false,
        hasDirectVoiceOrSettingsActionRoute = false,
        cellularImmediateEffects = listOf("ContentResolver.delete(DEFAULTAPN_URI)"),
        cellularQueuedEffects = listOf(
            "ConnectivityManager.factoryReset",
            "TelephonyManager.resetSettings",
            "NetworkPolicyManager.factoryReset",
            "TelephonyManager.resetIms",
        ),
        wifiAndBluetoothQueuedEffects = listOf(
            "ConnectivityManager.factoryReset",
            "WifiManager.factoryReset",
            "WifiP2pManager.factoryReset",
            "BluetoothAdapter.factoryReset",
        ),
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
