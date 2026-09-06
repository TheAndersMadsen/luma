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
    case connect, sendText = "send_text", retryPending = "retry_pending", cancel, disconnect
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

    func enqueue(_ command: NativeCommand, text: String? = nil) throws {
        guard let handle else { throw ClientFailure.connectionUnavailable }
        let status: Int32
        switch command {
        case .connect: status = cosmos_surface_connect(handle)
        case .sendText:
            guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !text.contains("\0"),
                  text.utf8.count <= Int(COSMOS_SURFACE_MAX_TEXT_BYTES) else {
                throw ClientFailure.invalidText
            }
            status = Data(text.utf8).withUnsafeBytes { bytes in
                cosmos_surface_send_text(handle, bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count)
            }
        case .retryPending: status = cosmos_surface_retry_pending(handle)
        case .cancel: status = cosmos_surface_cancel(handle)
        case .disconnect: status = cosmos_surface_disconnect(handle)
        }
        guard status == COSMOS_SURFACE_OK else {
            throw status == COSMOS_SURFACE_QUEUE_FULL ? ClientFailure.busy : .connectionUnavailable
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
