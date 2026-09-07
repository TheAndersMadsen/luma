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

/// One option in a choices card. Cosmos numbers them in order; the id is what the
/// owner's answer refers back to.
public struct ChoiceItem: Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String

    public init(id: String, title: String, detail: String) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

public enum DisplayContent: Equatable, Sendable {
    case text(String)
    case places(query: String, items: [PlaceItem], credits: [[CreditPart]])
    /// A titled list of two to eight options, shown numbered in Cosmos's order.
    case choices(title: String, items: [ChoiceItem])
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

public enum TurnState: String, CaseIterable, Sendable {
    case working, waiting, shown, spoken, nowhere, unknown
    /// A command is waiting for someone's confirmation at the device that would
    /// carry it out.
    case confirming
    /// A device is carrying one out; nothing is claimed yet.
    case acting
    /// A device reported that it did, or did not, carry the command out.
    case done, refused
}

/// Cosmos's own account of where the latest request stands. The panel repeats it
/// with fixed wording and never infers an outcome the runtime has not reported.
public struct TurnStatus: Equatable, Sendable {
    public static let platforms = ["pin", "browser", "macos", "linux", "android", "android_tv"]

    public let turnID: UUID
    public let generation: UInt64
    public let state: TurnState
    /// The kind of surface the state concerns, when Cosmos named one.
    public let surfacePlatform: String?
    public let privacy: String

    public init(turnID: UUID, generation: UInt64, state: TurnState, surfacePlatform: String?, privacy: String) throws {
        guard turnID != DisplayCard.nilUUID, generation > 0, generation <= 9_007_199_254_740_991,
              ["public", "shared_room", "near_user", "private"].contains(privacy),
              surfacePlatform.map({ !$0.isEmpty && $0.utf8.count <= 32
                  && $0.allSatisfy { ($0.isLowercase && $0.isLetter) || $0 == "_" } }) ?? true else {
            throw ClientFailure.invalidResponse
        }
        self.turnID = turnID
        self.generation = generation
        self.state = state
        self.surfacePlatform = surfacePlatform
        self.privacy = privacy
    }
}

// MARK: Device actions

/// What a command names. Every value was minted by Cosmos from state it
/// committed itself; this Mac still checks each one against the owner's own list.
public enum DeviceLocator: Equatable, Sendable {
    case https(url: String)
    case app(id: String)
    case file(rootID: String, relative: String)
}

/// Where in a document to land. Carried through to the opener untouched.
public enum DevicePosition: Equatable, Sendable {
    case line(UInt32)
    case page(UInt32)
    case fragment(String)
}

/// The bound command itself. `unsupported` is how a channel this Mac does not
/// declare still reaches a refusal: an operation is never met with silence.
public enum DeviceOperation: Equatable, Sendable {
    case open(locator: DeviceLocator, version: String?, position: DevicePosition?, label: String)
    case run(entryID: String, label: String, entryDigest: String, argvDigest: String,
             budgetMs: Int64, mutates: Bool)
    case unsupported(kind: String)

    /// The owner's own name for it, for the task card. An operation with no
    /// label of its own is named by its kind and nothing more.
    public var label: String {
        switch self {
        case .open(_, _, _, let label): label
        case .run(_, let label, _, _, _, _): label
        case .unsupported(let kind): kind
        }
    }

    public var mutates: Bool {
        if case .run(_, _, _, _, _, let mutates) = self { return mutates }
        return false
    }

    /// The command's own time limit, for a run. Nothing else here has one.
    public var budgetMs: Int64? {
        if case .run(_, _, _, _, let budget, _) = self { return budget }
        return nil
    }
}

/// One command this installation was asked to carry out. Acknowledging it says
/// "I bound this exact command and it is legal here", and nothing more.
public struct DeviceTask: Equatable, Sendable {
    public let actionID: UUID
    public let turnID: UUID
    public let generation: UInt64
    public let channel: String
    public let contentDigest: String
    /// Deduplicate on this: a repeat re-sends the existing report and never
    /// runs anything a second time.
    public let idempotencyKey: String
    public let operation: DeviceOperation
    public let expiresAtMs: Int64
    public let reportByMs: Int64
    public let privacy: String

    public init(actionID: UUID, turnID: UUID, generation: UInt64, channel: String,
                contentDigest: String, idempotencyKey: String, operation: DeviceOperation,
                expiresAtMs: Int64, reportByMs: Int64, privacy: String) throws {
        guard actionID != DisplayCard.nilUUID, turnID != DisplayCard.nilUUID,
              generation > 0, generation <= 9_007_199_254_740_991,
              ["action.open", "action.route", "action.play", "action.run"].contains(channel),
              contentDigest.count == 64, contentDigest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              idempotencyKey.count == 64, idempotencyKey.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              expiresAtMs > 0, reportByMs > 0,
              ["public", "shared_room", "near_user", "private"].contains(privacy) else {
            throw ClientFailure.invalidResponse
        }
        self.actionID = actionID
        self.turnID = turnID
        self.generation = generation
        self.channel = channel
        self.contentDigest = contentDigest
        self.idempotencyKey = idempotencyKey
        self.operation = operation
        self.expiresAtMs = expiresAtMs
        self.reportByMs = reportByMs
        self.privacy = privacy
    }
}

/// What the ceremony asks in Cosmos's own composed words. This Mac renders them
/// from its own strings file; the JSON never reaches a person.
public struct ActionDescription: Equatable, Sendable {
    public let verb: String
    public let subject: String
    public let deviceKind: String
    public let effect: String
    public let privacyClass: String

    public init(verb: String, subject: String, deviceKind: String, effect: String, privacyClass: String) throws {
        guard DevicePolicy.text(verb, maximum: 16), DevicePolicy.text(subject, maximum: 120),
              DevicePolicy.text(deviceKind, maximum: 32), DevicePolicy.text(effect, maximum: 200),
              ["public", "shared_room", "near_user", "private"].contains(privacyClass) else {
            throw ClientFailure.invalidResponse
        }
        self.verb = verb
        self.subject = subject
        self.deviceKind = deviceKind
        self.effect = effect
        self.privacyClass = privacyClass
    }
}

/// What the platform proved about the person who answered. A bare tap can never
/// stand in for device-owner authentication.
public enum Attestation: String, Equatable, Sendable, CaseIterable {
    case foregroundTap = "foreground_tap"
    case deviceOwnerAuth = "device_owner_auth"

    /// Ordered by strength, so "at least as strong as" is one comparison.
    public var strength: Int { self == .deviceOwnerAuth ? 1 : 0 }
}

public enum ActionRisk: String, Equatable, Sendable, CaseIterable {
    case low, moderate, high
}

/// One ceremony this installation is the venue for. The person standing here is
/// the person who answers; declining weighs exactly as much as accepting.
public struct ConfirmationRequest: Equatable, Sendable {
    public let grantID: UUID
    public let actionID: UUID
    public let turnID: UUID
    public let generation: UInt64
    public let description: ActionDescription
    public let descriptionDigest: String
    public let risk: ActionRisk
    /// The weakest actor evidence Cosmos will accept for this command.
    public let attestation: Attestation
    public let privacy: String
    public let expiresAtMs: Int64

    public init(grantID: UUID, actionID: UUID, turnID: UUID, generation: UInt64,
                description: ActionDescription, descriptionDigest: String, risk: ActionRisk,
                attestation: Attestation, privacy: String, expiresAtMs: Int64) throws {
        guard grantID != DisplayCard.nilUUID, actionID != DisplayCard.nilUUID,
              turnID != DisplayCard.nilUUID, generation > 0, generation <= 9_007_199_254_740_991,
              descriptionDigest.count == 64,
              descriptionDigest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              ["public", "shared_room", "near_user", "private"].contains(privacy),
              expiresAtMs > 0 else {
            throw ClientFailure.invalidResponse
        }
        self.grantID = grantID
        self.actionID = actionID
        self.turnID = turnID
        self.generation = generation
        self.description = description
        self.descriptionDigest = descriptionDigest
        self.risk = risk
        self.attestation = attestation
        self.privacy = privacy
        self.expiresAtMs = expiresAtMs
    }
}

/// Why Cosmos told this installation to stop. A revoke supersedes remaining
/// work; it does not un-open an application.
public struct RevokedTask: Equatable, Sendable {
    public enum Reason: String, Equatable, Sendable, CaseIterable {
        case cancelled, preempted, superseded, expired
        case revalidationFailed = "revalidation_failed"
    }

    public let actionID: UUID
    public let reason: Reason

    public init(actionID: UUID, reason: Reason) {
        self.actionID = actionID
        self.reason = reason
    }
}

/// What this Mac says happened, and only what it observed. A non-zero exit code
/// is a command that ran, so it is completed evidence, not a failure.
public struct ActionReport: Equatable, Sendable {
    public enum Outcome: String, Equatable, Sendable, CaseIterable {
        case completed, refused, failed, cancelled, unknown
    }

    public enum Evidence: Equatable, Sendable {
        case open(resolvedApp: String?, opened: Bool, documentDigest: String?)
        case command(entryID: String, exitCode: Int32?, durationMs: Int64, outputBytes: UInt32, truncated: Bool)
        case declined(ActionRefusal)
    }

    public let outcome: Outcome
    public let evidence: Evidence
    /// The command's own bounded bytes, for a terminal command report only.
    public let output: String?

    public init(outcome: Outcome, evidence: Evidence, output: String? = nil) {
        self.outcome = outcome
        self.evidence = evidence
        self.output = output
    }

    public static func refusal(_ reason: ActionRefusal) -> ActionReport {
        ActionReport(outcome: .refused, evidence: .declined(reason))
    }

    /// The exact bounded JSON the shared library parses. Encoded here so the
    /// shape this Mac sends is the shape its own tests read.
    public func encoded() -> Data {
        var evidenceObject: [String: Any]
        switch evidence {
        case .open(let resolvedApp, let opened, let documentDigest):
            evidenceObject = ["kind": "open", "opened": opened]
            if let resolvedApp { evidenceObject["resolvedApp"] = resolvedApp }
            if let documentDigest { evidenceObject["documentDigest"] = documentDigest }
        case .command(let entryID, let exitCode, let durationMs, let outputBytes, let truncated):
            evidenceObject = [
                "kind": "command", "entryId": entryID, "durationMs": durationMs,
                "outputBytes": outputBytes, "truncated": truncated,
            ]
            if let exitCode { evidenceObject["exitCode"] = exitCode }
        case .declined(let reason):
            evidenceObject = ["kind": "declined", "reason": reason.rawValue]
        }
        var object: [String: Any] = ["outcome": outcome.rawValue, "evidence": evidenceObject]
        if let output { object["output"] = output }
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

/// One explicit request: public text, the context the owner attached on purpose and
/// the kind of device to continue on. Cosmos decides where the reply actually goes.
public struct TextRequest: Equatable, Sendable {
    public static let targets = ["browser", "macos", "linux", "android", "android_tv"]

    public let text: String
    public let context: ContextChip?
    public let target: String?

    public init(text: String, context: ContextChip? = nil, target: String? = nil) {
        self.text = text
        self.context = context
        self.target = target
    }
}

/// Which of the newer shared-library calls this build can make. A missing call is
/// reported as unavailable; it is never approximated with the plain text call.
public struct ClientCapabilities: Equatable, Sendable {
    /// cosmos_surface_send_text_to: a request with a destination kind.
    public let targets: Bool
    /// cosmos_surface_send_text_with_context: a request with attached local text.
    public let context: Bool
    /// acknowledge_task, report, progress and grant, together. Without all four
    /// this Mac cannot answer a ceremony or say what happened, so it refuses
    /// every command locally and loudly rather than running one silently.
    public let actions: Bool

    public init(targets: Bool = false, context: Bool = false, actions: Bool = false) {
        self.targets = targets
        self.context = context
        self.actions = actions
    }

    public static let none = ClientCapabilities()
}

/// A private card is waiting for this installation. Cosmos delivers it through the
/// normal card path once the app reports its unlocked foreground visible.
public struct WaitingReply: Equatable, Sendable {
    /// What is waiting: a private card, or a command this Mac was asked to
    /// carry out. Neither carries content.
    public enum Kind: String, Equatable, Sendable, CaseIterable {
        case card, task
    }

    public let id: UUID
    public let kind: Kind
    public let origin: String
    public let privacy: String
    public let expiresAtMs: Int64
    public init(id: UUID, kind: Kind = .card, origin: String, privacy: String, expiresAtMs: Int64) {
        self.id = id
        self.kind = kind
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
    /// Cosmos's latest report on the current turn, if it sent one.
    public var status: TurnStatus?
    /// The command dispatched to this Mac, if one is current. Presence is not
    /// acknowledgment, and acknowledgment is not an outcome.
    public var task: DeviceTask?
    /// The ceremony this Mac is the venue for, if one is current.
    public var confirmation: ConfirmationRequest?
    /// The command Cosmos retired, and why.
    public var revoked: RevokedTask?

    public init(phase: ClientPhase = .disconnected, hasPending: Bool = false,
                admission: TextAdmission? = nil, failure: ClientFailure? = nil,
                pendingOpen: Bool = false, needsReconnect: Bool = false,
                canRetry: Bool = false, hasUnknownOutcome: Bool = false,
                visible: Bool = false, display: DisplayCard? = nil, speech: SpeechReply? = nil,
                waiting: WaitingReply? = nil, status: TurnStatus? = nil,
                task: DeviceTask? = nil, confirmation: ConfirmationRequest? = nil,
                revoked: RevokedTask? = nil) {
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
        self.status = status
        self.task = task
        self.confirmation = confirmation
        self.revoked = revoked
    }
}

/// Map transport/storage failures to these fixed messages; never display raw errors.
public enum ClientFailure: Error, Equatable, Sendable {
    case invalidServer, invalidText, invalidResponse, identityUnavailable, storageUnavailable
    case storageBlocked, approvalRequired, connectionUnavailable, uncertainRequest, busy
    case featureUnavailable

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
        case .featureUnavailable: "That option is not available in this build of Cosmos. The request was not sent."
        }
    }

    /// The same fact as two short sentences: what happened, and what to do about it.
    /// Anything technical — a Keychain rule, a path — stays in `detail`, which the
    /// panel shows only behind the Details disclosure.
    public var notice: Notice {
        switch self {
        case .invalidServer:
            Notice(happened: "That is not a Center address.",
                   next: "Enter an https:// address with nothing after the host.", isFailure: true)
        case .invalidText:
            Notice(happened: "That request is too long to send.",
                   next: "Keep it under 4,000 characters.", isFailure: true)
        case .invalidResponse:
            Notice(happened: "Cosmos sent something this Mac could not verify.",
                   next: "Update Cosmos and try again.", isFailure: true)
        case .identityUnavailable:
            Notice(happened: "This Mac's key could not be opened.",
                   next: "Reset the installation and set this Mac up again.",
                   detail: message, isFailure: true)
        case .storageUnavailable:
            Notice(happened: "Protected storage is unavailable.",
                   next: "Unlock your Keychain, then try again.", isFailure: true)
        case .storageBlocked:
            Notice(happened: "The last request could not be saved.",
                   next: "Retry it before sending anything else.", isFailure: true)
        case .approvalRequired:
            Notice(happened: "This Mac is not approved yet.",
                   next: "Approve it in Center to connect.", isFailure: true)
        case .connectionUnavailable:
            Notice(happened: "Cosmos could not be reached.", next: Words.reconnecting, isFailure: true)
        case .uncertainRequest:
            Notice(happened: "The last request may or may not have gone through.",
                   next: "Retry it before sending anything else.")
        case .busy:
            Notice(happened: "Cosmos is still finishing the last action.",
                   next: "Wait a moment, then try again.")
        case .featureUnavailable:
            Notice(happened: "This needs a newer Cosmos.", next: "Update Cosmos and try again.", isFailure: true)
        }
    }
}

@MainActor
public protocol ClientBridge: AnyObject {
    var snapshot: ClientSnapshot { get }
    var onChange: ((ClientSnapshot) -> Void)? { get set }
    /// Fixed for the life of the process: which newer library calls exist.
    var capabilities: ClientCapabilities { get }
    func prepare(server: ServerEndpoint) async throws -> PublicDescriptor
    func connect() async throws
    func send(_ request: TextRequest) async throws -> TextAdmission
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
    /// Acknowledge that this Mac bound the exact command from its own copy of
    /// the owner's policy and that it is legal here. It claims no outcome.
    func acknowledgeTask(_ task: DeviceTask) async throws
    /// Say what happened, once, and only what this Mac observed.
    func report(_ report: ActionReport, for task: DeviceTask) async throws
    /// Liveness for a running command. It renews the deadline and claims nothing.
    func progress(sequence: UInt32, elapsedMs: Int64, for task: DeviceTask) async throws
    /// Answer the ceremony with the attestation actually obtained. Dismissing
    /// the panel answers nothing at all and never reaches this call.
    func grant(_ granted: Bool, attestation: Attestation?, for confirmation: ConfirmationRequest) async throws
    func disconnect() async
}
