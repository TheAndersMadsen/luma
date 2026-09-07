import AppKit
import Foundation
import XCTest
@testable import CosmosMac

/// The rules a reply follows when it shows itself: how long it stays, what keeps
/// it, and the rooms it must not appear in at all.
final class AutoPresentTests: XCTestCase {
    private let digest = String(repeating: "ab", count: 32)

    private func card(_ content: DisplayContent, privacy: String = "shared_room",
                      id: UUID = UUID()) throws -> DisplayCard {
        try DisplayCard(actionID: id, turnID: UUID(), generation: 1, contentDigest: digest,
                        expiresAtMs: 1, content: content, privacy: privacy)
    }

    private func speech(_ text: String, id: UUID = UUID()) throws -> SpeechReply {
        try SpeechReply(actionID: id, turnID: UUID(), generation: 1, contentDigest: digest,
                        expiresAtMs: 1, text: text, format: "audio/mpeg", byteLength: 32)
    }

    private func ceremony(privacy: String = "shared_room", id: UUID = UUID()) throws -> ConfirmationRequest {
        try ConfirmationRequest(
            grantID: id, actionID: UUID(), turnID: UUID(), generation: 1,
            description: ActionDescription(verb: "open", subject: "the notes", deviceKind: "mac",
                                           effect: "opens a document", privacyClass: privacy),
            descriptionDigest: digest, risk: .low, attestation: .foregroundTap,
            privacy: privacy, expiresAtMs: 1)
    }

    private func task(privacy: String = "shared_room", id: UUID = UUID()) throws -> DeviceTask {
        try DeviceTask(actionID: id, turnID: UUID(), generation: 1, channel: "action.open",
                       contentDigest: digest, idempotencyKey: digest,
                       operation: .open(locator: .app(id: "com.apple.Notes"), version: nil,
                                        position: nil, label: "Notes"),
                       expiresAtMs: 1, reportByMs: 1, privacy: privacy)
    }

    // MARK: How long a reply stays

    func testDwellFollowsReadingTimeAndStaysWithinSensibleBounds() {
        // A short answer needs a few seconds, and the floor is what makes it
        // possible to notice the panel at all.
        XCTAssertEqual(AutoPresent.dwell(for: "Yes."), AutoPresent.shortestDwell, accuracy: 0.001)
        XCTAssertEqual(AutoPresent.dwell(for: ""), AutoPresent.shortestDwell, accuracy: 0.001)
        // Fifteen words is the point where reading time overtakes the floor:
        // 1.5 s to notice it plus 15 words at 200 words a minute is 6.0 s.
        XCTAssertEqual(AutoPresent.dwell(for: Array(repeating: "word", count: 15).joined(separator: " ")),
                       6, accuracy: 0.001)
        XCTAssertEqual(AutoPresent.dwell(for: Array(repeating: "word", count: 40).joined(separator: " ")),
                       13.5, accuracy: 0.001)
        // A long reply is given longer, up to the ceiling, and never more.
        XCTAssertEqual(AutoPresent.dwell(for: Array(repeating: "word", count: 200).joined(separator: " ")),
                       AutoPresent.longestDwell, accuracy: 0.001)
        XCTAssertEqual(AutoPresent.dwell(for: String(repeating: "word ", count: 5000)),
                       AutoPresent.longestDwell, accuracy: 0.001)
        // The dwell never decreases as the reply grows.
        var previous = 0.0
        for count in stride(from: 0, through: 120, by: 5) {
            let value = AutoPresent.dwell(for: Array(repeating: "word", count: count).joined(separator: " "))
            XCTAssertGreaterThanOrEqual(value, previous)
            XCTAssertGreaterThanOrEqual(value, AutoPresent.shortestDwell)
            XCTAssertLessThanOrEqual(value, AutoPresent.longestDwell)
            previous = value
        }
    }

    func testWordsAreCountedTheWayAReaderCountsThem() {
        XCTAssertEqual(AutoPresent.words(in: ""), 0)
        XCTAssertEqual(AutoPresent.words(in: "   \n\t "), 0)
        XCTAssertEqual(AutoPresent.words(in: "one"), 1)
        XCTAssertEqual(AutoPresent.words(in: "  one   two\nthree\tfour "), 4)
        XCTAssertEqual(AutoPresent.words(in: "Kaffe på Nørrebro — 15 min."), 6)
    }

    func testReadableCollectsEverythingOnScreenInReadingOrder() throws {
        XCTAssertEqual(AutoPresent.readable(card: nil, speech: nil, task: nil), "")
        let text = try card(.text("The kettle is on."))
        XCTAssertEqual(AutoPresent.readable(card: text, speech: nil, task: nil), "The kettle is on.")

        let places = try card(.places(query: "Cafés near you",
                                      items: [PlaceItem(placeID: "a", name: "Kaffe", address: "Nørrebrogade 1",
                                                        sourceURL: nil)],
                                      credits: [[.text("Google")]]))
        let placesText = AutoPresent.readable(card: places, speech: nil, task: nil)
        XCTAssertEqual(placesText, "Cafés near you Kaffe Nørrebrogade 1")
        XCTAssertFalse(placesText.contains("Google"), "a credit line is not something the owner reads for meaning")

        let choices = try card(.choices(title: "Which one?",
                                        items: [ChoiceItem(id: "1", title: "The first", detail: "nearby"),
                                                ChoiceItem(id: "2", title: "The second", detail: "")]))
        XCTAssertEqual(AutoPresent.readable(card: choices, speech: nil, task: nil),
                       "Which one? The first nearby The second")

        // Everything on screen counts, so the panel is timed by what it shows.
        let together = AutoPresent.readable(
            card: text, speech: try speech("Spoken words too."),
            task: TaskCardModel(state: Words.completed, sentence: "Notes is open on this Mac.", detail: "detail"))
        XCTAssertEqual(together, "Completed Notes is open on this Mac. detail The kettle is on. Spoken words too.")
        XCTAssertGreaterThan(AutoPresent.words(in: together), AutoPresent.words(in: "The kettle is on."),
                             "the panel is timed by everything it shows, not by the card alone")
    }

    // MARK: What arrived

    func testArrivalsRankTheMostUrgentFirstAndCarryTheRoutedClass() throws {
        XCTAssertTrue(AutoPresent.arrivals(display: nil, speech: nil, confirmation: nil, task: nil).isEmpty)

        let display = try card(.text("hello"))
        let spoken = try speech("hello")
        let question = try ceremony()
        let command = try task()
        let arrivals = AutoPresent.arrivals(display: display, speech: spoken,
                                            confirmation: question, task: command)
        XCTAssertEqual(arrivals.map(\.kind), [.ceremony, .task, .card, .speech])
        XCTAssertEqual(arrivals.map(\.id), [question.grantID, command.actionID,
                                            display.actionID, spoken.actionID])
        XCTAssertEqual(arrivals.map(\.isPrivate), [false, false, false, false])

        for privacy in ["near_user", "private"] {
            let personal = AutoPresent.arrivals(display: try card(.text("hello"), privacy: privacy),
                                                speech: nil,
                                                confirmation: try ceremony(privacy: privacy),
                                                task: try task(privacy: privacy))
            XCTAssertEqual(personal.map(\.isPrivate), [true, true, true])
        }
        for privacy in ["public", "shared_room"] {
            XCTAssertFalse(AutoPresent.isPrivate(privacy))
        }
    }

    // MARK: Whether it may appear at all

    private func arrival(_ kind: AutoPresent.Arrival.Kind = .card,
                         isPrivate: Bool = false) -> AutoPresent.Arrival {
        AutoPresent.Arrival(kind: kind, id: UUID(), isPrivate: isPrivate)
    }

    func testAReplyPresentsItselfInAnOrdinaryRoom() {
        XCTAssertEqual(AutoPresent.decide(arrival(), room: AutoPresent.Room(),
                                          showing: false, opening: nil), .present)
        XCTAssertEqual(AutoPresent.decide(arrival(.speech), room: AutoPresent.Room(),
                                          showing: false, opening: nil), .present)
        XCTAssertEqual(AutoPresent.decide(arrival(.task), room: AutoPresent.Room(),
                                          showing: false, opening: nil), .present,
                       "a task card presents itself like any other reply")
    }

    func testNothingPresentsItselfWhereItWouldBeRudeOrWrong() {
        let rooms: [(String, AutoPresent.Room)] = [
            ("the owner turned it off", AutoPresent.Room(enabled: false)),
            ("the screen is locked", AutoPresent.Room(screenLocked: true)),
            ("a Focus is on", AutoPresent.Room(focusOn: true)),
            ("an app is in full screen", AutoPresent.Room(fullScreen: true)),
            ("the menu-bar item is out of reach", AutoPresent.Room(anchored: false)),
        ]
        XCTAssertFalse(AutoPresent.Room().interrupts, "an ordinary room interrupts nothing")
        for (reason, room) in rooms {
            XCTAssertEqual(room.interrupts, room.enabled, "\(reason): the switch is not an interruption")
            for kind in AutoPresent.Arrival.Kind.allCases {
                XCTAssertEqual(AutoPresent.decide(arrival(kind), room: room, showing: false, opening: nil),
                               .hold, "\(kind) must not present itself while \(reason)")
            }
        }
        // A ceremony is no exception: a question put on a locked screen, or over
        // a Focus, is exactly the interruption the owner asked not to have.
        XCTAssertEqual(AutoPresent.decide(arrival(.ceremony), room: AutoPresent.Room(screenLocked: true),
                                          showing: false, opening: nil), .hold)
    }

    func testPrivateContentIsNeverRevealedByThePanelPresentingItself() {
        // The runtime releases a private card to an unlocked foreground; the
        // owner's own open is what makes one, so this path never creates one.
        XCTAssertEqual(AutoPresent.decide(arrival(isPrivate: true), room: AutoPresent.Room(),
                                          showing: false, opening: nil), .hold)
        XCTAssertEqual(AutoPresent.decide(arrival(.ceremony, isPrivate: true), room: AutoPresent.Room(),
                                          showing: false, opening: nil), .hold)
        XCTAssertEqual(AutoPresent.decide(arrival(.task, isPrivate: true), room: AutoPresent.Room(),
                                          showing: false, opening: nil), .hold)
        // A panel already on screen is a foreground the runtime already allowed,
        // so a private card delivered into it behaves like any other.
        XCTAssertEqual(AutoPresent.decide(arrival(isPrivate: true), room: AutoPresent.Room(),
                                          showing: true, opening: .automatic), .present)
    }

    func testACeremonyPresentsItselfAndIsNeverTakenAway() {
        // Dismissing a confirmation would be answering it, so it stays.
        XCTAssertEqual(AutoPresent.decide(arrival(.ceremony), room: AutoPresent.Room(),
                                          showing: false, opening: nil), .stay)
        XCTAssertEqual(AutoPresent.decide(arrival(.ceremony), room: AutoPresent.Room(),
                                          showing: true, opening: .automatic), .stay)
        // And nothing on screen can time it out either.
        XCTAssertTrue(AutoPresent.holdsOpen(pointerInside: false, windowIsKey: false, drafting: false,
                                            choosing: false, playing: false, workingHere: false,
                                            ceremony: true))
    }

    func testAPanelTheOwnerOpenedBehavesExactlyAsItDoesToday() {
        for kind in AutoPresent.Arrival.Kind.allCases {
            XCTAssertEqual(AutoPresent.decide(arrival(kind), room: AutoPresent.Room(),
                                              showing: true, opening: .owner), .stay,
                           "an owner's panel is never taken away by a countdown")
            // Even switched off, an open panel keeps showing what arrives.
            XCTAssertEqual(AutoPresent.decide(arrival(kind), room: AutoPresent.Room(enabled: false),
                                              showing: true, opening: .owner), .stay)
            XCTAssertEqual(AutoPresent.decide(arrival(kind, isPrivate: true),
                                              room: AutoPresent.Room(screenLocked: true),
                                              showing: true, opening: .owner), .stay)
        }
    }

    // MARK: Whether it may leave yet

    func testAnySignOfAttentionKeepsThePanel() {
        XCTAssertFalse(AutoPresent.holdsOpen(pointerInside: false, windowIsKey: false, drafting: false,
                                             choosing: false, playing: false, workingHere: false,
                                             ceremony: false),
                       "an unattended panel is the only one that fades")
        let signals: [(String, () -> Bool)] = [
            ("the pointer is over the panel", {
                AutoPresent.holdsOpen(pointerInside: true, windowIsKey: false, drafting: false,
                                      choosing: false, playing: false, workingHere: false, ceremony: false)
            }),
            ("the panel is taking keystrokes", {
                AutoPresent.holdsOpen(pointerInside: false, windowIsKey: true, drafting: false,
                                      choosing: false, playing: false, workingHere: false, ceremony: false)
            }),
            ("the owner started typing an ask", {
                AutoPresent.holdsOpen(pointerInside: false, windowIsKey: false, drafting: true,
                                      choosing: false, playing: false, workingHere: false, ceremony: false)
            }),
            ("the send-to picker is open", {
                AutoPresent.holdsOpen(pointerInside: false, windowIsKey: false, drafting: false,
                                      choosing: true, playing: false, workingHere: false, ceremony: false)
            }),
            ("the reply is still being spoken", {
                AutoPresent.holdsOpen(pointerInside: false, windowIsKey: false, drafting: false,
                                      choosing: false, playing: true, workingHere: false, ceremony: false)
            }),
            ("a command is running here", {
                AutoPresent.holdsOpen(pointerInside: false, windowIsKey: false, drafting: false,
                                      choosing: false, playing: false, workingHere: true, ceremony: false)
            }),
        ]
        for (reason, holds) in signals {
            XCTAssertTrue(holds(), "the panel stays while \(reason)")
        }
    }

    // MARK: What the room is doing

    func testOnlyAFullScreenSpaceCoversAWholeScreen() {
        let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
        XCTAssertTrue(AutoPresent.covers(window: screen, screen: screen))
        XCTAssertTrue(AutoPresent.covers(window: CGRect(x: -1, y: -1, width: 1514, height: 984), screen: screen))
        // A maximized window stops below the menu bar, so it is not full screen.
        XCTAssertFalse(AutoPresent.covers(window: CGRect(x: 0, y: 0, width: 1512, height: 944), screen: screen))
        XCTAssertFalse(AutoPresent.covers(window: CGRect(x: 200, y: 100, width: 600, height: 400), screen: screen))
        // A full-screen app on the other display leaves this one alone.
        let other = CGRect(x: 1512, y: 0, width: 2560, height: 1440)
        XCTAssertFalse(AutoPresent.covers(window: other, screen: screen))
    }

    func testWindowServerRectanglesAreReadInCocoaCoordinates() {
        // The window server counts down from the top of the primary display.
        XCTAssertEqual(AutoPresent.cocoaRect(fromWindowServer: CGRect(x: 0, y: 0, width: 1512, height: 982),
                                             primaryMaxY: 982),
                       CGRect(x: 0, y: 0, width: 1512, height: 982))
        XCTAssertEqual(AutoPresent.cocoaRect(fromWindowServer: CGRect(x: 10, y: 38, width: 400, height: 300),
                                             primaryMaxY: 982),
                       CGRect(x: 10, y: 644, width: 400, height: 300))
    }

    func testAFocusIsReadFromItsOwnAssertions() {
        XCTAssertFalse(AutoPresent.focusOn(assertions: nil), "no store means no Focus was ever set up here")
        XCTAssertFalse(AutoPresent.focusOn(assertions: Data("not json".utf8)))
        XCTAssertFalse(AutoPresent.focusOn(assertions: Data(#"{"data":[]}"#.utf8)))
        XCTAssertFalse(AutoPresent.focusOn(assertions:
            Data(#"{"data":[{"storeAssertionRecords":[]}]}"#.utf8)))
        XCTAssertFalse(AutoPresent.focusOn(assertions:
            Data(#"{"data":[{"storeInvalidationRecords":[{"a":1}]}]}"#.utf8)),
                       "an assertion that ended is not a Focus that is on")
        XCTAssertTrue(AutoPresent.focusOn(assertions:
            Data(#"{"data":[{"storeAssertionRecords":[{"assertionUUID":"x"}]}]}"#.utf8)))
    }

    // MARK: The glyph while a reply waits

    @MainActor
    func testTheGlyphSaysSomeoneIsWaitedForWhileAReplyIsUnread() async throws {
        let bridge = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let model = ClientModel(client: bridge, initialServerOrigin: "https://center.example")
        XCTAssertFalse(model.unshownReply)
        XCTAssertEqual(model.presence, .quiet)

        let reply = try card(.text("The kettle is on."))
        bridge.publish(ClientSnapshot(phase: .connected, display: reply))
        await Task.yield()
        XCTAssertTrue(model.unshownReply)
        XCTAssertEqual(model.presence, .waiting, "a reply nobody has read is waiting for the owner")

        model.setVisible(true)
        XCTAssertFalse(model.unshownReply, "it is not waiting once the panel is showing it")
        XCTAssertEqual(model.presence, .quiet)

        // Once this Mac has rendered the card, the glyph goes quiet again even
        // after the panel leaves: the owner has seen it.
        model.displayCommitted(reply)
        for _ in 0..<200 where bridge.acknowledgedCards.isEmpty { await Task.yield() }
        XCTAssertEqual(bridge.acknowledgedCards, [reply])
        model.setVisible(false)
        XCTAssertFalse(model.unshownReply, "a reply already shown here waits for nobody")
        XCTAssertEqual(model.presence, .quiet)
    }

    /// Cosmos chooses the screen before anyone is in front of it, so a card can be
    /// bound for this Mac while the panel is closed. The runtime holds it and hands
    /// it over when this Mac says it is in front, which makes the foreground report
    /// the thing that releases it — not a consequence of a card already being here.
    @MainActor
    func testComingToTheFrontIsWhatReleasesAReplyBoundForThisMac() async throws {
        let bridge = try MockClientBridge()
        let model = ClientModel(client: bridge, initialServerOrigin: "https://center.example")
        model.prepare()
        for _ in 0..<400 where model.descriptor == nil { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNotNil(model.descriptor)
        model.connect()
        for _ in 0..<400 where model.busy { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(bridge.visibilityReports, [], "nothing is claimed before the panel is on screen")

        let waiting = WaitingReply(id: UUID(), kind: .card, origin: "pin",
                                   privacy: "near_user", expiresAtMs: 4_102_444_800_000)
        bridge.publish(ClientSnapshot(phase: .connected, visible: false, waiting: waiting))
        await Task.yield()
        XCTAssertEqual(model.presence, .waiting, "the glyph says one is held for this Mac")
        XCTAssertNil(model.display, "the runtime holds the card; nothing is invented here")

        model.setVisible(true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(bridge.visibilityReports, [true], "the report is what the runtime waits for")
        XCTAssertFalse(model.heldForThisMac, "the panel is in front; nothing is held any more")

        let reply = try card(.text("The kettle is on."))
        bridge.publish(ClientSnapshot(phase: .connected, visible: true, display: reply))
        await Task.yield()
        XCTAssertEqual(model.display, reply, "the held card arrives once this Mac is in front")
    }
}
