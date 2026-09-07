import AVFoundation
import Combine
import Foundation

@MainActor
public final class ClientModel: ObservableObject {
    @Published public var serverInput: String
    @Published public var draft = ""
    /// Where the next request asks to continue. Sent as a plain kind of device;
    /// Cosmos decides whether any such display gets the reply. Resets after a send.
    @Published public var destination: Destination = .thisMac
    /// Text the owner attached to the next request through an explicit action.
    @Published public private(set) var context: ContextChip?
    @Published public private(set) var snapshot: ClientSnapshot {
        didSet {
            // A reply that arrived on this Mac says more than the question does.
            if snapshot.display != nil || snapshot.speech != nil { nowLine = nil }
            syncPlayback()
            scheduleReconnect()
        }
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
    /// The request the owner just sent, shown as the Now line the moment they send it
    /// and cleared once a reply lands on this Mac. It is what they typed, verbatim.
    @Published public private(set) var nowLine: String?
    /// True for a moment after a connection is confirmed, so "Connected" can appear
    /// and then fade instead of standing there forever.
    @Published public private(set) var justConnected = false
    /// True when the last capture failed only because Accessibility is off, so the
    /// panel can offer the one button that fixes it.
    @Published public private(set) var accessibilityBlocked = false
    private var connectedNote: Task<Void, Never>?

    private let client: any ClientBridge
    private let contextProvider: any ContextProvider
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
                contextProvider: (any ContextProvider)? = nil,
                reconnectDelays: [Duration] = [.seconds(1.5), .seconds(3), .seconds(6), .seconds(12), .seconds(30)]) {
        self.client = client
        self.contextProvider = contextProvider ?? SystemContextProvider()
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
    /// Everything a request needs except its text: one connected room, nothing in
    /// flight and no unresolved operation.
    public var canSubmit: Bool {
        !busy && !snapshot.hasPending && !snapshot.pendingOpen && !snapshot.needsReconnect
            && snapshot.phase == .connected
    }
    public var canSend: Bool { canSubmit && Self.validText(draft) }
    /// A request is on the wire right now: the send control says so, and nothing
    /// the owner can press starts a second one.
    public var sending: Bool { busy && pendingDraft != nil }
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
        PanelState.stage(hasDescriptor: descriptor != nil, phase: snapshot.phase, rejoining: rejoining,
                         retained: snapshot.needsReconnect || snapshot.pendingOpen)
    }
    public var connectionStatus: ConnectionStatus {
        if disconnectInFlight { return .disconnecting }
        return PanelState.status(phase: snapshot.phase, rejoining: rejoining)
    }
    public var waveformPhase: CosmosPhase {
        // A request that has left but has no status yet is still work in progress.
        let working = snapshot.status?.state == .working || (nowLine != nil && snapshot.status == nil)
        return PanelState.waveform(speaking: speaking, busy: busy, rejoining: rejoining,
                                   failed: snapshot.failure != nil, working: working)
    }
    /// Cosmos's report on the current turn in the panel's fixed words, while one is current.
    public var statusLine: StatusLine? { snapshot.status.map(PanelState.statusLine) }
    /// Which newer library calls this build can make; fixed for the process.
    public var capabilities: ClientCapabilities { client.capabilities }
    /// The quiet line under the header: "Reconnecting…", a fading "Connected", or nothing.
    public var connectionNote: String? {
        PanelState.connectionNote(connectionStatus, justConnected: justConnected)
    }
    /// How many options the current choice list offers, or nil when there is none.
    public var choiceCount: Int? {
        if case .choices(_, let items)? = snapshot.display?.content { return items.count }
        return nil
    }
    /// A choice list on this Mac that the owner has not answered yet.
    public var awaitingChoice: Bool { choiceCount != nil }
    /// What the menu-bar glyph shows without the panel being open.
    public var presence: MenuPresence {
        let waitingHere = awaitingChoice
            || (snapshot.status?.state == .waiting && snapshot.status?.surfacePlatform == "macos")
        return PanelState.presence(phase: waveformPhase, waitingHere: waitingHere)
    }
    /// Whether Cosmos may read a selection at all on this Mac.
    public var canReadSelection: Bool { capabilities.context && contextProvider.canReadSelection }
    /// The panel's own notice for the current message: what happened, what to do.
    public var notice: Notice? {
        if accessibilityBlocked {
            return Notice(happened: Words.accessibilityOff, next: Words.accessibilityAction,
                          detail: Self.accessibilityDetail)
        }
        return PanelState.notice(message)
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
            noteConnected()
        }
    }

    /// "Connected" stands for a moment and then fades; a settled connection says
    /// nothing at all, which is what quiet presence means.
    private func noteConnected() {
        justConnected = true
        connectedNote?.cancel()
        connectedNote = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            guard let self, !Task.isCancelled else { return }
            justConnected = false
            connectedNote = nil
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
                self.noteConnected()
            }
        }
    }

    public func send() {
        guard canSend else { return }
        // A destination or attached text is never dropped silently: without the
        // library call that carries it, the request is not sent at all.
        if destination.target != nil, !capabilities.targets { message = Self.targetsUnavailableMessage; return }
        if context != nil, !capabilities.context { message = Self.contextUnavailableMessage; return }
        let request = TextRequest(text: draft, context: context, target: destination.target)
        let requested = destination
        pendingDraft = request.text
        admissionBeforeSend = snapshot.admission?.turnID
        // Acknowledge the click before the wire does: the typed line is the Now line
        // from this instant, and the send control says it is in flight.
        nowLine = request.text.trimmingCharacters(in: .whitespacesAndNewlines)
        run { [self] in
            _ = try await client.send(request)
            guard !Task.isCancelled else { return }
            if draft == request.text { draft = "" }
            if context == request.context { context = nil }
            if destination == requested { destination = .thisMac }
            pendingDraft = nil
            message = Self.admittedMessage(context: request.context, destination: requested)
        }
    }

    /// Picks one option from the current choices card. The client sends the item's
    /// title as the next request, exactly as the TV and the phone do; the numbering
    /// and its meaning belong to the runtime.
    @discardableResult
    public func choose(_ index: Int) -> Bool {
        guard case .choices(_, let items)? = snapshot.display?.content,
              items.indices.contains(index), canSubmit else { return false }
        let title = items[index].title
        guard Self.validText(title) else { return false }
        let request = TextRequest(text: title)
        pendingDraft = title
        admissionBeforeSend = snapshot.admission?.turnID
        nowLine = title
        run { [self] in
            _ = try await client.send(request)
            guard !Task.isCancelled else { return }
            pendingDraft = nil
            message = Self.admittedMessage(context: nil, destination: .thisMac)
        }
        return true
    }

    /// A plain request needs no notice: the Now line and the state above it already
    /// say Cosmos has it. Only an attached selection or another destination adds
    /// something the owner cannot see for themselves.
    nonisolated static func admittedMessage(context: ContextChip?, destination: Destination) -> String {
        if let context {
            return "Cosmos has your request with your \(context.source.label.lowercased()) from \(context.app). The reply stays on this Mac."
        }
        if destination != .thisMac {
            return "Cosmos has your request, to continue on \(destination.label)."
        }
        return ""
    }

    nonisolated static let targetsUnavailableMessage =
        "Continuing on another device is not available in this build of Cosmos. The request was not sent; choose This Mac to send it."
    nonisolated static let contextUnavailableMessage =
        "Attaching selected or clipboard text is not available in this build of Cosmos."
    /// One sentence on what happened and one on what to do; the panel puts the button
    /// that opens the pane next to it. The application's own path is technical detail
    /// and lives behind Details.
    nonisolated static let accessibilityMessage = "\(Words.accessibilityOff) \(Words.accessibilityAction)"
    nonisolated static var accessibilityDetail: String {
        "Add Cosmos with the + button in that pane. This build is at \(Bundle.main.bundleURL.path)."
    }

    /// Reads the selection from the application the owner was using. Only this
    /// explicit action reads another application, and only through Accessibility.
    public func useSelection() {
        guard capabilities.context else { message = Self.contextUnavailableMessage; return }
        attach(contextProvider.selectedText(), source: .selection)
    }

    /// Reads the pasteboard. Only this explicit action ever does.
    public func useClipboard() {
        guard capabilities.context else { message = Self.contextUnavailableMessage; return }
        attach(contextProvider.clipboardText(), source: .clipboard)
    }

    public func clearContext() { context = nil }

    private func attach(_ capture: ContextCapture, source: ContextSource) {
        accessibilityBlocked = false
        switch capture {
        case .text(let app, let text):
            guard let chip = ContextChip(source: source, app: app, text: text) else {
                message = source == .selection ? "The selection in \(app) holds no text." : "The clipboard holds no text."
                return
            }
            context = chip
            message = chip.truncated
                ? "Using the first \(ContextChip.formatBytes(ContextChip.maximumBytes)) of the \(source.label.lowercased()) from \(app)."
                : ""
        case .empty(let app):
            message = source == .selection
                ? "No selected text was found in \(app). Select text there, or use the clipboard instead."
                : "The clipboard holds no text."
        case .noApplication:
            message = "Switch to the app with the text you want, then come back and use its selection."
        case .permissionMissing:
            accessibilityBlocked = true
            message = Self.accessibilityMessage
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
        connectedNote?.cancel(); connectedNote = nil
        justConnected = false
        nowLine = nil
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
        accessibilityBlocked = false
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
