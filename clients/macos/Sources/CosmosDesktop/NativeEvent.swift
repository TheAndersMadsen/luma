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
            // The audience profile is what a fresh enrollment asks for; every
            // earlier rung still connects, renders and speaks with whatever it
            // declared, and declares no audience until the owner reapproves
            // this installation in Center.
            guard platform == "macos", PublicDescriptor.knownApprovals.contains(approval) else {
                throw ClientFailure.invalidResponse
            }
            return try PublicDescriptor(enrollmentID: enrollmentId, publicKey: publicKey, approval: approval)
        }
    }

    struct Pending: Decodable, Sendable {
        let kind: String
        let instanceId: UUID
        let sequence: UInt64
        let canRetry: Bool

        func validate() throws {
            guard ["text", "heartbeat", "cancel", "state", "acknowledge", "report", "grant"].contains(kind),
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

    /// A private card waiting for this installation: no content, only the class,
    /// the kind of surface that asked and the expiry.
    struct Invitation: Decodable, Sendable {
        let id: UUID
        let kind: String?
        let origin: String
        let privacy: String
        let expiresAtMs: Int64

        func verified() throws -> WaitingReply {
            // A private card is above shared_room by definition; a waiting task
            // may be at any class, because it waits for an unlocked foreground
            // rather than for privacy.
            let kind = WaitingReply.Kind(rawValue: self.kind ?? "card")
            let classes = kind == .task
                ? ["public", "shared_room", "near_user", "private"] : ["near_user", "private"]
            guard let kind,
                  id != UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)), !origin.isEmpty, origin.utf8.count <= 32,
                  origin.allSatisfy({ ($0.isLowercase && $0.isLetter) || $0 == "_" }),
                  classes.contains(privacy), expiresAtMs > 0 else {
                throw ClientFailure.invalidResponse
            }
            return WaitingReply(id: id, kind: kind, origin: origin, privacy: privacy, expiresAtMs: expiresAtMs)
        }
    }

    struct Speech: Decodable, Sendable {
        let actionId: UUID
        let turnId: UUID
        let generation: UInt64
        let contentDigest: String
        let expiresAtMs: Int64
        let text: String
        let format: String
        let byteLength: Int

        func verified() throws -> SpeechReply {
            try SpeechReply(actionID: actionId, turnID: turnId, generation: generation, contentDigest: contentDigest,
                            expiresAtMs: expiresAtMs, text: text, format: format, byteLength: byteLength)
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
    let visible: Bool
    /// Verified while decoding: kind, bounds, credit grammar and privacy class.
    let display: DisplayCard?
    let speech: Speech?
    let invitation: Invitation?
    /// Cosmos's report on the current turn; absent from older library builds.
    let status: TurnStatus?
    /// The command dispatched to this installation, verified while decoding.
    let task: DeviceTask?
    /// The ceremony this installation is the venue for, verified while decoding.
    let confirmation: ConfirmationRequest?
    /// The command Cosmos retired, and why.
    let revoked: RevokedTask?
    /// The owner's own policy this connection delivered, named but not carried:
    /// the document's own bytes are read separately. Null means this Mac holds
    /// none and may carry nothing out.
    let policy: HeldPolicy?
    let eventsSkipped: UInt64

    static func decode(_ bytes: Data) throws -> NativeEvent {
        do {
            let event = try JSONDecoder().decode(Self.self, from: bytes)
            guard event.version == 1, event.kind == "state",
                  ["prepare", "connect", "send_text", "send_text_to", "send_text_with_context", "retry_pending",
                   "cancel", "set_visible", "acknowledge", "acknowledge_speech", "acknowledge_task", "report",
                   "progress", "grant", "display", "speech", "invitation", "status", "task", "confirmation",
                   "policy", "disconnect", "heartbeat"].contains(event.operation),
                  ["ok", "error"].contains(event.outcome),
                  (event.outcome == "ok") == (event.error == nil),
                  event.error.map({ $0.utf8.count <= 64 }) ?? true else {
                throw ClientFailure.invalidResponse
            }
            try event.pending?.validate()
            try event.lastUnknown?.validate()
            _ = try event.admission?.verified()
            _ = try event.descriptor?.verified()
            _ = try event.speech?.verified()
            _ = try event.invitation?.verified()
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
        // Cosmos replaced the command between this Mac reading the snapshot and
        // the report reaching the library. The report closed nothing, which is
        // neither a failed effect nor a fault in the connection: there is
        // simply nothing left to say about that command.
        case "stale_task": return nil
        case "no_pending_operation", "disconnected", "expired", "stale", "unavailable", "no_admission",
             "no_display", "no_speech", "no_task", "no_confirmation":
            return .connectionUnavailable
        default: return .invalidResponse
        }
    }
}
