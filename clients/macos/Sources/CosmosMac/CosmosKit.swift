import AppKit
import SwiftUI

/// Visual tokens from the owner's Cosmos macOS UI kit (design-tokens.json).
/// The Cosmos identity lives inside the panel; system chrome and fonts stay native.
public enum CosmosTokens {
    public static let background = Color(red: 8 / 255, green: 14 / 255, blue: 18 / 255)
    public static let surface = Color(red: 17 / 255, green: 27 / 255, blue: 32 / 255)
    public static let panel = Color(red: 3 / 255, green: 8 / 255, blue: 9 / 255)
    public static let accent = Color(red: 39 / 255, green: 230 / 255, blue: 223 / 255)
    public static let response = Color(red: 88 / 255, green: 244 / 255, blue: 241 / 255)
    public static let primary = Color(red: 242 / 255, green: 247 / 255, blue: 248 / 255)
    public static let secondary = Color(red: 164 / 255, green: 183 / 255, blue: 190 / 255)
    public static let border = Color(red: 51 / 255, green: 70 / 255, blue: 77 / 255)
    public static let error = Color(red: 1, green: 172 / 255, blue: 156 / 255)
    public static let success = Color(red: 136 / 255, green: 228 / 255, blue: 190 / 255)

    public static let panelWidth: CGFloat = 560
    public static let cardRadius: CGFloat = 22
    public static let padding: CGFloat = 24
    public static let bodySize: CGFloat = 17
    public static let bodyLineHeight: CGFloat = 25
    public static let controlHeight: CGFloat = 36
    public static let nebulaOpacity: Double = 0.42

    static let backgroundNSColor = NSColor(srgbRed: 8 / 255, green: 14 / 255, blue: 18 / 255, alpha: 1)
}

/// The kit's shared UI-state names (assistant-state.schema.json). Listening is
/// part of the shared contract; this client has no microphone and never uses it.
public enum CosmosPhase: String, CaseIterable, Sendable {
    case idle, listening, thinking, speaking, error

    public var label: String {
        switch self {
        case .idle: "Ready"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .error: "Needs attention"
        }
    }

    public var animated: Bool { self == .listening || self == .thinking || self == .speaking }
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
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .reconnecting: "Reconnecting…"
        case .disconnecting: "Disconnecting…"
        case .disconnected: "Disconnected"
        }
    }
}

/// Pure presentation mappings from model state. Kept free of views so they are testable.
public enum PanelState {
    /// A connected room, a room being rejoined and a disconnect in flight all keep
    /// the connected layout; the setup and approval layouts need an identity decision.
    public static func stage(hasDescriptor: Bool, phase: ClientPhase, rejoining: Bool) -> PanelStage {
        if phase == .connected || phase == .disconnecting || rejoining { return .connected }
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

    /// Observed playback outranks everything; work in progress outranks a stale
    /// failure, which outranks rest. Nothing here claims listening.
    public static func waveform(speaking: Bool, busy: Bool, rejoining: Bool, failed: Bool) -> CosmosPhase {
        if speaking { return .speaking }
        if busy || rejoining { return .thinking }
        if failed { return .error }
        return .idle
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

    /// Whether a model message is one of the fixed failure sentences.
    public static func isFailureMessage(_ message: String) -> Bool {
        let failures: [ClientFailure] = [
            .invalidServer, .invalidText, .invalidResponse, .identityUnavailable, .storageUnavailable,
            .storageBlocked, .approvalRequired, .connectionUnavailable, .uncertainRequest, .busy,
        ]
        return failures.contains { $0.message == message }
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
            case .idle: CosmosTokens.primary
            case .listening, .thinking, .speaking: CosmosTokens.response
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
            Circle().fill(CosmosTokens.panel)
            Circle().strokeBorder(CosmosTokens.accent.opacity(0.55), lineWidth: 1)
            CosmosCrescent().fill(CosmosTokens.primary)
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
            let symbol = NSImage(systemSymbolName: "waveform", accessibilityDescription: "Cosmos") ?? NSImage()
            symbol.isTemplate = true
            return symbol
        }
        image.isTemplate = true
        image.accessibilityDescription = "Cosmos"
        return image
    }
}
