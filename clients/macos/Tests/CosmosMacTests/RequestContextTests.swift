import Combine
import Foundation
import XCTest
@testable import CosmosMac

@MainActor
private final class FakeContextProvider: ContextProvider {
    var canReadSelection = true
    var selection: ContextCapture = .noApplication
    var clipboard: ContextCapture = .empty(app: "Unknown app")
    var selectionReads = 0
    var clipboardReads = 0

    func selectedText() -> ContextCapture {
        selectionReads += 1
        return selection
    }

    func clipboardText() -> ContextCapture {
        clipboardReads += 1
        return clipboard
    }
}

private let turnID = UUID(uuidString: "44444444-4444-4444-4444-444444444444")!
private let digest = String(repeating: "0123456789abcdef", count: 4)

private func status(_ state: TurnState, _ platform: String?, privacy: String = "shared_room") throws -> TurnStatus {
    try TurnStatus(turnID: turnID, generation: 1, state: state, surfacePlatform: platform, privacy: privacy)
}

private func choicesJSON(items: String = """
    [{"id":"1","title":"Café","detail":"Open now"},{"id":"2","title":"Bakery","detail":""},{"id":"3","title":"Bar"}]
    """, title: String? = "\"Which one?\"", credits: String = "[]", digest: String = digest,
                         privacy: String = "\"private\"") -> Data {
    let titleField = title.map { ",\"title\":\($0)" } ?? ""
    return Data("""
    {"actionId":"33333333-3333-3333-3333-333333333333","turnId":"\(turnID.uuidString.lowercased())",
     "generation":2,"contentDigest":"\(digest)","expiresAtMs":1000,
     "content":{"kind":"choices"\(titleField),"items":\(items)},"credits":\(credits),"privacy":\(privacy)}
    """.utf8)
}

final class RequestContextTests: XCTestCase {
    @MainActor
    private func settled(_ model: ClientModel, file: StaticString = #filePath, line: UInt = #line) async {
        if !model.busy { return }
        let done = expectation(description: "The current model operation finishes")
        let subscription = model.$busy.first(where: { !$0 }).sink { _ in done.fulfill() }
        defer { subscription.cancel() }
        await fulfillment(of: [done], timeout: 2)
        XCTAssertFalse(model.busy, file: file, line: line)
    }

    @MainActor
    private func connectedModel(_ provider: FakeContextProvider) throws -> (MockClientBridge, ClientModel) {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                contextProvider: provider)
        return (client, model)
    }

    // MARK: Chip bounding and labels

    func testChipBoundsTextToEightThousandBytesOnCharacterBoundaries() throws {
        let exact = try XCTUnwrap(ContextChip(source: .selection, app: "Safari", text: String(repeating: "a", count: 8000)))
        XCTAssertEqual(exact.byteCount, 8000)
        XCTAssertFalse(exact.truncated)
        let over = try XCTUnwrap(ContextChip(source: .selection, app: "Safari", text: String(repeating: "a", count: 8001)))
        XCTAssertEqual(over.byteCount, 8000)
        XCTAssertTrue(over.truncated)
        // 2,001 four-byte characters: the cut lands before the 2,001st, never inside it.
        let emoji = try XCTUnwrap(ContextChip(source: .clipboard, app: "Notes", text: String(repeating: "😀", count: 2001)))
        XCTAssertEqual(emoji.text.count, 2000)
        XCTAssertEqual(emoji.byteCount, 8000)
        XCTAssertTrue(emoji.truncated)
        // 7,999 single bytes then a four-byte character: the limit falls inside it, so it goes.
        let mixed = try XCTUnwrap(ContextChip(source: .selection, app: "Notes", text: String(repeating: "b", count: 7999) + "😀c"))
        XCTAssertEqual(mixed.byteCount, 7999)
        XCTAssertTrue(mixed.truncated)
        XCTAssertNil(ContextChip(source: .selection, app: "Safari", text: ""))
        XCTAssertNil(ContextChip(source: .selection, app: "Safari", text: " \n\t"))
        XCTAssertNil(ContextChip(source: .selection, app: "Safari", text: "\0"))
        XCTAssertEqual(try XCTUnwrap(ContextChip(source: .selection, app: "Safari", text: "a\0b")).text, "ab")
    }

    func testChipBoundsTheApplicationNameAndNamesAnUnknownOne() throws {
        let long = try XCTUnwrap(ContextChip(source: .selection, app: String(repeating: "é", count: 40), text: "x"))
        XCTAssertEqual(long.app.utf8.count, 64)
        XCTAssertEqual(long.app.count, 32)
        XCTAssertEqual(try XCTUnwrap(ContextChip(source: .clipboard, app: "  ", text: "x")).app, "Unknown app")
        XCTAssertEqual(try XCTUnwrap(ContextChip(source: .clipboard, app: " Safari ", text: "x")).app, "Safari")
    }

    func testChipCaptionNamesTheAppAndNeverTheSize() throws {
        let selection = try XCTUnwrap(ContextChip(source: .selection, app: "Mail", text: "hello"))
        XCTAssertEqual(selection.caption, "Using: Mail selection")
        let clipboard = try XCTUnwrap(ContextChip(source: .clipboard, app: "Mail", text: "hello"))
        XCTAssertEqual(clipboard.caption, "Using: clipboard text")
        for caption in [selection.caption, clipboard.caption] {
            XCTAssertFalse(caption.contains("KB"), "the chip names where the text came from, not how much")
            XCTAssertFalse(caption.contains("B"), caption)
        }
    }

    func testChipLabelNamesTheSourceAndSize() throws {
        func label(_ source: ContextSource, bytes: Int) throws -> String {
            try XCTUnwrap(ContextChip(source: source, app: "Safari", text: String(repeating: "a", count: bytes))).label
        }
        XCTAssertEqual(try label(.selection, bytes: 1200), "Selected text · 1.2 KB")
        XCTAssertEqual(try label(.clipboard, bytes: 812), "Clipboard text · 812 B")
        XCTAssertEqual(try label(.selection, bytes: 9000), "Selected text · 8 KB")
        XCTAssertEqual(ContextChip.formatBytes(999), "999 B")
        XCTAssertEqual(ContextChip.formatBytes(1000), "1 KB")
        XCTAssertEqual(ContextChip.formatBytes(1050), "1.1 KB")
        XCTAssertEqual(ContextChip.formatBytes(7960), "8 KB")
    }

    // MARK: Destinations

    func testDestinationsMapToPlainWireTargets() throws {
        XCTAssertEqual(Destination.allCases, [.thisMac, .phone, .linuxPC, .tv, .browser])
        XCTAssertEqual(Destination.allCases.map(\.label), ["This Mac", "Phone", "Linux PC", "TV", "Browser"])
        XCTAssertEqual(Destination.allCases.map(\.target), [nil, "android", "linux", "android_tv", "browser"])
        for destination in Destination.allCases where destination != .thisMac {
            XCTAssertTrue(TextRequest.targets.contains(try XCTUnwrap(destination.target)))
        }
        XCTAssertFalse(TextRequest.targets.contains("pin"), "the Pin asks; it is never a destination")
        for destination in Destination.allCases {
            XCTAssertFalse(destination.label.lowercased().contains("approved"))
            XCTAssertFalse(destination.label.lowercased().contains("available"))
        }
    }

    // MARK: Status vocabulary and decoding

    func testStatusVocabularyIsFixed() throws {
        func line(_ state: TurnState, _ platform: String? = nil) throws -> StatusLine {
            PanelState.statusLine(try status(state, platform))
        }
        // The headline always comes from the shared vocabulary the other clients use.
        let vocabulary = [Words.working, Words.waitingForYou, Words.waitingForDevice,
                          Words.completed, Words.cannotConfirm, Words.nowhere]
        for state in TurnState.allCases {
            for platform in [nil, "macos", "android", "android_tv", "linux", "browser", "pin", "watch"] {
                XCTAssertTrue(vocabulary.contains(try line(state, platform).title),
                              "\(state) on \(platform ?? "no surface") left the vocabulary")
            }
        }
        XCTAssertEqual(try line(.working, nil), StatusLine(title: "Working"))
        XCTAssertEqual(try line(.working, "android"), StatusLine(title: "Working"))
        // A turn waiting on this Mac is waiting for the owner; anywhere else it waits
        // for a device, and the sentence under it names which one.
        XCTAssertEqual(try line(.waiting, "macos"), StatusLine(title: "Waiting for you"))
        XCTAssertEqual(try line(.waiting, nil), StatusLine(title: "Waiting for a device"))
        XCTAssertEqual(try line(.waiting, "android"),
                       StatusLine(title: "Waiting for a device", detail: "Waiting for your phone"))
        XCTAssertEqual(try line(.waiting, "android_tv").detail, "Waiting for your TV")
        XCTAssertEqual(try line(.waiting, "linux").detail, "Waiting for your Linux PC")
        XCTAssertEqual(try line(.waiting, "browser").detail, "Waiting for your browser")
        XCTAssertEqual(try line(.waiting, "pin").detail, "Waiting for your Ai Pin")
        // A finished turn is "Completed"; the sentence says where, unless it is here.
        XCTAssertEqual(try line(.shown, "macos"), StatusLine(title: "Completed"))
        XCTAssertEqual(try line(.shown, nil), StatusLine(title: "Completed"))
        XCTAssertEqual(try line(.shown, "android"),
                       StatusLine(title: "Completed", detail: "Shown on your phone"))
        XCTAssertEqual(try line(.spoken, "pin").detail, "Spoken on your Ai Pin")
        XCTAssertEqual(try line(.spoken, "macos"), StatusLine(title: "Completed"))
        XCTAssertEqual(try line(.shown, "watch").detail, "Shown on another display",
                       "a new kind of display is not a failure")
        XCTAssertEqual(try line(.nowhere), StatusLine(title: "Nowhere to show it",
                                                      detail: "No approved screen showed the reply."))
        let unknown = try line(.unknown, "android")
        XCTAssertEqual(unknown.title, "Cannot confirm")
        XCTAssertEqual(unknown.detail, "I can't confirm whether that request was handled. It was not sent again.")
        XCTAssertFalse(PanelState.isFailureMessage(try XCTUnwrap(unknown.detail)))
        XCTAssertFalse(PanelState.isFailureMessage(unknown.title))
    }

    /// The quiet line under the header: a settled connection says nothing at all.
    func testConnectionNoteFadesOnceConnected() {
        XCTAssertEqual(PanelState.connectionNote(.connected, justConnected: true), "Connected")
        XCTAssertNil(PanelState.connectionNote(.connected, justConnected: false))
        XCTAssertEqual(PanelState.connectionNote(.reconnecting, justConnected: false), "Reconnecting…")
        XCTAssertEqual(PanelState.connectionNote(.connecting, justConnected: false), "Connecting…")
        XCTAssertEqual(PanelState.connectionNote(.disconnecting, justConnected: false), "Disconnecting…")
        XCTAssertEqual(PanelState.connectionNote(.disconnected, justConnected: false), "Disconnected")
    }

    func testStatusDecodesFromTheSnapshotShapeAndRejectsWhatItCannotName() throws {
        func decode(_ json: String) throws -> TurnStatus {
            try JSONDecoder().decode(TurnStatus.self, from: Data(json.utf8))
        }
        let waiting = try decode("""
        {"turnId":"44444444-4444-4444-4444-444444444444","generation":3,"state":"waiting","surfacePlatform":"android","privacy":"near_user"}
        """)
        XCTAssertEqual(waiting, try TurnStatus(turnID: turnID, generation: 3, state: .waiting,
                                               surfacePlatform: "android", privacy: "near_user"))
        let bare = try decode("""
        {"turnId":"44444444-4444-4444-4444-444444444444","generation":1,"state":"nowhere","surfacePlatform":null,"privacy":"public"}
        """)
        XCTAssertNil(bare.surfacePlatform)
        XCTAssertEqual(PanelState.statusLine(bare).title, "Nowhere to show it")
        let absent = try decode("""
        {"turnId":"44444444-4444-4444-4444-444444444444","generation":1,"state":"unknown","privacy":"shared_room"}
        """)
        XCTAssertEqual(absent.state, .unknown)
        let invalid = [
            """
            {"turnId":"44444444-4444-4444-4444-444444444444","generation":1,"state":"rendered","privacy":"public"}
            """,
            """
            {"turnId":"00000000-0000-0000-0000-000000000000","generation":1,"state":"working","privacy":"public"}
            """,
            """
            {"turnId":"44444444-4444-4444-4444-444444444444","generation":0,"state":"working","privacy":"public"}
            """,
            """
            {"turnId":"44444444-4444-4444-4444-444444444444","generation":1,"state":"working","privacy":"secret"}
            """,
            """
            {"turnId":"44444444-4444-4444-4444-444444444444","generation":1,"state":"shown","surfacePlatform":"Android TV","privacy":"public"}
            """,
            """
            {"turnId":"44444444-4444-4444-4444-444444444444","generation":1,"privacy":"public"}
            """,
        ]
        for json in invalid {
            XCTAssertThrowsError(try decode(json), json)
        }
    }

    // MARK: Choices

    func testChoicesCardDecodesWithItsExactDigestAndPrivacy() throws {
        let card = try JSONDecoder().decode(DisplayCard.self, from: choicesJSON())
        XCTAssertEqual(card.contentDigest, digest)
        XCTAssertEqual(card.actionID.uuidString.lowercased(), "33333333-3333-3333-3333-333333333333")
        XCTAssertEqual(card.turnID, turnID)
        XCTAssertTrue(card.isPrivate)
        XCTAssertEqual(card.content, .choices(title: "Which one?", items: [
            ChoiceItem(id: "1", title: "Café", detail: "Open now"),
            ChoiceItem(id: "2", title: "Bakery", detail: ""),
            ChoiceItem(id: "3", title: "Bar", detail: ""),
        ]))
        let shared = try JSONDecoder().decode(DisplayCard.self, from: choicesJSON(privacy: "\"shared_room\""))
        XCTAssertFalse(shared.isPrivate)
        XCTAssertEqual(shared.content, card.content)

        let two = try JSONDecoder().decode(DisplayCard.self, from: choicesJSON(items: """
            [{"id":"a","title":"Yes"},{"id":"b","title":"No"}]
            """))
        if case .choices(_, let items) = two.content { XCTAssertEqual(items.count, 2) } else { XCTFail("choices") }
        let eight = (1...8).map { "{\"id\":\"\($0)\",\"title\":\"Option \($0)\",\"detail\":\"d\"}" }.joined(separator: ",")
        XCTAssertNoThrow(try JSONDecoder().decode(DisplayCard.self, from: choicesJSON(items: "[\(eight)]")))

        let nine = (1...9).map { "{\"id\":\"\($0)\",\"title\":\"Option \($0)\"}" }.joined(separator: ",")
        let rejected: [(String, Data)] = [
            ("one item", choicesJSON(items: "[{\"id\":\"1\",\"title\":\"Only\"}]")),
            ("nine items", choicesJSON(items: "[\(nine)]")),
            ("missing title", choicesJSON(title: nil)),
            ("blank title", choicesJSON(title: "\" \"")),
            ("item without id", choicesJSON(items: "[{\"title\":\"A\"},{\"id\":\"2\",\"title\":\"B\"}]")),
            ("item without title", choicesJSON(items: "[{\"id\":\"1\"},{\"id\":\"2\",\"title\":\"B\"}]")),
            ("credits on choices", choicesJSON(credits: "[[{\"kind\":\"text\",\"text\":\"x\"}]]")),
            ("uppercase digest", choicesJSON(digest: digest.uppercased())),
            ("short digest", choicesJSON(digest: String(digest.dropLast()))),
            ("unknown class", choicesJSON(privacy: "\"sensitive\"")),
        ]
        for (name, data) in rejected {
            XCTAssertThrowsError(try JSONDecoder().decode(DisplayCard.self, from: data), name) { error in
                XCTAssertEqual(error as? ClientFailure, .invalidResponse, name)
            }
        }
    }

    func testTextAndPlacesCardsStillDecodeThroughTheSharedDecoder() throws {
        let text = try JSONDecoder().decode(DisplayCard.self, from: Data("""
        {"actionId":"33333333-3333-3333-3333-333333333333","turnId":"44444444-4444-4444-4444-444444444444",
         "generation":1,"contentDigest":"\(digest)","expiresAtMs":5,
         "content":{"kind":"text","text":"Hello"},"credits":[]}
        """.utf8))
        XCTAssertEqual(text.content, .text("Hello"))
        XCTAssertEqual(text.privacy, "shared_room")
        let places = try JSONDecoder().decode(DisplayCard.self, from: Data("""
        {"actionId":"33333333-3333-3333-3333-333333333333","turnId":"44444444-4444-4444-4444-444444444444",
         "generation":1,"contentDigest":"\(digest)","expiresAtMs":5,
         "content":{"kind":"places","query":"cafe","items":[{"placeId":"p1","name":"Café","address":"1 Main St","sourceUrl":null}],
         "attributions":["Credit"]},"credits":[[{"kind":"text","text":"Credit: "},{"kind":"link","text":"Map","href":"https://credits.example/"}]]}
        """.utf8))
        XCTAssertEqual(places.content, .places(query: "cafe", items: [
            PlaceItem(placeID: "p1", name: "Café", address: "1 Main St", sourceURL: nil),
        ], credits: [[.text("Credit: "), .link(text: "Map", href: "https://credits.example/")]]))
        XCTAssertThrowsError(try JSONDecoder().decode(DisplayCard.self, from: Data("""
        {"actionId":"33333333-3333-3333-3333-333333333333","turnId":"44444444-4444-4444-4444-444444444444",
         "generation":1,"contentDigest":"\(digest)","expiresAtMs":5,
         "content":{"kind":"text","text":"Hello"},"credits":[[{"kind":"text","text":"x"}]]}
        """.utf8)), "text cards carry no credits")
    }

    @MainActor
    func testChoicesCardIsAcknowledgedOnceWithItsDigest() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected, visible: true))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                contextProvider: FakeContextProvider())
        let card = try JSONDecoder().decode(DisplayCard.self, from: choicesJSON())
        client.publish(ClientSnapshot(phase: .connected, visible: true, display: card))
        XCTAssertEqual(model.display, card)
        model.displayCommitted(card)
        model.displayCommitted(card)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(client.acknowledgedCards.map(\.contentDigest), [digest])
        XCTAssertEqual(client.acknowledgedCards.map(\.actionID), [card.actionID])
    }

    // MARK: The chip in the model

    @MainActor
    func testSelectionIsAttachedBoundedAndSentAsPrivateContext() async throws {
        let provider = FakeContextProvider()
        provider.selection = .text(app: "Safari", text: String(repeating: "s", count: 9000))
        let (client, model) = try connectedModel(provider)
        model.useSelection()
        let chip = try XCTUnwrap(model.context)
        XCTAssertEqual(chip.source, .selection)
        XCTAssertEqual(chip.app, "Safari")
        XCTAssertEqual(chip.byteCount, 8000)
        XCTAssertTrue(chip.truncated)
        XCTAssertEqual(chip.label, "Selected text · 8 KB")
        XCTAssertEqual(model.message, "Using the first 8 KB of the selected text from Safari.")
        XCTAssertEqual(provider.selectionReads, 1)
        XCTAssertEqual(provider.clipboardReads, 0, "the selection path never reads the clipboard")
        model.draft = "Explain this"
        model.send()
        await settled(model)
        XCTAssertEqual(client.sentRequests, [TextRequest(text: "Explain this", context: chip, target: nil)])
        XCTAssertNil(model.context, "attached text belongs to the request it went with")
        XCTAssertEqual(model.draft, "")
        XCTAssertEqual(model.message,
                       "Cosmos has your request with your selected text from Safari. The reply stays on this Mac.")
    }

    @MainActor
    func testClipboardIsReadOnlyThroughItsOwnActionAndTheChipIsRemovable() async throws {
        let provider = FakeContextProvider()
        provider.selection = .text(app: "Safari", text: "selected")
        provider.clipboard = .text(app: "Notes", text: "copied")
        let (client, model) = try connectedModel(provider)
        model.useClipboard()
        XCTAssertEqual(model.context?.label, "Clipboard text · 6 B")
        XCTAssertEqual(model.context?.app, "Notes")
        XCTAssertEqual(provider.selectionReads, 0)
        XCTAssertEqual(provider.clipboardReads, 1)
        model.clearContext()
        XCTAssertNil(model.context)
        model.draft = "Plain"
        model.send()
        await settled(model)
        XCTAssertEqual(client.sentRequests, [TextRequest(text: "Plain")])
        XCTAssertEqual(model.message, "", "a plain request speaks for itself")
        XCTAssertEqual(provider.clipboardReads, 1, "sending never reads the clipboard again")
    }

    @MainActor
    func testMissingAccessibilityPermissionExplainsSystemSettingsWithoutReadingAnything() throws {
        let provider = FakeContextProvider()
        provider.selection = .permissionMissing
        let (client, model) = try connectedModel(provider)
        model.useSelection()
        XCTAssertNil(model.context)
        // One sentence on what happened, one on what to do, and the button that does it.
        let notice = try XCTUnwrap(model.notice)
        XCTAssertTrue(model.accessibilityBlocked)
        XCTAssertEqual(notice.happened, "Cosmos can't read the selection yet.")
        XCTAssertEqual(notice.next, "Turn Cosmos on in System Settings › Privacy & Security › Accessibility.")
        XCTAssertFalse(notice.happened.contains("/"), "no path in a sentence the owner reads")
        XCTAssertFalse(try XCTUnwrap(notice.next).contains("/"))
        XCTAssertTrue(try XCTUnwrap(notice.detail).contains(Bundle.main.bundleURL.path),
                      "the exact path stays behind Details")
        XCTAssertEqual(SystemSettings.accessibility.scheme, "x-apple.systempreferences")
        XCTAssertFalse(PanelState.isFailureMessage(model.message))
        XCTAssertEqual(provider.clipboardReads, 0)
        XCTAssertTrue(client.sentRequests.isEmpty)

        provider.selection = .empty(app: "Safari")
        model.useSelection()
        XCTAssertNil(model.context)
        XCTAssertEqual(model.message, "No selected text was found in Safari. Select text there, or use the clipboard instead.")
        provider.selection = .noApplication
        model.useSelection()
        XCTAssertEqual(model.message, "Switch to the app with the text you want, then come back and use its selection.")
        provider.selection = .text(app: "Safari", text: " \n")
        model.useSelection()
        XCTAssertNil(model.context)
        XCTAssertEqual(model.message, "The selection in Safari holds no text.")
        provider.clipboard = .empty(app: "Safari")
        model.useClipboard()
        XCTAssertNil(model.context)
        XCTAssertEqual(model.message, "The clipboard holds no text.")
    }

    // MARK: Destinations in the model

    @MainActor
    func testDestinationTravelsWithTheRequestAndResetsAfterwards() async throws {
        let (client, model) = try connectedModel(FakeContextProvider())
        XCTAssertEqual(model.destination, .thisMac)
        model.destination = .tv
        model.draft = "Show this"
        model.send()
        await settled(model)
        XCTAssertEqual(client.sentRequests, [TextRequest(text: "Show this", target: "android_tv")])
        XCTAssertEqual(model.destination, .thisMac, "a destination is for one request")
        XCTAssertEqual(model.message,
                       "Cosmos has your request, to continue on TV.")
        model.draft = "And this"
        model.send()
        await settled(model)
        XCTAssertEqual(client.sentRequests.last, TextRequest(text: "And this"))
    }

    @MainActor
    func testMissingLibraryCallsAreReportedInsteadOfNarrowingTheRequest() async throws {
        let provider = FakeContextProvider()
        provider.selection = .text(app: "Safari", text: "hello")
        let (client, model) = try connectedModel(provider)
        client.capabilities = .none
        XCTAssertEqual(model.capabilities, .none)
        model.useSelection()
        XCTAssertNil(model.context)
        XCTAssertEqual(model.message, ClientModel.contextUnavailableMessage)
        XCTAssertTrue(model.message.contains("not available in this build"))
        XCTAssertEqual(provider.selectionReads, 0, "nothing is read for a request that cannot carry it")
        model.destination = .phone
        model.draft = "Route"
        model.send()
        XCTAssertFalse(model.busy)
        XCTAssertTrue(client.sentRequests.isEmpty)
        XCTAssertEqual(model.message, ClientModel.targetsUnavailableMessage)
        XCTAssertEqual(model.destination, .phone, "the choice stays until the owner changes it")
        model.destination = .thisMac
        model.send()
        await settled(model)
        XCTAssertEqual(client.sentRequests, [TextRequest(text: "Route")])
    }

    // MARK: Status in the model

    @MainActor
    func testStatusLineFollowsTheSnapshotAndDrivesTheWaveform() throws {
        let (client, model) = try connectedModel(FakeContextProvider())
        XCTAssertNil(model.statusLine)
        client.publish(ClientSnapshot(phase: .connected, status: try status(.working, nil)))
        XCTAssertEqual(model.statusLine, StatusLine(title: "Working"))
        XCTAssertEqual(model.waveformPhase, .thinking)
        client.publish(ClientSnapshot(phase: .connected, status: try status(.shown, "android", privacy: "near_user")))
        XCTAssertEqual(model.statusLine?.title, "Completed")
        XCTAssertEqual(model.statusLine?.detail, "Shown on your phone")
        XCTAssertEqual(model.waveformPhase, .idle)
        client.publish(ClientSnapshot(phase: .connected, status: try status(.unknown, nil)))
        XCTAssertEqual(model.statusLine?.title, "Cannot confirm")
        XCTAssertEqual(model.statusLine?.detail, "I can't confirm whether that request was handled. It was not sent again.")
        XCTAssertEqual(model.waveformPhase, .idle, "an unconfirmed turn is not a failure")
        client.publish(ClientSnapshot(phase: .connected))
        XCTAssertNil(model.statusLine)
    }
}
