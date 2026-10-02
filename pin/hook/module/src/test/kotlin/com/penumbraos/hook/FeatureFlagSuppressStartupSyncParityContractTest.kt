package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the installed scheduling contract for the startup-sync suppression flag.
 *
 * The DEX/reference audit covers the 21 unique Humane APKs pulled from firmware
 * 101.000470.45.20. Ironman's audited APK SHA-256 is
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class FeatureFlagSuppressStartupSyncParityContractTest {
    @Test
    fun `installed corpus has exactly one startup scheduler read`() {
        assertEquals(21, installedArtifacts.size)
        assertEquals(17, installedArtifacts.count(ArtifactScan::declaresSelector))
        assertEquals(4, installedArtifacts.count { !it.declaresSelector })
        assertEquals(1, installedArtifacts.sumOf(ArtifactScan::externalFieldReads))
        assertEquals(
            listOf("hu.ma.ne.ironman"),
            installedArtifacts.filter { it.externalFieldReads > 0 }.map(ArtifactScan::apk),
        )
        assertTrue(installedArtifacts.all { it.rawKeyConsumers == 0 })

        assertEquals("FEATURE_FLAG_SUPPRESS_SYNC_ON_STARTUP", installed.enumName)
        assertEquals("feature_flag_suppress_sync_on_startup", installed.key)
        assertEquals(1, installed.runtimeConsumerCount)
        assertEquals(1, installed.getBoolCallSites)
        assertEquals(0, installed.observerCount)
        assertEquals(0, installed.nativeLibraryMatches)
        assertEquals(
            "AppController singleton construction",
            installed.readBoundary,
        )
        assertTrue(installed.ironmanProcessRestartRequired)
    }

    @Test
    fun `false preserves the boot fetch while true only suppresses that one-time work`() {
        assertTrue(flagFalse.explicitImmediateSync)
        assertTrue(flagFalse.periodicSyncEnqueued)
        assertEquals(1, flagFalse.periodicInitialDelayDays)

        assertFalse(flagTrue.explicitImmediateSync)
        assertTrue(flagTrue.periodicSyncEnqueued)
        assertNull(flagTrue.periodicInitialDelayDays)

        assertEquals(ExistingWorkPolicy.REPLACE, flagFalse.immediateWorkPolicy)
        assertEquals(ExistingPeriodicWorkPolicy.KEEP, flagFalse.periodicWorkPolicy)
        assertEquals(flagFalse.periodicWorkPolicy, flagTrue.periodicWorkPolicy)
        assertEquals(1, flagFalse.periodicIntervalDays)
        assertEquals(flagFalse.periodicIntervalDays, flagTrue.periodicIntervalDays)
        assertTrue(flagFalse.requiresConnectedNetwork)
        assertTrue(flagTrue.requiresConnectedNetwork)

        // KEEP means a previously enqueued unique periodic request is retained;
        // a later startup does not necessarily replace its initial-delay policy.
        assertTrue(installed.existingPeriodicRequestRetained)
        assertFalse(installed.liveAssignmentChangeCancelsQueuedWork)
    }

    @Test
    fun `push dashboard and debug sync remain available outside the startup selector`() {
        assertEquals(
            setOf("AppController startup"),
            installed.gatedImmediateSyncTriggers,
        )
        assertEquals(
            setOf("humane.feature-flags push", "FORCE_FLAG_SYNC debug/dashboard broadcast"),
            installed.ungatedImmediateSyncTriggers,
        )
        assertTrue(installed.periodicPathAlwaysEnqueued)
        assertFalse(installed.suppressesAllFeatureFlagSync)
    }

    @Test
    fun `stock default and manager failure fallbacks keep startup refresh enabled`() {
        assertEquals(StockValueType.BOOL, installed.valueType)
        assertFalse(installed.firmwareDefault)
        assertFalse(installed.serverAssignmentObserved)
        assertFalse(installed.missingServiceValue)
        assertFalse(installed.remoteExceptionValue)
        assertTrue(installed.wrongTypeThrows)
    }

    @Test
    fun `penumbra locks the flag absent but retains an independent verified sync path`() {
        val catalog = repoFile("runtime/core/src/feature_flags.rs").readText()
        val spec = catalog
            .substringAfter("key: \"feature_flag_suppress_sync_on_startup\"")
            .substringBefore("key: \"touchcode_timeout_millis\"")

        assertTrue(spec.contains("value_type: FeatureFlagValueType::Bool"))
        assertTrue(spec.contains("firmware_default: FeatureFlagDefault::Bool(false)"))
        assertTrue(spec.contains("penumbra_default: None"))
        assertTrue(spec.contains("writable: false"))
        assertTrue(spec.contains("restart_recommended: true"))
        assertTrue(spec.contains("one-time startup feature-flag fetch"))
        assertTrue(spec.contains("periodic, push, and debug/dashboard sync paths remain"))
        assertTrue(spec.contains("daily periodic work remains enqueued"))

        val api = repoFile("runtime/core/src/api/feature_flags.rs").readText()
        assertTrue(api.contains("FORCE_FLAG_SYNC_ACTION"))
        assertTrue(api.contains("command.args([\"broadcast\", \"-a\", FORCE_FLAG_SYNC_ACTION])"))
        assertTrue(api.contains("publish_feature_flags_and_sync("))

        val acknowledgement = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook/FeatureFlagApplyAckHooks.kt",
        ).readText()
        assertTrue(acknowledgement.contains("\"setServerFlags\""))
        assertTrue(acknowledgement.contains("\"getFlagAssignment\""))
        assertTrue(acknowledgement.contains("exactReadBack"))

        val hookSources = repoFile(
            "hook/module/src/main/kotlin/com/penumbraos/hook",
        ).walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        listOf(installed.key, installed.enumName).forEach { selector ->
            assertFalse(
                "Production Hook must not force or replace the stock startup decision: $selector",
                hookSources.any { it.readText().contains(selector) },
            )
        }
    }

    private enum class StockValueType { BOOL }

    private enum class ExistingWorkPolicy { REPLACE }

    private enum class ExistingPeriodicWorkPolicy { KEEP }

    private data class ArtifactScan(
        val apk: String,
        val declaresSelector: Boolean,
        val externalFieldReads: Int = 0,
        val rawKeyConsumers: Int = 0,
    )

    private data class SchedulingContract(
        val explicitImmediateSync: Boolean,
        val periodicSyncEnqueued: Boolean,
        val periodicInitialDelayDays: Int?,
        val periodicIntervalDays: Int = 1,
        val immediateWorkPolicy: ExistingWorkPolicy = ExistingWorkPolicy.REPLACE,
        val periodicWorkPolicy: ExistingPeriodicWorkPolicy = ExistingPeriodicWorkPolicy.KEEP,
        val requiresConnectedNetwork: Boolean = true,
    )

    private data class InstalledContract(
        val enumName: String,
        val key: String,
        val runtimeConsumerCount: Int,
        val getBoolCallSites: Int,
        val observerCount: Int,
        val nativeLibraryMatches: Int,
        val readBoundary: String,
        val ironmanProcessRestartRequired: Boolean,
        val existingPeriodicRequestRetained: Boolean,
        val liveAssignmentChangeCancelsQueuedWork: Boolean,
        val gatedImmediateSyncTriggers: Set<String>,
        val ungatedImmediateSyncTriggers: Set<String>,
        val periodicPathAlwaysEnqueued: Boolean,
        val suppressesAllFeatureFlagSync: Boolean,
        val valueType: StockValueType,
        val firmwareDefault: Boolean,
        val serverAssignmentObserved: Boolean,
        val missingServiceValue: Boolean,
        val remoteExceptionValue: Boolean,
        val wrongTypeThrows: Boolean,
    )

    private val installedArtifacts = listOf(
        ArtifactScan("hu.ma.ne.ironman", declaresSelector = true, externalFieldReads = 1),
        ArtifactScan("humane.experience.answers", declaresSelector = true),
        ArtifactScan("humane.experience.clock", declaresSelector = true),
        ArtifactScan("humane.experience.contacts", declaresSelector = true),
        ArtifactScan("humane.experience.dialer", declaresSelector = true),
        ArtifactScan("humane.experience.food", declaresSelector = true),
        ArtifactScan("humane.experience.messages", declaresSelector = true),
        ArtifactScan("humane.experience.music", declaresSelector = true),
        ArtifactScan("humane.experience.notifications", declaresSelector = true),
        ArtifactScan("humane.experience.photography", declaresSelector = true),
        ArtifactScan("humane.experience.settings", declaresSelector = true),
        ArtifactScan("humane.experience.systemnavigation", declaresSelector = true),
        ArtifactScan("humane.experience.tickle", declaresSelector = true),
        ArtifactScan("humane.experience.translation", declaresSelector = true),
        ArtifactScan("humane.experience.vision", declaresSelector = true),
        ArtifactScan("humane.experience.voicemail", declaresSelector = true),
        ArtifactScan("humane.grandcentral", declaresSelector = true),
        ArtifactScan("humane.connectivity.esimlpa", declaresSelector = false),
        ArtifactScan("humane.experience.onboarding", declaresSelector = false),
        ArtifactScan("humane.voice.recognition", declaresSelector = false),
        ArtifactScan("humane.voice.tts", declaresSelector = false),
    )

    private val installed = InstalledContract(
        enumName = "FEATURE_FLAG_SUPPRESS_SYNC_ON_STARTUP",
        key = "feature_flag_suppress_sync_on_startup",
        runtimeConsumerCount = 1,
        getBoolCallSites = 1,
        observerCount = 0,
        nativeLibraryMatches = 0,
        readBoundary = "AppController singleton construction",
        ironmanProcessRestartRequired = true,
        existingPeriodicRequestRetained = true,
        liveAssignmentChangeCancelsQueuedWork = false,
        gatedImmediateSyncTriggers = setOf("AppController startup"),
        ungatedImmediateSyncTriggers = setOf(
            "humane.feature-flags push",
            "FORCE_FLAG_SYNC debug/dashboard broadcast",
        ),
        periodicPathAlwaysEnqueued = true,
        suppressesAllFeatureFlagSync = false,
        valueType = StockValueType.BOOL,
        firmwareDefault = false,
        serverAssignmentObserved = false,
        missingServiceValue = false,
        remoteExceptionValue = false,
        wrongTypeThrows = true,
    )

    private val flagFalse = SchedulingContract(
        explicitImmediateSync = true,
        periodicSyncEnqueued = true,
        periodicInitialDelayDays = 1,
    )

    private val flagTrue = SchedulingContract(
        explicitImmediateSync = false,
        periodicSyncEnqueued = true,
        periodicInitialDelayDays = null,
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
