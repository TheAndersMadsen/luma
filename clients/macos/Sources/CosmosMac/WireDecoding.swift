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
