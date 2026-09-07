import AVFoundation
import Foundation
import Speech
import XCTest
@testable import CosmosMac

/// The whole path, end to end, without a microphone: synthesised speech goes
/// into the same `SpeechWakeWordListener` the owner's microphone feeds, through
/// the same `SpeechAnalyzer`, and what comes out is the request that followed
/// the phrase.
///
/// It is skipped when this Mac has no on-device analyser or no installed model
/// for the language, because then there is nothing to prove rather than
/// something to fail.
@available(macOS 26, *)
final class SpokenRequestTests: XCTestCase {
    /// Finishing an analyser is asynchronous, so this gives it the moment it
    /// needs before the next test starts measuring anything.
    override func tearDown() async throws {
        try? await Task.sleep(for: .milliseconds(400))
    }

    /// The phrase and a request in one breath, exactly as the owner would say
    /// it. Nothing is asserted about the transcript's spelling: what matters is
    /// that the phrase fired and that the request came back with it.
    @MainActor
    func testHearsThePhraseAndTheRequestInSynthesisedSpeech() async throws {
        let spoken = "Hey Cosmos, find cafés near me."
        let heard = try await recognise(spoken)
        XCTAssertFalse(heard.text.isEmpty, "nothing was recognised")
        print("[wake] said: \(spoken)")
        print("[wake] heard: \(heard.text)")
        print("[wake] capture: \(heard.capture.captureMs) ms \(heard.capture.attestation)")
        // The request is what followed the phrase, and the phrase itself is
        // gone from it.
        XCTAssertNil(WakePhrase.match(in: heard.text))
        XCTAssertTrue(heard.text.lowercased().contains("cafe")
                      || heard.text.lowercased().contains("café")
                      || heard.text.lowercased().contains("coffee"),
                      "the request did not survive: \(heard.text)")
        // And it is attested as having begun with a phrase, inside the bound
        // the runtime accepts for one capture.
        XCTAssertEqual(heard.capture.attestation, [.wakePhrase, .captureIndicator])
        XCTAssertLessThanOrEqual(heard.capture.captureMs, VoiceCapture.maximumCaptureMs)
    }

    /// The same sentence in the owner's own accent: a Danish voice speaking
    /// English, which is where "Cosmos" turns into something else.
    @MainActor
    func testHearsThePhraseInADanishVoice() async throws {
        let danish = AVSpeechSynthesisVoice.speechVoices()
            .first { $0.language.hasPrefix("da") }
        guard let danish else { throw XCTSkip("This Mac has no Danish voice installed.") }
        // The transcript first, because what a Danish voice does to "Hey" is
        // the whole reason the matcher is generous: this Mac wrote "Here
        // cosmos" for it, and that spelling is now one of the ones it knows.
        let transcript = try await transcribe("Hey Cosmos, find cafés near me.", voice: danish)
        print("[wake] a Danish voice reading English came back as: \(transcript)")
        XCTAssertFalse(transcript.isEmpty, "nothing was recognised at all")
        XCTAssertNotNil(WakePhrase.match(in: transcript),
                        "the phrase did not survive the accent: \(transcript)")

        // And then the whole path, so the generosity is proved where it is used
        // rather than only where it is written.
        let heard = try await recognise("Hey Cosmos, find cafés near me.", voice: danish)
        print("[wake] danish voice request: \(heard.text)")
        XCTAssertFalse(heard.text.isEmpty)
        XCTAssertEqual(heard.capture.attestation, [.wakePhrase, .captureIndicator])
    }

    /// What the analyser writes down for one sentence, with no phrase matching
    /// in the way. It is the same on-device transcriber the listener runs.
    @MainActor
    private func transcribe(_ sentence: String, voice: AVSpeechSynthesisVoice?) async throws -> String {
        let locale = Locale(identifier: "en_US")
        guard await SpeechTranscriber.installedLocales.contains(where: {
            $0.identifier == locale.identifier
        }) else {
            throw XCTSkip("This Mac has no installed on-device model for \(locale.identifier).")
        }
        _ = try? await AssetInventory.reserve(locale: locale)
        defer { Task { _ = await AssetInventory.release(reservedLocale: locale) } }
        let buffers = try await Self.synthesise(sentence, voice: voice)
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
              let first = buffers.first,
              let converter = BufferConverter(from: first.format, to: format) else {
            throw XCTSkip("This Mac could not prepare the analyser.")
        }
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        try await analyzer.start(inputSequence: stream)
        for buffer in buffers {
            if let converted = converter.convert(buffer) { continuation.yield(AnalyzerInput(buffer: converted)) }
        }
        continuation.finish()
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        var text = ""
        for try await result in transcriber.results where result.isFinal {
            text += (text.isEmpty ? "" : " ") + String(result.text.characters)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A sentence that is not the phrase opens nothing. This is the expensive
    /// half of the promise: the microphone stays shut about everything else.
    @MainActor
    func testDoesNotFireOnASentenceThatIsNotThePhrase() async throws {
        do {
            let heard = try await recognise("The cosmos is very large, and Costco is closed.",
                                            expectingSilence: true)
            XCTFail("fired on: \(heard.text)")
        } catch is NothingHeard {
            // Exactly right: nothing left this Mac.
        }
    }

    /// What listening actually costs when nobody is speaking.
    ///
    /// The real listener, the real analyser, fed a quiet room for a minute, and
    /// the processor time this process spent on it. It is off by default
    /// because a minute of nothing is not a check; set `COSMOS_WAKE_COST` to
    /// the number of seconds to measure over.
    @MainActor
    func testMeasuresWhatListeningCostsWhenIdle() async throws {
        guard let seconds = ProcessInfo.processInfo.environment["COSMOS_WAKE_COST"]
            .flatMap(Double.init) else {
            throw XCTSkip("Set COSMOS_WAKE_COST to the seconds of silence to measure over.")
        }
        let locale = Locale(identifier: "en_US")
        guard await SpeechTranscriber.installedLocales.contains(where: {
            $0.identifier == locale.identifier
        }) else { throw XCTSkip("No installed on-device model to measure.") }

        let source = ReplayingAudioSource(buffers: [])
        source.silenceOnly = seconds + 5
        let listener = SpeechWakeWordListener(source: source, locale: locale)
        var started = false
        listener.onSignal = { if case .started = $0 { started = true } }
        listener.start()
        defer { listener.stop() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !started, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(started, "the listener never opened its input")

        let before = Self.processorSeconds()
        let wallBefore = ContinuousClock.now
        try? await Task.sleep(for: .seconds(seconds))
        let used = Self.processorSeconds() - before
        let wall = Double(wallBefore.duration(to: .now).components.seconds)
        print(String(format: "[wake] idle cost: %.2f s of processor time over %.0f s of silence "
                     + "= %.1f%% of one core (in this process)", used, wall, used / wall * 100))
    }

    /// User plus system processor time for this whole process, every thread.
    private static func processorSeconds() -> Double {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return 0 }
        let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
        let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
        return user + system
    }

    // MARK: Driving the real listener

    private struct NothingHeard: Error {}

    /// Runs one sentence through the real listener and returns what it decided.
    @MainActor
    private func recognise(_ sentence: String, voice: AVSpeechSynthesisVoice? = nil,
                           expectingSilence: Bool = false) async throws -> SpokenRequest {
        let locale = Locale(identifier: "en_US")
        guard await SpeechTranscriber.installedLocales.contains(where: {
            $0.identifier == locale.identifier
        }) else {
            throw XCTSkip("This Mac has no installed on-device model for \(locale.identifier).")
        }
        let buffers = try await Self.synthesise(sentence, voice: voice)
        let seconds = buffers.reduce(0.0) { $0 + Double($1.frameLength) / $1.format.sampleRate }
        print("[wake] synthesised \(buffers.count) buffers, \(String(format: "%.2f", seconds))s, "
              + "voice \(voice?.name ?? "en-US default")")
        XCTAssertFalse(buffers.isEmpty, "the system synthesised no audio")

        let source = ReplayingAudioSource(buffers: buffers)
        let listener = SpeechWakeWordListener(source: source, locale: locale)
        var captured: SpokenRequest?
        var blocked: Listening.Blocker?
        var state = Listening.State.off
        listener.onSignal = { signal in
            switch signal {
            case .captured(let request): captured = request
            case .blocked(let blocker): blocked = blocker
            default: break
            }
            let event: Listening.Event = switch signal {
            case .started: .started
            case .blocked(let blocker): .blocked(blocker)
            case .cleared: .cleared
            case .heardPhrase: .heardPhrase
            case .captureBegan: .captureBegan
            case .captured: .captured
            case .captureExpired: .captureExpired
            }
            if let next = Listening.next(state, on: event) { state = next }
        }
        state = .starting
        listener.start()
        defer { listener.stop() }

        // The sentence, then the silence that ends a request, then room for the
        // analyser to settle. Everything here runs at the speed a person speaks.
        let deadline = ContinuousClock.now.advanced(by: .seconds(expectingSilence ? 20 : 30))
        while captured == nil, blocked == nil, ContinuousClock.now < deadline {
            if source.finished, source.silenceSeconds > 6 { break }
            if Task.isCancelled { print("[wake] the test's own task was cancelled"); break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let blocked { throw XCTSkip("This Mac could not listen: \(blocked)") }
        guard let captured else { throw NothingHeard() }
        return captured
    }

    /// One sentence as audio, from the system's own synthesiser. Nothing is
    /// recorded and nothing is read from disk.
    private static func synthesise(_ text: String,
                                   voice: AVSpeechSynthesisVoice?) async throws -> [AVAudioPCMBuffer] {
        let collector = SynthesisCollector()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice ?? AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        return try await collector.write(utterance)
    }
}

/// Collects the synthesiser's own buffers. It copies each one, because the
/// synthesiser reuses the buffer it hands over.
private final class SynthesisCollector: @unchecked Sendable {
    private let synthesiser = AVSpeechSynthesizer()
    private var buffers: [AVAudioPCMBuffer] = []
    private var continuation: CheckedContinuation<[AVAudioPCMBuffer], Error>?
    private let lock = NSLock()

    func write(_ utterance: AVSpeechUtterance) async throws -> [AVAudioPCMBuffer] {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock(); self.continuation = continuation; lock.unlock()
            synthesiser.write(utterance) { [weak self] buffer in
                guard let self, let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 { finish(); return }
                if let copy = Self.copy(pcm) {
                    lock.lock(); buffers.append(copy); lock.unlock()
                }
            }
            // The synthesiser does not always send an empty buffer to say it is
            // done, so the wall clock ends it either way.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                self?.finish()
            }
        }
    }

    private func finish() {
        lock.lock()
        let pending = continuation
        continuation = nil
        let values = buffers
        lock.unlock()
        pending?.resume(returning: values)
    }

    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            return nil
        }
        copy.frameLength = buffer.frameLength
        let bytes = Int(buffer.frameLength) * Int(buffer.format.streamDescription.pointee.mBytesPerFrame)
        if let from = buffer.int16ChannelData, let to = copy.int16ChannelData {
            for channel in 0..<Int(buffer.format.channelCount) {
                memcpy(to[channel], from[channel], bytes / Int(buffer.format.channelCount))
            }
            return copy
        }
        if let from = buffer.floatChannelData, let to = copy.floatChannelData {
            for channel in 0..<Int(buffer.format.channelCount) {
                memcpy(to[channel], from[channel], bytes / Int(buffer.format.channelCount))
            }
            return copy
        }
        return nil
    }
}

/// The synthesised sentence played into the listener at the speed it was
/// spoken, followed by silence, in the format the analyser asked for. It stands
/// exactly where the microphone stands, so everything after it is the real path.
@MainActor
final class ReplayingAudioSource: WakeAudioSource {
    /// When the sentence ended, shared with the replay so the test can tell
    /// silence from a listener that simply never answered.
    final class SilenceClock: @unchecked Sendable {
        private let lock = NSLock()
        private var startedAt: Date?

        func begin() { lock.lock(); startedAt = Date(); lock.unlock() }
        var seconds: Double {
            lock.lock(); defer { lock.unlock() }
            return startedAt.map { Date().timeIntervalSince($0) } ?? 0
        }
        var began: Bool { seconds > 0 }
    }

    private let buffers: [AVAudioPCMBuffer]
    private var replay: Task<Void, Never>?
    private let clock = SilenceClock()
    /// Seconds of nothing but a quiet room, for measuring what listening to one
    /// costs. Zero means play the sentence instead.
    var silenceOnly: Double = 0

    var finished: Bool { clock.began }
    var silenceSeconds: Double { clock.seconds }

    init(buffers: [AVAudioPCMBuffer]) { self.buffers = buffers }

    func open(format: AVAudioFormat, sink: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws {
        if silenceOnly > 0 {
            let quiet = silenceOnly
            replay = Task.detached { await Self.play(silence: quiet, format: format, sink: sink) }
            return
        }
        guard let first = buffers.first,
              let converter = BufferConverter(from: first.format, to: format) else {
            throw WakeAudioFailure(.microphoneUnavailable)
        }
        let values = buffers
        let clock = self.clock
        replay = Task.detached {
            // A moment of silence first, so the analyser starts on a quiet room
            // exactly as it does when the owner turns listening on.
            await Self.play(silence: 0.5, format: format, sink: sink)
            for buffer in values {
                if Task.isCancelled { return }
                let seconds = Double(buffer.frameLength) / buffer.format.sampleRate
                if let converted = converter.convert(buffer) { sink(converted) }
                try? await Task.sleep(for: .seconds(seconds))
            }
            clock.begin()
            // Then the silence that ends a request, and enough of it that a
            // capture which never closes is a failure rather than a timeout.
            await Self.play(silence: 12, format: format, sink: sink)
        }
    }

    func close() {
        replay?.cancel()
        replay = nil
    }

    /// Real silence at the analyser's own rate: what a quiet room sounds like.
    private static func play(silence seconds: Double, format: AVAudioFormat,
                             sink: @escaping @Sendable (AVAudioPCMBuffer) -> Void) async {
        let frames = AVAudioFrameCount(format.sampleRate / 10)
        var remaining = seconds
        while remaining > 0, !Task.isCancelled {
            if let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) {
                buffer.frameLength = frames
                let bytes = Int(frames) * Int(format.streamDescription.pointee.mBytesPerFrame)
                for channel in 0..<Int(format.channelCount) {
                    if let data = buffer.floatChannelData {
                        memset(data[channel], 0, bytes / Int(format.channelCount))
                    } else if let data = buffer.int16ChannelData {
                        memset(data[channel], 0, bytes / Int(format.channelCount))
                    }
                }
                sink(buffer)
            }
            try? await Task.sleep(for: .milliseconds(100))
            remaining -= 0.1
        }
    }
}
