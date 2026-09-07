package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.ActionLedger
import dk.andersmadsen.cosmos.android.action.ActionOutcome
import dk.andersmadsen.cosmos.android.action.DeclineReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActionLedgerTest {
    private val key = "a".repeat(64)
    private val other = "b".repeat(64)
    private val report = ActionOutcome.open("com.android.chrome", launched = true, tookForeground = true)

    @Test
    fun aRepeatedCommandRunsOnceAndReportsTheSameThing() {
        val ledger = ActionLedger()
        assertTrue(ledger.begin(key, 1_000))
        // The same key while it is still running: nothing runs a second time.
        assertFalse(ledger.begin(key, 1_100))
        assertTrue(ledger.running(key, 1_100))
        assertNull(ledger.recall(key, 1_100))
        ledger.finish(key, report, 2_000)
        // And afterwards the repeat is answered from here with the same report.
        assertFalse(ledger.begin(key, 2_100))
        assertEquals(report, ledger.recall(key, 2_100))
        assertFalse(ledger.running(key, 2_100))
    }

    @Test
    fun differentCommandsAreKeptApart() {
        val ledger = ActionLedger()
        assertTrue(ledger.begin(key, 1_000))
        assertTrue(ledger.begin(other, 1_000))
        ledger.finish(other, ActionOutcome.refused(DeclineReason.NOT_PERMITTED), 1_200)
        assertNull(ledger.recall(key, 1_300))
        assertEquals(DeclineReason.NOT_PERMITTED, (ledger.recall(other, 1_300)?.evidence as? dk.andersmadsen.cosmos.android.action.Evidence.Declined)?.reason)
        assertEquals(2, ledger.size(1_300))
    }

    @Test
    fun theWindowIsTenMinutesAndThenTheKeyIsFreeAgain() {
        val ledger = ActionLedger()
        assertTrue(ledger.begin(key, 1_000))
        ledger.finish(key, report, 1_000)
        assertFalse(ledger.begin(key, 1_000 + ActionLedger.RETENTION_MS - 1))
        assertEquals(0, ledger.size(1_000 + ActionLedger.RETENTION_MS))
        assertTrue(ledger.begin(key, 1_000 + ActionLedger.RETENTION_MS))
    }
}
