import Foundation
import XCTest
@testable import CosmosMac

/// The always-listening state machine, and what the model does with it: the
/// switch, the phrase, the bounded capture, the request, and every way it can
/// be stopped. Nothing here opens a microphone.
final class ListeningTests: XCTestCase {
    // MARK: The states, one at a time

    func testTheOwnersSwitchIsTheWholeJourney() {
        var state = Listening.State.off
        for (event, expected) in [
            (Listening.Event.turnOn, Listening.State.starting),
            (.started, .listening),
            (.heardPhrase, .heard),
            (.captureBegan, .capturing),
            (.captured, .sending),
            (.sent, .listening),
            (.turnOff, .off),
        ] {
            guard let next = Listening.next(state, on: event) else {
                return XCTFail("\(event) said nothing in \(state)")
            }
            XCTAssertEqual(next, expected, "\(state) on \(event)")
            state = next
        }
    }

    /// Turning it off is answered from every state, and never from `off`.
    func testTurningItOffAlwaysStopsIt() {
        for state in [Listening.State.starting, .listening, .heard, .capturing, .sending,
                      .blocked(.microphoneDenied)] {
            XCTAssertEqual(Listening.next(state, on: .turnOff), .off, "\(state)")
        }
        XCTAssertNil(Listening.next(.off, on: .turnOff))
        XCTAssertNil(Listening.next(.listening, on: .turnOn))
    }

    /// Nothing that arrives late from a stream that has been torn down may
    /// start the microphone again.
    func testEventsAreIgnoredWhereTheySayNothing() {
        for event in [Listening.Event.started, .heardPhrase, .captureBegan, .captured,
                      .captureExpired, .sent, .sendFailed, .cleared, .blocked(.lidClosed)] {
            XCTAssertNil(Listening.next(.off, on: event), "\(event)")
        }
        XCTAssertNil(Listening.next(.listening, on: .captured))
        XCTAssertNil(Listening.next(.listening, on: .captureBegan))
        XCTAssertNil(Listening.next(.starting, on: .heardPhrase))
    }

    func testAPhraseWithNothingAfterItSendsNothing() {
        XCTAssertEqual(Listening.next(.capturing, on: .captureExpired), .listening)
        XCTAssertEqual(Listening.next(.heard, on: .captureExpired), .listening)
    }

    func testARefusedRequestGoesBackToListeningRatherThanStopping() {
        XCTAssertEqual(Listening.next(.sending, on: .sendFailed), .listening)
    }

    // MARK: Permission, the lid, and everything else in the way

    /// A microphone lost while the owner is speaking takes the half-heard
    /// request with it. Nothing is sent from a capture that did not finish.
    func testAnythingInTheWayStopsItFromWhereverItWas() {
        for state in [Listening.State.starting, .listening, .heard, .capturing, .sending] {
            XCTAssertEqual(Listening.next(state, on: .blocked(.lidClosed)), .blocked(.lidClosed),
                           "\(state)")
        }
        XCTAssertNil(Listening.next(.off, on: .blocked(.lidClosed)))
    }

    func testTheLidClearsByItselfAndPermissionDoesNot() {
        XCTAssertEqual(Listening.next(.blocked(.lidClosed), on: .cleared), .starting)
        XCTAssertEqual(Listening.next(.blocked(.microphoneDenied), on: .cleared), .starting)
        // Still the owner's switch: a blocker never turns it off for them.
        XCTAssertTrue(Listening.State.blocked(.microphoneDenied).isOn)
        XCTAssertFalse(Listening.State.blocked(.microphoneDenied).isOpen)
    }

    func testEveryBlockerSaysWhatHappenedAndWhatToDo() {
        for blocker in [Listening.Blocker.microphoneDenied, .microphoneUnavailable, .lidClosed,
                        .systemTooOld, .modelUnavailable] {
            XCTAssertFalse(Words.listeningBlocked(blocker).isEmpty)
            XCTAssertFalse(Words.listeningBlockedNext(blocker).isEmpty)
        }
        // The two sentences a refused microphone needs: the fact, and the one
        // place on this Mac that changes it.
        XCTAssertTrue(Words.listeningBlockedNext(.microphoneDenied).contains("System Settings"))
        XCTAssertTrue(Words.listeningBlockedNext(.microphoneDenied).contains("Microphone"))
        // The lid is a fact about the hardware, so what to do about it is to
        // open the lid, and Cosmos starts again on its own.
        XCTAssertTrue(Words.listeningBlockedNext(.lidClosed).contains("Open the lid"))
    }

    /// The two things about listening on a laptop that no client can change are
    /// said in the client's own words, where the switch is.
    func testTheLimitsAreSaidOutLoud() {
        XCTAssertTrue(Words.listeningIsVisible.contains("orange"))
        XCTAssertTrue(Words.listeningEndsWithTheLid.lowercased().contains("lid"))
        XCTAssertTrue(Words.listeningStaysHere.contains("Nothing is sent until you say the phrase"))
    }

    // MARK: One capture

    /// The capture is the runtime's own bound: fifteen seconds, and both halves
    /// of the attestation, one of which is the phrase itself.
    func testACaptureIsBoundedAndAttestedAsAPhrase() {
        let capture = VoiceCapture(captureMs: 2_400)
        XCTAssertEqual(capture?.attestation, [.wakePhrase, .captureIndicator])
        XCTAssertEqual(capture?.captureMs, 2_400)
        XCTAssertNotNil(VoiceCapture(captureMs: VoiceCapture.maximumCaptureMs))
        XCTAssertNil(VoiceCapture(captureMs: 0))
        XCTAssertNil(VoiceCapture(captureMs: -1))
        XCTAssertNil(VoiceCapture(captureMs: VoiceCapture.maximumCaptureMs + 1))
        // The runtime's own numbers, so this Mac never claims a capture it
        // would refuse: cosmos/crates/cosmos/src/ambiance/native_voice.rs.
        XCTAssertEqual(VoiceCapture.maximumCaptureMs, 15_000)
        XCTAssertEqual(VoiceCapture.sampleRate, 16_000)
    }

    // MARK: The model

    @MainActor
    func testTurningItOnOpensTheMicrophoneAndTurningItOffStopsTheStream() async throws {
        let (model, _, listener) = try await connected()
        XCTAssertEqual(model.listening, .off)
        XCTAssertEqual(listener.starts, 0)

        model.setListening(true)
        XCTAssertEqual(model.listening, .starting)
        XCTAssertEqual(listener.starts, 1)
        listener.report(.started)
        XCTAssertEqual(model.listening, .listening)
        XCTAssertTrue(model.listeningOpen)
        XCTAssertFalse(model.capturingRequest)

        model.setListening(false)
        XCTAssertEqual(model.listening, .off)
        // The mute is the stream: the listener was actually stopped, not hidden.
        XCTAssertEqual(listener.stops, 1)
        XCTAssertFalse(model.listeningOpen)
    }

    @MainActor
    func testTheSwitchIsRememberedAcrossLaunches() async throws {
        let store = try XCTUnwrap(UserDefaults(suiteName: "cosmos.listening.\(UUID().uuidString)"))
        defer { store.removePersistentDomain(forName: store.description) }
        let first = try await connected(store: store)
        XCTAssertFalse(first.model.listeningRemembered)
        first.model.setListening(true)
        XCTAssertTrue(first.model.listeningRemembered)

        // A relaunch: a new model over the same remembered switch.
        let second = try await connected(store: store)
        XCTAssertEqual(second.model.listening, .off)
        second.model.resumeListening()
        XCTAssertEqual(second.model.listening, .starting)
        XCTAssertEqual(second.listener.starts, 1)

        second.model.setListening(false)
        let third = try await connected(store: store)
        third.model.resumeListening()
        XCTAssertEqual(third.model.listening, .off)
        XCTAssertEqual(third.listener.starts, 0)
    }

    @MainActor
    func testThePhraseSendsWhatFollowedItMarkedAsAPhrase() async throws {
        let (model, client, listener) = try await connected()
        model.setListening(true)
        listener.report(.started)
        listener.report(.heardPhrase)
        XCTAssertEqual(model.listening, .heard)
        listener.report(.captureBegan)
        XCTAssertTrue(model.capturingRequest)

        let capture = try XCTUnwrap(VoiceCapture(captureMs: 3_100))
        listener.report(.captured(SpokenRequest(text: "find cafés near me", capture: capture)))
        try await until { !model.busy }
        XCTAssertEqual(client.sentTexts, ["find cafés near me"])
        XCTAssertEqual(model.nowLine, "find cafés near me")
        // The request began with a phrase, and says so.
        XCTAssertEqual(model.lastCapture?.attestation, [.wakePhrase, .captureIndicator])
        XCTAssertEqual(model.lastCapture?.captureMs, 3_100)
        // And it is back to waiting for the phrase, still on.
        XCTAssertEqual(model.listening, .listening)
    }

    @MainActor
    func testAPhraseWithNothingAfterItSendsNothingAtAll() async throws {
        let (model, client, listener) = try await connected()
        model.setListening(true)
        listener.report(.started)
        listener.report(.heardPhrase)
        listener.report(.captureBegan)
        listener.report(.captureExpired)
        XCTAssertEqual(model.listening, .listening)
        XCTAssertTrue(client.sentRequests.isEmpty)
        XCTAssertNil(model.nowLine)
        XCTAssertNil(model.lastCapture)
    }

    @MainActor
    func testARequestHeardWhileDisconnectedIsNotSentAndNotKept() async throws {
        let client = try MockClientBridge()
        let listener = StubWakeWordListener()
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                listener: listener, listeningStore: scratchStore())
        model.setListening(true)
        listener.report(.started)
        listener.report(.heardPhrase)
        listener.report(.captureBegan)
        let capture = try XCTUnwrap(VoiceCapture(captureMs: 900))
        listener.report(.captured(SpokenRequest(text: "what's the weather", capture: capture)))
        XCTAssertTrue(client.sentRequests.isEmpty)
        XCTAssertNil(model.lastCapture)
        XCTAssertEqual(model.listening, .listening)
        XCTAssertEqual(model.message, ClientModel.spokenUnavailableMessage)
    }

    /// Cosmos is there but still on the last request. Nothing is queued and
    /// nothing is kept: this Mac holds no audio once a capture closes.
    @MainActor
    func testARequestHeardWhileTheLastOneIsStillOutIsNotQueued() async throws {
        let (model, client, listener) = try await connected()
        model.setListening(true)
        listener.report(.started)
        model.draft = "what's the weather"
        model.send()
        XCTAssertTrue(model.sending)
        listener.report(.heardPhrase)
        listener.report(.captureBegan)
        let capture = try XCTUnwrap(VoiceCapture(captureMs: 1_200))
        listener.report(.captured(SpokenRequest(text: "cancel that", capture: capture)))
        XCTAssertEqual(model.message, ClientModel.spokenBusyMessage)
        XCTAssertEqual(model.listening, .listening)
        try await until { !model.busy }
        XCTAssertEqual(client.sentTexts, ["what's the weather"])
    }

    @MainActor
    func testTheLidStopsItAndOpeningItStartsAgain() async throws {
        let (model, _, listener) = try await connected()
        model.setListening(true)
        listener.report(.started)
        listener.report(.heardPhrase)
        listener.report(.captureBegan)
        // The lid closes mid-request: the half-heard request goes with it.
        listener.report(.blocked(.lidClosed))
        XCTAssertEqual(model.listening, .blocked(.lidClosed))
        XCTAssertFalse(model.listeningOpen)
        XCTAssertEqual(model.listeningLine?.title, Words.listeningBlocked(.lidClosed))
        XCTAssertEqual(model.listeningLine?.detail, Words.listeningBlockedNext(.lidClosed))
        // The owner's switch is untouched, so it comes back by itself.
        XCTAssertTrue(model.listening.isOn)
        listener.report(.cleared)
        XCTAssertEqual(model.listening, .starting)
    }

    @MainActor
    func testARefusedMicrophoneSaysSoOnceAndOffersThePane() async throws {
        let (model, _, listener) = try await connected()
        model.setListening(true)
        listener.report(.blocked(.microphoneDenied))
        XCTAssertEqual(model.listening, .blocked(.microphoneDenied))
        XCTAssertEqual(model.listeningLine?.title, "Cosmos can't use the microphone yet.")
        XCTAssertEqual(SystemSettings.microphone.absoluteString,
                       "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    }

    /// A Mac with no on-device analyser says so instead of pretending to
    /// listen: the switch goes on, the microphone never does.
    @MainActor
    func testAMacWithNoListenerSaysSoRatherThanPretending() async throws {
        let client = try MockClientBridge()
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                listener: nil, listeningStore: scratchStore())
        model.setListening(true)
        XCTAssertEqual(model.listening, .blocked(.systemTooOld))
        XCTAssertFalse(model.listeningOpen)
        XCTAssertEqual(model.listeningLine?.title, Words.listeningBlocked(.systemTooOld))
    }

    /// This Mac does have one. The check exists so the client's own claim
    /// about what it can do is checked against the system it runs on.
    @MainActor
    func testThisSystemHasAListener() throws {
        if #available(macOS 26, *) {
            XCTAssertNotNil(ClientModel.systemListener())
        } else {
            XCTAssertNil(ClientModel.systemListener())
        }
    }

    @MainActor
    func testTheIndicatorSaysWhichOfTheTwoStatesItIsIn() async throws {
        let (model, _, listener) = try await connected()
        XCTAssertNil(model.listeningLine)
        model.setListening(true)
        XCTAssertEqual(model.listeningLine?.detail, Words.listeningStarting)
        listener.report(.started)
        XCTAssertEqual(model.listeningLine?.title, Words.listening)
        XCTAssertEqual(model.listeningLine?.detail, Words.listeningForPhrase)
        listener.report(.heardPhrase)
        // The second indicator, and it is a different one: the panel shows a
        // filled dot rather than a ring for it.
        XCTAssertEqual(model.listeningLine?.title, Words.heardPhrase)
        XCTAssertTrue(model.capturingRequest)
    }

    @MainActor
    func testQuittingClosesTheMicrophoneWithoutForgettingTheSwitch() async throws {
        let store = scratchStore()
        let (model, _, listener) = try await connected(store: store)
        model.setListening(true)
        listener.report(.started)
        model.suspendListening()
        XCTAssertEqual(model.listening, .off)
        XCTAssertEqual(listener.stops, 1)
        XCTAssertTrue(model.listeningRemembered)
    }

    // MARK: Fixtures

    private func scratchStore() -> UserDefaults {
        UserDefaults(suiteName: "cosmos.listening.\(UUID().uuidString)") ?? .standard
    }

    @MainActor
    private func connected(store: UserDefaults? = nil)
        async throws -> (model: ClientModel, client: MockClientBridge, listener: StubWakeWordListener) {
        let client = try MockClientBridge()
        let listener = StubWakeWordListener()
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                listener: listener, listeningStore: store ?? scratchStore())
        model.prepare()
        try await until { !model.busy && model.descriptor != nil }
        model.connect()
        try await until { !model.busy && model.snapshot.phase == .connected }
        return (model, client, listener)
    }

    @MainActor
    private func until(_ condition: () -> Bool, timeout: Duration = .seconds(5)) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition() {
            guard ContinuousClock.now < deadline else { return XCTFail("condition never held") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

/// The microphone side, without a microphone: the test says what was heard and
/// the model does exactly what it would do for the real one.
@MainActor
final class StubWakeWordListener: WakeWordListening {
    var onSignal: ((WakeWordSignal) -> Void)?
    private(set) var starts = 0
    private(set) var stops = 0

    func start() { starts += 1 }
    func stop() { stops += 1 }
    func report(_ signal: WakeWordSignal) { onSignal?(signal) }
}
