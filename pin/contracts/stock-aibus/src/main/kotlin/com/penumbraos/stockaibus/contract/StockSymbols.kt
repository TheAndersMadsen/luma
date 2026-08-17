package com.penumbraos.stockaibus.contract

/**
 * Every STOCK-owned symbol (package name, class FQCN, proto message name) that
 * more than one Penumbra source file has to spell out.
 *
 * Two invariants govern this file:
 *
 * 1. **The values are recovered from the installed firmware, never authored
 *    here.** They are not edited to "fix" spelling. `factoryService` really is
 *    lower-camel, `getActiveprofileICCID`-style casing really is stock, and the
 *    unprefixed `system.` root on some Photography classes is genuine stock, not
 *    a missing package prefix. Changing a value to look tidier renames a symbol
 *    that only Humane owns.
 *
 * 2. **A wrong value is a SILENT no-op, not a crash.** Almost every constant
 *    here feeds `ClassLoader.loadClass`, a hook probe table, a `ComponentName`,
 *    or a `PackageManager.checkSignatures` / `getPackageUid` authorization
 *    check. A typo does not throw at build time and usually does not throw at
 *    runtime either — the hook simply never installs, or the security gate
 *    simply never matches. `StockSymbolsTest` pins each value byte-for-byte so
 *    an accidental edit is a red test instead of a dead hook.
 *
 * Deliberately NOT centralized here: symbols that appear in exactly one file
 * (the file that declares them is already their single source of truth), the
 * eSIM ACTION strings (`EsimOperationGate` builds them from a prefix while
 * `EsimEventStore` spells them out, and the two sets are asymmetric — see the
 * follow-up note in the architecture docs), and the seven `<package>` entries in
 * `runtime/android/src/main/AndroidManifest.xml` (AGP-merged manifest attributes cannot
 * reference a Kotlin const; [serverQueriedPackages] plus the server module's
 * `StockManifestParityTest` are the only defence there).
 */
object StockSymbols {

    /** The stock system/assistant runtime process. Signature and UID anchor. */
    object Ironman {
        const val PACKAGE = TierASymbols.Packages.IRONMAN
        const val MAIN_APPLICATION_CLASS = "humaneinternal.system.MainApplication"
    }

    /** The stock credential/crypto service process. */
    object Krypto {
        const val PACKAGE = TierASymbols.Packages.KRYPTO
    }

    object Messages {
        const val PACKAGE = TierASymbols.Packages.MESSAGES
        const val PERSISTENT_MESSAGE_STORE_CLASS =
            "humane.experience.messages.store.PersistentMessageStore"
        const val SEMANTIC_INDEX_CLASS = "humane.experience.messages.utilities.SemanticIndex"
    }

    object Music {
        const val PACKAGE = TierASymbols.Packages.MUSIC
    }

    object Photography {
        const val PACKAGE = TierASymbols.Packages.PHOTOGRAPHY
    }

    object Dialer {
        const val PACKAGE = TierASymbols.Packages.DIALER
    }

    object Food {
        const val PACKAGE = TierASymbols.Packages.FOOD
    }

    object Settings {
        const val PACKAGE = TierASymbols.Packages.SETTINGS

        /**
         * Settings is the ONE experience whose exported launcher activity is not
         * [ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY].
         */
        const val SETTINGS_EXPERIENCE_CLASS = "humane.experience.settings.SettingsExperience"
    }

    object Tickle {
        const val PACKAGE = TierASymbols.Packages.TICKLE
    }

    object EsimLpa {
        const val PACKAGE = TierASymbols.Packages.ESIM_LPA

        /** Lower-camel `factoryService` is verbatim stock; do not capitalize it. */
        const val FACTORY_SERVICE_CLASS = "humane.connectivity.esimlpa.factoryService"
    }

    /** Classes shared by every stock experience APK rather than owned by one. */
    object ExperienceRuntime {
        /**
         * The exported MAIN+LAUNCHER activity every stock experience except
         * Settings exposes. Registry: `humaneinternal.experience.HumanePackageManager`.
         */
        const val HUMANE_EXPERIENCE_ACTIVITY = "humaneinternal.system.ipc.HumaneExperienceActivity"

        /**
         * Present in many stock APKs, so it identifies the experience RUNTIME,
         * never the package. Exact package matching stays the load-bearing gate
         * wherever this is used as a hook probe.
         */
        const val EXPERIENCE_APPLICATION_CLASS = "humane.experience.ExperienceApplication"
    }

    /** Proto message names carried over the stock AI Bus binder surface. */
    object AiBusMessages {
        const val UNDERSTAND_REQUEST = TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_REQUEST
        const val UNDERSTAND_RESPONSE = TierASymbols.ProtoKids.SYNAPSE_UNDERSTANDING_RESPONSE
        const val LOCATION_ENVELOPE = TierASymbols.ProtoKids.LOCATION_ENVELOPE
    }

    /**
     * The stock packages `runtime/android/src/main/AndroidManifest.xml` declares under
     * `<queries>`.
     *
     * AGP-merged manifest attributes cannot reference a Kotlin const, so those
     * seven values are necessarily duplicated in XML. This set is the only
     * thing that can notice when they drift: `StockManifestParityTest` (in the
     * server module) parses the manifest and asserts the non-`com.penumbraos.*`
     * `<package>` entries are exactly this set, so adding a stock package to the
     * manifest without adding it here fails the build.
     *
     * Membership is deliberately NOT derived from the dispatch table.
     * `humane.experience.tickle` is dispatched to but has no `<queries>` entry —
     * a real, recorded gap. Adding it here would silently change runtime package
     * visibility; it is tracked as a follow-up instead.
     */
    val serverQueriedPackages: Set<String> = setOf(
        Dialer.PACKAGE,
        Messages.PACKAGE,
        Music.PACKAGE,
        Photography.PACKAGE,
        Food.PACKAGE,
        Krypto.PACKAGE,
        Ironman.PACKAGE,
    )
}
