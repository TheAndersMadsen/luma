import CosmosMac
import Foundation

@MainActor
final class RustSurfaceBridge: ClientBridge {
    private(set) var snapshot = ClientSnapshot() {
        didSet { onChange?(snapshot) }
    }
    var onChange: ((ClientSnapshot) -> Void)?
    let capabilities = OptionalSymbols.capabilities

    private let worker = NativeWorker()
    private let epoch: UUID
    private var server: ServerEndpoint?
    private var descriptor: PublicDescriptor?
    private var prepared = false
    private var busy = false
    private var disconnecting = false
    private var closing = false
    private var expectedOperation: String?
    private var completion: NativeEvent?
    private var poller: Task<Void, Never>?

    init(epoch: UUID) {
        self.epoch = epoch
        poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !self.closing else { return }
                if !self.busy { await self.pollIdle() }
                do { try await Task.sleep(for: .milliseconds(200)) }
                catch { return }
            }
        }
    }

    func prepare(server: ServerEndpoint) async throws -> PublicDescriptor {
        guard !busy, !disconnecting, !closing else { throw ClientFailure.busy }
        guard !snapshot.hasPending, !snapshot.pendingOpen, snapshot.phase != .connected else {
            throw ClientFailure.uncertainRequest
        }
        busy = true
        expectedOperation = "prepare"
        completion = nil
        prepared = false
        descriptor = nil
        self.server = server
        snapshot = ClientSnapshot(phase: .preparing)
        defer { finishOperation() }
        do {
            let local = try await worker.create(server: server, epoch: epoch)
            descriptor = local
            let event = try await awaitOutcome()
            guard let reported = try event.descriptor?.verified(), reported == local else {
                throw ClientFailure.invalidResponse
            }
            prepared = true
            snapshot.phase = .prepared
            // The selected HTTPS origin is public configuration, never a credential.
            UserDefaults.standard.set(server.origin, forKey: "CosmosServerOrigin")
            return local
        } catch {
            record(error)
            throw publicFailure(error)
        }
    }

    func connect() async throws {
        guard prepared, descriptor != nil, server != nil else { throw ClientFailure.approvalRequired }
        guard !snapshot.hasPending || snapshot.pendingOpen || snapshot.needsReconnect else {
            throw ClientFailure.uncertainRequest
        }
        _ = try await perform(.connect)
    }

    func send(_ request: TextRequest) async throws -> TextAdmission {
        guard snapshot.phase == .connected, !snapshot.needsReconnect else {
            throw ClientFailure.connectionUnavailable
        }
        guard !snapshot.hasPending, !snapshot.pendingOpen else { throw ClientFailure.uncertainRequest }
        guard ClientModel.validText(request.text) else { throw ClientFailure.invalidText }
        guard request.target == nil || capabilities.targets, request.context == nil || capabilities.context else {
            throw ClientFailure.featureUnavailable
        }
        let event = try await perform(.sendText, request: request)
        guard let admission = try event.admission?.verified() else {
            record(ClientFailure.invalidResponse)
            throw ClientFailure.invalidResponse
        }
        return admission
    }

    func retryPending() async throws {
        guard !busy, !disconnecting, !closing else { throw ClientFailure.busy }
        guard snapshot.canRetry else { throw ClientFailure.uncertainRequest }
        busy = true
        do {
            // A failed Keychain mutation is retried with its original bytes first.
            try await worker.retryStorageWrite()
            busy = false
            if !prepared {
                await worker.destroy()
                snapshot = ClientSnapshot(phase: .disconnected)
                return
            }
            guard !snapshot.needsReconnect, !snapshot.pendingOpen else {
                throw ClientFailure.connectionUnavailable
            }
            _ = try await perform(.retryPending)
        } catch {
            busy = false
            record(error)
            throw publicFailure(error)
        }
    }

    func cancel(admission: TextAdmission) async throws {
        guard snapshot.phase == .connected, !snapshot.hasPending, !snapshot.pendingOpen,
              !snapshot.needsReconnect,
              snapshot.admission?.turnID == admission.turnID,
              snapshot.admission?.generation == admission.generation else {
            throw ClientFailure.uncertainRequest
        }
        _ = try await perform(.cancel)
    }

    func setVisible(_ visible: Bool) async throws {
        guard prepared else { throw ClientFailure.approvalRequired }
        // Visibility is retained by the native worker while disconnected; a pending
        // request still blocks a new sequenced control on a live connection.
        if snapshot.phase == .connected, snapshot.hasPending || snapshot.pendingOpen { throw ClientFailure.uncertainRequest }
        _ = try await perform(.setVisible, visible: visible)
    }

    func acknowledge(display: DisplayCard) async throws {
        guard snapshot.phase == .connected, !snapshot.needsReconnect else {
            throw ClientFailure.connectionUnavailable
        }
        guard !snapshot.hasPending, !snapshot.pendingOpen else { throw ClientFailure.uncertainRequest }
        guard snapshot.display == display else { throw ClientFailure.connectionUnavailable }
        _ = try await perform(.acknowledge)
    }

    func speechAudio(for reply: SpeechReply) async throws -> Data {
        guard snapshot.phase == .connected, snapshot.speech == reply else { throw ClientFailure.connectionUnavailable }
        return try await worker.speechAudio(expectedLength: reply.byteLength)
    }

    func acknowledgeSpeech(_ reply: SpeechReply) async throws {
        guard snapshot.phase == .connected, !snapshot.needsReconnect else {
            throw ClientFailure.connectionUnavailable
        }
        guard !snapshot.hasPending, !snapshot.pendingOpen else { throw ClientFailure.uncertainRequest }
        guard snapshot.speech == reply else { throw ClientFailure.connectionUnavailable }
        _ = try await perform(.acknowledgeSpeech)
    }

    func acknowledgeTask(_ task: DeviceTask) async throws {
        try requireCurrent(task)
        _ = try await perform(.acknowledgeTask)
    }

    func report(_ report: ActionReport, for task: DeviceTask) async throws {
        try requireCurrent(task)
        _ = try await perform(.report, report: (task.actionID, report.encoded()))
    }

    func devicePolicy(_ held: HeldPolicy) async throws -> Data {
        guard capabilities.actions else { throw ClientFailure.featureUnavailable }
        guard snapshot.phase == .connected, snapshot.policy == held else {
            throw ClientFailure.connectionUnavailable
        }
        return try await worker.devicePolicy(expectedLength: held.byteLength)
    }

    func progress(sequence: UInt32, elapsedMs: Int64, for task: DeviceTask) async throws {
        try requireCurrent(task)
        _ = try await perform(.progress, progress: (sequence, elapsedMs))
    }

    func grant(_ granted: Bool, attestation: Attestation?, for confirmation: ConfirmationRequest) async throws {
        guard capabilities.actions else { throw ClientFailure.featureUnavailable }
        guard snapshot.phase == .connected, !snapshot.needsReconnect else {
            throw ClientFailure.connectionUnavailable
        }
        guard !snapshot.hasPending, !snapshot.pendingOpen else { throw ClientFailure.uncertainRequest }
        guard snapshot.confirmation?.grantID == confirmation.grantID else {
            throw ClientFailure.connectionUnavailable
        }
        _ = try await perform(.grant, grant: (granted, attestation))
    }

    /// Every task control names the task Cosmos currently has here. A control
    /// for anything else is not sent at all.
    private func requireCurrent(_ task: DeviceTask) throws {
        guard capabilities.actions else { throw ClientFailure.featureUnavailable }
        guard snapshot.phase == .connected, !snapshot.needsReconnect else {
            throw ClientFailure.connectionUnavailable
        }
        guard !snapshot.hasPending, !snapshot.pendingOpen else { throw ClientFailure.uncertainRequest }
        guard snapshot.task?.actionID == task.actionID else { throw ClientFailure.connectionUnavailable }
    }

    func disconnect() async {
        guard !closing, !disconnecting else { return }
        disconnecting = true
        snapshot.phase = .disconnecting
        defer { disconnecting = false }
        // Cancelling a Swift UI task does not cancel or forget an accepted C command.
        // Drain its bounded result before queuing the explicit disconnect behind it.
        while busy, !closing { await operationPause() }
        guard !closing else { return }
        do {
            _ = try await perform(.disconnect, allowDisconnect: true)
            snapshot.phase = .disconnected
        } catch {
            record(error)
        }
    }

    func shutdown() async {
        guard !closing else { return }
        closing = true
        poller?.cancel()
        poller = nil
        snapshot.phase = .disconnecting
        // NativeWorker serializes this callback barrier with every poll/enqueue.
        // Its context and the application's OS lease remain alive through it;
        // callback-free network cleanup may retain the process-wide native slot.
        await worker.destroy()
        snapshot.phase = .disconnected
        onChange = nil
    }

    private func perform(_ command: NativeCommand, request: TextRequest? = nil, visible: Bool? = nil,
                         report: (actionID: UUID, body: Data)? = nil,
                         progress: (sequence: UInt32, elapsedMs: Int64)? = nil,
                         grant: (granted: Bool, attestation: Attestation?)? = nil,
                         allowDisconnect: Bool = false) async throws -> NativeEvent {
        guard !busy, !closing, !disconnecting || allowDisconnect else { throw ClientFailure.busy }
        busy = true
        expectedOperation = command.operation(for: request)
        completion = nil
        if command == .connect { snapshot.phase = .connecting }
        snapshot.failure = nil
        defer { finishOperation() }
        do {
            try await worker.enqueue(command, request: request, visible: visible,
                                     report: report, progress: progress, grant: grant)
            return try await awaitOutcome()
        } catch {
            record(error)
            throw publicFailure(error)
        }
    }

    private func finishOperation() {
        expectedOperation = nil
        completion = nil
        busy = false
    }

    private func awaitOutcome() async throws -> NativeEvent {
        let deadline = ContinuousClock.now.advanced(by: .seconds(90))
        while !closing {
            for event in try await worker.poll() { try await consume(event) }
            if let completion {
                if completion.outcome == "error" {
                    throw snapshot.failure ?? completion.failure ?? .connectionUnavailable
                }
                return completion
            }
            guard ContinuousClock.now < deadline else {
                snapshot.hasPending = true
                snapshot.needsReconnect = true
                snapshot.canRetry = false
                throw ClientFailure.uncertainRequest
            }
            // A cancelled UI await still drains native completion. This delay does
            // not spin when its Swift caller has been cancelled by Disconnect.
            await operationPause()
        }
        throw ClientFailure.connectionUnavailable
    }

    private func pollIdle() async {
        do {
            for event in try await worker.poll() { try await consume(event) }
        } catch {
            if !closing { record(error) }
        }
    }

    private func consume(_ event: NativeEvent) async throws {
        guard !closing else { return }
        if let reported = try event.descriptor?.verified(), let descriptor, reported != descriptor {
            throw ClientFailure.invalidResponse
        }
        var failure = event.failure
        if failure != nil, let callbackFailure = await worker.takeCallbackFailure() {
            failure = callbackFailure
        }
        let storageBlocked = failure == .storageBlocked || failure == .storageUnavailable
        let pending = event.pending != nil || event.pendingOpen || storageBlocked
        if failure == .connectionUnavailable, pending { failure = .uncertainRequest }
        var phase: ClientPhase = event.connected ? .connected : (prepared ? .prepared : .disconnected)
        if event.operation == "prepare", event.outcome == "ok" { phase = .prepared }
        if let failure, [.identityUnavailable, .invalidResponse, .storageBlocked, .storageUnavailable].contains(failure) {
            phase = .blocked
        }
        if disconnecting { phase = .disconnecting }
        snapshot = ClientSnapshot(
            phase: phase, hasPending: pending,
            admission: try event.admission?.verified(), failure: failure,
            pendingOpen: event.pendingOpen,
            needsReconnect: event.needsReconnect,
            canRetry: storageBlocked || ((event.pending?.canRetry ?? false) && !event.needsReconnect),
            hasUnknownOutcome: event.lastUnknown != nil,
            visible: event.visible,
            display: event.connected ? event.display : nil,
            speech: event.connected ? try event.speech?.verified() : nil,
            waiting: event.connected ? try event.invitation?.verified() : nil,
            status: event.connected ? event.status : nil,
            task: event.connected ? event.task : nil,
            confirmation: event.connected ? event.confirmation : nil,
            revoked: event.connected ? event.revoked : nil,
            // The copy is dropped with the connection that carried it.
            policy: event.connected ? event.policy : nil
        )
        if event.operation == expectedOperation { completion = event }
    }

    private func record(_ error: Error) {
        guard !closing else { return }
        let failure = publicFailure(error)
        snapshot.failure = failure
        if failure == .storageBlocked || failure == .storageUnavailable {
            snapshot.hasPending = true
            snapshot.canRetry = true
            snapshot.phase = .blocked
        } else if failure == .invalidResponse || failure == .identityUnavailable {
            snapshot.phase = .blocked
        } else if snapshot.phase == .connecting || snapshot.phase == .preparing {
            snapshot.phase = prepared ? .prepared : .disconnected
        }
    }

    private func publicFailure(_ error: Error) -> ClientFailure {
        error as? ClientFailure ?? .connectionUnavailable
    }

    private func operationPause() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(100)) {
                continuation.resume()
            }
        }
    }
}
