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
            guard platform == "macos", approval == "native-shared-speech-v3" else {
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
            guard ["text", "heartbeat", "cancel", "state", "acknowledge"].contains(kind),
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

    struct Credit: Decodable, Sendable {
        let kind: String
        let text: String
        let href: String?

        func verified() throws -> CreditPart {
            switch kind {
            case "text" where href == nil: return .text(text)
            case "link":
                guard let href, href.hasPrefix("https://"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      URL(string: href)?.scheme == "https" else { throw ClientFailure.invalidResponse }
                return .link(text: text, href: href)
            default: throw ClientFailure.invalidResponse
            }
        }
    }

    struct Place: Decodable, Sendable {
        let placeId: String
        let name: String
        let address: String
        let sourceUrl: String?

        func verified() throws -> PlaceItem {
            guard !placeId.isEmpty, !name.isEmpty, !address.isEmpty,
                  sourceUrl.map({ $0.hasPrefix("https://") && URL(string: $0) != nil }) ?? true else {
                throw ClientFailure.invalidResponse
            }
            return PlaceItem(placeID: placeId, name: name, address: address, sourceURL: sourceUrl)
        }
    }

    struct Content: Decodable, Sendable {
        let kind: String
        let text: String?
        let query: String?
        let items: [Place]?
        let attributions: [String]?
    }

    struct Display: Decodable, Sendable {
        let actionId: UUID
        let turnId: UUID
        let generation: UInt64
        let contentDigest: String
        let expiresAtMs: Int64
        let content: Content
        let credits: [[Credit]]

        func verified() throws -> DisplayCard {
            let body: DisplayContent
            switch content.kind {
            case "text":
                guard let text = content.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      text.utf8.count <= 4000, !text.contains("\0"), content.query == nil,
                      content.items == nil, content.attributions == nil, credits.isEmpty else {
                    throw ClientFailure.invalidResponse
                }
                body = .text(text)
            case "places":
                guard let query = content.query, !query.isEmpty, let items = content.items, items.count <= 4,
                      let attributions = content.attributions, attributions.count == credits.count,
                      attributions.count <= 16, content.text == nil else {
                    throw ClientFailure.invalidResponse
                }
                body = .places(query: query, items: try items.map { try $0.verified() },
                               credits: try credits.map { try $0.map { try $0.verified() } })
            default:
                throw ClientFailure.invalidResponse
            }
            return try DisplayCard(actionID: actionId, turnID: turnId, generation: generation,
                                   contentDigest: contentDigest, expiresAtMs: expiresAtMs, content: body)
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
    let display: Display?
    let speech: Speech?
    let eventsSkipped: UInt64

    static func decode(_ bytes: Data) throws -> NativeEvent {
        do {
            let event = try JSONDecoder().decode(Self.self, from: bytes)
            guard event.version == 1, event.kind == "state",
                  ["prepare", "connect", "send_text", "retry_pending", "cancel", "set_visible", "acknowledge",
                   "acknowledge_speech", "display", "speech", "disconnect", "heartbeat"].contains(event.operation),
                  ["ok", "error"].contains(event.outcome),
                  (event.outcome == "ok") == (event.error == nil),
                  event.error.map({ $0.utf8.count <= 64 }) ?? true else {
                throw ClientFailure.invalidResponse
            }
            try event.pending?.validate()
            try event.lastUnknown?.validate()
            _ = try event.admission?.verified()
            _ = try event.descriptor?.verified()
            _ = try event.display?.verified()
            _ = try event.speech?.verified()
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
        case "no_pending_operation", "disconnected", "expired", "stale", "unavailable", "no_admission", "no_display", "no_speech":
            return .connectionUnavailable
        default: return .invalidResponse
        }
    }
}
