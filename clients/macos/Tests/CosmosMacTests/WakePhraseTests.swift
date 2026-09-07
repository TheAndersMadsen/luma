import XCTest
@testable import CosmosMac

/// The one decision the whole always-listening path turns on, tested as the
/// pure function it is: what fires, what must never fire, and what the owner's
/// own accent does to the two words.
final class WakePhraseTests: XCTestCase {
    // MARK: What fires

    func testHearsThePhraseHoweverTheRecogniserWroteIt() {
        for transcript in [
            "Hey Cosmos",
            "hey cosmos",
            "Hey, Cosmos.",
            "hey  cosmos",
            "HEY COSMOS",
            "Hey Cosmos!",
            // The recogniser runs the two words together when they are said fast.
            "heycosmos",
            "Hey Cosmo",
        ] {
            XCTAssertNotNil(WakePhrase.match(in: transcript), transcript)
        }
    }

    /// The owner is Danish. "Hej" is what he actually says, "kosmos" is how the
    /// word is spelled in his language, and a recogniser writes down what it
    /// hears rather than what was meant.
    func testHearsItInTheOwnersAccent() {
        for transcript in [
            "Hej Cosmos",
            "hej kosmos",
            "Hey Kosmos",
            "Hej, kosmos, find en cafe",
            "hei cosmos",
            "hey kosmoz",
            "hey cosmus",
            // One slip inside a six-letter word is a mishearing, not a word.
            "hey casmos",
            "hey cosmoss",
            // Measured, not guessed: this is what the on-device transcriber
            // wrote when a Danish voice read "Hey Cosmos" aloud.
            "Here cosmos, fin cafes near me.",
            "hear cosmos",
        ] {
            XCTAssertNotNil(WakePhrase.match(in: transcript), transcript)
        }
    }

    func testTakesTheLastPhraseSoAskingAgainWins() {
        let match = WakePhrase.match(in: "Hey Cosmos what is the weather Hey Cosmos cancel that")
        XCTAssertEqual(match?.request, "cancel that")
    }

    // MARK: What must never fire

    func testDoesNotFireOnAnythingElse() {
        for transcript in [
            "",
            "cosmos",
            "the cosmos is very large",
            "hey",
            "hey there",
            // The near misses that matter: ordinary words a recogniser writes
            // when the room is noisy and nobody said the phrase at all.
            "hey cosmic rays are fascinating",
            "hey Costco is closed",
            "hey close the door",
            "hey chaos",
            "hey customs took my parcel",
            "hey compass",
            "hey cousins",
            "hey Cosmopolitan",
            // The name on its own, however it is introduced.
            "play Cosmos by Carl Sagan",
            "I was reading about the cosmos",
            "her name is Cosima",
            // A greeting to somebody else.
            "hey Cortana",
            "hey Siri",
            "hey Google",
            // The wider greetings buy nothing on their own.
            "here",
            "over here",
            "did you hear that",
            "here comes trouble",
            "I put it here, cosmically speaking",
        ] {
            XCTAssertNil(WakePhrase.match(in: transcript), transcript)
        }
    }

    /// The name must follow the greeting immediately. A sentence that happens
    /// to contain both words is not the phrase.
    func testTheTwoWordsMustBeAdjacent() {
        XCTAssertNil(WakePhrase.match(in: "hey, have you read about the cosmos"))
        XCTAssertNil(WakePhrase.match(in: "hey I said cosmos"))
        XCTAssertNotNil(WakePhrase.match(in: "and then I said hey cosmos"))
    }

    // MARK: The request after it

    func testTakesWhatWasSaidAfterThePhrase() {
        XCTAssertEqual(WakePhrase.match(in: "Hey Cosmos, find cafés near me")?.request,
                       "find cafés near me")
        XCTAssertEqual(WakePhrase.match(in: "hey cosmos what's the weather in Copenhagen?")?.request,
                       "what's the weather in Copenhagen?")
        // The phrase on its own carries no request; the client waits for one.
        XCTAssertEqual(WakePhrase.match(in: "Hey Cosmos")?.request, "")
        XCTAssertEqual(WakePhrase.match(in: "Hey Cosmos.")?.request, "")
    }

    func testKeepsWhatWasHeardForTheRecord() {
        XCTAssertEqual(WakePhrase.match(in: "well then Hej Kosmos, hello")?.heard, "Hej Kosmos")
    }

    // MARK: The pieces

    func testFoldsTheDanishLettersTheWayARecogniserWritesThem() {
        XCTAssertEqual(WakePhrase.fold("Kosmøs"), "kosmos")
        XCTAssertEqual(WakePhrase.fold("HÉJ"), "hej")
        XCTAssertEqual(WakePhrase.fold("Åse"), "Ase".lowercased())
    }

    func testDistanceStopsAtTheLimit() {
        XCTAssertEqual(WakePhrase.distance("cosmos", "cosmos", limit: 1), 0)
        XCTAssertEqual(WakePhrase.distance("kosmos", "cosmos", limit: 1), 1)
        XCTAssertGreaterThan(WakePhrase.distance("cosmic", "cosmos", limit: 1), 1)
        XCTAssertGreaterThan(WakePhrase.distance("hello", "cosmos", limit: 1), 1)
    }

    // MARK: The rolling window

    /// The buffer is bounded and replaced; it never grows with the room.
    func testTheRollingWindowKeepsOnlyTheLastFewSeconds() {
        var rolling = RollingTranscript()
        for _ in 0..<50 { rolling.append(String(repeating: "a", count: 40)) }
        XCTAssertEqual(rolling.text.count, RollingTranscript.maximumCharacters)
        rolling.clear()
        XCTAssertEqual(rolling.text, "")
        rolling.append("hey")
        XCTAssertEqual(rolling.with(volatile: "cosmos"), "hey cosmos")
        XCTAssertNotNil(WakePhrase.match(in: rolling.with(volatile: "cosmos")))
    }
}
