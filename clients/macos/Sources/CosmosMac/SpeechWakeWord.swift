import AVFoundation
import Foundation
import IOKit
import IOKit.pwr_mgt
import Speech

/// The one thing in this client that opens a microphone.
///
/// It runs Apple's own on-device analyser: a `SpeechDetector` and a
/// `SpeechTranscriber` in one `SpeechAnalyzer`, with the detector as the gate.
/// While the room is quiet the rolling transcript is thrown away rather than
/// grown, and only what the detector calls speech is ever matched against the
/// phrase. Both models run on this Mac; no audio and no transcript leaves it
/// before "Hey Cosmos" fires, and nothing is written to disk at any point.
///
/// It decides nothing. It reports what it heard and `Listening.next` decides.

/// Why the microphone could not be opened. The blocker is the sentence the
/// owner reads; this is only how it travels.
public struct WakeAudioFailure: Error, Equatable {
    public let blocker: Listening.Blocker
    public init(_ blocker: Listening.Blocker) { self.blocker = blocker }
}

/// Where the audio comes from. The microphone is one implementation; a test
/// drives the very same listener from synthesised speech instead.
@MainActor
public protocol WakeAudioSource: AnyObject {
    /// Opens the input and delivers buffers already in `format`. The sink is
    /// called off the main actor, on whatever thread the audio arrives on.
    func open(format: AVAudioFormat, sink: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws
    /// Stops the stream itself: the engine stops and the tap is removed. This
    /// is what "off" means; there is no muted-but-open state.
    func close()
    /// What is in the way right now, or nil while the input is healthy. It is
    /// read a few times a second, so a lid closed mid-sentence is reported
    /// rather than silently swallowing everything said after it.
    var blocker: Listening.Blocker? { get }
}

public extension WakeAudioSource {
    var blocker: Listening.Blocker? { nil }
}

// MARK: The Mac's own microphone

/// The built-in or connected microphone, resampled into the analyser's format.
@MainActor
public final class MicrophoneAudioSource: WakeAudioSource {
    private var engine: AVAudioEngine?

    public init() {}

    /// True while the lid is shut. A Mac disconnects its own microphone in
    /// hardware then, so this is a fact to report, never one to work around.
    public static var lidIsClosed: Bool {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard service != 0 else { return false }
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(service, "AppleClamshellState" as CFString,
                                                    kCFAllocatorDefault, 0)
        return (value?.takeRetainedValue() as? Bool) ?? false
    }

    /// Asks for the microphone, at the moment the owner turns listening on and
    /// never at launch. A refusal is an answer, not an error to retry.
    public static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    public func open(format: AVAudioFormat, sink: @escaping @Sendable (AVAudioPCMBuffer) -> Void) throws {
        close()
        if Self.lidIsClosed { throw WakeAudioFailure(.lidClosed) }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw WakeAudioFailure(.microphoneUnavailable)
        }
        let converter = BufferConverter(from: inputFormat, to: format)
        guard converter != nil else { throw WakeAudioFailure(.microphoneUnavailable) }
        // A quarter of a second at a time: small enough that the analyser sees
        // the phrase promptly, large enough that the tap is not the cost.
        let frames = AVAudioFrameCount(inputFormat.sampleRate / 4)
        input.installTap(onBus: 0, bufferSize: frames, format: inputFormat) { buffer, _ in
            if let converted = converter?.convert(buffer) { sink(converted) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw WakeAudioFailure(.microphoneUnavailable)
        }
        self.engine = engine
    }

    public func close() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }

    /// Read a few times a second while listening. The lid is the honest case:
    /// a Mac in clamshell mode on an external display keeps running with its
    /// microphone switched off, and everything said at it is lost. Cosmos says
    /// so rather than appearing to listen to a microphone that is not there.
    public var blocker: Listening.Blocker? {
        // The lid first, and whether or not the engine is open: it is the
        // reason the engine had to be closed, and the reason to wait.
        if Self.lidIsClosed { return .lidClosed }
        guard let engine else { return nil }
        if !engine.isRunning { return .microphoneUnavailable }
        let format = engine.inputNode.inputFormat(forBus: 0)
        return format.sampleRate > 0 && format.channelCount > 0 ? nil : .microphoneUnavailable
    }
}

/// Resamples the microphone's own format into the analyser's. It is used only
/// from the audio thread, which is why it holds nothing else.
final class BufferConverter: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let output: AVAudioFormat
    private let ratio: Double

    init?(from input: AVAudioFormat, to output: AVAudioFormat) {
        guard let converter = AVAudioConverter(from: input, to: output) else { return nil }
        self.converter = converter
        self.output = output
        ratio = output.sampleRate / input.sampleRate
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let result = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
        var supplied = false
        var failure: NSError?
        let status = converter.convert(to: result, error: &failure) { _, outcome in
            if supplied { outcome.pointee = .noDataNow; return nil }
            supplied = true
            outcome.pointee = .haveData
            return buffer
        }
        guard status != .error, result.frameLength > 0 else { return nil }
        return result
    }
}

// MARK: The listener

@available(macOS 26, *)
@MainActor
public final class SpeechWakeWordListener: WakeWordListening {
    public var onSignal: ((WakeWordSignal) -> Void)?

    private let source: any WakeAudioSource
    private let locale: Locale
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var detector: SpeechDetector?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var work: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    /// App Nap throttles a background accessory application until its timers
    /// and its audio thread miss the phrase. This assertion is held for exactly
    /// as long as the microphone is open and released with it.
    private var activity: (any NSObjectProtocol)?
    /// The language reserved with the system's model store while listening, so
    /// it is given back when the microphone closes.
    private var reserved: Locale?

    /// The rolling window: a few seconds of what the recogniser wrote, in
    /// memory, replaced on every result and dropped whenever the room goes
    /// quiet or the phrase fires.
    private var rolling = RollingTranscript()
    private var volatileText = ""
    /// While capturing: the request as it is being spoken.
    private var capturedFinal = ""
    private var capturedVolatile = ""
    private var capturing = false
    private var phraseAt: Date?
    private var lastSpeechAt = Date()

    public init(source: (any WakeAudioSource)? = nil, locale: Locale = .current) {
        self.source = source ?? MicrophoneAudioSource()
        self.locale = locale
    }

    public func start() {
        guard work == nil else { return }
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep],
            reason: "Listening for “\(WakePhrase.display)”")
        startTicking()
        work = Task { [weak self] in await self?.run() }
    }

    public func stop() {
        ticker?.cancel()
        ticker = nil
        blocked = nil
        retryAt = nil
        retryDelay = 3
        closeAudio()
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
    }

    /// Everything the microphone side holds, given back. The reservation on the
    /// system's model store goes with it, and so does whatever was half-heard.
    private func closeAudio() {
        work?.cancel()
        work = nil
        source.close()
        input?.finish()
        input = nil
        let closing = analyzer
        analyzer = nil
        transcriber = nil
        detector = nil
        let language = reserved
        reserved = nil
        Task {
            await closing?.cancelAndFinishNow()
            if let language { _ = await AssetInventory.release(reservedLocale: language) }
        }
        rolling.clear()
        volatileText = ""
        resetCapture()
    }

    // MARK: Running

    private func run() async {
        do {
            if await MicrophoneAudioSource.requestAccess() == false, source is MicrophoneAudioSource {
                return fail(.microphoneDenied)
            }
            let language = await Self.usableLocale(locale)
            let transcriber = SpeechTranscriber(locale: language, preset: .progressiveTranscription)
            let detector = SpeechDetector(detectionOptions: .init(sensitivityLevel: .medium),
                                          reportResults: true)
            let modules: [any SpeechModule] = [detector, transcriber]
            guard await Self.readyAssets(for: modules, locale: language) else {
                return fail(.modelUnavailable)
            }
            reserved = language
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
                return fail(.modelUnavailable)
            }
            // Bounded on purpose: about five seconds of audio can be in flight
            // to the analyser and no more. If it ever fell further behind than
            // that, the memory would grow without limit and the promise that
            // this holds only a few seconds would stop being true.
            let (stream, continuation) = AsyncStream.makeStream(
                of: AnalyzerInput.self, bufferingPolicy: .bufferingNewest(20))
            let analyzer = SpeechAnalyzer(modules: modules)
            try await analyzer.start(inputSequence: stream)
            guard !Task.isCancelled else { return continuation.finish() }
            self.analyzer = analyzer
            self.transcriber = transcriber
            self.detector = detector
            input = continuation
            try source.open(format: format) { buffer in continuation.yield(AnalyzerInput(buffer: buffer)) }
            // Turning listening off during the seconds this takes must not
            // leave the microphone open behind it.
            guard !Task.isCancelled else { return source.close() }
            lastSpeechAt = Date()
            blocked = nil
            retryAt = nil
            // It works again, so the next interruption waits the short time
            // rather than the long one.
            retryDelay = 3
            emit(.started)
            await withTaskGroup(of: Void.self) { group in
                group.addTask { [weak self] in await self?.readTranscripts(transcriber) }
                group.addTask { [weak self] in await self?.readDetections(detector) }
            }
        } catch let failure as WakeAudioFailure {
            fail(failure.blocker)
        } catch {
            guard !Task.isCancelled else { return }
            fail(.microphoneUnavailable)
        }
    }

    /// Whatever is in the way now, if anything. While it is set the microphone
    /// is shut and the ticker is the only thing running, waiting for it to go.
    private var blocked: Listening.Blocker?
    /// When to look again. A refused microphone and a Mac too old to listen are
    /// answers rather than interruptions, so they are never retried.
    private var retryAt: Date?
    /// How long to wait before looking again, doubling while it keeps failing
    /// so a Mac with no model does not flicker between two states forever.
    private var retryDelay: Double = 3

    /// Something is in the way: the audio stops first, then the owner is told.
    /// A half-heard request goes with it rather than being sent as if it were
    /// whole.
    private func fail(_ blocker: Listening.Blocker) {
        guard blocked != blocker else { return }
        blocked = blocker
        if [.lidClosed, .microphoneUnavailable, .modelUnavailable].contains(blocker) {
            retryAt = Date().addingTimeInterval(retryDelay)
            retryDelay = min(retryDelay * 2, 60)
        } else {
            retryAt = nil
        }
        closeAudio()
        emit(.blocked(blocker))
    }

    /// The lid opened, or the microphone came back. Everything is built again
    /// from nothing, because a stream that was interrupted is not one to reuse.
    private func resume() {
        blocked = nil
        retryAt = nil
        emit(.cleared)
        work = Task { [weak self] in await self?.run() }
    }

    /// The language the analyser actually has, preferring the owner's own.
    private static func usableLocale(_ wanted: Locale) async -> Locale {
        if let match = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) { return match }
        return Locale(identifier: "en_US")
    }

    /// The models live outside this application, in the system's own store, and
    /// an application asks for one language at a time. Reserving it is what
    /// makes it usable here; a language the system does not hold yet is fetched
    /// once, and turning listening on is the owner's own action, so this is the
    /// moment to ask.
    private static func readyAssets(for modules: [any SpeechModule], locale: Locale) async -> Bool {
        _ = try? await AssetInventory.reserve(locale: locale)
        if await AssetInventory.status(forModules: modules) == .installed { return true }
        do {
            guard let request = try await AssetInventory.assetInstallationRequest(supporting: modules) else {
                return await AssetInventory.status(forModules: modules) == .installed
            }
            try await request.downloadAndInstall()
            return await AssetInventory.status(forModules: modules) == .installed
        } catch {
            return false
        }
    }

    private func readTranscripts(_ transcriber: SpeechTranscriber) async {
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !Task.isCancelled else { return }
                if !text.isEmpty { lastSpeechAt = Date() }
                heard(text, final: result.isFinal)
            }
        } catch {
            guard !Task.isCancelled else { return }
            fail(.microphoneUnavailable)
        }
    }

    /// The gate. While the detector reports no speech the rolling window is
    /// emptied, so what is held is never older than the last thing anyone said,
    /// and the silence after a request is what ends it.
    private func readDetections(_ detector: SpeechDetector) async {
        do {
            for try await result in detector.results {
                guard !Task.isCancelled else { return }
                if result.speechDetected {
                    lastSpeechAt = Date()
                } else if !capturing {
                    rolling.clear()
                    volatileText = ""
                }
            }
        } catch {
            guard !Task.isCancelled else { return }
            fail(.microphoneUnavailable)
        }
    }

    // MARK: What was heard

    private func heard(_ text: String, final: Bool) {
        if capturing {
            // The analyser repeats the whole utterance as it settles, phrase and
            // all, so every contribution is measured from after the phrase.
            let addition = WakePhrase.match(in: text)?.request ?? text
            if final {
                if !addition.isEmpty {
                    capturedFinal = capturedFinal.isEmpty ? addition : capturedFinal + " " + addition
                }
                capturedVolatile = ""
            } else {
                capturedVolatile = addition
            }
            return
        }
        if final {
            rolling.append(text)
            volatileText = ""
        } else {
            volatileText = text
        }
        guard let match = WakePhrase.match(in: rolling.with(volatile: volatileText)) else { return }
        // Nothing said before the phrase is kept, including the phrase itself.
        rolling.clear()
        volatileText = ""
        capturing = true
        phraseAt = Date()
        lastSpeechAt = Date()
        capturedFinal = ""
        capturedVolatile = match.request
        emit(.heardPhrase)
        emit(.captureBegan)
    }

    /// Five times a second while the microphone is open: the only clock the
    /// capture has, and cheap enough to be honest about.
    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, !Task.isCancelled else { return }
                tick()
            }
        }
    }

    private func tick() {
        // The lid, or a microphone unplugged, checked while it matters rather
        // than only when the owner turned listening on.
        if let blocker = source.blocker { return fail(blocker) }
        if blocked != nil {
            guard let retryAt, Date() >= retryAt else { return }
            return resume()
        }
        guard capturing, let began = phraseAt else { return }
        let elapsed = Date().timeIntervalSince(began)
        let quiet = Date().timeIntervalSince(lastSpeechAt)
        let spoken = request
        if spoken.isEmpty {
            // The phrase with nothing after it: the owner said the name and
            // stopped, or the room did. Nothing is sent.
            if quiet >= Listening.quietAfterPhraseSeconds { close(sending: false) }
            return
        }
        let bounded = elapsed * 1000 >= Double(VoiceCapture.maximumCaptureMs)
        if bounded || quiet >= Listening.endOfRequestSeconds { close(sending: true) }
    }

    private var request: String {
        let parts = [capturedFinal, capturedVolatile].filter { !$0.isEmpty }
        return parts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func close(sending: Bool) {
        let text = request
        let elapsed = phraseAt.map { Int64(Date().timeIntervalSince($0) * 1000) } ?? 0
        resetCapture()
        guard sending, !text.isEmpty,
              let capture = VoiceCapture(captureMs: min(max(elapsed, 1), VoiceCapture.maximumCaptureMs)) else {
            return emit(.captureExpired)
        }
        emit(.captured(SpokenRequest(text: text, capture: capture)))
    }

    private func resetCapture() {
        capturing = false
        phraseAt = nil
        capturedFinal = ""
        capturedVolatile = ""
    }

    private func emit(_ signal: WakeWordSignal) { onSignal?(signal) }
}
