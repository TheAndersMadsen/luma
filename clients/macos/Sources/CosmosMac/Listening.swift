import Foundation

/// Always listening for "Hey Cosmos" on this Mac: the states, what moves
/// between them, and what one capture is.
///
/// Everything that decides is here and is a pure function, so the rules are
/// read and tested without a microphone. The one thing that opens a microphone
/// lives in `SpeechWakeWord.swift` and does nothing but report what it heard.
///
/// Three lines run through it, and they are the same three the runtime states
/// for a press. Nothing is sent anywhere until the phrase fires: what the
/// recogniser writes down before that is a rolling window a few seconds long,
/// in memory, overwritten continuously, never written to disk. The owner turns
/// this on per device, and turning it off stops the audio stream itself rather
/// than hiding an indicator. And the capture that follows the phrase is the
/// same bounded capture a press makes, marked as having begun with a phrase.
public enum Listening {
    /// Where the listener is, in the owner's terms.
    ///
    /// `off` is the switch; `starting` is the moment between the switch and an
    /// open microphone; `listening` is armed and hearing nothing worth keeping;
    /// `heard` is the instant the phrase matched; `capturing` is the bounded
    /// window that follows it; `sending` is that request on its way to Cosmos.
    public enum State: Equatable, Sendable {
        case off
        case starting
        case listening
        case heard
        case capturing
        case sending
        case blocked(Blocker)

        /// True while the microphone is open. Nothing else in the client may
        /// claim this, and the panel's indicator reads it.
        public var isOpen: Bool {
            switch self {
            case .listening, .heard, .capturing, .sending: true
            case .off, .starting, .blocked: false
            }
        }

        /// True while this Mac is recording the owner's request rather than
        /// waiting for the phrase. The second indicator reads this.
        public var isCapturing: Bool { self == .heard || self == .capturing }

        /// True while the owner's switch is on, whatever is in the way.
        public var isOn: Bool { self != .off }
    }

    /// A fact about this Mac that stops it listening. Each one is a sentence
    /// the owner can act on, or one they only need to know.
    public enum Blocker: Equatable, Sendable {
        /// The owner said no to the microphone, or has not been asked yet and
        /// the system refused without asking.
        case microphoneDenied
        /// No input device at all: every microphone unplugged.
        case microphoneUnavailable
        /// The lid is shut. The Mac disconnects its own microphone in
        /// hardware, so this is not something the client can work around.
        case lidClosed
        /// This build of macOS has no on-device analyser to listen with.
        case systemTooOld
        /// The on-device speech model for this language is not installed and
        /// could not be fetched.
        case modelUnavailable
    }

    /// What the microphone side reports. It never decides a state; it says what
    /// happened and the state machine below decides.
    public enum Event: Equatable, Sendable {
        /// The owner's switch.
        case turnOn, turnOff
        /// The microphone is open and the analyser is running.
        case started
        case blocked(Blocker)
        /// Whatever was in the way is gone: the lid opened, the device came back.
        case cleared
        /// The phrase matched in the rolling transcript.
        case heardPhrase
        /// The bounded window after the phrase began.
        case captureBegan
        /// The window closed with words in it.
        case captured
        /// The window closed with nothing said after the phrase. Nothing is sent.
        case captureExpired
        /// Cosmos has the request, or refused to take it.
        case sent, sendFailed
    }

    /// The one transition table. `nil` means this event says nothing here,
    /// which is not an error: a late result from a stream that has already been
    /// torn down arrives exactly like that.
    public static func next(_ state: State, on event: Event) -> State? {
        // The owner's switch wins over everything, in both directions, and
        // turning off is the one event that is answered from every state.
        switch event {
        case .turnOn: return state == .off ? .starting : nil
        case .turnOff: return state == .off ? nil : .off
        // A microphone lost mid-capture takes the request with it: what was
        // half-heard is dropped rather than sent as if it were whole.
        case .blocked(let blocker): return state == .off ? nil : .blocked(blocker)
        default: break
        }
        switch (state, event) {
        case (.starting, .started): return .listening
        case (.blocked, .cleared): return .starting
        case (.listening, .heardPhrase): return .heard
        case (.heard, .captureBegan): return .capturing
        case (.heard, .captured), (.capturing, .captured): return .sending
        case (.heard, .captureExpired), (.capturing, .captureExpired): return .listening
        case (.sending, .sent), (.sending, .sendFailed): return .listening
        default: return nil
        }
    }

    // MARK: One capture

    /// A few seconds of transcript is all that is ever held before the phrase
    /// fires. Longer than one sentence would keep what the owner did not say to
    /// Cosmos; shorter would cut the phrase in half.
    public static let rollingWindowSeconds: Double = 6

    /// How long the window after the phrase stays open with nothing said in it
    /// before the client gives up and goes back to waiting.
    public static let quietAfterPhraseSeconds: Double = 4

    /// The silence that ends a request the owner has finished speaking.
    public static let endOfRequestSeconds: Double = 1.2
}

/// The client's half of one capture, in the shape the runtime states for a
/// press: what this Mac attests about it and how long it held the microphone.
///
/// It mirrors `cosmos/crates/cosmos/src/ambiance/native_voice.rs`, which bounds
/// a capture at fifteen seconds of sixteen-kilohertz mono and refuses anything
/// longer. This Mac recognises the words itself, so what it sends is the
/// transcript rather than the audio; the record of the capture is kept in the
/// runtime's own terms so it says the same thing when the audio path exists.
public struct VoiceCapture: Equatable, Sendable {
    /// What began the capture. `wakePhrase` is this file's whole point: a
    /// request that began with the phrase is not a request that began with a
    /// press, and it never claims to be one.
    public enum Attestation: String, Equatable, Sendable, CaseIterable {
        case wakePhrase = "wake_phrase"
        case captureIndicator = "capture_indicator"
    }

    /// The runtime's bound on one capture, in milliseconds.
    public static let maximumCaptureMs: Int64 = 15_000
    /// The rate the runtime's recogniser takes.
    public static let sampleRate: Int = 16_000

    public let attestation: [Attestation]
    public let captureMs: Int64

    /// Nil when this Mac cannot honestly attest the capture: a window longer
    /// than the runtime accepts, or one with no time in it at all.
    public init?(captureMs: Int64) {
        guard captureMs > 0, captureMs <= Self.maximumCaptureMs else { return nil }
        // Both halves, always. The phrase started it and the panel showed that
        // it was capturing for the whole of it; a capture missing either half
        // is not one this Mac may claim.
        attestation = [.wakePhrase, .captureIndicator]
        self.captureMs = captureMs
    }
}

/// What one spoken request carried: the words, and the capture they came from.
public struct SpokenRequest: Equatable, Sendable {
    public let text: String
    public let capture: VoiceCapture

    public init(text: String, capture: VoiceCapture) {
        self.text = text
        self.capture = capture
    }
}

/// What the microphone side reports to the model.
public enum WakeWordSignal: Equatable, Sendable {
    case started
    case blocked(Listening.Blocker)
    case cleared
    case heardPhrase
    case captureBegan
    case captured(SpokenRequest)
    case captureExpired
}

/// The microphone side, so the model can be driven by recorded audio, by a
/// stub, or by the Mac's own microphone without knowing which.
@MainActor
public protocol WakeWordListening: AnyObject {
    var onSignal: ((WakeWordSignal) -> Void)? { get set }
    /// Opens the microphone. Called only from the owner's own switch.
    func start()
    /// Closes it. This stops the audio stream itself: the engine is stopped,
    /// the tap is removed and the analyser is finished. Nothing is muted in
    /// the interface while the microphone stays open.
    func stop()
}

/// A few seconds of what the recogniser wrote, and nothing older.
///
/// This is the rolling buffer the rule is about. It holds text rather than
/// audio because the analyser hands back text; either way it is bounded, in
/// memory, replaced on every result, and dropped the moment the room goes
/// quiet or the phrase fires.
public struct RollingTranscript: Equatable, Sendable {
    /// Roughly six seconds of speech. Ordinary speech runs near fifteen
    /// characters a second, so this is the window, not a text limit anyone
    /// would notice.
    public static let maximumCharacters = 240

    public private(set) var text = ""

    public init() {}

    /// Adds a finalised result. The oldest characters go first so the window
    /// keeps its length no matter how long the room talks.
    public mutating func append(_ addition: String) {
        let joined = text.isEmpty ? addition : text + " " + addition
        text = String(joined.suffix(Self.maximumCharacters))
    }

    /// The window plus the result the analyser has not settled yet, which is
    /// where the phrase usually appears first.
    public func with(volatile: String) -> String {
        volatile.isEmpty ? text : (text.isEmpty ? volatile : text + " " + volatile)
    }

    /// Called when the room goes quiet and when the phrase fires: nothing said
    /// before either moment is kept.
    public mutating func clear() { text = "" }
}
