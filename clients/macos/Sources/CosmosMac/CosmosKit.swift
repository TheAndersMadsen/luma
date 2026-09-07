import AppKit
import SwiftUI

/// Visual tokens from the owner's Cosmos macOS UI kit (design-tokens.json).
///
/// Every colour is a pair: the kit's graphite ground in dark appearance and a
/// light graphite ground with the same roles in light appearance. Nothing in the
/// panel hard-codes a colour that only works in one of them, and the accent is
/// darkened for light so text on it still clears 4.5:1.
public enum CosmosTokens {
    // The kit's dark palette, unchanged.
    static let darkBackground = NSColor(srgbRed: 8 / 255, green: 14 / 255, blue: 18 / 255, alpha: 1)
    static let darkSurface = NSColor(srgbRed: 17 / 255, green: 27 / 255, blue: 32 / 255, alpha: 1)
    static let darkPanel = NSColor(srgbRed: 3 / 255, green: 8 / 255, blue: 9 / 255, alpha: 1)
    static let darkAccent = NSColor(srgbRed: 39 / 255, green: 230 / 255, blue: 223 / 255, alpha: 1)
    static let darkResponse = NSColor(srgbRed: 88 / 255, green: 244 / 255, blue: 241 / 255, alpha: 1)
    static let darkPrimary = NSColor(srgbRed: 242 / 255, green: 247 / 255, blue: 248 / 255, alpha: 1)
    static let darkSecondary = NSColor(srgbRed: 164 / 255, green: 183 / 255, blue: 190 / 255, alpha: 1)
    static let darkBorder = NSColor(srgbRed: 51 / 255, green: 70 / 255, blue: 77 / 255, alpha: 1)
    static let darkError = NSColor(srgbRed: 1, green: 172 / 255, blue: 156 / 255, alpha: 1)
    static let darkSuccess = NSColor(srgbRed: 136 / 255, green: 228 / 255, blue: 190 / 255, alpha: 1)

    // The same roles in light appearance: a cool near-white ground, ink that is
    // dark enough to read, and the kit's cyan taken down until it carries text.
    static let lightBackground = NSColor(srgbRed: 238 / 255, green: 243 / 255, blue: 244 / 255, alpha: 1)
    static let lightSurface = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
    static let lightPanel = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
    static let lightAccent = NSColor(srgbRed: 10 / 255, green: 105 / 255, blue: 101 / 255, alpha: 1)
    static let lightResponse = NSColor(srgbRed: 8 / 255, green: 62 / 255, blue: 60 / 255, alpha: 1)
    static let lightPrimary = NSColor(srgbRed: 12 / 255, green: 20 / 255, blue: 23 / 255, alpha: 1)
    static let lightSecondary = NSColor(srgbRed: 68 / 255, green: 87 / 255, blue: 94 / 255, alpha: 1)
    static let lightBorder = NSColor(srgbRed: 200 / 255, green: 214 / 255, blue: 219 / 255, alpha: 1)
    static let lightError = NSColor(srgbRed: 148 / 255, green: 38 / 255, blue: 22 / 255, alpha: 1)
    static let lightSuccess = NSColor(srgbRed: 13 / 255, green: 95 / 255, blue: 67 / 255, alpha: 1)

    /// One token as a colour that resolves itself from the drawing appearance.
    static func pair(_ light: NSColor, _ dark: NSColor) -> NSColor {
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        }
    }

    public static let backgroundNSColor = pair(lightBackground, darkBackground)
    static let surfaceNSColor = pair(lightSurface, darkSurface)
    static let panelNSColor = pair(lightPanel, darkPanel)
    static let accentNSColor = pair(lightAccent, darkAccent)
    static let responseNSColor = pair(lightResponse, darkResponse)
    static let primaryNSColor = pair(lightPrimary, darkPrimary)
    static let secondaryNSColor = pair(lightSecondary, darkSecondary)
    static let borderNSColor = pair(lightBorder, darkBorder)
    static let errorNSColor = pair(lightError, darkError)
    static let successNSColor = pair(lightSuccess, darkSuccess)

    public static let background = Color(nsColor: backgroundNSColor)
    public static let surface = Color(nsColor: surfaceNSColor)
    public static let panel = Color(nsColor: panelNSColor)
    public static let accent = Color(nsColor: accentNSColor)
    public static let response = Color(nsColor: responseNSColor)
    public static let primary = Color(nsColor: primaryNSColor)
    public static let secondary = Color(nsColor: secondaryNSColor)
    public static let border = Color(nsColor: borderNSColor)
    public static let error = Color(nsColor: errorNSColor)
    public static let success = Color(nsColor: successNSColor)

    /// Ink that sits on top of the accent (a filled primary button).
    public static let onAccent = Color(nsColor: pair(.white, darkPanel))

    public static let panelWidth: CGFloat = 600
    /// The reading column: about 68 characters at the body size.
    public static let readingWidth: CGFloat = 520
    public static let windowRadius: CGFloat = 16
    public static let cardRadius: CGFloat = 14
    public static let padding: CGFloat = 20
    public static let bodySize: CGFloat = 15
    public static let controlHeight: CGFloat = 36
    /// The nebula is a cyan cloud drawn for a graphite ground; on a light one it has
    /// to stay a hint, or it washes the controls that sit over it.
    public static let nebulaOpacity = (light: 0.14, dark: 0.42)
    /// How much graphite sits over the window material, per appearance.
    static let groundOpacity = (light: 0.70, dark: 0.80)
    /// Height changes take this long, ease-out, unless motion is reduced.
    public static let motionDuration: Double = 0.2

    /// WCAG relative-contrast ratio between two opaque colours, for the palette test.
    public static func contrastRatio(_ first: NSColor, _ second: NSColor) -> Double {
        func luminance(_ color: NSColor) -> Double {
            guard let srgb = color.usingColorSpace(.sRGB) else { return 0 }
            func channel(_ value: CGFloat) -> Double {
                let component = Double(value)
                return component <= 0.03928 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channel(srgb.redComponent)
                + 0.7152 * channel(srgb.greenComponent)
                + 0.0722 * channel(srgb.blueComponent)
        }
        let first = luminance(first), second = luminance(second)
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }
}

/// The kit's shared UI-state names (assistant-state.schema.json). Listening is
/// part of the shared contract; this client has no microphone and never uses it.
public enum CosmosPhase: String, CaseIterable, Sendable {
    case idle, listening, thinking, speaking, error

    public var label: String {
        switch self {
        case .idle: "Ready"
        case .listening: "Listening"
        case .thinking: Words.working
        case .speaking: Words.speaking
        case .error: "Needs attention"
        }
    }

    public var animated: Bool { self == .listening || self == .thinking || self == .speaking }
}

/// What the menu-bar glyph says about Cosmos without opening the panel. Presence
/// is the icon and nothing else: three shapes, one template image, no colour.
public enum MenuPresence: String, Equatable, Sendable {
    case quiet, working, waiting

    public var help: String {
        switch self {
        case .quiet: "Cosmos"
        case .working: "Cosmos · \(Words.working)"
        case .waiting: "Cosmos · \(Words.waitingForYou)"
        }
    }
}

/// Which of the three panel layouts the model currently calls for.
public enum PanelStage: Equatable, Sendable {
    case setup, approve, connected
}

/// The short state the status pill shows; the full sentence stays in `statusText`.
public enum ConnectionStatus: Equatable, Sendable {
    case connected, connecting, reconnecting, disconnecting, disconnected

    public var label: String {
        switch self {
        case .connected: Words.connected
        case .connecting: Words.connecting
        case .reconnecting: Words.reconnecting
        case .disconnecting: Words.disconnecting
        case .disconnected: Words.disconnected
        }
    }
}

/// The status line's fixed wording: a headline from the state vocabulary and, under
/// it, one plain sentence. It is information, never styled as an error.
public struct StatusLine: Equatable, Sendable {
    public let title: String
    public let detail: String?

    public init(title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }
}

/// One thing that happened and one thing to do about it. Nothing the owner reads
/// carries a raw error, an identifier or a digest; that lives under `detail`,
/// which the panel shows only behind the Details disclosure.
public struct Notice: Equatable, Sendable {
    public let happened: String
    public let next: String?
    public let detail: String?
    public let isFailure: Bool

    public init(happened: String, next: String? = nil, detail: String? = nil, isFailure: Bool = false) {
        self.happened = happened
        self.next = next
        self.detail = detail
        self.isFailure = isFailure
    }
}

/// Pure presentation mappings from model state. Kept free of views so they are testable.
public enum PanelState {
    /// A connected room, a room being rejoined and a disconnect in flight all keep
    /// the connected layout; so does a retained signed connection, because a Mac with
    /// one to return to was approved long ago and must not be asked again. The setup
    /// and approval layouts are for an installation that still needs a decision.
    public static func stage(hasDescriptor: Bool, phase: ClientPhase, rejoining: Bool,
                             retained: Bool = false) -> PanelStage {
        if phase == .connected || phase == .disconnecting || rejoining { return .connected }
        if hasDescriptor, retained { return .connected }
        return hasDescriptor ? .approve : .setup
    }

    public static func status(phase: ClientPhase, rejoining: Bool) -> ConnectionStatus {
        switch phase {
        case .connected: return .connected
        case .disconnecting: return .disconnecting
        case .connecting: return rejoining ? .reconnecting : .connecting
        case .disconnected, .preparing, .prepared, .blocked: return rejoining ? .reconnecting : .disconnected
        }
    }

    /// The quiet line under the header. A settled connection says nothing at all:
    /// "Connected" is shown for a moment after it happens and then fades away.
    public static func connectionNote(_ status: ConnectionStatus, justConnected: Bool) -> String? {
        switch status {
        case .connected: return justConnected ? Words.connected : nil
        case .connecting: return Words.connecting
        case .reconnecting: return Words.reconnecting
        case .disconnecting: return Words.disconnecting
        case .disconnected: return Words.disconnected
        }
    }

    /// Observed playback outranks everything; work in progress, here or reported by
    /// Cosmos, outranks a stale failure, which outranks rest. Nothing here claims listening.
    public static func waveform(speaking: Bool, busy: Bool, rejoining: Bool, failed: Bool,
                                working: Bool = false) -> CosmosPhase {
        if speaking { return .speaking }
        if busy || rejoining || working { return .thinking }
        if failed { return .error }
        return .idle
    }

    /// What the menu-bar glyph shows. Only a turn Cosmos reported as waiting on this
    /// Mac, or a choice list the owner has not answered, counts as waiting.
    public static func presence(phase: CosmosPhase, waitingHere: Bool) -> MenuPresence {
        if waitingHere { return .waiting }
        if phase == .thinking || phase == .speaking { return .working }
        return .quiet
    }

    /// The owner's name for a kind of surface Cosmos reported; nil when it named none.
    public static func surfaceName(_ platform: String?) -> String? {
        switch platform {
        case nil: nil
        case "pin": "your Ai Pin"
        case "browser": "your browser"
        case "macos": "this Mac"
        case "linux": "your Linux PC"
        case "android": "your phone"
        case "android_tv": "your TV"
        default: "another display"
        }
    }

    /// Repeats Cosmos's report of the turn in the shared state vocabulary: a headline
    /// the other clients also use and, when it adds something, one plain sentence.
    /// A turn that finished on this Mac needs no sentence; the reply is right there.
    public static func statusLine(_ status: TurnStatus) -> StatusLine {
        let here = status.surfacePlatform == "macos"
        let surface = surfaceName(status.surfacePlatform)
        switch status.state {
        case .working:
            return StatusLine(title: Words.working)
        case .waiting:
            if here { return StatusLine(title: Words.waitingForYou) }
            return StatusLine(title: Words.waitingForDevice, detail: surface.map(Words.waitingFor))
        case .confirming:
            // Someone has to answer at the device that would carry it out. When
            // that is this Mac the ceremony is already on screen under this line.
            if here { return StatusLine(title: Words.waitingForYou) }
            return StatusLine(title: Words.waitingForDevice, detail: surface.map(Words.waitingFor))
        case .acting:
            return StatusLine(title: Words.working, detail: here ? nil : surface.map(Words.runningOn))
        case .done:
            return StatusLine(title: Words.completed, detail: here ? nil : surface.map(Words.doneOn))
        case .refused:
            // The origin never learns why; it learns only that it did not happen.
            return StatusLine(title: Words.notDone, detail: Words.turnRefusedDetail)
        case .shown:
            return StatusLine(title: Words.completed, detail: here ? nil : surface.map(Words.shownOn))
        case .spoken:
            return StatusLine(title: Words.completed, detail: here ? nil : surface.map(Words.spokenOn))
        case .nowhere:
            return StatusLine(title: Words.nowhere, detail: Words.nowhereDetail)
        case .unknown:
            return StatusLine(title: Words.cannotConfirm, detail: Words.cannotConfirmDetail)
        }
    }

    /// Groups a hex fingerprint into 4-character blocks, eight blocks per line, so the
    /// owner can compare it with Center block by block. Non-hex input is returned as is.
    public static func groupedFingerprint(_ fingerprint: String, blockLength: Int = 4, blocksPerLine: Int = 8) -> String {
        guard blockLength > 0, blocksPerLine > 0, !fingerprint.isEmpty,
              fingerprint.allSatisfy({ $0.isHexDigit }) else { return fingerprint }
        let characters = Array(fingerprint)
        let blocks = stride(from: 0, to: characters.count, by: blockLength).map { start in
            String(characters[start..<min(start + blockLength, characters.count)])
        }
        return stride(from: 0, to: blocks.count, by: blocksPerLine).map { start in
            blocks[start..<min(start + blocksPerLine, blocks.count)].joined(separator: " ")
        }.joined(separator: "\n")
    }

    /// Copy that only restates what the stage already says is not shown as a notice.
    public static func restatesStage(_ message: String, stage: PanelStage) -> Bool {
        switch stage {
        case .setup: message == ClientModel.initialMessage
        case .approve: message == ClientModel.approveMessage
        case .connected: message == ClientModel.connectedMessage
        }
    }

    static let failures: [ClientFailure] = [
        .invalidServer, .invalidText, .invalidResponse, .identityUnavailable, .storageUnavailable,
        .storageBlocked, .approvalRequired, .connectionUnavailable, .uncertainRequest, .busy,
        .featureUnavailable,
    ]

    /// Whether a model message is one of the fixed failure sentences.
    public static func isFailureMessage(_ message: String) -> Bool {
        failures.contains { $0.message == message }
    }

    /// The one notice the panel may show, or none at all.
    ///
    /// Only what is about what the owner is doing now, and only one thing: the
    /// room state they can act on outranks the message the last operation left,
    /// and older news never stacks on top of either. A client older than the
    /// runtime is not a notice at all — nothing about it can be acted on from
    /// here, so it is one quiet sentence in the status line instead.
    public static func notice(failure: ClientFailure?, hasPending: Bool = false,
                              retained: Bool = false, rejoining: Bool = false,
                              message: String = "", stage: PanelStage = .connected) -> Notice? {
        if let failure, failure != .invalidResponse { return failure.notice }
        if hasPending { return ClientFailure.uncertainRequest.notice }
        if retained, !rejoining {
            return Notice(happened: "This Mac still holds a signed connection.",
                          next: "Reconnect to resolve it before sending another request.")
        }
        guard !message.isEmpty, !restatesStage(message, stage: stage) else { return nil }
        if let failure = failures.first(where: { $0.message == message }) {
            return failure == .invalidResponse ? nil : failure.notice
        }
        return Notice(happened: message)
    }

    /// The quiet line beside the mark: the connection while it is changing, or
    /// the one sentence for a Cosmos this Mac is too old to read.
    public static func statusNote(_ status: ConnectionStatus, justConnected: Bool,
                                  failure: ClientFailure?) -> String? {
        if failure == .invalidResponse { return Words.needsNewerCosmos }
        return connectionNote(status, justConnected: justConnected)
    }

    /// The three prompts on the empty panel. The selection example appears only where
    /// Cosmos can actually read a selection, so no suggestion leads to a refusal.
    public static func examplePrompts(canReadSelection: Bool) -> [String] {
        var prompts = [Words.exampleCafes, Words.exampleNotes]
        if canReadSelection { prompts.append(Words.exampleSelection) }
        return prompts
    }

    /// Everything a Command combination can ask the panel to do.
    public enum Command: Equatable, Sendable {
        case send, cancelTask, destinations, close, focusAsk, useSelection, choose(Int)
        /// Only while a ceremony is on screen. Both are deliberate combinations
        /// and neither is reachable by a stray keypress.
        case confirmTask, declineTask
    }

    /// The panel's whole keyboard model as one pure mapping. An accessory
    /// application has no main menu, so the window resolves each combination here
    /// rather than relying on SwiftUI's own shortcuts, which never fire without one.
    public static func command(key: String, command: Bool, shift: Bool = false,
                               option: Bool = false, control: Bool = false,
                               choiceCount: Int? = nil, ceremony: Bool = false) -> Command? {
        guard command, !option, !control else { return nil }
        let key = key.lowercased()
        if shift { return key == "u" ? .useSelection : nil }
        // A ceremony takes the two combinations that answer it and nothing else.
        // Everything the panel otherwise offers keeps working underneath.
        if ceremony {
            switch key {
            case "\r", "\u{3}": return .confirmTask
            case "\u{8}", "\u{7f}": return .declineTask
            default: break
            }
        }
        switch key {
        case "\r", "\u{3}": return .send
        case ".": return .cancelTask
        case "k": return .destinations
        case "w": return .close
        case "l": return .focusAsk
        default:
            guard let digit = key.first, key.count == 1, let count = choiceCount,
                  let index = choiceIndex(digit: digit, count: count) else { return nil }
            return .choose(index)
        }
    }

    /// The zero-based option a digit picks, or nil when it names no option. Cosmos
    /// numbers at most eight, so ⌘9 and ⌘0 never pick anything.
    public static func choiceIndex(digit: Character, count: Int) -> Int? {
        guard let value = digit.wholeNumberValue, (1...8).contains(value), value <= count else { return nil }
        return value - 1
    }

    /// The host shown for a server origin, so the setup screen reads
    /// "center.example" rather than a URL.
    public static func serverSummary(_ origin: String) -> String {
        let trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed), let host = components.host, !host.isEmpty else {
            return trimmed
        }
        return components.port.map { "\(host):\($0)" } ?? host
    }
}

/// The few pieces of panel state the window's own key handling has to reach.
/// An accessory application has no main menu, so SwiftUI's keyboard shortcuts never
/// fire; the window handles them and drives the panel through this.
@MainActor
public final class PanelCommands: ObservableObject {
    /// Whether the "Send to" picker is open, from the chip or from Command-K.
    @Published public var destinationsShown = false
    /// Bumped whenever the ask field should take focus again.
    @Published public var focusRequests = 0
    /// Whether the panel's window is the one taking keystrokes. A focus ring on a
    /// window that is not is a lie about where typing goes.
    @Published public var windowIsKey = false

    public init() {}

    public func focusAsk() { focusRequests &+= 1 }
}

/// The window's own material. A real `NSVisualEffectView` behind the panel, so the
/// desktop shows through the way every other menu-bar panel on this Mac does.
struct PanelMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

/// Seven-bar activity indicator from the kit: an envelope, never a spectrum.
/// It moves only while the panel is on screen, an animated phase is active and
/// neither the system nor the caller asks for reduced motion.
struct CosmosWaveform: View {
    var phase: CosmosPhase
    var active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let moving = phase.animated && active && !reduceMotion
        Group {
            if moving {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    bars(time: timeline.date.timeIntervalSinceReferenceDate)
                }
            } else {
                bars(time: nil)
            }
        }
        .accessibilityHidden(true)
    }

    private func bars(time: Double?) -> some View {
        Canvas { context, size in
            let bases: [Double] = [0.22, 0.56, 0.82, 1, 0.82, 0.56, 0.22]
            let tint: Color = switch phase {
            case .error: CosmosTokens.error
            case .idle: CosmosTokens.secondary
            case .listening, .thinking, .speaking: CosmosTokens.accent
            }
            let barWidth = size.width / 13
            for index in 0..<7 {
                let envelope = time.map { 0.64 + 0.30 * sin($0 * 5.24 + Double(index) * 0.62) } ?? 0.82
                let height = max(3, size.height * bases[index] * envelope)
                let x = Double(index) * size.width / 7 + (size.width / 7 - barWidth) / 2
                let rect = CGRect(x: x, y: (size.height - height) / 2, width: barWidth, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: barWidth / 2), with: .color(tint))
            }
        }
    }
}

/// The kit's crescent (assets/svg/cosmos-mark.svg), drawn natively so it scales.
struct CosmosCrescent: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 54, y: 24))
        path.addCurve(to: CGPoint(x: 86, y: 56), control1: CGPoint(x: 72, y: 24), control2: CGPoint(x: 86, y: 38))
        path.addCurve(to: CGPoint(x: 55, y: 87), control1: CGPoint(x: 86, y: 73), control2: CGPoint(x: 72, y: 87))
        path.addCurve(to: CGPoint(x: 23, y: 57), control1: CGPoint(x: 38, y: 87), control2: CGPoint(x: 24, y: 74))
        path.addCurve(to: CGPoint(x: 51, y: 52), control1: CGPoint(x: 30, y: 61), control2: CGPoint(x: 42, y: 61))
        path.addCurve(to: CGPoint(x: 54, y: 24), control1: CGPoint(x: 60, y: 43), control2: CGPoint(x: 60, y: 32))
        path.closeSubpath()
        let scale = min(rect.width, rect.height) / 108
        let offset = CGPoint(x: rect.midX - 54 * scale, y: rect.midY - 54 * scale)
        return path.applying(CGAffineTransform(translationX: offset.x, y: offset.y).scaledBy(x: scale, y: scale))
    }
}

/// The crescent on its dark disc, as in the kit's logo and app icon.
struct CosmosMark: View {
    var size: CGFloat = 26

    var body: some View {
        ZStack {
            Circle().fill(CosmosTokens.accent.opacity(0.14))
            Circle().strokeBorder(CosmosTokens.accent.opacity(0.45), lineWidth: 1)
            CosmosCrescent().fill(CosmosTokens.accent)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Kit images from the SwiftPM resource bundle. The CLI places that bundle in
/// Cosmos.app/Contents/Resources; `swift test` and `swift run` find the build copy.
public enum CosmosResources {
    static let bundleName = "CosmosMac_CosmosMac.bundle"

    static let bundle: Bundle = {
        if let url = Bundle.main.resourceURL?.appendingPathComponent(bundleName), let bundle = Bundle(url: url) {
            return bundle
        }
        return Bundle.module
    }()

    /// The nebula texture; nil only when the resource bundle is missing.
    @MainActor public static let nebula: NSImage? =
        bundle.url(forResource: "Nebula", withExtension: "png").flatMap { NSImage(contentsOf: $0) }

    /// The monochrome menu-bar glyph, template-rendered so the system tints it.
    /// Falls back to a system symbol if the bundle is missing.
    @MainActor public static var menuBarIcon: NSImage {
        let size = NSSize(width: 20, height: 16)
        let image = NSImage(size: size)
        for name in ["MenuTemplate", "MenuTemplate@2x"] {
            guard let url = bundle.url(forResource: name, withExtension: "png"),
                  let representation = NSImageRep(contentsOf: url) else { continue }
            representation.size = size
            image.addRepresentation(representation)
        }
        guard !image.representations.isEmpty else {
            let symbol = NSImage(systemSymbolName: "waveform", accessibilityDescription: Words.appName) ?? NSImage()
            symbol.isTemplate = true
            return symbol
        }
        image.isTemplate = true
        image.accessibilityDescription = Words.appName
        return image
    }

    /// The same glyph carrying its presence: quiet is the mark alone, working adds a
    /// row of three dots under it, waiting one filled dot. All template, no colour.
    @MainActor public static func menuBarIcon(_ presence: MenuPresence) -> NSImage {
        let base = menuBarIcon
        guard presence != .quiet else { return base }
        let size = NSSize(width: base.size.width, height: base.size.height)
        let image = NSImage(size: size, flipped: false) { rect in
            base.draw(in: NSRect(x: 0, y: 2, width: rect.width, height: rect.height - 2),
                      from: .zero, operation: .sourceOver, fraction: 1)
            NSColor.black.setFill()
            let radius: CGFloat = 1.1
            let centers: [CGFloat] = presence == .working
                ? [rect.midX - 3.6, rect.midX, rect.midX + 3.6]
                : [rect.midX]
            for center in centers {
                NSBezierPath(ovalIn: NSRect(x: center - radius, y: 0, width: radius * 2, height: radius * 2)).fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = presence.help
        return image
    }
}
