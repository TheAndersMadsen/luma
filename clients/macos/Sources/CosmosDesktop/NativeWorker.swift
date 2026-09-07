import CCosmosSurface
import CosmosMac
import Foundation

private final class CallbackContext: @unchecked Sendable {
    let vault: KeychainVault
    let server: ServerEndpoint
    let descriptor: PublicDescriptor
    private let failureLock = NSLock()
    private var failure: ClientFailure?

    init(vault: KeychainVault, server: ServerEndpoint, descriptor: PublicDescriptor) {
        self.vault = vault
        self.server = server
        self.descriptor = descriptor
    }

    func record(_ error: Error, fallback: ClientFailure) {
        failureLock.lock()
        failure = error as? ClientFailure ?? fallback
        failureLock.unlock()
    }

    func takeFailure() -> ClientFailure? {
        failureLock.lock()
        defer { failureLock.unlock() }
        defer { failure = nil }
        return failure
    }
}

private func callbackContext(_ pointer: UnsafeMutableRawPointer?) -> CallbackContext? {
    guard let pointer else { return nil }
    return Unmanaged<CallbackContext>.fromOpaque(pointer).takeUnretainedValue()
}

private func copyCallbackData(_ data: Data, output: UnsafeMutablePointer<UInt8>?,
                              capacity: Int, written: UnsafeMutablePointer<Int>?) -> Int32 {
    guard let written else { return Int32(COSMOS_SURFACE_INVALID_ARGUMENT) }
    written.pointee = 0
    guard capacity >= data.count, let output else {
        return Int32(COSMOS_SURFACE_INVALID_ARGUMENT)
    }
    data.copyBytes(to: output, count: data.count)
    written.pointee = data.count
    return Int32(COSMOS_SURFACE_OK)
}

private let readPublicKey: CosmosSurfaceRead = { pointer, output, capacity, written in
    written?.pointee = 0
    guard let context = callbackContext(pointer) else {
        return Int32(COSMOS_SURFACE_INVALID_ARGUMENT)
    }
    do {
        try context.vault.requireReady()
        let encoded = context.descriptor.publicKey
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4)),
              data.count == 65, data.first == 4 else {
            throw ClientFailure.identityUnavailable
        }
        return copyCallbackData(data, output: output, capacity: capacity, written: written)
    } catch {
        context.record(error, fallback: .identityUnavailable)
        return Int32(COSMOS_SURFACE_UNAVAILABLE)
    }
}

private let signMessage: CosmosSurfaceSign = { pointer, message, length, output, capacity, written in
    written?.pointee = 0
    guard let context = callbackContext(pointer), let message, length > 0, length <= 2048 else {
        return Int32(COSMOS_SURFACE_INVALID_ARGUMENT)
    }
    do {
        // The vault hashes the full transcript exactly once and returns strict DER.
        let signature = try context.vault.sign(message: Data(bytes: message, count: length))
        guard !signature.isEmpty, signature.count <= 72 else { throw ClientFailure.identityUnavailable }
        return copyCallbackData(signature, output: output, capacity: capacity, written: written)
    } catch {
        context.record(error, fallback: .identityUnavailable)
        return Int32(COSMOS_SURFACE_UNAVAILABLE)
    }
}

private let readJournal: CosmosSurfaceRead = { pointer, output, capacity, written in
    written?.pointee = 0
    guard let context = callbackContext(pointer), written != nil else {
        return Int32(COSMOS_SURFACE_INVALID_ARGUMENT)
    }
    do {
        guard let data = try context.vault.readJournal(server: context.server) else {
            return Int32(COSMOS_SURFACE_CALLBACK_NOT_FOUND)
        }
        guard data.count <= Int(COSMOS_SURFACE_MAX_JOURNAL_BYTES) else {
            throw ClientFailure.storageBlocked
        }
        return copyCallbackData(data, output: output, capacity: capacity, written: written)
    } catch {
        context.record(error, fallback: .storageUnavailable)
        return Int32(COSMOS_SURFACE_UNAVAILABLE)
    }
}

private let writeJournal: CosmosSurfaceWrite = { pointer, bytes, length in
    guard let context = callbackContext(pointer), let bytes, length > 0,
          length <= Int(COSMOS_SURFACE_MAX_JOURNAL_BYTES) else {
        return Int32(COSMOS_SURFACE_INVALID_ARGUMENT)
    }
    do {
        try context.vault.writeJournal(Data(bytes: bytes, count: length), server: context.server)
        return Int32(COSMOS_SURFACE_OK)
    } catch {
        context.record(error, fallback: .storageBlocked)
        return Int32(COSMOS_SURFACE_UNAVAILABLE)
    }
}

enum NativeCommand: String, Sendable {
    case connect, sendText = "send_text", retryPending = "retry_pending", cancel
    case setVisible = "set_visible", acknowledge, acknowledgeSpeech = "acknowledge_speech", disconnect
    case acknowledgeTask = "acknowledge_task", report, progress, grant

    /// The operation name the library reports for this command's completion. A
    /// request with a destination or attached text is its own operation.
    func operation(for request: TextRequest?) -> String {
        guard self == .sendText, let request else { return rawValue }
        if request.context != nil { return "send_text_with_context" }
        if request.target != nil { return "send_text_to" }
        return rawValue
    }
}

/// Newer library calls, looked up by name once the library is loaded. A build of the
/// library without them leaves the matching feature reported as unavailable; the
/// app never substitutes the plain text call for a request that carries more.
enum OptionalSymbols {
    typealias SendTextTo = @convention(c) (
        OpaquePointer?, UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int
    ) -> Int32
    typealias SendTextWithContext = @convention(c) (
        OpaquePointer?, UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int,
        UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int
    ) -> Int32

    typealias Handle = @convention(c) (OpaquePointer?) -> Int32
    /// A report names the command it is about, so a task the runtime replaced
    /// between the snapshot and this call is refused instead of closed.
    typealias Report = @convention(c) (
        OpaquePointer?, UnsafePointer<UInt8>?, Int, UnsafePointer<UInt8>?, Int
    ) -> Int32
    typealias Progress = @convention(c) (OpaquePointer?, UInt32, Int64) -> Int32
    typealias Grant = @convention(c) (OpaquePointer?, Int32, UnsafePointer<UInt8>?, Int) -> Int32
    typealias Copy = @convention(c) (
        OpaquePointer?, UnsafeMutablePointer<UInt8>?, Int, UnsafeMutablePointer<Int>?
    ) -> Int32

    static let sendTextTo: SendTextTo? = resolve("cosmos_surface_send_text_to")
    static let sendTextWithContext: SendTextWithContext? = resolve("cosmos_surface_send_text_with_context")
    // The five device-action calls are looked up the same way and only ever
    // called through these pointers, so a library without them leaves the
    // feature reported as unavailable instead of failing to bind at first use.
    static let acknowledgeTask: Handle? = resolve("cosmos_surface_acknowledge_task")
    static let report: Report? = resolve("cosmos_surface_report")
    static let progress: Progress? = resolve("cosmos_surface_progress")
    static let grant: Grant? = resolve("cosmos_surface_grant")
    static let devicePolicy: Copy? = resolve("cosmos_surface_device_policy")

    static let capabilities = ClientCapabilities(
        targets: sendTextTo != nil, context: sendTextWithContext != nil,
        // All five, or none: this Mac must be able to read what the owner
        // allowed, acknowledge, report, stay live and answer a ceremony before
        // it carries anything out.
        actions: acknowledgeTask != nil && report != nil && progress != nil && grant != nil
            && devicePolicy != nil
    )

    private static func resolve<Function>(_ name: String) -> Function? {
        // RTLD_DEFAULT: the shared library is linked into this executable, so its
        // exports are in the default search scope without another dlopen.
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
        return unsafeBitCast(symbol, to: Function.self)
    }
}

/// All handle operations, including destruction, are serialized away from AppKit.
/// The C worker owns callbacks; this actor retains their context until destroy's
/// callback barrier completes. Callback-free cleanup can retain the native slot.
actor NativeWorker {
    private var handle: OpaquePointer?
    private var retainedContext: UnsafeMutableRawPointer?
    private var context: CallbackContext?

    func create(server: ServerEndpoint, epoch: UUID) throws -> PublicDescriptor {
        destroy()
        let vault = try KeychainVault.loadOrCreate()
        try vault.requireReady()
        let descriptor = vault.descriptor()
        let value = CallbackContext(vault: vault, server: server, descriptor: descriptor)
        let retained = Unmanaged.passRetained(value).toOpaque()
        var callbacks = CosmosSurfaceCallbacks(
            context: retained, public_key: readPublicKey, sign_sha256: signMessage,
            read_journal: readJournal, write_journal_atomically: writeJournal
        )
        struct Configuration: Encodable {
            let version = 1
            let serverOrigin: String
            let enrollmentId: String
            let platform = "macos"
            let bootEpoch: String
        }
        let config: Data
        do {
            config = try JSONEncoder().encode(Configuration(
                serverOrigin: server.origin, enrollmentId: descriptor.enrollmentID.uuidString.lowercased(),
                bootEpoch: epoch.uuidString.lowercased()
            ))
        } catch {
            Unmanaged<CallbackContext>.fromOpaque(retained).release()
            throw ClientFailure.invalidServer
        }
        var created: OpaquePointer?
        let status = config.withUnsafeBytes { bytes in
            cosmos_surface_create(bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count, &callbacks, &created)
        }
        guard status == COSMOS_SURFACE_OK, let created else {
            if let created { _ = cosmos_surface_destroy(created) }
            Unmanaged<CallbackContext>.fromOpaque(retained).release()
            throw status == COSMOS_SURFACE_QUEUE_FULL ? ClientFailure.busy : .connectionUnavailable
        }
        handle = created
        retainedContext = retained
        context = value
        return descriptor
    }

    func enqueue(_ command: NativeCommand, request: TextRequest? = nil, visible: Bool? = nil,
                 report: (actionID: UUID, body: Data)? = nil,
                 progress: (sequence: UInt32, elapsedMs: Int64)? = nil,
                 grant: (granted: Bool, attestation: Attestation?)? = nil) throws {
        guard let handle else { throw ClientFailure.connectionUnavailable }
        let status: Int32
        switch command {
        case .acknowledgeTask:
            guard let call = OptionalSymbols.acknowledgeTask else { throw ClientFailure.featureUnavailable }
            status = call(handle)
        case .report:
            guard let call = OptionalSymbols.report else { throw ClientFailure.featureUnavailable }
            guard let report, !report.body.isEmpty, report.body.count <= 16 * 1024 else {
                throw ClientFailure.invalidText
            }
            // The action id exactly as the snapshot spelled it: the runtime
            // refuses a report for anything but the command it currently holds.
            let action = Data(report.actionID.uuidString.lowercased().utf8)
            status = action.withUnsafeBytes { action in
                report.body.withUnsafeBytes { body in
                    call(handle, action.bindMemory(to: UInt8.self).baseAddress, action.count,
                         body.bindMemory(to: UInt8.self).baseAddress, body.count)
                }
            }
        case .progress:
            guard let call = OptionalSymbols.progress else { throw ClientFailure.featureUnavailable }
            guard let progress, (1...60).contains(progress.sequence), progress.elapsedMs >= 0 else {
                throw ClientFailure.invalidText
            }
            status = call(handle, progress.sequence, progress.elapsedMs)
        case .grant:
            guard let call = OptionalSymbols.grant else { throw ClientFailure.featureUnavailable }
            guard let grant else { throw ClientFailure.invalidResponse }
            // Granting without the evidence the ceremony asked for is not an
            // answer; declining carries none by definition.
            guard !grant.granted || grant.attestation != nil else { throw ClientFailure.invalidResponse }
            let attestation = Data((grant.attestation?.rawValue ?? "").utf8)
            let length = attestation.count
            status = (length == 0 ? Data([0]) : attestation).withUnsafeBytes { bytes in
                call(handle, grant.granted ? 1 : 0,
                     bytes.bindMemory(to: UInt8.self).baseAddress, length)
            }
        case .connect: status = cosmos_surface_connect(handle)
        case .setVisible:
            guard let visible else { throw ClientFailure.invalidResponse }
            status = cosmos_surface_set_visible(handle, visible ? 1 : 0)
        case .acknowledge: status = cosmos_surface_acknowledge(handle)
        case .acknowledgeSpeech: status = cosmos_surface_acknowledge_speech(handle)
        case .sendText:
            guard let request, !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !request.text.contains("\0"),
                  request.text.utf8.count <= Int(COSMOS_SURFACE_MAX_TEXT_BYTES) else {
                throw ClientFailure.invalidText
            }
            status = try Self.sendText(handle, request)
        case .retryPending: status = cosmos_surface_retry_pending(handle)
        case .cancel: status = cosmos_surface_cancel(handle)
        case .disconnect: status = cosmos_surface_disconnect(handle)
        }
        guard status == COSMOS_SURFACE_OK else {
            throw status == COSMOS_SURFACE_QUEUE_FULL ? ClientFailure.busy : .connectionUnavailable
        }
    }

    /// Plain text uses the original call. A destination needs send_text_to and
    /// attached context needs send_text_with_context; each is a distinct wire shape
    /// and a library without the call rejects the request rather than narrowing it.
    private static func sendText(_ handle: OpaquePointer, _ request: TextRequest) throws -> Int32 {
        let text = Data(request.text.utf8)
        // Empty byte strings still hand the C side a valid pointer with length 0.
        func bytes(_ value: String) -> Data { value.isEmpty ? Data([0]) : Data(value.utf8) }
        let targetText = request.target ?? ""
        guard targetText.isEmpty || TextRequest.targets.contains(targetText) else { throw ClientFailure.invalidText }
        let target = bytes(targetText)
        let targetLength = targetText.utf8.count
        if let context = request.context {
            guard let call = OptionalSymbols.sendTextWithContext else { throw ClientFailure.featureUnavailable }
            guard (1...ContextChip.maximumAppBytes).contains(context.app.utf8.count),
                  (1...ContextChip.maximumBytes).contains(context.text.utf8.count),
                  !context.app.contains("\0"), !context.text.contains("\0") else {
                throw ClientFailure.invalidText
            }
            let app = Data(context.app.utf8)
            let body = Data(context.text.utf8)
            return text.withUnsafeBytes { text in
                app.withUnsafeBytes { app in
                    body.withUnsafeBytes { body in
                        target.withUnsafeBytes { target in
                            call(handle,
                                 text.bindMemory(to: UInt8.self).baseAddress, text.count,
                                 app.bindMemory(to: UInt8.self).baseAddress, app.count,
                                 body.bindMemory(to: UInt8.self).baseAddress, body.count,
                                 target.bindMemory(to: UInt8.self).baseAddress, targetLength)
                        }
                    }
                }
            }
        }
        if request.target != nil {
            guard let call = OptionalSymbols.sendTextTo else { throw ClientFailure.featureUnavailable }
            return text.withUnsafeBytes { text in
                target.withUnsafeBytes { target in
                    call(handle, text.bindMemory(to: UInt8.self).baseAddress, text.count,
                         target.bindMemory(to: UInt8.self).baseAddress, targetLength)
                }
            }
        }
        return text.withUnsafeBytes { bytes in
            cosmos_surface_send_text(handle, bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count)
        }
    }

    func poll() throws -> [NativeEvent] {
        guard let handle else { return [] }
        var events: [NativeEvent] = []
        // A fixed per-poll budget prevents either the C queue or UI updates starving the app.
        for _ in 0..<16 {
            var bytes = [UInt8](repeating: 0, count: Int(COSMOS_SURFACE_MAX_EVENT_BYTES))
            var written = 0
            let status = cosmos_surface_poll(handle, &bytes, bytes.count, &written)
            if status == COSMOS_SURFACE_EMPTY { break }
            guard status == COSMOS_SURFACE_OK, written > 0, written <= bytes.count else {
                throw ClientFailure.invalidResponse
            }
            events.append(try NativeEvent.decode(Data(bytes.prefix(written))))
        }
        return events
    }

    /// The current spoken reply's exact bytes; the snapshot's byteLength bounds the copy.
    func speechAudio(expectedLength: Int) throws -> Data {
        guard let handle else { throw ClientFailure.connectionUnavailable }
        guard expectedLength > 0, expectedLength <= Int(COSMOS_SURFACE_MAX_SPEECH_BYTES) else {
            throw ClientFailure.invalidResponse
        }
        var bytes = [UInt8](repeating: 0, count: expectedLength)
        var written = 0
        let status = cosmos_surface_speech_audio(handle, &bytes, bytes.count, &written)
        guard status == COSMOS_SURFACE_OK, written == expectedLength else {
            throw status == COSMOS_SURFACE_EMPTY ? ClientFailure.connectionUnavailable : .invalidResponse
        }
        return Data(bytes)
    }

    /// The owner's own policy document for this installation, exactly as the
    /// snapshot named it. A build that cannot read one holds none, and holding
    /// none means this Mac carries nothing out.
    func devicePolicy(expectedLength: Int) throws -> Data {
        guard let handle, let call = OptionalSymbols.devicePolicy else {
            throw ClientFailure.featureUnavailable
        }
        guard expectedLength > 0, expectedLength <= Int(COSMOS_SURFACE_MAX_POLICY_BYTES) else {
            throw ClientFailure.invalidResponse
        }
        var bytes = [UInt8](repeating: 0, count: expectedLength)
        var written = 0
        let status = call(handle, &bytes, bytes.count, &written)
        guard status == COSMOS_SURFACE_OK, written == expectedLength else {
            throw status == COSMOS_SURFACE_EMPTY ? ClientFailure.connectionUnavailable : .invalidResponse
        }
        return Data(bytes)
    }

    func takeCallbackFailure() -> ClientFailure? { context?.takeFailure() }

    func retryStorageWrite() throws {
        let vault = try KeychainVault.loadOrCreate()
        try vault.retryPendingJournalWrite()
        try vault.requireReady()
        if let context { _ = try vault.readJournal(server: context.server) }
    }

    func destroy() {
        if let handle {
            self.handle = nil
            // After this barrier no key or journal callback can run. Callback-free
            // cleanup may continue; the native library stays loaded for app life.
            _ = cosmos_surface_destroy(handle)
        }
        if let retainedContext {
            Unmanaged<CallbackContext>.fromOpaque(retainedContext).release()
            self.retainedContext = nil
        }
        context = nil
    }
}
