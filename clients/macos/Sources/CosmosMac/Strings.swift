import Foundation

/// Every word the owner reads on this Mac, in one place.
///
/// The state vocabulary and the sentences under it are fixed by the Cosmos
/// client brief and shared with the Pixel, the Linux PC and the TV. A wording
/// change happens here and nowhere else, so the panel and the tests read the
/// same sentence.
public enum Words {
    // MARK: The state vocabulary

    public static let listening = "Listening"
    public static let working = "Working"
    public static let waitingForYou = "Waiting for you"
    public static let waitingForDevice = "Waiting for a device"
    public static let completed = "Completed"
    public static let cannotConfirm = "Cannot confirm"
    public static let nowhere = "Nowhere to show it"
    public static let disconnected = "Disconnected"

    // MARK: Sub-lines: plain sentences, never a state of their own

    public static let connecting = "Connecting…"
    public static let reconnecting = "Reconnecting…"
    public static let connected = "Connected"
    public static let disconnecting = "Disconnecting…"
    public static let cannotConfirmDetail =
        "I can't confirm whether that request was handled. It was not sent again."
    public static let nowhereDetail = "No approved screen showed the reply."
    public static func shownOn(_ device: String) -> String { "Shown on \(device)" }
    public static func spokenOn(_ device: String) -> String { "Spoken on \(device)" }
    public static func waitingFor(_ device: String) -> String { "Waiting for \(device)" }
    public static func runningOn(_ device: String) -> String { "Running on \(device)" }
    public static func doneOn(_ device: String) -> String { "Done on \(device)" }
    public static let turnRefusedDetail = "A device did not carry that out."

    // MARK: Presence and the menu bar

    public static let appName = "Cosmos"
    public static let openCosmos = "Open Cosmos"
    public static let quit = "Quit Cosmos"
    /// The owner's own switch for a reply that shows itself. On by default.
    public static let showRepliesAutomatically = "Show replies automatically"

    // MARK: Listening for the phrase

    /// The owner's own switch for always-listening. Off until they turn it on,
    /// and remembered from then on.
    public static let listenForPhrase = "Listen for “\(WakePhrase.display)”"
    /// The first indicator: the microphone is open and nothing has been heard.
    public static let listeningForPhrase = "Listening for “\(WakePhrase.display)”"
    public static let listeningStarting = "Turning the microphone on…"
    /// The second indicator: the phrase fired and this Mac is recording the
    /// request itself.
    public static let heardPhrase = "Heard “\(WakePhrase.display)”"
    public static let listeningToRequest = "Say what you want. It goes when you stop."
    /// The two things that are true and that no client can change, said where
    /// the owner turns listening on rather than discovered later.
    public static let listeningIsVisible =
        "macOS shows an orange dot beside the menu bar the whole time Cosmos listens."
    public static let listeningEndsWithTheLid =
        "Closing the lid switches this Mac's microphone off in hardware, so listening stops until you open it again."
    /// Nothing crosses the network until the phrase does.
    public static let listeningStaysHere =
        "What you say is recognised on this Mac. Nothing is sent until you say the phrase, and nothing is saved."

    public static func listeningBlocked(_ blocker: Listening.Blocker) -> String {
        switch blocker {
        case .microphoneDenied: "Cosmos can't use the microphone yet."
        case .microphoneUnavailable: "This Mac has no microphone Cosmos can open."
        case .lidClosed: "This Mac's microphone is off while the lid is closed."
        case .systemTooOld: "This version of macOS has no on-device listener Cosmos can use."
        case .modelUnavailable: "The on-device speech model for this language isn't installed."
        }
    }

    public static func listeningBlockedNext(_ blocker: Listening.Blocker) -> String {
        switch blocker {
        case .microphoneDenied: "Turn Cosmos on in System Settings › Privacy & Security › Microphone."
        case .microphoneUnavailable: "Connect a microphone and turn listening on again."
        case .lidClosed: "Open the lid and Cosmos starts listening again by itself."
        case .systemTooOld: "Update to macOS 26 or later, or ask by typing."
        case .modelUnavailable: "Connect to the internet and turn listening on again."
        }
    }

    public static let openMicrophoneSettings = "Open Microphone settings"

    // MARK: Set up this Mac

    public static let setupTitle = "Set up this Mac"
    public static let setupLede =
        "Cosmos will know this Mac as one of your devices. It sends what you type here and shows the "
        + "replies. It listens only if you turn that on yourself, and it never reads your screen "
        + "unless you attach a selection."
    public static let setupAction = "Set up this Mac"
    public static let setupWorking = "Setting up…"
    public static let stepOne = "Step 1 of 2"
    public static let stepTwo = "Step 2 of 2"
    public static let serverLabel = "Center"
    public static let serverChange = "Change"
    public static let serverKeep = "Done"
    public static let serverPlaceholder = "https://center.example"

    // MARK: Approve in Center

    public static let approveTitle = "Approve in Center"
    public static let approveLede =
        "Scan the code with your phone, or open the link here. Center shows the same fingerprint. "
        + "Approve it there and this Mac connects by itself."
    public static let approveAction = "Approve in Center"
    public static let approveWaiting = "Waiting for your approval in Center…"
    public static let connectNow = "Connect now"
    public static let fingerprintLabel = "Fingerprint"
    public static let copyDescriptor = "Copy descriptor"
    public static let saveDescriptor = "Save…"
    public static let connectedTitle = "Connected"
    public static let connectedLede = "Ask anything. Replies appear here or on the device that suits them best."

    // MARK: The connected panel

    public static let askPlaceholder = "Ask Cosmos"
    public static let send = "Send"
    public static let sending = "Sending…"
    public static let now = "Now"
    public static let close = "Close"
    public static let cancelTask = "Cancel task"
    public static let disconnect = "Disconnect"
    public static let retry = "Retry"
    public static let details = "Details"
    public static let privateReply = "Private reply"
    public static let spokenReply = "Spoken reply"
    public static let speaking = "Speaking"
    public static let noPlaces = "No matching places found."
    public static let viewOnMaps = "View on Google Maps"
    /// The suggestions under the ask field. They are chips, so each one is the
    /// whole request it sends and short enough to read at a glance.
    public static let exampleCafes = "Find cafés near me"
    public static let exampleNotes = "Show my notes"
    public static let exampleSelection = "Summarise my selection"
    public static let overLimit = "Too long to send"
    /// A build older than the runtime it is talking to. It is a fact about this
    /// Mac, said once and quietly, never a red block over the ask field.
    public static let needsNewerCosmos = "Some replies need a newer Cosmos"

    // MARK: Destination

    /// Cosmos chooses the screen from what the answer is, so no destination is
    /// the default. Naming one is an override that stays available; it is never
    /// a step the owner has to take, and the chip says nothing until they do.
    public static let destinationTitle = "Send to"
    public static func destinationChip(_ name: String) -> String { "→ \(name)" }

    // MARK: Context

    public static let attachText = "Attach text"
    public static let useSelection = "Use selection"
    public static let useClipboard = "Use clipboard"
    public static func usingSelection(_ app: String) -> String { "Using: \(app) selection" }
    public static let usingClipboard = "Using: clipboard text"
    public static let contextExplains = "Only this text is attached. The reply stays on this Mac."
    /// What the chip adds once this Mac can say which document that screen is.
    /// The owner reads the name before they send anything; the name itself is
    /// never part of what Cosmos is asked.
    public static func usingDocument(_ name: String) -> String { " · \(name)" }
    public static func documentContinues(_ name: String, place: String?) -> String {
        "Cosmos can pick up \(name)\(place.map { " at \($0)" } ?? "") on another device."
    }
    public static let removeContext = "Remove the attached text"
    public static let accessibilityOff = "Cosmos can't read the selection yet."
    public static let accessibilityAction = "Turn Cosmos on in System Settings › Privacy & Security › Accessibility."
    public static let openAccessibilitySettings = "Open Accessibility settings"

    // MARK: Choices

    public static func chooseHint(_ count: Int) -> String {
        count <= 1 ? "Press ↩ to pick it." : "Press 1–\(min(count, 8)) or ↑↓ then ↩ to pick one."
    }

    // MARK: Tasks this Mac carries out

    /// The refusal headline. It is never styled as a fault: a task that did not
    /// happen is a fact about the task.
    public static let notDone = "Not done"
    public static let taskWaiting = "A task is ready for this Mac."
    public static let taskWaitingDetail = "Open Cosmos to see it."
    public static func runningTask(_ label: String) -> String { "Running \(label)" }
    public static func finishedTask(_ label: String, seconds: String) -> String {
        "\(label) finished after \(seconds)."
    }
    public static func openedTask(_ label: String) -> String { "\(label) is open on this Mac." }
    public static func exitCodeDetail(_ code: Int32) -> String {
        code == 0 ? "It ended without errors." : "It ended with exit code \(code)."
    }
    public static let taskCannotConfirmDetail =
        "I can't confirm whether that finished. It was not run again."
    public static func taskStopped(_ label: String) -> String { "\(label) was stopped." }
    public static let taskStoppedByYou = "Nothing more of it will run."
    public static let taskStoppedForNewRequest = "Stopped when you asked for something else."
    public static let taskRanOutOfTime = "It reached its own time limit and was stopped."
    public static let taskWithdrawn = "Cosmos withdrew the task."
    public static let taskNothingMore = "Ask again when you want it run."
    /// The output card's own heading: these are the command's bytes, not Cosmos's words.
    public static func outputFrom(_ label: String) -> String { "Output from \(label)" }

    // MARK: The confirmation ceremony

    public static func ceremonyQuestion(verb: String, subject: String, effect: String) -> String {
        "\(verb.prefix(1).uppercased())\(verb.dropFirst()) \(subject) on this Mac? It \(effect)."
    }
    public static let ceremonyPrivate = "This is private to you."
    public static let ceremonyPrompt = "Confirm below to let it run."
    public static let confirmAction = "Confirm"
    public static func declineAction(_ verb: String) -> String { "Don't \(verb.lowercased())" }
    public static let declineNoun = "Don't"
    public static func countdown(_ seconds: Int) -> String { "\(seconds)s left" }
    public static let ceremonyShortcuts = "⌘↩ confirm · ⌘⌫ don't · esc closes without answering"
    public static let ceremonyDeclined = "You said no."
    public static let ceremonyExpired = "The confirmation timed out."
    public static let attestationRefused = "This Mac did not confirm it was you."

    // MARK: What this Mac may do at all

    public static let actionsUnavailable =
        "This build of Cosmos cannot run tasks on this Mac yet. Nothing was run."
    public static let actionsUnavailableDetail = "Update Cosmos and ask again."

    // MARK: Proving it is you

    public static let attestationUnavailable = "This Mac cannot ask to confirm it is you right now."
    public static let attestationNotSetUp =
        "This Mac has no Touch ID or password set up for confirming it is you."
    public static let attestationUnsignedBuild =
        "This development build of Cosmos is not signed, so macOS will not let it ask for Touch ID or your password."
    public static let attestationNext = "Nothing was run."

    // MARK: Refusals, in the fixed vocabulary

    public static func refusalHappened(_ reason: ActionRefusal) -> String {
        switch reason {
        case .noHandler: "Nothing on this Mac can carry that out."
        case .locked: "This Mac was locked."
        case .notPermitted: "This Mac is not allowed to do that."
        case .unresolvable: "That could not be found on this Mac."
        case .versionChanged: "That document changed since it was read."
        case .entryChanged: "That task changed since Cosmos prepared it."
        case .noAttestation: "This Mac could not confirm it was you."
        }
    }

    public static func refusalNext(_ reason: ActionRefusal) -> String {
        switch reason {
        case .noHandler: "Set it up in Center → Devices, then ask again."
        case .locked: "Unlock this Mac and ask again."
        case .notPermitted: "Add it to this Mac's list in Center → Devices."
        case .unresolvable: "Check the folder or the address in Center → Devices."
        case .versionChanged: "Ask again to work from what is there now."
        case .entryChanged: "Ask again to use the task as it is now."
        case .noAttestation: "Nothing was run. Ask again when you can use Touch ID or your password."
        }
    }
}
