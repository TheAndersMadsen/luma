package dk.andersmadsen.cosmos.android.action

/**
 * What this device has already been asked to do, kept for ten minutes.
 *
 * A repeated command carries the same idempotency key, and a repeat must
 * produce no second effect — only the same report. So the key is claimed
 * before anything runs and the report is remembered against it; a second
 * arrival with that key is answered from here and never launches anything.
 */
class ActionLedger(private val retentionMs: Long = RETENTION_MS) {
    private data class Entry(val atMs: Long, val report: Report?)

    private val entries = LinkedHashMap<String, Entry>()

    /**
     * Claim this key for a first attempt. False means it is already claimed:
     * either the effect is still running or it has already been reported, and
     * in both cases nothing may run again.
     */
    fun begin(key: String, nowMs: Long): Boolean {
        prune(nowMs)
        if (entries.containsKey(key)) return false
        if (entries.size >= MAX_ENTRIES) entries.remove(entries.keys.first())
        entries[key] = Entry(nowMs, null)
        return true
    }

    /** Remember what this device observed, so a repeat re-sends exactly it. */
    fun finish(key: String, report: Report, nowMs: Long) {
        prune(nowMs)
        entries[key] = Entry(nowMs, report)
    }

    /** The report already sent for this key, if the effect has finished. */
    fun recall(key: String, nowMs: Long): Report? {
        prune(nowMs)
        return entries[key]?.report
    }

    /** True while a claimed key has no report yet: the effect is in flight. */
    fun running(key: String, nowMs: Long): Boolean {
        prune(nowMs)
        return entries[key]?.report == null && entries.containsKey(key)
    }

    fun size(nowMs: Long): Int {
        prune(nowMs)
        return entries.size
    }

    private fun prune(nowMs: Long) {
        entries.entries.removeAll { (_, entry) -> nowMs - entry.atMs >= retentionMs || entry.atMs > nowMs }
    }

    companion object {
        const val RETENTION_MS = 600_000L
        const val MAX_ENTRIES = 32
    }
}
