package com.penumbraos.stockaibus.contract

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the legacy compatibility surface delegates to the generated Tier-A
 * registry.
 *
 * Reflection class names not represented in Tier A remain pinned here because
 * [StockSymbols] is still their canonical declaration.
 */
class StockSymbolsTest {
    @Test
    fun stockPackageAliasesDelegateToTheTierARegistry() {
        assertEquals(TierASymbols.Packages.IRONMAN, StockSymbols.Ironman.PACKAGE)
        assertEquals(TierASymbols.Packages.KRYPTO, StockSymbols.Krypto.PACKAGE)
        assertEquals(TierASymbols.Packages.MESSAGES, StockSymbols.Messages.PACKAGE)
        assertEquals(TierASymbols.Packages.MUSIC, StockSymbols.Music.PACKAGE)
        assertEquals(TierASymbols.Packages.PHOTOGRAPHY, StockSymbols.Photography.PACKAGE)
        assertEquals(TierASymbols.Packages.DIALER, StockSymbols.Dialer.PACKAGE)
        assertEquals(TierASymbols.Packages.FOOD, StockSymbols.Food.PACKAGE)
        assertEquals(TierASymbols.Packages.SETTINGS, StockSymbols.Settings.PACKAGE)
        assertEquals(TierASymbols.Packages.TICKLE, StockSymbols.Tickle.PACKAGE)
        assertEquals(TierASymbols.Packages.ESIM_LPA, StockSymbols.EsimLpa.PACKAGE)
    }

    @Test
    fun reflectionTargetClassNamesMatchTheInstalledFirmware() {
        assertEquals(
            "humaneinternal.system.MainApplication",
            StockSymbols.Ironman.MAIN_APPLICATION_CLASS,
        )
        assertEquals(
            "humane.experience.messages.store.PersistentMessageStore",
            StockSymbols.Messages.PERSISTENT_MESSAGE_STORE_CLASS,
        )
        assertEquals(
            "humane.experience.messages.utilities.SemanticIndex",
            StockSymbols.Messages.SEMANTIC_INDEX_CLASS,
        )
        assertEquals(
            "humane.experience.settings.SettingsExperience",
            StockSymbols.Settings.SETTINGS_EXPERIENCE_CLASS,
        )
        assertEquals(
            "humane.connectivity.esimlpa.factoryService",
            StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS,
        )
        assertEquals(
            "humaneinternal.system.ipc.HumaneExperienceActivity",
            StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY,
        )
        assertEquals(
            "humane.experience.ExperienceApplication",
            StockSymbols.ExperienceRuntime.EXPERIENCE_APPLICATION_CLASS,
        )
    }

    @Test
    fun aiBusMessageNamesMatchTheTransactionTable() {
        assertEquals(
            TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_REQUEST,
            StockSymbols.AiBusMessages.UNDERSTAND_REQUEST,
        )
        assertEquals(
            TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_RESPONSE,
            StockSymbols.AiBusMessages.UNDERSTAND_RESPONSE,
        )
        assertEquals(
            TierASymbols.ProtoKids.LOCATION_ENVELOPE,
            StockSymbols.AiBusMessages.LOCATION_ENVELOPE,
        )

        // The compatibility API and transaction table must consume the generated
        // boundary, not re-spell its values.
        val synapse = StockAiBusContract.transaction(
            StockAiBusContract.TRANSACTION_SYNAPSE_UNDERSTANDING,
        )!!
        assertEquals(
            StockSymbols.AiBusMessages.UNDERSTAND_REQUEST,
            (synapse.arguments.first { it.name == "request" }.value as WireValue.Proto).className,
        )
        assertEquals(
            StockSymbols.AiBusMessages.LOCATION_ENVELOPE,
            (synapse.arguments.first { it.name == "location" }.value as WireValue.Proto).className,
        )
        assertEquals(
            StockSymbols.AiBusMessages.UNDERSTAND_RESPONSE,
            (
                synapse.arguments.first { it.name == "responseHandler" }.value
                    as WireValue.StreamObserver
                ).valueClassName,
        )
    }

    /**
     * The lower-camel `factoryService` and the missing `.messages`/`.settings`
     * style suffix symmetry are stock quirks, not typos. This guards the exact
     * shapes a well-meaning rename would "correct".
     */
    @Test
    fun stockSpellingQuirksAreNotNormalized() {
        assertTrue(StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS.endsWith(".factoryService"))
        assertEquals(
            "${StockSymbols.EsimLpa.PACKAGE}.factoryService",
            StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS,
        )

        // EsimOperationGate's ACTION_PREFIX is this package plus a trailing dot.
        // They are deliberately NOT derived from each other; assert they stay
        // distinguishable so nobody collapses the two.
        assertTrue(!StockSymbols.EsimLpa.PACKAGE.endsWith("."))

        // `humaneinternal.*` and `humane.*` are two different stock roots.
        assertTrue(StockSymbols.Ironman.MAIN_APPLICATION_CLASS.startsWith("humaneinternal."))
        assertTrue(
            StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY
                .startsWith("humaneinternal."),
        )
        assertTrue(
            StockSymbols.ExperienceRuntime.EXPERIENCE_APPLICATION_CLASS
                .startsWith("humane.experience."),
        )
    }

    @Test
    fun everyExperiencePackageIsDistinct() {
        val packages = listOf(
            StockSymbols.Ironman.PACKAGE,
            StockSymbols.Krypto.PACKAGE,
            StockSymbols.Messages.PACKAGE,
            StockSymbols.Music.PACKAGE,
            StockSymbols.Photography.PACKAGE,
            StockSymbols.Dialer.PACKAGE,
            StockSymbols.Food.PACKAGE,
            StockSymbols.Settings.PACKAGE,
            StockSymbols.Tickle.PACKAGE,
            StockSymbols.EsimLpa.PACKAGE,
        )
        assertEquals(packages.size, packages.toSet().size)
        assertTrue(StockSymbols.serverQueriedPackages.all { it in packages })
    }

    @Test
    fun serverQueriedPackagesPinTheManifestAllowlist() {
        assertEquals(
            setOf(
                TierASymbols.Packages.DIALER,
                TierASymbols.Packages.MESSAGES,
                TierASymbols.Packages.MUSIC,
                TierASymbols.Packages.PHOTOGRAPHY,
                TierASymbols.Packages.FOOD,
                TierASymbols.Packages.KRYPTO,
                TierASymbols.Packages.IRONMAN,
            ),
            StockSymbols.serverQueriedPackages,
        )
    }
}
