import Combine
import Foundation

@MainActor
public final class ClientModel: ObservableObject {
    @Published public var serverInput: String
    @Published public var draft = ""
    @Published public private(set) var snapshot: ClientSnapshot
    @Published public private(set) var descriptor: PublicDescriptor?
    @Published public private(set) var selectedServer: ServerEndpoint?
    @Published public private(set) var busy = false
    @Published public private(set) var message = "Prepare this installation, then approve its public descriptor in Center."
    @Published public private(set) var shortcutMessage = ""
    @Published private var disconnectInFlight = false

    private let client: any ClientBridge
    private var operation: Task<Void, Never>?
    private var operationGeneration: UInt64 = 0
    private var pendingDraft: String?
    private var admissionBeforeSend: UUID?
    private var descriptorData: Data?

    public init(client: any ClientBridge, initialServerOrigin: String) {
        self.client = client
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
        case .connected: return "Connected for public text"
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
            message = "Approve this public descriptor in Center, then connect."
        }
    }

    public func connect() {
        guard canConnect else { return }
        run { [self] in
            try await client.connect()
            guard !Task.isCancelled else { return }
            message = "Cosmos confirmed the connection. Responses appear on an approved Center display."
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
            message = "Request admitted by Cosmos. Check the approved Center display for its response."
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

    public func publicDescriptorData() -> Data? { descriptorData }
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
