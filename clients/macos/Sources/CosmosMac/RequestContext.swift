import AppKit
import ApplicationServices
import Foundation

/// Where attached text came from. Both are explicit owner actions; nothing is read
/// from another application or the pasteboard without one.
public enum ContextSource: Equatable, Sendable {
    case selection, clipboard

    public var label: String {
        switch self {
        case .selection: "Selected text"
        case .clipboard: "Clipboard text"
        }
    }
}

/// Text the owner attached to the next request, bounded to what the wire accepts.
/// Cosmos hears the application it came from; the reply carrying it stays private
/// to this Mac.
public struct ContextChip: Equatable, Sendable {
    public static let maximumBytes = 8000
    public static let maximumAppBytes = 64
    public static let unknownApp = "Unknown app"

    public let source: ContextSource
    /// The application name Cosmos is told, at most 64 UTF-8 bytes.
    public let app: String
    /// The attached text, at most 8,000 UTF-8 bytes, cut on a character boundary.
    public let text: String
    /// True when the captured text was longer than the bound and was cut.
    public let truncated: Bool

    /// Nil when the capture holds no text worth attaching.
    public init?(source: ContextSource, app: String, text: String) {
        let clean = text.replacingOccurrences(of: "\0", with: "")
        guard !clean.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let bounded = Self.bounded(clean, to: Self.maximumBytes)
        guard !bounded.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let name = app.replacingOccurrences(of: "\0", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.source = source
        self.app = Self.bounded(name.isEmpty ? Self.unknownApp : name, to: Self.maximumAppBytes).text
        self.text = bounded.text
        truncated = bounded.truncated
    }

    public var byteCount: Int { text.utf8.count }

    /// "Selected text · 1.2 KB": the exact size, kept for the Details disclosure and
    /// for what a screen reader announces. The chip itself never shows a byte count.
    public var label: String { "\(source.label) · \(Self.formatBytes(byteCount))" }

    /// What the chip says: "Using: Safari selection", "Using: clipboard text".
    /// It names where the text came from, never how much of it there is.
    public var caption: String {
        source == .selection ? Words.usingSelection(app) : Words.usingClipboard
    }

    /// Cuts to at most `limit` UTF-8 bytes without splitting a character.
    public static func bounded(_ text: String, to limit: Int) -> (text: String, truncated: Bool) {
        guard text.utf8.count > limit else { return (text, false) }
        var count = 0
        var end = text.startIndex
        for index in text.indices {
            let next = text.index(after: index)
            let size = text.utf8.distance(from: index, to: next)
            if count + size > limit { break }
            count += size
            end = next
        }
        return (String(text[..<end]), true)
    }

    /// Decimal units as Finder shows them: "812 B", "1.2 KB", "8 KB".
    public static func formatBytes(_ bytes: Int) -> String {
        guard bytes >= 1000 else { return "\(bytes) B" }
        let kilobytes = Double(bytes) / 1000
        let rounded = (kilobytes * 10).rounded() / 10
        return rounded == rounded.rounded() ? "\(Int(rounded)) KB" : String(format: "%.1f KB", rounded)
    }
}

/// The "Continue on" choice. Labels name a kind of device and nothing about whether
/// one is approved, visible or eligible; Cosmos alone decides that.
public enum Destination: String, CaseIterable, Identifiable, Sendable {
    case thisMac, phone, linuxPC, tv, browser

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .thisMac: "This Mac"
        case .phone: "Phone"
        case .linuxPC: "Linux PC"
        case .tv: "TV"
        case .browser: "Browser"
        }
    }

    /// The wire target; nil sends the request with no destination at all.
    public var target: String? {
        switch self {
        case .thisMac: nil
        case .phone: "android"
        case .linuxPC: "linux"
        case .tv: "android_tv"
        case .browser: "browser"
        }
    }
}

/// What one explicit capture found.
public enum ContextCapture: Equatable, Sendable {
    case text(app: String, text: String)
    /// The source was readable but held no text.
    case empty(app: String)
    /// No other application has been in front since Cosmos started.
    case noApplication
    /// Accessibility permission is missing; the owner grants it in System Settings.
    case permissionMissing
}

@MainActor
public protocol ContextProvider: AnyObject {
    /// Whether this Mac has granted Cosmos the Accessibility permission a selection
    /// needs. Reading this asks the system a question; it never prompts and never
    /// reads another application.
    var canReadSelection: Bool { get }
    /// The selection in the application the owner was using, read through the
    /// Accessibility API. Called only from the explicit "Use selection" action.
    func selectedText() -> ContextCapture
    /// The pasteboard's plain text. Called only from the explicit "Use clipboard" action.
    func clipboardText() -> ContextCapture
}

public extension ContextProvider {
    var canReadSelection: Bool { true }
}

/// The exact System Settings pane the owner needs for a selection. Opening it is an
/// explicit action behind a button; Cosmos never opens it or prompts on its own.
public enum SystemSettings {
    public static let accessibility =
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
}

/// Reads the selection from the application that was in front before this panel
/// took focus, through Accessibility when this app has that permission. It never
/// prompts for the permission and never reads the pasteboard on its own.
@MainActor
public final class SystemContextProvider: ContextProvider {
    private var otherApplication: NSRunningApplication?
    private var observer: NSObjectProtocol?

    public init() {
        let workspace = NSWorkspace.shared
        let own = ProcessInfo.processInfo.processIdentifier
        if let front = workspace.frontmostApplication, front.processIdentifier != own { otherApplication = front }
        observer = workspace.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let application = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  application.processIdentifier != own else { return }
            MainActor.assumeIsolated { self?.otherApplication = application }
        }
    }

    deinit {
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }

    private var applicationName: String? {
        guard let application = otherApplication, !application.isTerminated else { return nil }
        return application.localizedName ?? application.bundleIdentifier
    }

    public var canReadSelection: Bool { AXIsProcessTrusted() }

    public func selectedText() -> ContextCapture {
        guard let application = otherApplication, !application.isTerminated, let name = applicationName else {
            return .noApplication
        }
        guard AXIsProcessTrusted() else { return .permissionMissing }
        let element = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 1)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            return .empty(app: name)
        }
        var selected: CFTypeRef?
        guard AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXSelectedTextAttribute as CFString, &selected) == .success,
              let text = selected as? String else {
            return .empty(app: name)
        }
        return .text(app: name, text: text)
    }

    public func clipboardText() -> ContextCapture {
        let name = applicationName ?? ContextChip.unknownApp
        guard let text = NSPasteboard.general.string(forType: .string) else { return .empty(app: name) }
        return .text(app: name, text: text)
    }
}
