import SwiftUI

/// The two cards a device action puts on screen: the task while it runs, and
/// the ceremony while it waits for an answer.
///
/// Both draw only from the pure state in `TaskCard`. Nothing here decides
/// anything: closing the panel changes neither, Cancel task is its own explicit
/// control, and the ceremony is answered only by a deliberate press.

/// One running, finished or refused task. The state word, one sentence, the
/// elapsed time and — only while something is actually running — Cancel task.
struct TaskCardView: View {
    let card: TaskCardModel
    let output: String?
    let outputTitle: String
    var cancel: (@MainActor () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(card.isFailure ? CosmosTokens.error : CosmosTokens.secondary)
                    .accessibilityHidden(true)
                Text(card.state).font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 12)
                // Reserved so the row keeps its height whether or not a clock runs.
                Text(card.elapsed ?? " ")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(CosmosTokens.secondary)
                    .monospacedDigit()
                    .opacity(card.elapsed == nil ? 0 : 1)
                    .accessibilityLabel("Elapsed")
                    .accessibilityValue(card.elapsed ?? "")
                    .accessibilityHidden(card.elapsed == nil)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(card.sentence)
                    .font(.system(size: 13))
                    .foregroundStyle(CosmosTokens.primary)
                if let detail = card.detail {
                    Text(detail).font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
                }
            }
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
            if card.canCancel, let cancel {
                Button(Words.cancelTask, action: cancel)
                    .buttonStyle(SecondaryButton())
                    .keyboardShortcut(".", modifiers: .command)
                    .help("\(Words.cancelTask) (⌘.)")
                    .accessibilityLabel(Words.cancelTask)
                    .accessibilityIdentifier("cancel-task")
            }
            if let output, !output.isEmpty { outputBlock(output) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CosmosTokens.surface.opacity(0.7),
                    in: RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous)
            .strokeBorder(CosmosTokens.border.opacity(0.8), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Task")
        .accessibilityValue("\(card.state). \(card.sentence)")
        .accessibilityIdentifier("task-card")
    }

    /// The command's own bytes, framed as the device's output and never as
    /// Cosmos's own words. It scrolls inside the card instead of growing it.
    private func outputBlock(_ output: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(outputTitle)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CosmosTokens.secondary)
            ScrollView {
                Text(output)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(CosmosTokens.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(maxHeight: 220)
            .background(CosmosTokens.background.opacity(0.35),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(CosmosTokens.border.opacity(0.6), lineWidth: 1))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(outputTitle)
        .accessibilityIdentifier("task-output")
    }

    private var symbol: String {
        switch card.state {
        case Words.working: "circle.dotted"
        case Words.completed: "checkmark.circle"
        case Words.notDone: "xmark.circle"
        case Words.cannotConfirm: "questionmark.circle"
        default: "clock"
        }
    }
}

/// The ceremony. The owner's own words for what will happen, a countdown that
/// is visible rather than implied, and two buttons of exactly equal weight.
/// Dismissing this panel answers nothing at all.
struct ConfirmCardView: View {
    let card: CeremonyCardModel
    /// The whole ceremony window, so the bar's proportion is honest.
    let totalSeconds: Int
    let remainingSeconds: Int
    var confirm: (@MainActor () -> Void)?
    var decline: (@MainActor () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(CosmosTokens.accent)
                    .accessibilityHidden(true)
                Text(Words.waitingForYou).font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 12)
                Text(card.countdown)
                    .font(.system(size: 12, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(CosmosTokens.secondary)
                    .accessibilityLabel("Time left")
                    .accessibilityValue(card.countdown)
                    .accessibilityIdentifier("ceremony-countdown")
            }
            countdownBar
            VStack(alignment: .leading, spacing: 4) {
                Text(card.question)
                    .font(.system(size: CosmosTokens.bodySize, weight: .semibold))
                    .lineSpacing(4)
                if let classLine = card.classLine {
                    Text(classLine).font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
                }
            }
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
            if let blocked = card.blocked {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 12)).foregroundStyle(CosmosTokens.error)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(blocked).font(.system(size: 12)).foregroundStyle(CosmosTokens.error)
                        Text(Words.attestationNext).font(.system(size: 12))
                            .foregroundStyle(CosmosTokens.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("ceremony-blocked")
            }
            // Two controls, the same style and the same width: nothing here
            // nudges the owner towards yes.
            HStack(spacing: 10) {
                Button { confirm?() } label: {
                    Text(card.confirm).frame(minWidth: 120)
                }
                .buttonStyle(SecondaryButton())
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!card.canConfirm)
                .help("\(card.confirm) (⌘↩)")
                .accessibilityIdentifier("ceremony-confirm")
                Button { decline?() } label: {
                    Text(card.decline).frame(minWidth: 120)
                }
                .buttonStyle(SecondaryButton())
                .keyboardShortcut(.delete, modifiers: .command)
                .help("\(card.decline) (⌘⌫)")
                .accessibilityIdentifier("ceremony-decline")
                Spacer(minLength: 0)
            }
            Text(card.shortcuts).font(.system(size: 11)).foregroundStyle(CosmosTokens.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CosmosTokens.surface.opacity(0.85),
                    in: RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous)
            .strokeBorder(CosmosTokens.accent.opacity(0.5), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Confirmation")
        .accessibilityValue(card.question)
        .accessibilityIdentifier("ceremony-card")
    }

    private var countdownBar: some View {
        GeometryReader { geometry in
            let fraction = totalSeconds <= 0 ? 0 : min(max(Double(remainingSeconds) / Double(totalSeconds), 0), 1)
            ZStack(alignment: .leading) {
                Capsule().fill(CosmosTokens.border.opacity(0.5))
                Capsule().fill(CosmosTokens.accent.opacity(0.8))
                    .frame(width: max(geometry.size.width * fraction, 0))
            }
        }
        .frame(height: 3)
        .accessibilityHidden(true)
    }
}

/// The one calm line the panel shows when the owner has set nothing up for this
/// Mac. It is information, not a problem to solve.
struct TaskPolicyNote: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Words.noTaskPolicy).font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
            Text(Words.noTaskPolicyDetail).font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Words.noTaskPolicy) \(Words.noTaskPolicyDetail)")
        .accessibilityIdentifier("task-policy-note")
    }
}
