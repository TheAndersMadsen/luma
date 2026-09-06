import AVFoundation
import Combine
import Foundation

@MainActor
public final class ClientModel: ObservableObject {
    @Published public var serverInput: String
    @Published public var draft = ""
    @Published public private(set) var snapshot: ClientSnapshot {
        didSet { syncPlayback(); scheduleReconnect() }
    }
    /// True only while the current reply's exact audio is playing.
    @Published public private(set) var speaking = false
    @Published public private(set) var descriptor: PublicDescriptor?
    @Published public private(set) var selectedServer: ServerEndpoint?
    @Published public private(set) var busy = false {
        // An operation that ends without a room (a relaunch that retained a
        // signed connection, a failed rejoin) is the moment to schedule the next attempt.
        didSet { if !busy { scheduleReconnect() } }
    }
    @Published public private(set) var message = ClientModel.initialMessage
    @Published public private(set) var shortcutMessage = ""
    /// Whether the panel itself is on screen; the waveform only moves while it is.
    @Published public private(set) var panelVisible = false
    @Published private var disconnectInFlight = false

    private let client: any ClientBridge
    private var operation: Task<Void, Never>?
    private var operationGeneration: UInt64 = 0
    private var pendingDraft: String?
    private var admissionBeforeSend: UUID?
    private var descriptorData: Data?
    private var wantedVisible = false
    private var acknowledged: UUID?
    private var acknowledging: Task<Void, Never>?
    private var playback: SpeechPlayback?
    private var loadingSpeech: Task<Void, Never>?
    private var spoken: UUID?
    /// Set by an explicit Connect, cleared by an explicit Disconnect: the
    /// window in which a dropped room is rejoined automatically.
    private var wantsConnection = false
    private var reconnectAttempt = 0
    private var reconnect: Task<Void, Never>?
    private let reconnectDelays: [Duration]

    public init(client: any ClientBridge, initialServerOrigin: String,
                reconnectDelays: [Duration] = [.seconds(1.5), .seconds(3), .seconds(6), .seconds(12), .seconds(30)]) {
        self.client = client
        self.reconnectDelays = reconnectDelays
        serverInput = initialServerOrigin
        snapshot = client.snapshot
        client.onChange = { [weak self] value in self?.snapshot = value }
    }

    public var canPrepare: Bool {
        !busy && !snapshot.hasPending && !snapshot.pendingOpen && !snapshot.needsReconnect
            && ![.connected, .connecting, .disconnecting].contains(snapshot.phase)
    }
    public var canConnect: Bool {
        !busy && !disconnectInFlight && snapshot.failure != .storageBlocked && descriptor != nil
            && selectedServer == (try? ServerEndpoint(serverInput))
            && ![.connecting, .disconnecting].contains(snapshot.phase)
            && (snapshot.needsReconnect || snapshot.pendingOpen
                || (!snapshot.hasPending && [.prepared, .disconnected].contains(snapshot.phase)))
    }
    public var canSend: Bool {
        !busy && !snapshot.hasPending && !snapshot.pendingOpen && !snapshot.needsReconnect
            && snapshot.phase == .connected && Self.validText(draft)
    }
    public var canCancel: Bool {
        !busy && !snapshot.hasPending && !snapshot.pendingOpen && !snapshot.needsReconnect
            && snapshot.phase == .connected && snapshot.admission != nil
    }
    public var canDisconnect: Bool {
        !disconnectInFlight && (![.disconnected, .prepared, .disconnecting].contains(snapshot.phase) || snapshot.hasPending)
    }
    public var canRetryPending: Bool { !busy && snapshot.canRetry }
    public var canEditServer: Bool {
        !busy && !snapshot.hasPending && !snapshot.pendingOpen && !snapshot.needsReconnect && !canDisconnect
    }

    /// A retained signed connection that this model is rejoining on its own: after a
    /// relaunch or a dropped room, without a pending request or a blocked journal.
    public var rejoining: Bool {
        wantsConnection && descriptor != nil && !snapshot.hasPending
            && ![.connected, .blocked].contains(snapshot.phase)
            && (snapshot.needsReconnect || snapshot.pendingOpen)
    }
    public var stage: PanelStage {
        PanelState.stage(hasDescriptor: descriptor != nil, phase: snapshot.phase, rejoining: rejoining)
    }
    public var connectionStatus: ConnectionStatus {
        if disconnectInFlight { return .disconnecting }
        return PanelState.status(phase: snapshot.phase, rejoining: rejoining)
    }
    public var waveformPhase: CosmosPhase {
        PanelState.waveform(speaking: speaking, busy: busy, rejoining: rejoining, failed: snapshot.failure != nil)
    }

    public var statusText: String {
        if disconnectInFlight { return "Disconnecting…" }
        if let failure = snapshot.failure { return failure.message }
        if snapshot.needsReconnect || snapshot.pendingOpen { return "Reconnect to resolve the retained connection state." }
        if snapshot.hasPending { return ClientFailure.uncertainRequest.message }
        switch snapshot.phase {
        case .disconnected: return "Disconnected"
        case .preparing: return "Opening installation identity…"
        case .prepared: return "Installation prepared. Center approval is required."
        case .connecting: return "Connecting to Cosmos…"
        case .connected:
            if speaking { return "Connected · speaking" }
            return snapshot.visible ? "Connected · visible shared display" : "Connected for public text"
        case .disconnecting: return "Disconnecting…"
        case .blocked: return "Connection stopped. Resolve the reported error before continuing."
        }
    }

    public static func validText(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && text.utf8.count <= 4000 && !text.contains("\0")
    }

    public func prepare() {
        guard canPrepare else { return }
        let server: ServerEndpoint
        do { server = try ServerEndpoint(serverInput) }
        catch { message = ClientFailure.invalidServer.message; return }
        descriptor = nil
        descriptorData = nil
        selectedServer = nil
        run { [self] in
            let value = try await client.prepare(server: server)
            let data = try value.encoded()
            guard !Task.isCancelled else { return }
            descriptor = value
            descriptorData = data
            selectedServer = server
            serverInput = server.origin
            // A retained signed connection means the owner connected on purpose;
            // rejoin it after a relaunch without another click.
            if snapshot.pendingOpen || snapshot.needsReconnect {
                wantsConnection = true
                message = "Rejoining the retained Cosmos connection…"
            } else {
                message = Self.approveMessage
            }
        }
    }

    public func connect() {
        guard canConnect else { return }
        wantsConnection = true
        reconnectAttempt = 0
        reconnect?.cancel(); reconnect = nil
        run { [self] in
            try await client.connect()
            guard !Task.isCancelled else { return }
            if wantedVisible { try? await client.setVisible(true) }
            message = Self.connectedMessage
        }
    }

    nonisolated static let connectedMessage = "Cosmos confirmed the connection. Responses appear on an approved display; this panel is one while it is visible."
    nonisolated static let initialMessage = "Prepare this installation, then approve its public descriptor in Center."
    nonisolated static let approveMessage = "Approve this public descriptor in Center, then connect."

    /// A dropped room (network change, server restart) is rejoined without a
    /// click: bounded backoff, only after an explicit Connect and never over a
    /// pending or blocked operation.
    private func scheduleReconnect() {
        guard wantsConnection, reconnect == nil, !busy, descriptor != nil,
              snapshot.phase != .connected, snapshot.phase != .connecting, snapshot.phase != .blocked,
              !snapshot.hasPending, snapshot.needsReconnect || snapshot.pendingOpen else { return }
        let delay = reconnectDelays[min(reconnectAttempt, reconnectDelays.count - 1)]
        reconnectAttempt = min(reconnectAttempt + 1, reconnectDelays.count)
        message = snapshot.phase == .prepared
            ? "Rejoining the retained Cosmos connection…"
            : "The Cosmos connection dropped. Reconnecting…"
        reconnect = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            reconnect = nil
            guard wantsConnection, canConnect else { return }
            run {
                try await self.client.connect()
                guard !Task.isCancelled else { return }
                self.reconnectAttempt = 0
                if self.wantedVisible { try? await self.client.setVisible(true) }
                self.message = Self.connectedMessage
            }
        }
    }

    public func send() {
        guard canSend else { return }
        let text = draft
        pendingDraft = text
        admissionBeforeSend = snapshot.admission?.turnID
        run { [self] in
            _ = try await client.send(text: text)
            guard !Task.isCancelled else { return }
            if draft == text { draft = "" }
            pendingDraft = nil
            message = "Request admitted by Cosmos. The response appears on the approved display it selects."
        }
    }

    public func retryPending() {
        guard canRetryPending else { return }
        run { [self] in
            try await client.retryPending()
            guard !Task.isCancelled else { return }
            snapshot = client.snapshot
            if !snapshot.hasPending, snapshot.admission?.turnID != admissionBeforeSend,
               snapshot.admission != nil, let pendingDraft, draft == pendingDraft {
                draft = ""
                self.pendingDraft = nil
            }
            if let failure = snapshot.failure { message = failure.message }
            else if descriptor == nil {
                message = "Protected storage recovered. Prepare the installation again to continue."
            }
            else { message = snapshot.hasPending ? ClientFailure.uncertainRequest.message
                : "Cosmos confirmed the pending operation. Its exact request was reused." }
        }
    }

    public func cancel() {
        guard canCancel, let admission = snapshot.admission else { return }
        run { [self] in
            try await client.cancel(admission: admission)
            guard !Task.isCancelled else { return }
            message = "Cancellation admitted by Cosmos. Check Center for the cleared display."
        }
    }

    /// Disconnect may interrupt a UI operation. The bridge owns exact request recovery.
    public func disconnect() {
        guard canDisconnect else { return }
        wantsConnection = false
        reconnect?.cancel(); reconnect = nil
        operationGeneration &+= 1
        let generation = operationGeneration
        operation?.cancel()
        busy = true
        disconnectInFlight = true
        message = "Disconnecting the native session…"
        operation = Task { [weak self] in
            guard let self else { return }
            guard generation == operationGeneration, !Task.isCancelled else { return }
            await client.disconnect()
            guard generation == operationGeneration else { return }
            snapshot = client.snapshot
            busy = false
            disconnectInFlight = false
            if !snapshot.hasPending { pendingDraft = nil; admissionBeforeSend = nil }
            if let failure = snapshot.failure { message = failure.message }
            else if snapshot.hasPending { message = ClientFailure.uncertainRequest.message }
            else if [.disconnected, .prepared].contains(snapshot.phase) {
                message = "Session disconnected. Owner approval remains in Center."
            } else { message = "Disconnection could not be confirmed. Check the connection status before continuing." }
        }
    }

    /// The current card as delivered; nil once Cosmos retires it or the link drops.
    public var display: DisplayCard? { snapshot.display }

    /// The current spoken reply as delivered; nil once Cosmos retires it or the link drops.
    public var speech: SpeechReply? { snapshot.speech }

    /// Plays each delivered reply exactly once and acknowledges only complete playback.
    /// A retired or replaced reply stops immediately and is never acknowledged.
    private func syncPlayback() {
        let current = snapshot.speech
        if let playback, playback.reply != current {
            playback.stop()
            self.playback = nil
            speaking = false
        }
        if current == nil { loadingSpeech?.cancel(); loadingSpeech = nil }
        guard let reply = current, playback == nil, loadingSpeech == nil, spoken != reply.actionID else { return }
        loadingSpeech = Task { [weak self] in
            guard let self else { return }
            defer { loadingSpeech = nil }
            guard let audio = try? await client.speechAudio(for: reply), !Task.isCancelled,
                  snapshot.speech == reply, audio.count == reply.byteLength else { return }
            guard let playback = SpeechPlayback(reply: reply, audio: audio, onFinish: { [weak self] finished in
                Task { @MainActor [weak self] in self?.playbackFinished(reply, completed: finished) }
            }) else { return }
            self.playback = playback
            speaking = true
        }
    }

    private func playbackFinished(_ reply: SpeechReply, completed: Bool) {
        guard playback?.reply == reply else { return }
        playback = nil
        speaking = false
        guard completed, snapshot.speech == reply else { return }
        spoken = reply.actionID
        acknowledging?.cancel()
        acknowledging = Task { [weak self] in
            guard let self else { return }
            defer { acknowledging = nil }
            while busy, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(50)) }
            guard !Task.isCancelled, snapshot.speech == reply else { return }
            do { try await client.acknowledgeSpeech(reply) }
            catch { snapshot = client.snapshot }
        }
    }

    /// Report the panel's own visibility. Cosmos routes a shared card here only while
    /// this is true; it never treats the report as occupancy or identity.
    public func setVisible(_ visible: Bool) {
        if panelVisible != visible { panelVisible = visible }
        guard wantedVisible != visible else { return }
        wantedVisible = visible
        if !visible { acknowledging?.cancel(); acknowledging = nil }
        guard descriptor != nil, !busy else { return }
        Task { [client] in try? await client.setVisible(visible) }
    }

    /// Call only after the card's complete content, including every credit line, has
    /// been committed to the window. Each card is acknowledged at most once.
    public func displayCommitted(_ card: DisplayCard) {
        guard snapshot.display == card, acknowledged != card.actionID, acknowledging == nil else { return }
        acknowledging = Task { [weak self] in
            guard let self else { return }
            defer { acknowledging = nil }
            // Wait for any UI-initiated operation; acknowledgment never interrupts it.
            while busy, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(50)) }
            guard !Task.isCancelled, snapshot.display == card else { return }
            do {
                try await client.acknowledge(display: card)
                acknowledged = card.actionID
            } catch {
                snapshot = client.snapshot
            }
        }
    }

    public func publicDescriptorData() -> Data? { descriptorData }

    /// Stop any playback before the panel or controller goes away.
    public func stopPlayback() {
        loadingSpeech?.cancel(); loadingSpeech = nil
        playback?.stop(); playback = nil
        speaking = false
    }
    public func setShortcutMessage(_ text: String) { shortcutMessage = text }
    public func exportFailed() { message = "The public descriptor could not be saved. Choose another location and retry." }

    private func run(_ body: @escaping @MainActor () async throws -> Void) {
        operationGeneration &+= 1
        let generation = operationGeneration
        busy = true
        message = ""
        operation = Task { [weak self] in
            guard let self else { return }
            guard generation == operationGeneration, !Task.isCancelled else { return }
            do { try await body() }
            catch {
                guard generation == operationGeneration else { return }
                message = (error as? ClientFailure ?? .connectionUnavailable).message
            }
            guard generation == operationGeneration else { return }
            snapshot = client.snapshot
            busy = false
        }
    }
}

/// Owns one AVAudioPlayer for one reply. Finishing naturally reports completion; stop does not.
@MainActor
private final class SpeechPlayback: NSObject, AVAudioPlayerDelegate {
    let reply: SpeechReply
    private let player: AVAudioPlayer
    private var onFinish: ((Bool) -> Void)?

    init?(reply: SpeechReply, audio: Data, onFinish: @escaping (Bool) -> Void) {
        guard let player = try? AVAudioPlayer(data: audio, fileTypeHint: AVFileType.mp3.rawValue) else { return nil }
        self.reply = reply
        self.player = player
        self.onFinish = onFinish
        super.init()
        player.delegate = self
        guard player.prepareToPlay(), player.play() else { return nil }
    }

    func stop() {
        onFinish = nil
        player.stop()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            let finish = self.onFinish
            self.onFinish = nil
            finish?(flag)
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            let finish = self.onFinish
            self.onFinish = nil
            finish?(false)
        }
    }
}
