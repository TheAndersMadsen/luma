import AppKit
import CoreGraphics
import Foundation

/// When a reply shows itself, how long it stays, and when it must not appear at all.
///
/// A reply routed to this Mac arrives whether or not anyone is looking at the
/// panel. Presenting it is a decision about the room the owner is in, not about
/// the reply: the panel appears under the menu-bar item without taking the
/// keyboard, stays as long as the content needs reading and any attention lasts,
/// and fades away on its own. Everything here that decides is a pure function, so
/// the rules are read and tested without a window.
public enum AutoPresent {
    // MARK: How long a reply stays

    /// A moment to notice the panel before the reading time starts.
    public static let noticeSeconds: Double = 1.5
    /// Comfortable silent reading of screen prose. Deliberately below the
    /// average so a reply is never taken away mid-sentence.
    public static let wordsPerMinute: Double = 200
    /// A one-word answer still has to be seen; a long one is not a document.
    public static let shortestDwell: Double = 6
    public static let longestDwell: Double = 20
    /// The fade itself: long enough to read as leaving, short enough not to linger.
    public static let fadeSeconds: Double = 0.4

    /// Words as a reader counts them: runs of non-space, punctuation included.
    public static func words(in text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
    }

    /// How long this much text should stay on screen: a moment to notice it plus
    /// the time to read it, clamped so neither end is absurd.
    public static func dwell(for text: String) -> Double {
        let reading = Double(words(in: text)) * 60 / wordsPerMinute
        return min(max(noticeSeconds + reading, shortestDwell), longestDwell)
    }

    /// Everything on the panel a person actually reads, in reading order. The
    /// dwell follows what is on screen now, so a card replaced by a longer one
    /// buys the time the longer one needs.
    public static func readable(card: DisplayCard?, speech: SpeechReply?,
                                task: TaskCardModel?) -> String {
        var parts: [String] = []
        if let task {
            parts.append(task.state)
            parts.append(task.sentence)
            if let detail = task.detail { parts.append(detail) }
        }
        if let card {
            switch card.content {
            case .text(let text):
                parts.append(text)
            case .places(let query, let items, _):
                parts.append(query)
                for item in items { parts.append(item.name); parts.append(item.address) }
            case .choices(let title, let items):
                parts.append(title)
                for item in items {
                    parts.append(item.title)
                    if !item.detail.isEmpty { parts.append(item.detail) }
                }
            }
        }
        if let speech { parts.append(speech.text) }
        return parts.joined(separator: " ")
    }

    // MARK: What arrived

    /// One thing delivered to this Mac that could present itself. It carries no
    /// content: only what kind of thing it is, its own identity, and the class
    /// Cosmos routed it at.
    public struct Arrival: Equatable, Sendable {
        /// Most urgent first. A ceremony is a question, so it outranks a report
        /// of work, which outranks a reply to read.
        public enum Kind: Int, Equatable, Sendable, CaseIterable {
            case ceremony, task, card, speech
        }

        public let kind: Kind
        public let id: UUID
        /// Above `shared_room`, so the runtime holds it for an unlocked foreground.
        public let isPrivate: Bool

        public init(kind: Kind, id: UUID, isPrivate: Bool) {
            self.kind = kind
            self.id = id
            self.isPrivate = isPrivate
        }
    }

    /// Above `shared_room` a reply belongs to one person at one screen.
    public static func isPrivate(_ privacy: String) -> Bool {
        privacy == "near_user" || privacy == "private"
    }

    /// Everything current on this Mac that can present itself, most urgent first.
    /// The caller remembers which ones it has already acted on; this says only
    /// what is here now.
    public static func arrivals(display: DisplayCard?, speech: SpeechReply?,
                                confirmation: ConfirmationRequest?, task: DeviceTask?) -> [Arrival] {
        var values: [Arrival] = []
        if let confirmation {
            values.append(Arrival(kind: .ceremony, id: confirmation.grantID,
                                  isPrivate: isPrivate(confirmation.privacy)))
        }
        if let task {
            values.append(Arrival(kind: .task, id: task.actionID, isPrivate: isPrivate(task.privacy)))
        }
        if let display {
            values.append(Arrival(kind: .card, id: display.actionID, isPrivate: display.isPrivate))
        }
        if let speech {
            // A spoken reply carries no class of its own; Cosmos already decided
            // this Mac may play it.
            values.append(Arrival(kind: .speech, id: speech.actionID, isPrivate: false))
        }
        return values
    }

    // MARK: Whether it may appear at all

    /// The room this Mac is in right now. Nothing here is about the reply.
    public struct Room: Equatable, Sendable {
        /// The owner's own switch, from the menu-bar menu.
        public var enabled: Bool
        /// The screen is locked or this session is not the one on the display.
        public var screenLocked: Bool
        /// Do Not Disturb, or any other Focus, is on.
        public var focusOn: Bool
        /// An application is in full screen on the display the panel would use.
        public var fullScreen: Bool
        /// The menu-bar item is reachable, so the panel can sit under it.
        public var anchored: Bool

        public init(enabled: Bool = true, screenLocked: Bool = false, focusOn: Bool = false,
                    fullScreen: Bool = false, anchored: Bool = true) {
            self.enabled = enabled
            self.screenLocked = screenLocked
            self.focusOn = focusOn
            self.fullScreen = fullScreen
            self.anchored = anchored
        }

        /// Any one of these makes presenting itself rude or wrong.
        public var interrupts: Bool { screenLocked || focusOn || fullScreen || !anchored }
    }

    /// How the panel came to be on screen. The owner's own open behaves exactly
    /// as it does today and is never taken away by a countdown.
    public enum Opening: Equatable, Sendable {
        case owner, automatic
    }

    public enum Decision: Equatable, Sendable {
        /// Show it, and start the countdown.
        case present
        /// Show it, and leave it: a ceremony that vanished would be an answer,
        /// and an owner who opened the panel did not ask for it to close.
        case stay
        /// Leave it closed. The glyph carries the waiting state and the reply is
        /// there when the owner opens Cosmos, which is the existing behaviour.
        case hold
    }

    /// Whether this arrival may present itself, and whether it may then leave.
    public static func decide(_ arrival: Arrival, room: Room,
                              showing: Bool, opening: Opening?) -> Decision {
        // The owner opened this panel. Nothing automatic closes it.
        if showing, opening == .owner { return .stay }
        guard room.enabled else { return .hold }
        guard !room.interrupts else { return .hold }
        // Auto-presenting is never the way private content reaches a screen it
        // was not already on: the runtime releases it to an unlocked foreground,
        // and the owner's own open is what makes one.
        if arrival.isPrivate, !showing { return .hold }
        return arrival.kind == .ceremony ? .stay : .present
    }

    // MARK: Whether it may leave yet

    /// Any sign that the owner is with the panel. While one lasts the countdown
    /// does not run; when it ends the countdown starts again from the top.
    public static func holdsOpen(pointerInside: Bool, windowIsKey: Bool, drafting: Bool,
                                 choosing: Bool, playing: Bool, workingHere: Bool,
                                 ceremony: Bool) -> Bool {
        pointerInside || windowIsKey || drafting || choosing || playing || workingHere || ceremony
    }

    // MARK: What the room is doing

    /// The Cocoa rectangle for a window the window server reports. Its own
    /// coordinates count down from the top of the primary display.
    public static func cocoaRect(fromWindowServer rect: CGRect, primaryMaxY: CGFloat) -> CGRect {
        CGRect(x: rect.origin.x, y: primaryMaxY - rect.origin.y - rect.height,
               width: rect.width, height: rect.height)
    }

    /// A window covers a screen when it reaches every edge of it. A maximized
    /// window stops below the menu bar, so only a full-screen space matches.
    public static func covers(window: CGRect, screen: CGRect, tolerance: CGFloat = 2) -> Bool {
        window.minX <= screen.minX + tolerance && window.minY <= screen.minY + tolerance
            && window.maxX >= screen.maxX - tolerance && window.maxY >= screen.maxY - tolerance
    }

    /// Whether a Focus is on, from the assertions the system keeps for it. An
    /// unreadable or absent store means no Focus was ever set up here.
    public static func focusOn(assertions data: Data?) -> Bool {
        guard let data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = object["data"] as? [[String: Any]] else { return false }
        return entries.contains { entry in
            let records = entry["storeAssertionRecords"] as? [[String: Any]]
            return !(records ?? []).isEmpty
        }
    }
}

/// What the operating system can honestly say about the room, read at the moment
/// a reply arrives. Everything it decides with lives in `AutoPresent`.
@MainActor
public enum SystemPresence {
    /// The macOS Focus store. A Focus that is on has a live assertion in it.
    static let focusAssertions = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/DoNotDisturb/DB/Assertions.json")

    /// The screen is locked, or this login session is not the one on the display.
    public static var screenLocked: Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if let locked = session["CGSSessionScreenIsLocked"] as? Bool, locked { return true }
        if let locked = session["CGSSessionScreenIsLocked"] as? Int, locked != 0 { return true }
        if let console = session[kCGSessionOnConsoleKey as String] as? Bool, !console { return true }
        return false
    }

    /// Do Not Disturb, or any other Focus, is on.
    public static var focusOn: Bool {
        AutoPresent.focusOn(assertions: try? Data(contentsOf: focusAssertions))
    }

    /// An application other than this one is in full screen on that display.
    public static func fullScreen(on screen: NSScreen) -> Bool {
        guard let primary = NSScreen.screens.first,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                       kCGNullWindowID) as? [[String: Any]] else {
            return false
        }
        let ownPID = Int(ProcessInfo.processInfo.processIdentifier)
        for window in windows {
            // Only ordinary application windows; the menu bar, the Dock and the
            // panel's own kind live above layer zero.
            guard (window[kCGWindowLayer as String] as? Int) == 0,
                  (window[kCGWindowOwnerPID as String] as? Int) != ownPID,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
            let frame = AutoPresent.cocoaRect(fromWindowServer: rect, primaryMaxY: primary.frame.maxY)
            if AutoPresent.covers(window: frame, screen: screen.frame) { return true }
        }
        return false
    }
}
