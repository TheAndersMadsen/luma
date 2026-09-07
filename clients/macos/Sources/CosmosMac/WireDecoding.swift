import Foundation

/// Decoding of the shared library's snapshot shapes that carry content. Every field
/// is bounded and verified here; a shape this client does not understand is rejected
/// rather than shown partially.
extension DisplayCard: Decodable {
    private struct Credit: Decodable {
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

    /// One list entry of either kind; the content kind decides which fields count.
    private struct Item: Decodable {
        let placeId: String?
        let name: String?
        let address: String?
        let sourceUrl: String?
        let id: String?
        let title: String?
        let detail: String?

        func verifiedPlace() throws -> PlaceItem {
            guard let placeId, !placeId.isEmpty, let name, !name.isEmpty, let address, !address.isEmpty,
                  sourceUrl.map({ $0.hasPrefix("https://") && URL(string: $0) != nil }) ?? true else {
                throw ClientFailure.invalidResponse
            }
            return PlaceItem(placeID: placeId, name: name, address: address, sourceURL: sourceUrl)
        }

        func verifiedChoice() throws -> ChoiceItem {
            guard let id, !id.isEmpty, !id.contains("\0"), let title,
                  !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !title.contains("\0"),
                  !(detail ?? "").contains("\0"), placeId == nil, address == nil else {
                throw ClientFailure.invalidResponse
            }
            return ChoiceItem(id: id, title: title, detail: detail ?? "")
        }
    }

    private struct Content: Decodable {
        let kind: String
        let text: String?
        let query: String?
        let title: String?
        let items: [Item]?
        let attributions: [String]?
    }

    private enum Keys: String, CodingKey {
        case actionId, turnId, generation, contentDigest, expiresAtMs, content, credits, privacy
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let content = try container.decode(Content.self, forKey: .content)
        let credits = try container.decode([[Credit]].self, forKey: .credits)
        let privacy = try container.decodeIfPresent(String.self, forKey: .privacy) ?? "shared_room"
        guard ["public", "shared_room", "near_user", "private"].contains(privacy) else {
            throw ClientFailure.invalidResponse
        }
        let body: DisplayContent
        switch content.kind {
        case "text":
            guard let text = content.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf8.count <= 4000, !text.contains("\0"), content.query == nil, content.title == nil,
                  content.items == nil, content.attributions == nil, credits.isEmpty else {
                throw ClientFailure.invalidResponse
            }
            body = .text(text)
        case "places":
            guard let query = content.query, !query.isEmpty, let items = content.items, items.count <= 4,
                  let attributions = content.attributions, attributions.count == credits.count,
                  attributions.count <= 16, content.text == nil, content.title == nil else {
                throw ClientFailure.invalidResponse
            }
            body = .places(query: query, items: try items.map { try $0.verifiedPlace() },
                           credits: try credits.map { try $0.map { try $0.verified() } })
        case "choices":
            guard let title = content.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !title.contains("\0"), let items = content.items, (2...8).contains(items.count),
                  content.text == nil, content.query == nil, content.attributions == nil, credits.isEmpty else {
                throw ClientFailure.invalidResponse
            }
            body = .choices(title: title, items: try items.map { try $0.verifiedChoice() })
        default:
            throw ClientFailure.invalidResponse
        }
        try self.init(
            actionID: container.decode(UUID.self, forKey: .actionId),
            turnID: container.decode(UUID.self, forKey: .turnId),
            generation: container.decode(UInt64.self, forKey: .generation),
            contentDigest: container.decode(String.self, forKey: .contentDigest),
            expiresAtMs: container.decode(Int64.self, forKey: .expiresAtMs),
            content: body, privacy: privacy
        )
    }
}

extension DeviceLocator: Decodable {
    private enum Keys: String, CodingKey { case scheme, url, id, rootId, relative }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .scheme) {
        case "https":
            self = .https(url: try container.decode(String.self, forKey: .url))
        case "app":
            self = .app(id: try container.decode(String.self, forKey: .id))
        case "file":
            self = .file(rootID: try container.decode(String.self, forKey: .rootId),
                         relative: try container.decode(String.self, forKey: .relative))
        default:
            throw ClientFailure.invalidResponse
        }
    }
}

extension DevicePosition: Decodable {
    private enum Keys: String, CodingKey { case kind, line, page, value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "line": self = .line(try container.decode(UInt32.self, forKey: .line))
        case "page": self = .page(try container.decode(UInt32.self, forKey: .page))
        case "fragment": self = .fragment(try container.decode(String.self, forKey: .value))
        default: throw ClientFailure.invalidResponse
        }
    }
}

extension DeviceOperation: Decodable {
    private enum Keys: String, CodingKey {
        case kind, locator, version, position, label
        case entryId, entryDigest, argvDigest, budgetMs, mutates
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "open":
            let label = try container.decode(String.self, forKey: .label)
            guard DevicePolicy.text(label, maximum: 120) else { throw ClientFailure.invalidResponse }
            let version = try container.decodeIfPresent(String.self, forKey: .version)
            guard version.map({ $0.count == 64 && $0.allSatisfy { $0.isHexDigit && !$0.isUppercase } }) ?? true else {
                throw ClientFailure.invalidResponse
            }
            self = .open(locator: try container.decode(DeviceLocator.self, forKey: .locator),
                         version: version,
                         position: try container.decodeIfPresent(DevicePosition.self, forKey: .position),
                         label: label)
        case "run":
            let label = try container.decode(String.self, forKey: .label)
            let entryID = try container.decode(String.self, forKey: .entryId)
            let entryDigest = try container.decode(String.self, forKey: .entryDigest)
            let argvDigest = try container.decode(String.self, forKey: .argvDigest)
            let budgetMs = try container.decode(Int64.self, forKey: .budgetMs)
            guard DevicePolicy.text(label, maximum: 120), DevicePolicy.token(entryID, maximum: 48),
                  entryDigest.count == 64, entryDigest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
                  argvDigest.count == 64, argvDigest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
                  (1...900_000).contains(budgetMs) else {
                throw ClientFailure.invalidResponse
            }
            self = .run(entryID: entryID, label: label, entryDigest: entryDigest, argvDigest: argvDigest,
                        budgetMs: budgetMs, mutates: try container.decode(Bool.self, forKey: .mutates))
        case "route", "play":
            // This Mac declares neither channel. The command still decodes so it
            // can be refused with a reason rather than met with silence.
            self = .unsupported(kind: kind)
        default:
            throw ClientFailure.invalidResponse
        }
    }
}

extension DeviceTask: Decodable {
    private enum Keys: String, CodingKey {
        case actionId, turnId, generation, channel, contentDigest, idempotencyKey
        case operation, expiresAtMs, reportByMs, privacy
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        try self.init(
            actionID: container.decode(UUID.self, forKey: .actionId),
            turnID: container.decode(UUID.self, forKey: .turnId),
            generation: container.decode(UInt64.self, forKey: .generation),
            channel: container.decode(String.self, forKey: .channel),
            contentDigest: container.decode(String.self, forKey: .contentDigest),
            idempotencyKey: container.decode(String.self, forKey: .idempotencyKey),
            operation: container.decode(DeviceOperation.self, forKey: .operation),
            expiresAtMs: container.decode(Int64.self, forKey: .expiresAtMs),
            reportByMs: container.decode(Int64.self, forKey: .reportByMs),
            privacy: container.decode(String.self, forKey: .privacy)
        )
    }
}

extension ActionDescription: Decodable {
    private enum Keys: String, CodingKey { case kind, verb, subject, deviceKind, effect, `class` }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        guard try container.decode(String.self, forKey: .kind) == "device_action" else {
            throw ClientFailure.invalidResponse
        }
        try self.init(
            verb: container.decode(String.self, forKey: .verb),
            subject: container.decode(String.self, forKey: .subject),
            deviceKind: container.decode(String.self, forKey: .deviceKind),
            effect: container.decode(String.self, forKey: .effect),
            privacyClass: container.decode(String.self, forKey: .class)
        )
    }
}

extension ConfirmationRequest: Decodable {
    private enum Keys: String, CodingKey {
        case grantId, actionId, turnId, generation, description, descriptionDigest
        case risk, attestation, privacy, expiresAtMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        guard let risk = ActionRisk(rawValue: try container.decode(String.self, forKey: .risk)),
              let attestation = Attestation(rawValue: try container.decode(String.self, forKey: .attestation)) else {
            throw ClientFailure.invalidResponse
        }
        try self.init(
            grantID: container.decode(UUID.self, forKey: .grantId),
            actionID: container.decode(UUID.self, forKey: .actionId),
            turnID: container.decode(UUID.self, forKey: .turnId),
            generation: container.decode(UInt64.self, forKey: .generation),
            description: container.decode(ActionDescription.self, forKey: .description),
            descriptionDigest: container.decode(String.self, forKey: .descriptionDigest),
            risk: risk, attestation: attestation,
            privacy: container.decode(String.self, forKey: .privacy),
            expiresAtMs: container.decode(Int64.self, forKey: .expiresAtMs)
        )
    }
}

extension RevokedTask: Decodable {
    private enum Keys: String, CodingKey { case actionId, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let actionID = try container.decode(UUID.self, forKey: .actionId)
        guard actionID != DisplayCard.nilUUID,
              let reason = Reason(rawValue: try container.decode(String.self, forKey: .reason)) else {
            throw ClientFailure.invalidResponse
        }
        self.init(actionID: actionID, reason: reason)
    }
}

extension HeldPolicy: Decodable {
    private enum Keys: String, CodingKey {
        case surfaceId, approvalRevision, actionsRevision, commandsRevision, digest, byteLength
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        // A section this installation was given nothing for is null, not zero.
        try self.init(
            surfaceID: container.decode(UUID.self, forKey: .surfaceId),
            approvalRevision: container.decode(UInt64.self, forKey: .approvalRevision),
            actionsRevision: container.decodeIfPresent(UInt64.self, forKey: .actionsRevision),
            commandsRevision: container.decodeIfPresent(UInt64.self, forKey: .commandsRevision),
            digest: container.decode(String.self, forKey: .digest),
            byteLength: container.decode(Int.self, forKey: .byteLength)
        )
    }
}

extension TurnStatus: Decodable {
    private enum Keys: String, CodingKey { case turnId, generation, state, surfacePlatform, privacy }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        guard let state = TurnState(rawValue: try container.decode(String.self, forKey: .state)) else {
            throw ClientFailure.invalidResponse
        }
        try self.init(
            turnID: container.decode(UUID.self, forKey: .turnId),
            generation: container.decode(UInt64.self, forKey: .generation),
            state: state,
            surfacePlatform: container.decodeIfPresent(String.self, forKey: .surfacePlatform),
            privacy: container.decode(String.self, forKey: .privacy)
        )
    }
}
