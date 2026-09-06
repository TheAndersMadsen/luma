import Foundation

/// The selected server is configuration, never part of the installation key.
public struct ServerEndpoint: Equatable, Sendable {
    public let origin: String

    public init(_ input: String) throws {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: text, encodingInvalidCharacters: false),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              host.unicodeScalars.allSatisfy({ $0.isASCII }),
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port.map({ (1...65535).contains($0) }) ?? true,
              !text.contains("%"), !text.contains("\\") else {
            throw ClientFailure.invalidServer
        }
        parts.scheme = "https"
        parts.host = host.lowercased()
        if parts.port == 443 { parts.port = nil }
        parts.path = ""
        guard let url = parts.url, url.host != nil,
              url.absoluteString.utf8.count <= 255 else { throw ClientFailure.invalidServer }
        origin = url.absoluteString
    }

    public var surfacesURL: URL { URL(string: origin + "/settings/account/surfaces")! }

    /// Center's approval page with the public descriptor carried as a link
    /// fragment, so a scan or a click prefills the review. The fragment never
    /// leaves the browser; the descriptor holds only public enrollment data.
    public func approvalURL(descriptorData: Data) -> URL? {
        guard descriptorData.count <= 1024 else { return nil }
        let encoded = descriptorData.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return URL(string: origin + "/settings/account/surfaces#descriptor=" + encoded)
    }
}

public struct TextAdmission: Equatable, Sendable {
    public let turnID: UUID
    public let generation: UInt64
    public let duplicate: Bool

    public init(turnID: UUID, generation: UInt64, duplicate: Bool) throws {
        guard turnID != UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
              generation > 0, generation <= 9_007_199_254_740_991 else {
            throw ClientFailure.invalidResponse
        }
        self.turnID = turnID
        self.generation = generation
        self.duplicate = duplicate
    }
}

public enum ClientPhase: String, Sendable {
    case disconnected, preparing, prepared, connecting, connected, disconnecting, blocked
}

/// One inert credit token. Text is shown verbatim; a link is exactly one HTTPS anchor.
public enum CreditPart: Equatable, Sendable {
    case text(String)
    case link(text: String, href: String)
}

public struct PlaceItem: Equatable, Sendable {
    public let placeID: String
    public let name: String
    public let address: String
    public let sourceURL: String?

    public init(placeID: String, name: String, address: String, sourceURL: String?) {
        self.placeID = placeID
        self.name = name
        self.address = address
        self.sourceURL = sourceURL
    }
}

public enum DisplayContent: Equatable, Sendable {
    case text(String)
    case places(query: String, items: [PlaceItem], credits: [[CreditPart]])
}

/// The exact card Cosmos delivered. The native client already verified its digest and
/// connection binding; the app renders it verbatim and acknowledges only after commit.
public struct DisplayCard: Equatable, Sendable {
    public let actionID: UUID
    public let turnID: UUID
    public let generation: UInt64
    public let contentDigest: String
    public let expiresAtMs: Int64
    public let content: DisplayContent
    /// The class Cosmos routed this card at; above shared_room it is private to this screen.
    public let privacy: String
    public var isPrivate: Bool { privacy == "near_user" || privacy == "private" }

    public init(actionID: UUID, turnID: UUID, generation: UInt64, contentDigest: String,
                expiresAtMs: Int64, content: DisplayContent, privacy: String = "shared_room") throws {
        guard actionID != DisplayCard.nilUUID, turnID != DisplayCard.nilUUID,
              generation > 0, generation <= 9_007_199_254_740_991, expiresAtMs > 0,
              contentDigest.count == 64, contentDigest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw ClientFailure.invalidResponse
        }
        self.actionID = actionID
        self.turnID = turnID
        self.generation = generation
        self.contentDigest = contentDigest
        self.expiresAtMs = expiresAtMs
        self.content = content
        self.privacy = privacy
    }

    static let nilUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
}

/// One complete spoken reply Cosmos delivered. The native client verified its binding and
/// digest; the app fetches the exact bytes, plays them to the end, then acknowledges.
public struct SpeechReply: Equatable, Sendable {
    public let actionID: UUID
    public let turnID: UUID
    public let generation: UInt64
    public let contentDigest: String
    public let expiresAtMs: Int64
    public let text: String
    public let format: String
    public let byteLength: Int

    public init(actionID: UUID, turnID: UUID, generation: UInt64, contentDigest: String,
                expiresAtMs: Int64, text: String, format: String, byteLength: Int) throws {
        guard actionID != DisplayCard.nilUUID, turnID != DisplayCard.nilUUID,
              generation > 0, generation <= 9_007_199_254_740_991, expiresAtMs > 0,
              contentDigest.count == 64, contentDigest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 4000,
              !text.contains("\0"), format == "audio/mpeg", byteLength > 0, byteLength <= 1_048_576 else {
            throw ClientFailure.invalidResponse
        }
        self.actionID = actionID
        self.turnID = turnID
        self.generation = generation
        self.contentDigest = contentDigest
        self.expiresAtMs = expiresAtMs
        self.text = text
        self.format = format
        self.byteLength = byteLength
    }
}

/// A private card is waiting for this installation. Cosmos delivers it through the
/// normal card path once the app reports its unlocked foreground visible.
public struct WaitingReply: Equatable, Sendable {
    public let id: UUID
    public let origin: String
    public let privacy: String
    public let expiresAtMs: Int64
    public init(id: UUID, origin: String, privacy: String, expiresAtMs: Int64) {
        self.id = id
        self.origin = origin
        self.privacy = privacy
        self.expiresAtMs = expiresAtMs
    }
}

/// Contains presentation-safe state only. Credentials and journal data never enter the UI.
public struct ClientSnapshot: Equatable, Sendable {
    public var phase: ClientPhase
    public var hasPending: Bool
    public var pendingOpen: Bool
    public var needsReconnect: Bool
    public var canRetry: Bool
    public var hasUnknownOutcome: Bool
    public var admission: TextAdmission?
    public var failure: ClientFailure?
    /// The foreground visibility Cosmos last accepted for this connection.
    public var visible: Bool
    /// The delivered card, if still current. Presence is not acknowledgment.
    public var display: DisplayCard?
    /// The delivered spoken reply, if still current. Presence is not playback.
    public var speech: SpeechReply?
    /// A private card waiting for this installation's unlocked foreground; it carries no content.
    public var waiting: WaitingReply?

    public init(phase: ClientPhase = .disconnected, hasPending: Bool = false,
                admission: TextAdmission? = nil, failure: ClientFailure? = nil,
                pendingOpen: Bool = false, needsReconnect: Bool = false,
                canRetry: Bool = false, hasUnknownOutcome: Bool = false,
                visible: Bool = false, display: DisplayCard? = nil, speech: SpeechReply? = nil,
                waiting: WaitingReply? = nil) {
        self.phase = phase
        self.hasPending = hasPending
        self.pendingOpen = pendingOpen
        self.needsReconnect = needsReconnect
        self.canRetry = canRetry
        self.hasUnknownOutcome = hasUnknownOutcome
        self.admission = admission
        self.failure = failure
        self.visible = visible
        self.display = display
        self.speech = speech
        self.waiting = waiting
    }
}

/// Map transport/storage failures to these fixed messages; never display raw errors.
public enum ClientFailure: Error, Equatable, Sendable {
    case invalidServer, invalidText, invalidResponse, identityUnavailable, storageUnavailable
    case storageBlocked, approvalRequired, connectionUnavailable, uncertainRequest, busy

    public var message: String {
        switch self {
        case .invalidServer: "Enter an HTTPS server address with no path, credentials, or query."
        case .invalidText: "Enter public text of at most 4,000 UTF-8 bytes."
        case .invalidResponse: "Cosmos returned a response this client could not verify."
        case .identityUnavailable: "The installation identity could not be opened in Keychain. A rebuilt or moved app is not the application that created it; reset the installation to enroll again."
        case .storageUnavailable: "Protected storage is unavailable. Unlock Keychain and try again."
        case .storageBlocked: "A protected journal update failed. Retry the pending request before connecting or sending."
        case .approvalRequired: "Approve this installation in Center before connecting."
        case .connectionUnavailable: "The Cosmos connection could not be confirmed."
        case .uncertainRequest: "The request outcome is unknown. Retry the exact pending request before sending another."
        case .busy: "Wait for the current operation to finish."
        }
    }
}

@MainActor
public protocol ClientBridge: AnyObject {
    var snapshot: ClientSnapshot { get }
    var onChange: ((ClientSnapshot) -> Void)? { get set }
    func prepare(server: ServerEndpoint) async throws -> PublicDescriptor
    func connect() async throws
    func send(text: String) async throws -> TextAdmission
    func retryPending() async throws
    func cancel(admission: TextAdmission) async throws
    /// Report this app's own foreground visibility; retained across reconnects.
    func setVisible(_ visible: Bool) async throws
    /// Acknowledge the exact card after its complete render, credits included.
    func acknowledge(display: DisplayCard) async throws
    /// The exact audio bytes of the current spoken reply.
    func speechAudio(for reply: SpeechReply) async throws -> Data
    /// Acknowledge the exact reply only after its audio played to the end.
    func acknowledgeSpeech(_ reply: SpeechReply) async throws
    func disconnect() async
}
