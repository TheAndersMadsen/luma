import Foundation

/// What a task looks like on this Mac, as pure state.
///
/// The vocabulary is the shared one — Waiting for you, Working, Completed,
/// Not done, Cannot confirm — and every sentence under it comes from the
/// strings file. Nothing here reads a wire field to a person, and nothing here
/// claims an outcome: the model sets these from what it observed.

/// Where the current task stands on this Mac.
public enum TaskActivity: Equatable, Sendable {
    /// Nothing is happening.
    case none
    /// A task is ready for this Mac but has not started; the panel has to be
    /// open and this Mac visible before anything can begin.
    case ready
    /// A ceremony is on screen and unanswered.
    case confirming
    /// A task is running here. `startedAtMs` is the clock the elapsed time is
    /// measured from, so the card and the progress messages agree.
    case working(label: String, startedAtMs: Int64, cancellable: Bool)
    /// It finished, with what this Mac observed.
    case completed(sentence: String, detail: String?)
    /// It did not happen, and this is the one sentence for what happened and
    /// the one for what to do.
    case notDone(happened: String, next: String?)
    /// This Mac cannot say whether it finished.
    case cannotConfirm

    public var isCurrent: Bool { self != .none }
}

/// The task card's exact contents: the state word, one sentence, the elapsed
/// time and whether Cancel task applies. Closing the panel changes none of it.
public struct TaskCardModel: Equatable, Sendable {
    public let state: String
    public let sentence: String
    public let detail: String?
    public let elapsed: String?
    public let canCancel: Bool
    public let isFailure: Bool

    public init(state: String, sentence: String, detail: String? = nil,
                elapsed: String? = nil, canCancel: Bool = false, isFailure: Bool = false) {
        self.state = state
        self.sentence = sentence
        self.detail = detail
        self.elapsed = elapsed
        self.canCancel = canCancel
        self.isFailure = isFailure
    }
}

/// The ceremony's exact contents. Two buttons of equal weight, a countdown that
/// is visible rather than implied, and one sentence in the owner's own words.
public struct CeremonyCardModel: Equatable, Sendable {
    public let question: String
    public let classLine: String?
    public let confirm: String
    public let decline: String
    public let countdown: String
    /// Set only when this Mac cannot ask for the evidence the ceremony needs.
    public let blocked: String?
    public let shortcuts: String

    public var canConfirm: Bool { blocked == nil }
}

/// What a key may do to a ceremony. Nothing else resolves it: a permission for
/// a device that can act is never answered by a stray keypress.
public enum CeremonyKey: Equatable, Sendable {
    case confirm, decline, dismiss
}

public enum TaskCard {
    /// The ceremony's own clock, as Cosmos runs it.
    public static let grantMs: Int64 = 30_000

    // MARK: The task card

    public static func card(_ activity: TaskActivity, now: Int64) -> TaskCardModel? {
        switch activity {
        case .none:
            return nil
        case .ready:
            return TaskCardModel(state: Words.waitingForDevice, sentence: Words.taskWaiting,
                                 detail: Words.taskWaitingDetail)
        case .confirming:
            return TaskCardModel(state: Words.waitingForYou, sentence: Words.ceremonyPrompt)
        case .working(let label, let startedAtMs, let cancellable):
            return TaskCardModel(state: Words.working, sentence: Words.runningTask(label),
                                 elapsed: elapsed(now - startedAtMs), canCancel: cancellable)
        case .completed(let sentence, let detail):
            return TaskCardModel(state: Words.completed, sentence: sentence, detail: detail)
        case .notDone(let happened, let next):
            return TaskCardModel(state: Words.notDone, sentence: happened, detail: next)
        case .cannotConfirm:
            return TaskCardModel(state: Words.cannotConfirm, sentence: Words.taskCannotConfirmDetail)
        }
    }

    /// Elapsed time as a person reads a clock: 0:14, 4:07, 1:02:30.
    public static func elapsed(_ milliseconds: Int64) -> String {
        let total = max(milliseconds, 0) / 1000
        let seconds = total % 60
        let minutes = (total / 60) % 60
        let hours = total / 3600
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, seconds) }
        return String(format: "%d:%02d", minutes, seconds)
    }

    /// Rounded seconds, for the sentence a completed task ends with.
    public static func duration(_ milliseconds: Int64) -> String {
        let seconds = Int((Double(max(milliseconds, 0)) / 1000).rounded())
        if seconds < 60 { return seconds == 1 ? "1 second" : "\(seconds) seconds" }
        let minutes = seconds / 60
        let rest = seconds % 60
        let head = minutes == 1 ? "1 minute" : "\(minutes) minutes"
        if rest == 0 { return head }
        return "\(head) \(rest == 1 ? "1 second" : "\(rest) seconds")"
    }

    /// A refusal reads as one sentence on what happened and one on what to do.
    public static func refusal(_ reason: ActionRefusal) -> TaskActivity {
        .notDone(happened: Words.refusalHappened(reason), next: Words.refusalNext(reason))
    }

    /// A task Cosmos withdrew. The owner learns that it stopped and why in their
    /// own terms; the wire word never reaches them.
    public static func revoked(_ reason: RevokedTask.Reason, label: String) -> TaskActivity {
        switch reason {
        case .cancelled:
            return .notDone(happened: Words.taskStopped(label), next: Words.taskStoppedByYou)
        case .preempted:
            return .notDone(happened: Words.taskStoppedForNewRequest, next: Words.taskNothingMore)
        case .expired:
            return .notDone(happened: Words.taskStopped(label), next: Words.taskRanOutOfTime)
        case .superseded, .revalidationFailed:
            return .notDone(happened: Words.taskWithdrawn, next: Words.taskNothingMore)
        }
    }

    /// What a finished command says. A non-zero exit code is not a failure: the
    /// command ran, which is what was asked, and the code is the evidence.
    public static func finished(label: String, exitCode: Int32?, durationMs: Int64) -> TaskActivity {
        guard let exitCode else {
            return .notDone(happened: Words.taskStopped(label), next: Words.taskStoppedByYou)
        }
        return .completed(sentence: Words.finishedTask(label, seconds: duration(durationMs)),
                          detail: Words.exitCodeDetail(exitCode))
    }

    // MARK: The ceremony

    public static func ceremony(_ request: ConfirmationRequest, now: Int64,
                                blocked: String? = nil) -> CeremonyCardModel {
        let description = request.description
        return CeremonyCardModel(
            question: Words.ceremonyQuestion(verb: description.verb, subject: description.subject,
                                             effect: description.effect),
            classLine: ["near_user", "private"].contains(description.privacyClass)
                ? Words.ceremonyPrivate : nil,
            confirm: Words.confirmAction,
            decline: Words.declineAction(description.verb),
            countdown: Words.countdown(remainingSeconds(request.expiresAtMs, now: now)),
            blocked: blocked,
            shortcuts: Words.ceremonyShortcuts
        )
    }

    /// The countdown never runs past the ceremony's own thirty seconds and never
    /// shows a negative number.
    public static func remainingSeconds(_ expiresAtMs: Int64, now: Int64) -> Int {
        let remaining = expiresAtMs - now
        guard remaining > 0 else { return 0 }
        return Int(min((remaining + 999) / 1000, grantMs / 1000))
    }

    /// Escape dismisses the panel and answers nothing, so the grant expires and
    /// the fail-safe default denies. Only the two deliberate combinations answer.
    public static func ceremonyKey(key: String, command: Bool, shift: Bool = false,
                                   option: Bool = false, control: Bool = false) -> CeremonyKey? {
        if key == "\u{1b}" { return .dismiss }
        guard command, !option, !control, !shift else { return nil }
        switch key.lowercased() {
        case "\r", "\u{3}": return .confirm
        case "\u{8}", "\u{7f}": return .decline
        default: return nil
        }
    }
}
