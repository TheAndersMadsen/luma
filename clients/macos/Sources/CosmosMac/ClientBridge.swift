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

    public init(phase: ClientPhase = .disconnected, hasPending: Bool = false,
                admission: TextAdmission? = nil, failure: ClientFailure? = nil,
                pendingOpen: Bool = false, needsReconnect: Bool = false,
                canRetry: Bool = false, hasUnknownOutcome: Bool = false) {
        self.phase = phase
        self.hasPending = hasPending
        self.pendingOpen = pendingOpen
        self.needsReconnect = needsReconnect
        self.canRetry = canRetry
        self.hasUnknownOutcome = hasUnknownOutcome
        self.admission = admission
        self.failure = failure
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
    func disconnect() async
}
