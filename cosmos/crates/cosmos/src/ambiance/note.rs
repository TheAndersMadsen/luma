//! The owner's own notes, as the runtime writes and reads them.
//!
//! Cognition is never handed the note store. Below the shared-room ceiling the
//! model may see the request, so it proposes `remember` with the words to keep
//! or `recall` with what to look for, and the runtime does the writing and the
//! reading under its own authority. Above that ceiling the request never
//! leaves the runtime at all, so the runtime reads the request's own shape
//! here instead. Either way the bounds, the class, the store call and the
//! sentence said back belong to the runtime.
//!
//! A note is the owner's content, so a stored note is private by provenance
//! whatever the request classified at, and it is read back exactly the way
//! every other private reply is: a card on a personal installation the owner
//! declared for the class, never speech, never a television. The sentence that
//! confirms a write is not the note: it names nothing that was kept, so it is
//! shared-safe and can be said wherever the request came from.
use super::PrivacyClass;
use serde::{Deserialize, Serialize};

/// A note body. Long enough for a paragraph the owner dictates, short enough
/// that one turn cannot fill the store.
pub const MAX_TEXT_BYTES: usize = 2000;
/// A title is for finding the note again, not for holding it.
pub const MAX_TITLE_BYTES: usize = 80;
/// How much of the note the runtime keeps when it has to derive a title.
const DERIVED_TITLE_CHARS: usize = 48;

/// Notes one principal may have written inside the window. Voice provenance
/// caps what a request can authorize but not how often it can arrive, so an
/// accumulation of low-risk writes from replayed or synthesized audio is
/// bounded here rather than left to the classifier (§4.5(d), §10).
pub const BUDGET_WINDOW_MS: i64 = 600_000;
pub const BUDGET_LIMIT: usize = 12;

/// How many notes are read for one reply, and how much of each is shown.
pub const READ_LIMIT: i32 = 24;
const MAX_ENTRY_CHARS: usize = 400;
const MAX_CARD_BYTES: usize = 3800;

/// Note writes in the rolling window. Same shape and the same reason as the
/// device-action budget: a bound the owner should never reach.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    #[serde(default)]
    pub written_at_ms: Vec<i64>,
}

impl Budget {
    pub fn prune(&mut self, now: i64) {
        self.written_at_ms
            .retain(|at| now.saturating_sub(*at) < BUDGET_WINDOW_MS);
        while self.written_at_ms.len() > BUDGET_LIMIT + 2 {
            self.written_at_ms.remove(0);
        }
    }

    pub fn exhausted(&self, now: i64) -> bool {
        self.written_at_ms
            .iter()
            .filter(|at| now.saturating_sub(**at) < BUDGET_WINDOW_MS)
            .count()
            >= BUDGET_LIMIT
    }

    pub fn spend(&mut self, now: i64) {
        self.written_at_ms.push(now);
        self.prune(now);
    }
}

/// Why the runtime would not write a note. The owner reads this in the ledger;
/// the surface that asked hears one sentence for every one of them, because a
/// refusal that explains itself out loud is a refusal that tells a room
/// something about the request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Denial {
    /// The words classify above the class a note may hold. Note bodies the
    /// runtime writes are stored as plaintext this server can read, so a
    /// secret does not become one.
    Sensitive,
    /// The turn carried the owner's own screen text. A page the owner is
    /// reading proposes nothing durable: reading it back onto the owner's own
    /// personal screen is harmless, authoring memory from it is not.
    ScreenContext,
    /// Too many notes inside the rolling window.
    Budget,
}

/// One admitted note write, as the turn remembers it. Content-free: how much
/// was kept, whether it carries a title, the class it was kept at, and what
/// the store actually did. Never the words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Write {
    pub bytes: u32,
    pub titled: bool,
    pub privacy: PrivacyClass,
    /// What the store did. `None` until it has answered, which is the only
    /// state in which no surface may say the note exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved: Option<bool>,
}

/// One bounded note the runtime is about to write. Building a draft is the
/// only way to reach the note store from a request, so every note written
/// this way passed these bounds and carries a title.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    title: String,
    text: String,
    proposed_title: bool,
}

impl Draft {
    /// Bound one proposed note. `title` is a suggestion: unusable or absent,
    /// the runtime derives one from the note's own opening words so the owner
    /// has something to recognize in Center's list.
    pub fn new(title: Option<&str>, text: &str) -> Option<Self> {
        let text = collapse(text);
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            return None;
        }
        let proposed = title
            .map(collapse)
            .filter(|title| !title.is_empty() && title.len() <= MAX_TITLE_BYTES);
        let proposed_title = proposed.is_some();
        let title = proposed.unwrap_or_else(|| derive_title(&text));
        Some(Self {
            title,
            text,
            proposed_title,
        })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// Whether cognition supplied a usable title rather than the runtime.
    pub fn proposed_title(&self) -> bool {
        self.proposed_title
    }

    pub fn bytes(&self) -> u32 {
        u32::try_from(self.title.len() + self.text.len()).unwrap_or(u32::MAX)
    }

    /// The class this note is kept at. A note is the owner's own memory, so it
    /// is private by provenance; the classifier can only raise it further, and
    /// anything it raises above `private` is refused rather than stored.
    pub fn privacy(&self) -> PrivacyClass {
        PrivacyClass::Private
            .max(super::runtime::input_privacy(&self.title))
            .max(super::runtime::input_privacy(&self.text))
    }

    /// What the store indexes. The same compact `{title,text}` object Center
    /// already projects for a note this server authored, so a note written
    /// here appears in Notes with its title and its body rather than as one
    /// undifferentiated line.
    pub fn body(&self) -> String {
        serde_json::json!({"title": self.title, "text": self.text}).to_string()
    }
}

/// Collapse a proposed string to one line of ordinary text.
fn collapse(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut space = false;
    for c in value.chars() {
        if c.is_whitespace() || c.is_control() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    out
}

/// A title from the note's own opening, cut at a word boundary.
fn derive_title(text: &str) -> String {
    let mut title = String::new();
    for word in text.split(' ') {
        // A sentence end is a better title boundary than a character count.
        let end = word.ends_with(['.', '!', '?', ';', ':']);
        let word = word.trim_end_matches(['.', '!', '?', ';', ':', ',']);
        if !title.is_empty() {
            if title.chars().count() + 1 + word.chars().count() > DERIVED_TITLE_CHARS {
                break;
            }
            title.push(' ');
        }
        title.push_str(word);
        if title.len() > MAX_TITLE_BYTES {
            // One word longer than a whole title: keep a readable prefix.
            title = title.chars().take(DERIVED_TITLE_CHARS).collect();
            break;
        }
        if end {
            break;
        }
    }
    if title.trim().is_empty() {
        return "Note".to_owned();
    }
    title
}

/// What a request the runtime must answer by itself is asking of the notes.
///
/// Cognition never sees a request above the shared-room ceiling, so for those
/// the reading is the runtime's own and deterministic: a save-shaped opening
/// in either of the owner's languages, with the rest of the sentence as the
/// note. Everything else is a question about what is already there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask<'a> {
    Save(&'a str),
    Read,
}

/// Save-shaped openings, longest first so `note that` wins over `note`.
/// Written lowercase; matching ignores case.
const OPENERS: &[&str] = &[
    // English
    "add to my notes that ",
    "add to my notes ",
    "add a note that ",
    "add a note ",
    "put in my notes that ",
    "put in my notes ",
    "save a note that ",
    "save a note ",
    "make a note that ",
    "make a note of ",
    "make a note ",
    "keep in mind that ",
    "write down that ",
    "write down ",
    "note to self",
    "note down that ",
    "note down ",
    "note that ",
    "note this ",
    "note ",
    "remember that ",
    "remember this ",
    "remember ",
    // Danish
    "tilføj til mine noter at ",
    "tilføj til mine noter ",
    "skriv i mine noter at ",
    "skriv i mine noter ",
    "skriv ned at ",
    "skriv ned ",
    "lav en note om at ",
    "lav en note om ",
    "lav en note ",
    "gem i mine noter at ",
    "gem i mine noter ",
    "notér ned at ",
    "noter ned at ",
    "notér ned ",
    "noter ned ",
    "notér at ",
    "noter at ",
    "notér ",
    "husk på at ",
    "husk at ",
    "husk ",
    "gem at ",
];

/// Openings that make the rest a question however the sentence began.
const INTERROGATIVES: &[&str] = &[
    "what ",
    "which ",
    "who ",
    "where ",
    "when ",
    "why ",
    "how ",
    "whether ",
    "if ",
    "hvad ",
    "hvilke ",
    "hvilken ",
    "hvilket ",
    "hvem ",
    "hvor ",
    "hvornår ",
    "hvorfor ",
    "hvordan ",
    "om ",
];

/// Read the shape of one request against the owner's notes.
pub fn ask(request: &str) -> Ask<'_> {
    let trimmed = request.trim();
    // A question is never a save, whatever verb it opens with: "remember what
    // is in my notes about the kitchen" asks, it does not keep.
    if trimmed.ends_with('?') {
        return Ask::Read;
    }
    for opener in OPENERS {
        let Some(index) = after(trimmed, opener) else {
            continue;
        };
        let rest = trimmed[index..]
            .trim_start_matches([' ', ':', ',', '-', '–', '—'])
            .trim();
        if rest.is_empty() || starts_interrogative(rest) {
            return Ask::Read;
        }
        return Ask::Save(rest);
    }
    Ask::Read
}

fn starts_interrogative(rest: &str) -> bool {
    INTERROGATIVES
        .iter()
        .any(|word| after(rest, word).is_some())
}

/// The byte offset in `text` just past a case-insensitive `prefix`. Offsets
/// index the original, so a remainder keeps the owner's own capitalisation.
fn after(text: &str, prefix: &str) -> Option<usize> {
    let mut wanted = prefix.chars();
    let mut index = 0usize;
    for c in text.chars() {
        let Some(want) = wanted.next() else {
            return Some(index);
        };
        if !c.to_lowercase().eq(want.to_lowercase()) {
            return None;
        }
        index += c.len_utf8();
    }
    wanted.next().is_none().then_some(index)
}

/// Which of the owner's two languages a request is in. The runtime composes
/// every sentence it says about a note itself, so it has to choose; the model
/// never supplies the wording of an outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    English,
    Danish,
}

/// Danish function words with no ordinary English reading. One is a coincidence
/// in an English sentence; two is the owner speaking Danish.
const DANISH_WORDS: &[&str] = &[
    "jeg", "ikke", "hvad", "hvem", "hvor", "hvilke", "hvilken", "hvilket", "hvordan", "hvorfor",
    "mine", "min", "mit", "dine", "din", "dit", "kan", "lide", "husk", "husker", "noter", "notér",
    "skriv", "skrev", "gem", "gemme", "siger", "står", "der", "det", "og", "til", "fra", "med",
    "om", "en", "et", "er", "har", "skal", "vil", "ned", "meget",
];

pub fn language(text: &str) -> Language {
    let lowered = text.to_lowercase();
    if lowered.contains(['æ', 'ø', 'å']) {
        return Language::Danish;
    }
    let mut hits = 0usize;
    for word in lowered.split(|c: char| !c.is_alphanumeric()) {
        if DANISH_WORDS.contains(&word) {
            hits += 1;
            if hits >= 2 {
                return Language::Danish;
            }
        }
    }
    Language::English
}

impl Language {
    /// The one sentence a saved note earns. It names nothing that was kept, so
    /// it is safe on the surface the request came from whatever else is in the
    /// room — which is the whole reason the runtime composes it and the model
    /// does not.
    pub fn saved(self) -> &'static str {
        match self {
            Self::English => "Saved to your notes.",
            Self::Danish => "Gemt i dine noter.",
        }
    }

    /// Every way a note was not written reads the same from outside: a store
    /// that could not be reached, a refusal, an exhausted budget and a page
    /// that tried to author memory are byte-identical here. The reason is in
    /// the owner's own ledger, where a bystander is not.
    pub fn not_saved(self) -> &'static str {
        match self {
            Self::English => "That was not saved to your notes.",
            Self::Danish => "Det blev ikke gemt i dine noter.",
        }
    }

    fn all_notes(self) -> &'static str {
        match self {
            Self::English => "Your notes, newest first",
            Self::Danish => "Dine noter, nyeste først",
        }
    }

    fn notes_about(self, query: &str) -> String {
        match self {
            Self::English => format!("Your notes about \u{201c}{query}\u{201d}, newest first"),
            Self::Danish => format!("Dine noter om \u{201c}{query}\u{201d}, nyeste først"),
        }
    }

    fn nothing_readable(self) -> &'static str {
        match self {
            Self::English => "You have no readable saved notes.",
            Self::Danish => "Du har ingen læsbare gemte noter.",
        }
    }

    fn nothing_matches(self, query: &str) -> String {
        match self {
            Self::English => format!("None of your notes mention \u{201c}{query}\u{201d}."),
            Self::Danish => format!("Ingen af dine noter nævner \u{201c}{query}\u{201d}."),
        }
    }

    fn unopened(self, count: usize) -> String {
        match self {
            Self::English => format!("{count} more could not be opened."),
            Self::Danish => format!("{count} mere kunne ikke åbnes."),
        }
    }
}

/// Words in the stored index that say nothing about which note is wanted.
const READ_STOPWORDS: &[&str] = &[
    "private", "privat", "notes", "note", "noter", "noten", "noterne", "read", "show", "what",
    "mine", "latest", "seneste", "besked", "beskeder", "message", "messages", "please", "about",
    "does", "said", "says", "siger", "står", "skrev", "skrevet", "noteret", "husk", "husker",
    "remember", "hvad", "omkring",
];

/// The words of a request that say which notes are wanted. Short words and the
/// vocabulary of asking are dropped, so "what do my notes say about the
/// kitchen" looks for the kitchen.
pub fn query_terms(request: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for word in request
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().count() >= 4)
        .filter(|word| !READ_STOPWORDS.contains(word))
    {
        if !terms.iter().any(|seen| seen == word) {
            terms.push(word.to_owned());
        }
        if terms.len() == 6 {
            break;
        }
    }
    terms
}

/// One stored index entry as a person reads it. A note this server authored is
/// a compact `{title,text}` object; anything else is shown as it stands.
pub fn entry(indexed_text: &str) -> String {
    #[derive(Deserialize)]
    struct Indexed {
        #[serde(default)]
        title: Option<String>,
        text: String,
    }
    let shown = match serde_json::from_str::<Indexed>(indexed_text) {
        Ok(note) => match note
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            Some(title) if !note.text.trim().starts_with(title) => {
                format!("{title} \u{2014} {}", note.text.trim())
            }
            _ => note.text.trim().to_owned(),
        },
        Err(_) => indexed_text.trim().to_owned(),
    };
    shown
        .chars()
        .take(MAX_ENTRY_CHARS)
        .collect::<String>()
        .replace(['\n', '\r'], " ")
}

/// The private card the owner reads. `readable` is newest first; `unopened`
/// counts the notes this server holds no key for, which are named as a number
/// rather than passed over in silence.
pub fn card(readable: &[String], unopened: usize, terms: &[String], language: Language) -> String {
    let query = terms.join(" ");
    let matched: Vec<&String> = if terms.is_empty() {
        readable.iter().collect()
    } else {
        readable
            .iter()
            .filter(|text| {
                let lowered = text.to_lowercase();
                terms.iter().any(|term| lowered.contains(term.as_str()))
            })
            .collect()
    };
    let mut card = if terms.is_empty() {
        language.all_notes().to_owned()
    } else {
        language.notes_about(&query)
    };
    let mut shown = 0usize;
    for text in &matched {
        let line = format!("\n\n{}. {text}", shown + 1);
        if card.len() + line.len() > MAX_CARD_BYTES {
            break;
        }
        card.push_str(&line);
        shown += 1;
    }
    if shown == 0 {
        card = if readable.is_empty() {
            language.nothing_readable().to_owned()
        } else {
            language.nothing_matches(&query)
        };
    }
    if unopened > 0 {
        card.push_str("\n\n");
        card.push_str(&language.unopened(unopened));
    }
    card
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A longer opening must be tried before any shorter one it starts with,
    /// or "note that I like bees" keeps the word "that".
    #[test]
    fn ambiance_note_openers_are_ordered_longest_first() {
        for (index, opener) in OPENERS.iter().enumerate() {
            for later in &OPENERS[index + 1..] {
                assert!(
                    !later.starts_with(*opener),
                    "{later} is hidden behind {opener}"
                );
            }
        }
    }

    #[test]
    fn ambiance_note_request_separates_saving_from_asking_in_both_languages() {
        for (request, kept) in [
            ("Note that I like bees", "I like bees"),
            ("note down that I like bees", "I like bees"),
            (
                "Add to my notes that the kitchen tap drips",
                "the kitchen tap drips",
            ),
            ("Note to self: call the dentist", "call the dentist"),
            ("Remember I like bees", "I like bees"),
            (
                "Make a note of the gate code for the studio",
                "the gate code for the studio",
            ),
            ("Notér at jeg kan lide bier", "jeg kan lide bier"),
            ("notér ned at køkkenhanen drypper", "køkkenhanen drypper"),
            ("Husk at jeg kan lide bier", "jeg kan lide bier"),
            (
                "Skriv i mine noter at jeg kan lide bier",
                "jeg kan lide bier",
            ),
            (
                "Tilføj til mine noter at bierne kommer i maj",
                "bierne kommer i maj",
            ),
        ] {
            assert_eq!(ask(request), Ask::Save(kept), "not a save: {request}");
        }
        for request in [
            "What do my notes say about the kitchen?",
            "Read my private notes",
            "Remember what my notes say about the kitchen",
            "Hvad står der i mine noter om køkkenet?",
            "Vis mine noter",
            "Note",
            "husk",
            "Show me the notes about bees",
        ] {
            assert_eq!(ask(request), Ask::Read, "not a read: {request}");
        }
    }

    #[test]
    fn ambiance_note_language_follows_the_request_and_never_the_model() {
        for danish in [
            "Notér at jeg kan lide bier",
            "Hvad står der i mine noter om køkkenet",
            "husk at hente brød",
            "gem det her i mine noter",
        ] {
            assert_eq!(language(danish), Language::Danish, "{danish}");
        }
        for english in [
            "Note that I like bees",
            "What do my notes say about the kitchen",
            "Remember to buy bread",
            "A mine is a hole in the ground",
        ] {
            assert_eq!(language(english), Language::English, "{english}");
        }
        assert_eq!(Language::Danish.saved(), "Gemt i dine noter.");
        assert_eq!(Language::English.saved(), "Saved to your notes.");
    }

    #[test]
    fn ambiance_note_draft_bounds_the_text_and_always_carries_a_title() {
        let draft = Draft::new(None, "I like bees. They live at the end of the garden.").unwrap();
        assert_eq!(draft.title(), "I like bees");
        assert!(!draft.proposed_title());
        assert_eq!(
            draft.text(),
            "I like bees. They live at the end of the garden."
        );
        assert_eq!(draft.privacy(), PrivacyClass::Private);
        let body: serde_json::Value = serde_json::from_str(&draft.body()).unwrap();
        assert_eq!(body["title"], "I like bees");
        assert_eq!(
            body["text"],
            "I like bees. They live at the end of the garden."
        );

        let titled = Draft::new(Some("  Bees\n"), "  I  like\tbees ").unwrap();
        assert_eq!((titled.title(), titled.text()), ("Bees", "I like bees"));
        assert!(titled.proposed_title());
        assert_eq!(titled.bytes(), 15);

        // An unusable title is derived rather than stored empty.
        assert_eq!(Draft::new(Some("   "), "bees").unwrap().title(), "bees");
        assert!(!Draft::new(Some("   "), "bees").unwrap().proposed_title());
        assert_eq!(
            Draft::new(Some(&"t".repeat(MAX_TITLE_BYTES + 1)), "bees")
                .unwrap()
                .title(),
            "bees"
        );
        // Bounds refuse rather than truncate the owner's own words.
        assert!(Draft::new(None, "   ").is_none());
        assert!(Draft::new(None, &"b".repeat(MAX_TEXT_BYTES + 1)).is_none());
        assert!(Draft::new(None, &"b".repeat(MAX_TEXT_BYTES)).is_some());
        // One very long word still yields a readable title.
        let long = Draft::new(None, &"b".repeat(300)).unwrap();
        assert_eq!(long.title().chars().count(), DERIVED_TITLE_CHARS);
    }

    #[test]
    fn ambiance_note_draft_never_holds_a_class_above_private() {
        let draft = Draft::new(None, "the door password is hunter2").unwrap();
        assert_eq!(draft.privacy(), PrivacyClass::Sensitive);
        let danish = Draft::new(None, "min adgangskode er hunter2").unwrap();
        assert_eq!(danish.privacy(), PrivacyClass::Sensitive);
        let ordinary = Draft::new(None, "the bees come in May").unwrap();
        assert_eq!(ordinary.privacy(), PrivacyClass::Private);
    }

    #[test]
    fn ambiance_note_card_answers_the_question_it_was_asked() {
        let entries = vec![
            entry(r#"{"title":"Kitchen","text":"the kitchen tap drips"}"#),
            entry("i like bees"),
        ];
        assert_eq!(entries[0], "Kitchen \u{2014} the kitchen tap drips");
        let terms = query_terms("What do my notes say about the kitchen?");
        assert_eq!(terms, vec!["kitchen".to_owned()]);
        let kitchen = card(&entries, 0, &terms, Language::English);
        assert!(kitchen.starts_with("Your notes about \u{201c}kitchen\u{201d}"));
        assert!(kitchen.contains("the kitchen tap drips"));
        assert!(!kitchen.contains("i like bees"));
        // Nothing matching says so instead of showing everything else.
        let empty = card_of(&entries, "What do my notes say about the boat?");
        assert!(empty.starts_with("None of your notes mention"));
        assert!(!empty.contains("kitchen tap"));
        // With nothing to look for, the whole list stands.
        let all = card(
            &entries,
            1,
            &query_terms("Read my private notes"),
            Language::English,
        );
        assert!(all.starts_with("Your notes, newest first"));
        assert!(all.contains("i like bees"));
        assert!(all.ends_with("1 more could not be opened."));
        // An empty store is never dressed up as a match.
        assert_eq!(
            card(&[], 0, &query_terms("Read my notes"), Language::Danish),
            "Du har ingen l\u{e6}sbare gemte noter."
        );
        let danish = card_of(
            &entries,
            "Hvad st\u{e5}r der i mine noter om k\u{f8}kkenet?",
        );
        assert!(danish.starts_with("Ingen af dine noter n\u{e6}vner"));
    }

    fn card_of(entries: &[String], request: &str) -> String {
        card(entries, 0, &query_terms(request), language(request))
    }
}
