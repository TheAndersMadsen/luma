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
            syncActions()
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

    // MARK: Listening for "Hey Cosmos"
    /// Where the always-listening path is. `off` until the owner turns it on,
    /// and off again the moment they turn it off, microphone and all.
    @Published public private(set) var listening: Listening.State = .off
    /// The capture the last spoken request came from, in the runtime's own
    /// terms: what this Mac attests about it and how long it held the
    /// microphone. Kept until the next request replaces it.
    @Published public private(set) var lastCapture: VoiceCapture?
    private let listener: (any WakeWordListening)?
    private let listeningStore: UserDefaults

    /// Where the current task stands on this Mac, in the shared vocabulary.
    @Published public private(set) var activity: TaskActivity = .none
    /// The command's own bounded output, shown as the device's bytes and never
    /// as Cosmos's claim about anything.
    @Published public private(set) var taskOutput: String?
    /// The owner's own name for the task the output belongs to.
    @Published public private(set) var taskLabel: String?
    /// Ticks once a second while a task or a ceremony is current, so the elapsed
    /// time and the countdown move without the rest of the panel redrawing.
    @Published public private(set) var clock: Int64 = ClientModel.nowMs()

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

    // MARK: Device actions
    private let executor = ActionExecutor()
    private let authenticator: any DeviceOwnerAuthenticating
    /// This installation's own copy of the owner's policy, as this connection
    /// delivered it. Nil means it holds none, which is an ordinary, calm state
    /// and means it may do nothing at all.
    private(set) var policy: DevicePolicy?
    /// The copy this model has already decided about, so a re-delivery of the
    /// same document is idempotent.
    private var policySeen: HeldPolicy?
    /// The surface and approval revision this connection's policy belongs to.
    /// A copy naming another is somebody else's permission.
    private var policyBinding: PolicyBinding?
    private var loadingPolicy: Task<Void, Never>?

    private struct PolicyBinding: Equatable {
        let surfaceID: UUID
        let approvalRevision: UInt64

        init(_ held: HeldPolicy) {
            surfaceID = held.surfaceID
            approvalRevision = held.approvalRevision
        }
    }
    /// The command being carried out here, and the clock its elapsed time and
    /// its progress messages both read. Starting or finishing one is what turns
    /// the panel's own clock on and off; no frame from Cosmos marks it.
    private var running: (task: DeviceTask, entry: CommandEntry, startedAtMs: Int64)? {
        didSet { syncTicker() }
    }
    private var carrying: Task<Void, Never>?
    private var progressing: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    private var boundTask: UUID?
    private var shownConfirmation: UUID?
    private var answeredConfirmation: UUID?
    private var handledRevoke: UUID?
    private var stoppedBy: RevokedTask.Reason?
    /// The actor evidence this Mac actually obtained, per action. A command is
    /// never spawned without evidence at least as strong as it demands.
    private var attestations: [UUID: Attestation] = [:]

    public init(client: any ClientBridge, initialServerOrigin: String,
                contextProvider: (any ContextProvider)? = nil,
                authenticator: (any DeviceOwnerAuthenticating)? = nil,
                listener: (any WakeWordListening)? = nil,
                listeningStore: UserDefaults = .standard,
                reconnectDelays: [Duration] = [.seconds(1.5), .seconds(3), .seconds(6), .seconds(12), .seconds(30)]) {
        self.client = client
        self.contextProvider = contextProvider ?? SystemContextProvider()
        self.authenticator = authenticator ?? DeviceOwnerAuthenticator()
        self.listener = listener
        self.listeningStore = listeningStore
        self.reconnectDelays = reconnectDelays
        serverInput = initialServerOrigin
        snapshot = client.snapshot
        client.onChange = { [weak self] value in self?.snapshot = value }
        self.listener?.onSignal = { [weak self] signal in self?.received(signal) }
    }

    /// The Mac's own listener, when this build of macOS has an on-device
    /// analyser to run it in. Nil is a fact the owner is told, not a crash, and
    /// it is what every test gets: a model built without one never opens a
    /// microphone.
    public static func systemListener() -> (any WakeWordListening)? {
        if #available(macOS 26, *) { return SpeechWakeWordListener() }
        return nil
    }

    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

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
        // A request that has left but has no status yet is still work in progress,
        // and so is a command actually running on this Mac.
        let working = snapshot.status?.state == .working || snapshot.status?.state == .acting
            || running != nil || (nowLine != nil && snapshot.status == nil)
        return PanelState.waveform(speaking: speaking, busy: busy, rejoining: rejoining,
                                   failed: snapshot.failure != nil, working: working)
    }
    /// Cosmos's report on the current turn in the panel's fixed words, while one is current.
    public var statusLine: StatusLine? { snapshot.status.map(PanelState.statusLine) }
    /// Which newer library calls this build can make; fixed for the process.
    public var capabilities: ClientCapabilities { client.capabilities }
    /// The quiet line under the header: "Reconnecting…", a fading "Connected",
    /// the one sentence for a Cosmos this Mac is too old to read, or nothing.
    public var connectionNote: String? {
        PanelState.statusNote(connectionStatus, justConnected: justConnected,
                              failure: snapshot.failure)
    }
    /// How many options the current choice list offers, or nil when there is none.
    public var choiceCount: Int? {
        if case .choices(_, let items)? = snapshot.display?.content { return items.count }
        return nil
    }
    /// A choice list on this Mac that the owner has not answered yet.
    public var awaitingChoice: Bool { choiceCount != nil }
    /// A reply landed on this Mac, the panel is not on screen, and this Mac has
    /// not shown or played it yet. It is waiting for the owner as surely as a
    /// question is. A reply already rendered here is not waiting for anyone.
    public var unshownReply: Bool {
        guard !panelVisible else { return false }
        if let card = snapshot.display, acknowledged != card.actionID { return true }
        if let reply = snapshot.speech, spoken != reply.actionID { return true }
        return false
    }
    /// What the menu-bar glyph shows without the panel being open. A ceremony or
    /// a task ready for this Mac is exactly what "waiting for you" means, and so
    /// is a reply that arrived while the panel was closed.
    public var presence: MenuPresence {
        let waitingHere = awaitingChoice || snapshot.confirmation != nil || activity == .ready
            || unshownReply
            || (snapshot.status?.state == .waiting && snapshot.status?.surfacePlatform == "macos")
        return PanelState.presence(phase: waveformPhase, waitingHere: waitingHere)
    }
    /// Whether Cosmos may read a selection at all on this Mac.
    public var canReadSelection: Bool { capabilities.context && contextProvider.canReadSelection }
    /// The one notice the panel may show: what happened, and what to do about
    /// it. A permission the owner can grant right now outranks everything else.
    public var notice: Notice? {
        if accessibilityBlocked {
            return Notice(happened: Words.accessibilityOff, next: Words.accessibilityAction,
                          detail: Self.accessibilityDetail)
        }
        return PanelState.notice(failure: snapshot.failure, hasPending: snapshot.hasPending,
                                 retained: snapshot.needsReconnect || snapshot.pendingOpen,
                                 rejoining: rejoining, message: message, stage: stage)
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

    // MARK: Listening for "Hey Cosmos"

    /// The owner's remembered switch. Absent means off: nothing on this Mac
    /// opens a microphone until they say so, and it stays on across launches
    /// once they have.
    public static let listeningKey = "CosmosListenForHeyCosmos"

    public var listeningRemembered: Bool { listeningStore.bool(forKey: Self.listeningKey) }
    /// True while the microphone is open, whatever else is on screen.
    public var listeningOpen: Bool { listening.isOpen }
    /// True only while this Mac is recording the request that followed the
    /// phrase. The panel's second indicator is exactly this.
    public var capturingRequest: Bool { listening.isCapturing }

    /// What the panel shows for the listener, or nil when it is off. The
    /// blocked cases carry the sentence and the thing to do about it.
    public var listeningLine: StatusLine? {
        switch listening {
        case .off: nil
        case .starting: StatusLine(title: Words.listening, detail: Words.listeningStarting)
        case .listening: StatusLine(title: Words.listening, detail: Words.listeningForPhrase)
        case .heard, .capturing: StatusLine(title: Words.heardPhrase, detail: Words.listeningToRequest)
        case .sending: StatusLine(title: Words.working)
        case .blocked(let blocker):
            StatusLine(title: Words.listeningBlocked(blocker), detail: Words.listeningBlockedNext(blocker))
        }
    }

    /// Turning it on asks for the microphone at that instant and never before.
    /// Turning it off stops the audio stream itself, so this is the mute too.
    public func setListening(_ on: Bool) {
        listeningStore.set(on, forKey: Self.listeningKey)
        apply(on ? .turnOn : .turnOff)
        guard let listener else {
            if on { apply(.blocked(.systemTooOld)) }
            return
        }
        if on { listener.start() } else { listener.stop() }
    }

    public func toggleListening() { setListening(!listening.isOn) }

    /// Closes the microphone without changing the owner's switch: the
    /// application is going away, it was not told to stop listening.
    public func suspendListening() {
        listener?.stop()
        apply(.turnOff)
    }

    /// Puts the owner's remembered switch back at launch. Called once.
    public func resumeListening() {
        guard listeningRemembered, listening == .off else { return }
        setListening(true)
    }

    private func received(_ signal: WakeWordSignal) {
        switch signal {
        case .started: apply(.started)
        case .blocked(let blocker): apply(.blocked(blocker))
        case .cleared: apply(.cleared)
        case .heardPhrase: apply(.heardPhrase)
        case .captureBegan: apply(.captureBegan)
        case .captureExpired: apply(.captureExpired)
        case .captured(let request): sendSpoken(request)
        }
    }

    private func apply(_ event: Listening.Event) {
        guard let next = Listening.next(listening, on: event) else { return }
        listening = next
    }

    /// A request that began with the phrase rather than a press.
    ///
    /// It is admitted exactly like a typed one — the same call, the same Now
    /// line, the same single request in flight — and the capture it came from
    /// is kept beside it, attested as having begun with the phrase.
    public func sendSpoken(_ request: SpokenRequest) {
        apply(.captured)
        guard Self.validText(request.text), canSubmit else {
            apply(.sendFailed)
            // Whichever it was, what was said is gone: this Mac holds no audio
            // and no transcript once a capture closes.
            if !canSubmit {
                message = snapshot.phase == .connected
                    ? Self.spokenBusyMessage
                    : Self.spokenUnavailableMessage
            }
            return
        }
        lastCapture = request.capture
        let value = TextRequest(text: request.text)
        pendingDraft = value.text
        admissionBeforeSend = snapshot.admission?.turnID
        nowLine = value.text
        clearFinishedTask()
        run { [self] in
            do {
                _ = try await client.send(value)
                guard !Task.isCancelled else { return }
                pendingDraft = nil
                apply(.sent)
                message = Self.admittedMessage(context: nil, destination: .thisMac)
            } catch {
                apply(.sendFailed)
                throw error
            }
        }
    }

    nonisolated static let spokenUnavailableMessage =
        "Cosmos wasn't connected, so what you said was not sent. It was not kept either."
    nonisolated static let spokenBusyMessage =
        "Cosmos was still on your last request, so what you said was not sent. It was not kept either."

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
        clearFinishedTask()
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
        clearFinishedTask()
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

    // MARK: Device actions

    /// The task card as the panel draws it, or nil when there is nothing to say.
    public var taskCard: TaskCardModel? { TaskCard.card(activity, now: clock) }
    /// The ceremony this Mac is the venue for, if one is on screen.
    public var ceremony: CeremonyCardModel? {
        guard let request = snapshot.confirmation else { return nil }
        return TaskCard.ceremony(request, now: clock, blocked: ceremonyBlocked(request))
    }
    /// A running command this Mac can stop. Closing the panel does not.
    public var canCancelTask: Bool { running != nil }

    /// Holds exactly what the owner allowed on this connection, and nothing
    /// while there is no connection.
    ///
    /// The snapshot names the copy; the bytes are read out of the library and
    /// verified here against that digest, that surface and that approval
    /// revision. A document this Mac will not act on leaves it holding nothing
    /// rather than half a permission.
    private func syncPolicy() {
        guard snapshot.phase == .connected, let held = snapshot.policy else {
            dropPolicy(refused: false)
            return
        }
        // This exact copy was already decided about; re-delivery changes nothing.
        guard policySeen != held else { return }
        policySeen = held
        let binding = PolicyBinding(held)
        guard policyBinding == nil || policyBinding == binding else {
            // A copy for another surface or another approval is not this
            // connection's permission, whatever the snapshot said.
            dropPolicy(refused: true)
            return
        }
        loadingPolicy = Task { [weak self] in await self?.holdPolicy(held, binding: binding) }
    }

    private func holdPolicy(_ held: HeldPolicy, binding: PolicyBinding) async {
        let bytes = try? await client.devicePolicy(held)
        // A copy that was replaced while it was being read is not this one.
        guard policySeen == held else { return }
        guard let bytes, let delivered = DevicePolicy.decode(bytes, held: held) else {
            dropPolicy(refused: bytes != nil)
            return
        }
        policy = delivered
        policyBinding = binding
    }

    /// Holding nothing is an ordinary state: this Mac then carries nothing out.
    /// A refusal keeps what was seen, so the same bad copy is not read again; a
    /// connection that ends takes its copy and its binding with it.
    private func dropPolicy(refused: Bool) {
        policy = nil
        guard !refused else { return }
        policySeen = nil
        policyBinding = nil
        loadingPolicy?.cancel()
        loadingPolicy = nil
    }

    /// Why this Mac could not ask for the evidence the ceremony needs, if it
    /// cannot. An unsigned development build reads as a sentence, not a crash.
    private func ceremonyBlocked(_ request: ConfirmationRequest) -> String? {
        guard capabilities.actions else { return Words.actionsUnavailable }
        guard request.attestation == .deviceOwnerAuth else { return nil }
        return authenticator.unavailable
    }

    private func syncActions() {
        // What the owner allowed is settled before anything is decided with it.
        syncPolicy()
        syncConfirmation()
        syncRevocation()
        syncInvitation()
        syncTask()
        syncTicker()
    }

    private func syncConfirmation() {
        guard let request = snapshot.confirmation else {
            if let shown = shownConfirmation, answeredConfirmation != shown, activity == .confirming {
                // The ceremony went away unanswered: the grant expired, which
                // denies by fail-safe default.
                activity = .notDone(happened: Words.ceremonyExpired, next: Words.taskNothingMore)
            }
            shownConfirmation = nil
            return
        }
        guard shownConfirmation != request.grantID else { return }
        shownConfirmation = request.grantID
        answeredConfirmation = nil
        taskOutput = nil
        activity = .confirming
    }

    private func syncRevocation() {
        guard let revoked = snapshot.revoked, handledRevoke != revoked.actionID else { return }
        handledRevoke = revoked.actionID
        guard let running, running.task.actionID == revoked.actionID else {
            // Nothing had started, so nothing has to stop; the owner still reads
            // why the task went away.
            if boundTask == revoked.actionID || shownConfirmation != nil {
                activity = TaskCard.revoked(revoked.reason, label: snapshot.task?.operation.label ?? Words.appName)
            }
            return
        }
        stoppedBy = revoked.reason
        executor.stop()
    }

    /// A task Cosmos is holding for this Mac until its unlocked foreground
    /// reports visible. It carries no content, only the fact that one waits.
    private func syncInvitation() {
        guard snapshot.task == nil, snapshot.confirmation == nil else { return }
        if snapshot.waiting?.kind == .task {
            if activity == .none { activity = .ready }
        } else if activity == .ready, running == nil {
            activity = .none
        }
    }

    private func syncTask() {
        guard let task = snapshot.task else { return }
        guard boundTask != task.actionID else { return }
        boundTask = task.actionID
        carrying?.cancel()
        carrying = Task { [weak self] in await self?.carryOut(task) }
    }

    /// One task, from binding to report. Nothing is acknowledged that this Mac
    /// will not attempt, and nothing is reported that it did not observe.
    private func carryOut(_ task: DeviceTask) async {
        taskOutput = nil
        taskLabel = task.operation.label
        // Without the four newer library calls this Mac cannot acknowledge,
        // report or answer anything. It refuses here, loudly and locally,
        // instead of running a command it could never account for.
        guard capabilities.actions else {
            activity = .notDone(happened: Words.actionsUnavailable, next: Words.actionsUnavailableDetail)
            return
        }
        // A repeat of the same command produces no second effect: the report the
        // first one produced is sent again and nothing runs.
        if let earlier = executor.report(forKey: task.idempotencyKey, now: Self.nowMs()) {
            await send(earlier, for: task)
            activity = Self.activity(for: earlier, task: task)
            return
        }
        // The owner's copy is what this command is checked against, so a task
        // that arrives with one still being read waits for it.
        await loadingPolicy?.value
        guard let policy else { await refuse(.notPermitted, for: task); return }
        let planned: PlannedAction
        switch policy.plan(task.operation) {
        case .failure(let reason):
            await refuse(reason, for: task)
            return
        case .success(let value):
            planned = value
        }
        // The actor rule, checked before anything is spawned: a command that
        // changes files needs device-owner authentication obtained at this Mac.
        if planned.isRun,
           !ActorAttestation.permitsRun(mutates: task.operation.mutates,
                                        held: attestations[task.actionID]) {
            await refuse(.noAttestation, for: task)
            return
        }
        await deliver { [client] in try await client.acknowledgeTask(task) }
        switch planned {
        case .run(let entry):
            await execute(entry, for: task)
        default:
            let report = executor.open(planned)
            await send(report, for: task)
            activity = Self.activity(for: report, task: task)
        }
    }

    private func execute(_ entry: CommandEntry, for task: DeviceTask) async {
        let startedAt = Self.nowMs()
        switch executor.start(entry) {
        case .failure(let reason):
            await refuse(reason, for: task)
            return
        case .success:
            break
        }
        stoppedBy = nil
        running = (task, entry, startedAt)
        activity = .working(label: entry.label, startedAtMs: startedAt, cancellable: true)
        startProgress(for: task, startedAt: startedAt)
        let report = await executor.finish(entry)
        progressing?.cancel()
        progressing = nil
        running = nil
        await send(report, for: task)
        if case .command(_, let exitCode, let durationMs, _, _) = report.evidence {
            if let reason = stoppedBy {
                activity = TaskCard.revoked(reason, label: entry.label)
            } else {
                activity = TaskCard.finished(label: entry.label, exitCode: exitCode, durationMs: durationMs)
            }
        } else {
            activity = Self.activity(for: report, task: task)
        }
        stoppedBy = nil
        taskOutput = report.output
    }

    /// Liveness while a command runs: one message every ten seconds, at most
    /// sixty, off the ordered path. It renews the deadline and claims nothing.
    private func startProgress(for task: DeviceTask, startedAt: Int64) {
        progressing?.cancel()
        progressing = Task { [weak self] in
            var sequence: UInt32 = 0
            while !Task.isCancelled, sequence < 60 {
                try? await Task.sleep(for: .seconds(10))
                guard let self, !Task.isCancelled, running?.task.actionID == task.actionID else { return }
                sequence += 1
                let elapsed = Self.nowMs() - startedAt
                await deliver { [client = self.client] in
                    try await client.progress(sequence: sequence, elapsedMs: elapsed, for: task)
                }
            }
        }
    }

    /// A new request starts a new turn, so a settled task's card makes way for
    /// it. A running one, or a ceremony, is left exactly where it is.
    private func clearFinishedTask() {
        guard running == nil, snapshot.confirmation == nil, activity != .confirming else { return }
        activity = .none
        taskOutput = nil
        taskLabel = nil
    }

    /// The owner stopping the task at this Mac. It needs no new authority: this
    /// installation stops its own work and says it stopped it.
    public func cancelTask() {
        guard running != nil else { return }
        stoppedBy = .cancelled
        executor.stop()
    }

    /// Answers the ceremony. Only a deliberate press reaches here; dismissing
    /// the panel answers nothing at all and lets the grant expire.
    public func answerCeremony(granted: Bool) {
        guard let request = snapshot.confirmation, answeredConfirmation != request.grantID else { return }
        guard capabilities.actions else {
            activity = .notDone(happened: Words.actionsUnavailable, next: Words.actionsUnavailableDetail)
            return
        }
        guard granted else {
            answeredConfirmation = request.grantID
            activity = .notDone(happened: Words.ceremonyDeclined, next: Words.taskNothingMore)
            let client = client
            Task { [weak self] in
                await self?.deliver {
                    try await client.grant(false, attestation: nil, for: request)
                }
            }
            return
        }
        Task { [weak self] in await self?.confirm(request) }
    }

    private func confirm(_ request: ConfirmationRequest) async {
        if let blocked = ceremonyBlocked(request) {
            // Nothing is answered: an unanswerable ceremony expires, which denies.
            activity = .notDone(happened: blocked, next: Words.attestationNext)
            return
        }
        var obtained = Attestation.foregroundTap
        if request.attestation == .deviceOwnerAuth {
            let reason = Words.ceremonyQuestion(verb: request.description.verb,
                                                subject: request.description.subject,
                                                effect: request.description.effect)
            guard await authenticator.authenticate(reason: reason) else {
                activity = .notDone(happened: Words.attestationRefused, next: Words.attestationNext)
                return
            }
            obtained = .deviceOwnerAuth
        }
        guard ActorAttestation.satisfies(obtained, required: request.attestation) else {
            activity = .notDone(happened: Words.attestationUnavailable, next: Words.attestationNext)
            return
        }
        answeredConfirmation = request.grantID
        attestations[request.actionID] = obtained
        activity = .ready
        await deliver { [client] in
            try await client.grant(true, attestation: obtained, for: request)
        }
    }

    private func refuse(_ reason: ActionRefusal, for task: DeviceTask) async {
        let report = ActionReport.refusal(reason)
        await send(report, for: task)
        activity = TaskCard.refusal(reason)
    }

    /// Exactly one report per task, remembered so a repeat of the same command
    /// re-sends it rather than doing anything again.
    private func send(_ report: ActionReport, for task: DeviceTask) async {
        executor.remember(report, forKey: task.idempotencyKey, now: Self.nowMs())
        await deliver { [client] in try await client.report(report, for: task) }
    }

    static func activity(for report: ActionReport, task: DeviceTask) -> TaskActivity {
        switch report.outcome {
        case .completed:
            return .completed(sentence: Words.openedTask(task.operation.label), detail: nil)
        case .refused:
            if case .declined(let reason) = report.evidence { return TaskCard.refusal(reason) }
            return TaskCard.refusal(.notPermitted)
        case .failed:
            return .notDone(happened: Words.refusalHappened(.noHandler), next: Words.refusalNext(.noHandler))
        case .cancelled:
            return .notDone(happened: Words.taskStopped(task.operation.label), next: Words.taskStoppedByYou)
        case .unknown:
            return .cannotConfirm
        }
    }

    /// One second at a time, only while something is actually moving. A quiet
    /// panel never redraws.
    private func syncTicker() {
        let wanted = running != nil || snapshot.confirmation != nil
        guard wanted else { ticker?.cancel(); ticker = nil; return }
        guard ticker == nil else { return }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                clock = Self.nowMs()
                if running == nil, snapshot.confirmation == nil { ticker = nil; return }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    /// Sends one control, waiting out any operation the panel started. A
    /// refusal, a report or a grant is never dropped because something else was
    /// in flight.
    private func deliver(_ body: @escaping @MainActor () async throws -> Void) async {
        for _ in 0..<100 {
            while busy, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(50)) }
            guard !Task.isCancelled else { return }
            do {
                try await body()
                return
            } catch ClientFailure.busy {
                try? await Task.sleep(for: .milliseconds(100))
            } catch {
                snapshot = client.snapshot
                return
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
