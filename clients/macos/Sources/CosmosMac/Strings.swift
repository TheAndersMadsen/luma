import Foundation

/// Every word the owner reads on this Mac, in one place.
///
/// The state vocabulary and the sentences under it are fixed by the Cosmos
/// client brief and shared with the Pixel, the Linux PC and the TV. A wording
/// change happens here and nowhere else, so the panel and the tests read the
/// same sentence.
public enum Words {
    // MARK: The state vocabulary

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

    // MARK: Presence and the menu bar

    public static let appName = "Cosmos"
    public static let openCosmos = "Open Cosmos"
    public static let quit = "Quit Cosmos"

    // MARK: Set up this Mac

    public static let setupTitle = "Set up this Mac"
    public static let setupLede =
        "Cosmos will know this Mac as one of your devices. It sends what you type here and shows the "
        + "replies. It never listens, and it never reads your screen unless you attach a selection."
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
    public static let emptyTitle = "Ask anything"
    public static let emptyLede = "Replies appear here, or on the device that suits them best."
    public static let exampleCafes = "Find cafés near me"
    public static let exampleNotes = "Show my notes about the kitchen"
    public static let exampleSelection = "Summarise what I've selected"
    public static let shortcutHint = "⌘↩ send · esc close · ⌘K send to"

    // MARK: Destination

    public static let thisMac = "This Mac"
    public static let destinationTitle = "Send to"
    public static func destinationChip(_ name: String) -> String { "→ \(name)" }

    // MARK: Context

    public static let useSelection = "Use selection"
    public static let useClipboard = "Use clipboard"
    public static func usingSelection(_ app: String) -> String { "Using: \(app) selection" }
    public static let usingClipboard = "Using: clipboard text"
    public static let contextExplains = "Only this text is attached. The reply stays on this Mac."
    public static let removeContext = "Remove the attached text"
    public static let accessibilityOff = "Cosmos can't read the selection yet."
    public static let accessibilityAction = "Turn Cosmos on in System Settings › Privacy & Security › Accessibility."
    public static let openAccessibilitySettings = "Open Accessibility settings"

    // MARK: Choices

    public static func chooseHint(_ count: Int) -> String {
        count <= 1 ? "Press ↩ to pick it." : "Press 1–\(min(count, 8)) or ↑↓ then ↩ to pick one."
    }
}
