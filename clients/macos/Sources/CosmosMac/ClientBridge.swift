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

    public init(actionID: UUID, turnID: UUID, generation: UInt64, contentDigest: String,
                expiresAtMs: Int64, content: DisplayContent) throws {
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
    }

    static let nilUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
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

    public init(phase: ClientPhase = .disconnected, hasPending: Bool = false,
                admission: TextAdmission? = nil, failure: ClientFailure? = nil,
                pendingOpen: Bool = false, needsReconnect: Bool = false,
                canRetry: Bool = false, hasUnknownOutcome: Bool = false,
                visible: Bool = false, display: DisplayCard? = nil) {
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
        case .identityUnavailable: "The installation identity could not be opened in Keychain."
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
    func disconnect() async
}
