package dk.andersmadsen.cosmos.android.action

/**
 * A running command, in the words a person reads. One state word, one plain
 * sentence about what is happening, the elapsed time while it runs, and Cancel
 * task. Closing the panel is never cancelling, so Close is not modelled here:
 * it hides this card and the command carries on.
 *
 * A television never explains a refusal. It says nothing at all about one,
 * which is what keeps a refusal, a failure and a privacy suppression
 * indistinguishable in a room with other people in it.
 */
data class TaskCard(
    /** Waiting for you · Working · Completed · Not done · Cannot confirm. */
    val state: String,
    /** One sentence on what is happening; absent where a room would learn something. */
    val sentence: String?,
    /** One sentence on what to do, for a refusal only. */
    val next: String? = null,
    /** Elapsed time as `m:ss`, while the command is running. */
    val elapsed: String? = null,
    val canCancel: Boolean = false,
)

/** Where a command stands on this device. */
sealed interface TaskStage {
    /** A ceremony is on screen at the device that would carry the command out. */
    data class Confirming(val description: Description) : TaskStage
    data class Working(val operation: Operation, val elapsedMs: Long) : TaskStage
    /** This device said what it observed. Nothing else may claim an outcome. */
    data class Reported(val operation: Operation, val report: Report) : TaskStage
}

object TaskCards {
    const val WAITING = "Waiting for you"
    const val WORKING = "Working"
    const val COMPLETED = "Completed"
    const val NOT_DONE = "Not done"
    const val CANNOT_CONFIRM = "Cannot confirm"

    /**
     * [device] is the phone or the television in the owner's own words, and
     * [explain] is false on a shared screen, where a refusal is never named.
     */
    fun card(stage: TaskStage, device: String, explain: Boolean = true): TaskCard? = when (stage) {
        is TaskStage.Confirming ->
            if (!explain) null
            else TaskCard(WAITING, "Confirm to ${stage.description.verb} ${stage.description.subject}.")
        is TaskStage.Working -> TaskCard(
            WORKING, working(stage.operation), elapsed = elapsed(stage.elapsedMs), canCancel = true,
        )
        is TaskStage.Reported -> reported(stage.operation, stage.report, device, explain)
    }

    private fun reported(operation: Operation, report: Report, device: String, explain: Boolean): TaskCard? =
        when (report.outcome) {
            ReportOutcome.COMPLETED -> TaskCard(COMPLETED, completed(operation, device))
            ReportOutcome.UNKNOWN -> TaskCard(CANNOT_CONFIRM, if (explain) unconfirmed(operation, device) else null)
            ReportOutcome.REFUSED -> if (!explain) null else {
                val reason = (report.evidence as? Evidence.Declined)?.reason ?: DeclineReason.UNRESOLVABLE
                TaskCard(NOT_DONE, refusal(reason, device), next(reason))
            }
            ReportOutcome.CANCELLED ->
                if (!explain) null else TaskCard(NOT_DONE, "Stopped when you asked for something else.")
            ReportOutcome.FAILED ->
                if (!explain) null else TaskCard(NOT_DONE, "That did not go through.", "Ask again in a moment.")
        }

    private fun working(operation: Operation): String = when (operation) {
        is Operation.Open -> "Opening ${operation.label}"
        is Operation.Route -> "Starting directions to ${operation.name}"
        is Operation.Play -> "Starting ${operation.title}"
        is Operation.Unsupported -> "Working on it"
    }

    private fun completed(operation: Operation, device: String): String = when (operation) {
        is Operation.Open -> "It's open on $device."
        is Operation.Route -> "Directions are running on $device."
        is Operation.Play -> "Playing on $device."
        is Operation.Unsupported -> "Done on $device."
    }

    private fun unconfirmed(operation: Operation, device: String): String = when (operation) {
        is Operation.Open -> "I opened it on $device — I can't confirm it's on screen."
        is Operation.Route -> "I opened it on $device — I can't confirm navigation started."
        is Operation.Play -> "I started it on $device — I can't confirm it's playing."
        is Operation.Unsupported -> "I can't confirm whether that happened on $device."
    }

    /** One sentence on what happened. Fixed wording, never a technical reason. */
    private fun refusal(reason: DeclineReason, device: String): String = when (reason) {
        DeclineReason.NO_HANDLER -> "Nothing on $device can open that."
        DeclineReason.NOT_PERMITTED -> "$device has not been allowed to do that."
        DeclineReason.UNRESOLVABLE -> "That did not name something $device can open."
        DeclineReason.VERSION_CHANGED -> "That document changed since it was read."
        DeclineReason.LOCKED -> "$device was locked, so nothing was opened."
        DeclineReason.ENTRY_CHANGED -> "That task changed since it was approved."
        DeclineReason.NO_ATTESTATION -> "$device could not confirm it was you."
    }.replaceFirstChar { it.uppercase() }

    /** One sentence on what to do. Only where doing something can actually help. */
    private fun next(reason: DeclineReason): String? = when (reason) {
        DeclineReason.NO_HANDLER -> "Install an app that opens it, then ask again."
        DeclineReason.NOT_PERMITTED -> "Allow it in Center → Devices, then ask again."
        DeclineReason.UNRESOLVABLE -> "Ask again and name what you want opened."
        DeclineReason.VERSION_CHANGED -> "Ask again to open the current one."
        DeclineReason.LOCKED -> "Unlock it and ask again."
        DeclineReason.ENTRY_CHANGED -> "Check that task in Center, then ask again."
        DeclineReason.NO_ATTESTATION -> null
    }

    /** `m:ss`, from a shared clock, never counting past a plausible task. */
    fun elapsed(elapsedMs: Long): String {
        val seconds = (elapsedMs.coerceAtLeast(0) / 1000).coerceAtMost(99 * 60 + 59)
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }
}
