import Foundation

/// Finding "Hey Cosmos" in what the recogniser wrote down.
///
/// The whole always-listening path turns on this one decision, so it is a pure
/// function over a string: no audio, no framework, no state. A transcript is
/// never a spelling of what a person said — it is one recogniser's guess, made
/// worse by a Danish accent, by a room, and by the two words arriving in
/// different results. So the match is deliberately generous about how the name
/// comes out and deliberately strict about the shape: a greeting immediately
/// followed by the name, and nothing else counts.
///
/// What follows the phrase in the same transcript is the request. Nothing here
/// decides to send it; it only says where the phrase ended.
public enum WakePhrase {
    /// The phrase as the owner reads it, everywhere it is written on screen.
    public static let display = "Hey Cosmos"

    /// One thing the matcher found: where the phrase ended, and whatever the
    /// same transcript already carries after it.
    public struct Match: Equatable, Sendable {
        /// The greeting and the name exactly as the recogniser wrote them, for
        /// the tests and for the Details disclosure. Never shown as a state.
        public let heard: String
        /// The words after the phrase, trimmed of the comma people speak after
        /// it. Empty when the phrase is all that has been said so far.
        public let request: String

        public init(heard: String, request: String) {
            self.heard = heard
            self.request = request
        }
    }

    // MARK: What the two words are allowed to look like

    /// Greetings a recogniser writes for the sound at the front of the phrase,
    /// including the Danish "hej" the owner says without thinking about it.
    /// The set is closed: a greeting is never guessed at by distance, because
    /// two-and-three-letter words are exactly where guessing invents matches.
    ///
    /// "here" and "hear" are in it because that is what the on-device
    /// transcriber actually wrote for a Danish "hey" — measured, not guessed.
    /// They are safe only because the name has to follow immediately.
    static let greetings: Set<String> = ["hey", "hej", "hei", "heh", "hay", "hi", "hy", "ay", "ey",
                                         "here", "hear"]

    /// Spellings of the name that are short enough that a distance test would
    /// be reckless, plus the two ordinary ones.
    static let names: Set<String> = ["cosmos", "kosmos", "cosmo", "kosmo", "cosmoz", "kozmos"]

    /// The two spellings a mishearing is measured against. "kosmos" is not a
    /// mishearing in Danish, it is the word, so it earns its own centre rather
    /// than spending the one edit that a further slip would need.
    static let nameCentres = ["cosmos", "kosmos"]

    /// The phrase said as one word, which is how it comes back when it is said
    /// quickly.
    static let joined: Set<String> = ["heycosmos", "heykosmos", "hejcosmos", "hejkosmos", "hicosmos"]

    // MARK: The match

    /// The last "Hey Cosmos" in this transcript, with everything after it.
    ///
    /// The last one and not the first: a rolling transcript can still be
    /// carrying the phrase from a moment ago, and the owner saying it again is
    /// them asking for this one, not that one.
    public static func match(in transcript: String) -> Match? {
        let tokens = self.tokens(in: transcript)
        guard !tokens.isEmpty else { return nil }
        for index in stride(from: tokens.count - 1, through: 0, by: -1) {
            let token = tokens[index]
            if joined.contains(token.folded) {
                return made(from: transcript, heardFrom: token, through: token)
            }
            guard index > 0, isName(token.folded), greetings.contains(tokens[index - 1].folded) else {
                continue
            }
            return made(from: transcript, heardFrom: tokens[index - 1], through: token)
        }
        return nil
    }

    /// True when this word is the name, allowing one slip in a word long enough
    /// that one slip is a mishearing rather than a different word.
    static func isName(_ folded: String) -> Bool {
        if names.contains(folded) { return true }
        guard folded.count >= 5, folded.count <= 7 else { return false }
        return nameCentres.contains { distance(folded, $0, limit: 1) <= 1 }
    }

    private static func made(from transcript: String, heardFrom first: Token,
                             through last: Token) -> Match {
        let heard = String(transcript[first.start..<last.end])
        let tail = transcript[last.end...]
        // People speak a comma after the phrase and recognisers write one.
        let request = tail.drop { $0.isWhitespace || $0.isPunctuation || $0.isNewline }
        return Match(heard: heard,
                     request: String(request).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // MARK: Words

    /// One word of the transcript: where it sits in the original text, and the
    /// comparable form of it.
    struct Token: Equatable {
        let start: String.Index
        let end: String.Index
        let folded: String
    }

    /// Splits on everything that is not a letter or a digit, so punctuation,
    /// quotation marks and the recogniser's own commas never join a word.
    static func tokens(in text: String) -> [Token] {
        var values: [Token] = []
        var start: String.Index?
        for index in text.indices {
            if text[index].isLetter || text[index].isNumber {
                if start == nil { start = index }
            } else if let began = start {
                values.append(Token(start: began, end: index, folded: fold(String(text[began..<index]))))
                start = nil
            }
        }
        if let began = start {
            values.append(Token(start: began, end: text.endIndex, folded: fold(String(text[began...]))))
        }
        return values
    }

    /// Lower case, without accents, and with the three Danish letters written
    /// the way an English recogniser writes them, so "kosmøs" and "Kosmos"
    /// compare as the same word.
    static func fold(_ word: String) -> String {
        let danish = word
            .replacingOccurrences(of: "ø", with: "o").replacingOccurrences(of: "Ø", with: "O")
            .replacingOccurrences(of: "æ", with: "ae").replacingOccurrences(of: "Æ", with: "AE")
            .replacingOccurrences(of: "å", with: "a").replacingOccurrences(of: "Å", with: "A")
        return danish.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive],
                              locale: Locale(identifier: "en_US_POSIX"))
    }

    /// Levenshtein distance, stopped as soon as it passes the limit. The words
    /// compared here are six letters long, so the plain table is the whole cost.
    static func distance(_ left: String, _ right: String, limit: Int) -> Int {
        let a = Array(left), b = Array(right)
        guard abs(a.count - b.count) <= limit else { return limit + 1 }
        var previous = Array(0...b.count)
        var current = previous
        for i in 1...max(a.count, 1) where !a.isEmpty {
            current[0] = i
            var best = current[0]
            for j in 1...max(b.count, 1) where !b.isEmpty {
                current[j] = a[i - 1] == b[j - 1]
                    ? previous[j - 1]
                    : 1 + min(previous[j - 1], previous[j], current[j - 1])
                best = min(best, current[j])
            }
            if best > limit { return limit + 1 }
            previous = current
        }
        return a.isEmpty ? b.count : (b.isEmpty ? a.count : previous[b.count])
    }
}
