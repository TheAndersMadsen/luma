package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Observed: machine-checkable parity contract for the 138 @Action classes
 * recovered from operator-owned installed Ironman SHA-256
 * 44bc22bfb666a2e4e679072e6d26b007391627df75174b50406a2e2fdb768c8e.
 */
class NativeActionParityLedgerTest {
    @Test
    fun `ledger exactly covers the installed 138 action catalog`() {
        assertEquals(138, rows.size)
        assertEquals(rows.size, rows.map { it.action }.toSet().size)
        assertEquals(TierASymbols.NativeActions.ALL, rows.map { it.action }.toSet())

        assertEquals(
            mapOf(
                "AGENT_SETTINGS" to 17,
                "ANSWERS" to 6,
                "CENTRAL" to 48,
                "CLOCK" to 12,
                "CONTACTS" to 8,
                "DIALER" to 11,
                "FOOD" to 1,
                "MESSAGES" to 7,
                "MESSAGES_BACKGROUND" to 1,
                "MUSIC" to 15,
                "NOTIFICATIONS" to 1,
                "PHOTOGRAPHY" to 4,
                "SYSTEM_NAVIGATION" to 1,
                "TICKLE_PROTOTYPE" to 1,
                "TRANSLATION" to 4,
                "UI_GALLERY" to 1,
            ),
            rows.groupingBy { it.experience }.eachCount().toSortedMap(),
        )

        assertEquals(installedKeyguardDisabledActions, rows.filterNot { it.enabledInKeyguard }.map { it.action }.toSet())
    }

    @Test
    fun `every native handler has one closed truthful classification and evidence`() {
        val validRoles = setOf(
            "prompt",
            "agent",
            "agent_tool",
            "context",
            "internal",
            "policy",
            "developer",
            "dead_schema",
        )
        val validRoutes = setOf(
            "stock_only",
            "restored_direct",
            "restored_agent",
            "provider_bridge",
            "replacement_rpc",
            "context_only",
            "internal_only",
            "safety_denied",
            "developer_only",
        )
        val validBoundaries = setOf(
            "keyguard_safe",
            "unlocked_required",
            "active_context",
            "policy_only",
            "device_event",
            "ui_state",
            "developer_only",
            "destructive_mutation",
            "power_mutation",
            "radio_mutation",
            "trust_mutation",
            "contact_mutation",
            "emergency_confirmation",
            "call_state",
            "messaging_state",
            "private_data",
            "provider_consent",
            "camera_state",
            "diagnostic",
        )

        rows.forEach { row ->
            assertTrue("Unknown stock role for ${row.action}: ${row.stockRole}", row.stockRole in validRoles)
            assertTrue("Unknown Penumbra route for ${row.action}: ${row.penumbraRoute}", row.penumbraRoute in validRoutes)
            assertTrue("Unknown safety boundary for ${row.action}: ${row.safetyBoundary}", row.safetyBoundary in validBoundaries)
            assertTrue("Missing note for ${row.action}", row.note.isNotBlank())
            assertTrue(
                "Unsafe stock evidence path for ${row.action}: ${row.stockEvidence}",
                row.stockEvidence.startsWith("ironman/sources/") &&
                    row.stockEvidence.endsWith(".java") &&
                    ".." !in row.stockEvidence.split('/'),
            )
            assertFalse(
                "Keyguard-disabled ${row.action} cannot be classified keyguard-safe",
                !row.enabledInKeyguard && row.safetyBoundary == "keyguard_safe",
            )

            val (path, needle) = row.evidence.split("::", limit = 2).let {
                assertEquals("Malformed evidence for ${row.action}", 2, it.size)
                it[0] to it[1]
            }
            val source = repoFile(path)
            assertTrue("Empty evidence needle for ${row.action}", needle.isNotBlank())
            val sourceText = source.readText()
            val tierAReference = rustNativeActionReference(row.action)
            val tierAEvidence = needle == "\"${row.action}\"" &&
                sourceReferencesRustNativeAction(sourceText, row.action)
            assertTrue(
                "Evidence for ${row.action} is absent from $path: $needle or $tierAReference",
                sourceText.contains(needle) || tierAEvidence,
            )
        }

        assertEquals(
            setOf(TierASymbols.NativeActions.CREATE_MEMORY),
            rows.filter { it.stockRole == "dead_schema" }.map { it.action }.toSet(),
        )
        assertEquals(
            setOf(TierASymbols.NativeActions.CREATE_MEMORY),
            rows.filter { it.penumbraRoute == "replacement_rpc" }.map { it.action }.toSet(),
        )
        assertTrue(rows.none { it.penumbraRoute == "not_revived" })

        rows.filter { it.stockRole == "context" }.forEach {
            assertEquals("Context action ${it.action} gained a broad route", "context_only", it.penumbraRoute)
        }
        rows.filter { it.stockRole == "internal" || it.stockRole == "policy" }.forEach {
            assertEquals("Internal action ${it.action} gained a broad route", "internal_only", it.penumbraRoute)
        }
        rows.filter { it.stockRole == "developer" }.forEach {
            assertEquals("Developer action ${it.action} gained a product route", "developer_only", it.penumbraRoute)
        }
        rows.filter { it.penumbraRoute in setOf("restored_direct", "restored_agent", "provider_bridge", "replacement_rpc") }
            .forEach {
                assertFalse(
                    "Implemented route ${it.action} must cite production code, not only prose",
                    it.evidence.startsWith("docs/"),
                )
            }
    }

    @Test
    fun `destructive trust radio and contact mutations remain outside broad planners`() {
        val denied = rows.filter { it.penumbraRoute == "safety_denied" }.map { it.action }.toSet()
        assertEquals(safetyDeniedActions, denied)
        rows.filter { it.action in safetyDeniedActions }.forEach {
            assertTrue(
                "Denied ${it.action} has a non-safety boundary ${it.safetyBoundary}",
                it.safetyBoundary in setOf(
                    "destructive_mutation",
                    "power_mutation",
                    "radio_mutation",
                    "trust_mutation",
                    "contact_mutation",
                ),
            )
        }

        val broadPlannerSources = listOf(
            "runtime/core/src/synapse/native_device_actions.rs",
            "runtime/core/src/synapse/capabilities/communications.rs",
            "runtime/core/src/synapse/capabilities/messaging.rs",
            "runtime/core/src/synapse/capabilities/music.rs",
            "runtime/core/src/synapse/capabilities/nutrition.rs",
            "runtime/core/src/synapse/capabilities/settings.rs",
            "runtime/core/src/synapse/capabilities/translation.rs",
        ).joinToString("\n") { repoFile(it).readText() }
        safetyDeniedActions.forEach { action ->
            val rawLiteral = "\"$action\""
            assertFalse(
                "Safety-denied $action leaked into a broad compatibility planner",
                broadPlannerSources.contains(rawLiteral) ||
                    sourceReferencesRustNativeAction(broadPlannerSources, action),
            )
        }

        val stockTools = repoFile("runtime/core/src/services/aibus/tools/stock_agent.rs").readText()
        assertTrue(stockTools.contains("DENIED_SETTINGS_TOOLS.contains(&name)"))
        assertTrue(stockTools.contains("DESTRUCTIVE_TOOLS.contains(&name)"))
        assertTrue(
            sourceReferencesRustNativeAction(
                stockTools,
                TierASymbols.NativeActions.CREATE_CONTACT,
            ),
        )
        assertTrue(
            sourceReferencesRustNativeAction(
                stockTools,
                TierASymbols.NativeActions.UPDATE_CONTACT_TRUSTED,
            ),
        )
    }

    @Test
    fun `confirmation internal and dead schema actions cannot masquerade as prompt parity`() {
        assertEquals(
            confirmationOnlyActions,
            rows.filter { it.penumbraRoute == "context_only" }.map { it.action }.toSet(),
        )
        assertEquals(
            setOf(
                TierASymbols.NativeActions.EXPERIMENTAL_INTERFACE,
                TierASymbols.NativeActions.SYSTEM_TRACE_START,
                TierASymbols.NativeActions.SYSTEM_TRACE_STOP,
            ),
            rows.filter { it.penumbraRoute == "developer_only" }.map { it.action }.toSet(),
        )

        val nativePlanner = repoFile("runtime/core/src/synapse/native_device_actions.rs").readText()
        val plannerExcludedActions = setOf(
            TierASymbols.NativeActions.CREATE_MEMORY,
            TierASymbols.NativeActions.USER_CONFIRMED_FACTORY_RESET,
            TierASymbols.NativeActions.USER_CONFIRMED_EMERGENCY_CALL,
            TierASymbols.NativeActions.START_TRANSLATION,
            TierASymbols.NativeActions.STOP_TRANSLATION,
        )
        plannerExcludedActions.forEach { action ->
            assertFalse(
                "$action leaked into the broad native planner",
                nativePlanner.contains("\"$action\"") ||
                    sourceReferencesRustNativeAction(nativePlanner, action),
            )
        }

        val functionExecution = repoFile("runtime/core/src/services/aibus/tools/execution.rs").readText()
        val createMemory = TierASymbols.NativeActions.CREATE_MEMORY
        assertTrue(functionExecution.contains("FunctionExecution($createMemory)"))
        assertTrue(
            functionExecution.contains(
                "if call.name != ${rustNativeActionReference(createMemory)}",
            ),
        )
    }

    private fun sourceReferencesRustNativeAction(source: String, action: String): Boolean {
        val symbol = rustNativeActionSymbols[action]
            ?: throw AssertionError("Missing generated Rust Tier-A native action: $action")
        if (source.contains("native_actions::$symbol")) {
            return true
        }
        val symbolToken = Regex("""(?<![A-Z0-9_])${Regex.escape(symbol)}(?![A-Z0-9_])""")
        return source.contains("use crate::tier_a::native_actions::{") &&
            symbolToken.findAll(source).count() >= 2
    }

    private fun rustNativeActionReference(action: String): String {
        val symbol = rustNativeActionSymbols[action]
            ?: throw AssertionError("Missing generated Rust Tier-A native action: $action")
        return "native_actions::$symbol"
    }

    private val rustNativeActionSymbols by lazy {
        val generated = repoFile("runtime/core/src/tier_a.rs").readText()
        val moduleHeader = "pub mod native_actions {"
        assertTrue("Generated Rust Tier-A native_actions module is missing", generated.contains(moduleHeader))
        val nativeActionsModule = generated
            .substringAfter(moduleHeader)
            .substringBefore("\n}\n")
        val declarations = Regex(
            """pub const ([A-Z][A-Z0-9_]*): &str = "([A-Za-z][A-Za-z0-9]+)";""",
        ).findAll(nativeActionsModule).map { match ->
            match.groupValues[2] to match.groupValues[1]
        }.toList()
        val symbolsByAction = declarations.toMap()
        assertEquals(
            "Generated Rust Tier-A native action values are not unique",
            declarations.size,
            symbolsByAction.size,
        )
        assertEquals(
            "Generated Kotlin and Rust Tier-A native action values diverged",
            TierASymbols.NativeActions.ALL,
            symbolsByAction.keys,
        )
        symbolsByAction
    }

    private fun loadRows(): List<ParityRow> {
        val lines = repoFile("contracts/tier-a/native-actions.tsv").readLines()
        assertEquals(
            listOf(
                "action",
                "experience",
                "enabled_in_keyguard",
                "stock_role",
                "penumbra_route",
                "safety_boundary",
                "evidence",
                "note",
                "stock_evidence",
            ),
            lines.first().split('\t'),
        )
        return lines.drop(1).mapIndexed { index, line ->
            val fields = line.split('\t')
            assertEquals("Malformed ledger row ${index + 2}", 9, fields.size)
            assertTrue("Invalid keyguard value at row ${index + 2}", fields[2] == "true" || fields[2] == "false")
            ParityRow(
                action = fields[0],
                experience = fields[1],
                enabledInKeyguard = fields[2].toBooleanStrict(),
                stockRole = fields[3],
                penumbraRoute = fields[4],
                safetyBoundary = fields[5],
                evidence = fields[6],
                note = fields[7],
                stockEvidence = fields[8],
            )
        }
    }

    private data class ParityRow(
        val action: String,
        val experience: String,
        val enabledInKeyguard: Boolean,
        val stockRole: String,
        val penumbraRoute: String,
        val safetyBoundary: String,
        val evidence: String,
        val note: String,
        val stockEvidence: String,
    )

    private val rows by lazy(::loadRows)

    private val installedKeyguardDisabledActions = setOf(
        "AskConfirmationForFactoryReset",
        "CallPerson",
        "CancelSendMessage",
        "CatchMeUp",
        "ComposeMessage",
        "ConfirmSendMessage",
        "CreateContact",
        "DeviceStatus",
        "DisplayMessages",
        "ExperimentalInterface",
        "FactoryReset",
        "GetQuickMessagingParticipants",
        "GetSerialNumber",
        "LockDevice",
        "ManageMemory",
        "ManageNutrition",
        "MessageSearch",
        "OpenContacts",
        "OpenDialerHome",
        "OpenDialpad",
        "OpenMessagesMainMenu",
        "OpenRecentCalls",
        "OpenRecentPhotos",
        "OpenTutorial",
        "ReadAllMessages",
        "TrustLock",
        "TurnOffAmberAlert",
        "TurnOffCellularData",
        "TurnOffCellularRoaming",
        "TurnOffEmergencyAlert",
        "TurnOffPublicSafetyAlert",
        "TurnOnAmberAlert",
        "TurnOnCellularData",
        "TurnOnCellularRoaming",
        "TurnOnEmergencyAlert",
        "TurnOnPublicSafetyAlert",
        "UserConfirmedFactoryReset",
        "UserDeniedFactoryReset",
        "ViewCallLog",
    )

    private val safetyDeniedActions = setOf(
        "ConnectToWifi",
        "CreateContact",
        "DisconnectWifi",
        "FactoryReset",
        "Reboot",
        "SetUpTouchcode",
        "TrustLock",
        "TurnOffAirplaneMode",
        "TurnOffAmberAlert",
        "TurnOffBluetooth",
        "TurnOffCellularData",
        "TurnOffCellularRoaming",
        "TurnOffDevice",
        "TurnOffEmergencyAlert",
        "TurnOffPublicSafetyAlert",
        "TurnOffWifi",
        "TurnOnAirplaneMode",
        "TurnOnAmberAlert",
        "TurnOnBluetooth",
        "TurnOnCellularData",
        "TurnOnCellularRoaming",
        "TurnOnEmergencyAlert",
        "TurnOnPublicSafetyAlert",
        "TurnOnWifi",
        "WifiQrScan",
    )

    private val confirmationOnlyActions = setOf(
        "AskConfirmationForEmergencyCall",
        "AskConfirmationForFactoryReset",
        "CancelSendMessage",
        "ConfirmSendMessage",
        "StartTranslation",
        "StopTranslation",
        "UserConfirmedEmergencyCall",
        "UserConfirmedFactoryReset",
        "UserDeniedEmergencyCall",
        "UserDeniedFactoryReset",
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
