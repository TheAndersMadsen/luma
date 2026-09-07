package dk.andersmadsen.cosmos.android.action

/**
 * The confirmation ceremony, as a state machine with no side effects.
 *
 * Only a deliberate tap answers it. Back dismisses the sheet and answers
 * nothing: the grant then expires on its own, which denies, because an
 * unanswered permission for a device that can act must never become a yes. An
 * answer is single use, and a ceremony that asks for evidence this device
 * cannot produce is never shown and never answered.
 */
enum class CeremonyState {
    /** On screen, waiting for a deliberate tap. */
    ASKING,

    /** Answered by a tap; the answer is on its way and cannot be changed. */
    ANSWERED,

    /** The sheet was dismissed with Back. Nothing was answered. */
    DISMISSED,

    /** The countdown ran out. Nothing was answered, which denies. */
    EXPIRED,

    /** This device cannot obtain the actor evidence the ceremony requires. */
    UNAVAILABLE,
}

sealed interface CeremonyEvent {
    data object Confirm : CeremonyEvent
    data object Decline : CeremonyEvent
    /** Back, or anything else that closes the sheet without answering it. */
    data object Back : CeremonyEvent
    data class Elapsed(val nowMs: Long) : CeremonyEvent
}

/** The answer this device sends, with the evidence it actually obtained. */
data class CeremonyAnswer(val granted: Boolean, val attestation: Attestation?)

data class Ceremony(
    val confirmation: Confirmation,
    val state: CeremonyState,
    val answer: CeremonyAnswer? = null,
) {
    val showing: Boolean get() = state == CeremonyState.ASKING

    /** The visible countdown, in whole seconds, never below zero. */
    fun secondsLeft(nowMs: Long): Int =
        ((confirmation.expiresAtMs - nowMs + 999) / 1000).coerceIn(0, 600).toInt()

    fun on(event: CeremonyEvent): Ceremony {
        // Every terminal state is terminal: one ceremony, one answer, and a
        // dismissed sheet does not come back to be answered by a stray tap.
        if (state != CeremonyState.ASKING) return this
        return when (event) {
            CeremonyEvent.Confirm -> copy(
                state = CeremonyState.ANSWERED,
                answer = CeremonyAnswer(granted = true, attestation = Attestation.FOREGROUND_TAP),
            )
            CeremonyEvent.Decline -> copy(
                state = CeremonyState.ANSWERED,
                answer = CeremonyAnswer(granted = false, attestation = null),
            )
            CeremonyEvent.Back -> copy(state = CeremonyState.DISMISSED)
            is CeremonyEvent.Elapsed ->
                if (event.nowMs >= confirmation.expiresAtMs) copy(state = CeremonyState.EXPIRED) else this
        }
    }

    companion object {
        /**
         * Every Cosmos manifest declares `actor_unknown`, so a bare tap can
         * never stand in for device-owner authentication. This client declares
         * `foreground_tap` and nothing more: a ceremony that requires more is
         * not shown here and is left to expire, which denies.
         */
        fun open(confirmation: Confirmation, nowMs: Long): Ceremony = Ceremony(
            confirmation,
            when {
                confirmation.attestation != Attestation.FOREGROUND_TAP -> CeremonyState.UNAVAILABLE
                nowMs >= confirmation.expiresAtMs -> CeremonyState.EXPIRED
                else -> CeremonyState.ASKING
            },
        )
    }
}
