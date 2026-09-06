import CosmosMac
import Foundation

/// Decode only bounded, presentation-safe FFI state. Request bodies and credentials
/// are never part of this interface or retained by the application model.
struct NativeEvent: Decodable, Sendable {
    struct Descriptor: Decodable, Sendable {
        let enrollmentId: UUID
        let publicKey: String
        let platform: String
        let approval: String

        func verified() throws -> PublicDescriptor {
            guard platform == "macos", approval == "native-shared-text-v1" else {
                throw ClientFailure.invalidResponse
            }
            return try PublicDescriptor(enrollmentID: enrollmentId, publicKey: publicKey)
        }
    }

    struct Pending: Decodable, Sendable {
        let kind: String
        let instanceId: UUID
        let sequence: UInt64
        let canRetry: Bool

        func validate() throws {
            guard ["text", "heartbeat", "cancel"].contains(kind),
                  instanceId != Self.nilUUID, sequence > 0,
                  sequence <= 9_007_199_254_740_991 else {
                throw ClientFailure.invalidResponse
            }
        }

        private static let nilUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    }

    struct Admission: Decodable, Sendable {
        let turnId: UUID
        let generation: UInt64
        let duplicate: Bool

        func verified() throws -> TextAdmission {
            try TextAdmission(turnID: turnId, generation: generation, duplicate: duplicate)
        }
    }

    let version: Int
    let kind: String
    let operation: String
    let outcome: String
    let error: String?
    let connected: Bool
    let descriptor: Descriptor?
    let pending: Pending?
    let lastUnknown: Pending?
    let pendingOpen: Bool
    let needsReconnect: Bool
    let admission: Admission?
    let eventsSkipped: UInt64

    static func decode(_ bytes: Data) throws -> NativeEvent {
        do {
            let event = try JSONDecoder().decode(Self.self, from: bytes)
            guard event.version == 1, event.kind == "state",
                  ["prepare", "connect", "send_text", "retry_pending", "cancel", "disconnect", "heartbeat"]
                    .contains(event.operation),
                  ["ok", "error"].contains(event.outcome),
                  (event.outcome == "ok") == (event.error == nil),
                  event.error.map({ $0.utf8.count <= 64 }) ?? true else {
                throw ClientFailure.invalidResponse
            }
            try event.pending?.validate()
            try event.lastUnknown?.validate()
            _ = try event.admission?.verified()
            _ = try event.descriptor?.verified()
            return event
        } catch {
            throw ClientFailure.invalidResponse
        }
    }

    var failure: ClientFailure? {
        guard let error else { return nil }
        switch error {
        case "pending_operation", "uncertain": return .uncertainRequest
        case "persistence": return .storageBlocked
        case "signing", "invalid_signature": return .identityUnavailable
        case "invalid_config": return .invalidServer
        case "invalid_input": return .invalidText
        case "invalid_response", "invalid_journal", "panic": return .invalidResponse
        case "denied": return .approvalRequired
        case "busy": return .busy
        case "no_pending_operation", "disconnected", "expired", "stale", "unavailable", "no_admission":
            return .connectionUnavailable
        default: return .invalidResponse
        }
    }
}
