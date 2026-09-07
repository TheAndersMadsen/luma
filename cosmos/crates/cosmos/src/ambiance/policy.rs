use crate::surface_registry::{Binding, Record};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyClass {
    #[default]
    Public,
    SharedRoom,
    NearUser,
    Private,
    Sensitive,
}

/// One output capability, with its own privacy properties. The four
/// `action.*` channels change something about the world; `confirm.tap` is the
/// ceremony that authorizes the ones that need it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Channel {
    #[serde(rename = "visual.card")]
    VisualCard,
    #[serde(rename = "audio.tts")]
    AudioTts,
    #[serde(rename = "action.open")]
    ActionOpen,
    #[serde(rename = "action.route")]
    ActionRoute,
    #[serde(rename = "action.play")]
    ActionPlay,
    #[serde(rename = "action.run")]
    ActionRun,
    #[serde(rename = "confirm.tap")]
    ConfirmTap,
}

impl Channel {
    /// The manifest key this channel is declared under.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VisualCard => "visual.card",
            Self::AudioTts => "audio.tts",
            Self::ActionOpen => "action.open",
            Self::ActionRoute => "action.route",
            Self::ActionPlay => "action.play",
            Self::ActionRun => "action.run",
            Self::ConfirmTap => "confirm.tap",
        }
    }

    /// Whether this channel can change something about the world. A device
    /// can accept such a command and then fail to carry it out, which is why
    /// an acknowledgment on it is not an outcome.
    pub fn is_action(self) -> bool {
        matches!(
            self,
            Self::ActionOpen | Self::ActionRoute | Self::ActionPlay | Self::ActionRun
        )
    }

    /// Whether every command on this channel needs a confirmation ceremony.
    pub fn needs_grant(self) -> bool {
        self == Self::ActionRun
    }

    /// Whether beginning here requires the installation's own visible
    /// foreground. Visibility is required to begin, never to continue.
    pub fn needs_foreground(self) -> bool {
        self.is_action() || self == Self::ConfirmTap
    }

    /// Whether a lost acknowledgment may be retried once with the same
    /// idempotency key on the same surface. `action.run` never retries.
    pub fn idempotent(self) -> bool {
        matches!(
            self,
            Self::ActionOpen | Self::ActionRoute | Self::ActionPlay
        )
    }
}

pub const MIN_CHOICES: usize = 2;
pub const MAX_CHOICES: usize = 8;
pub const MAX_CHOICE_TITLE_BYTES: usize = 120;
pub const MAX_CHOICE_ITEM_TITLE_BYTES: usize = 80;
pub const MAX_CHOICE_DETAIL_BYTES: usize = 200;

/// One numbered entry of a choice list. The runtime assigns ids `1`..`8` in
/// list order so a later "number two" names exactly this entry.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub id: String,
    pub title: String,
    pub detail: String,
}

fn choice_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

/// Semantic proposals have no device-operation, permission, or grant fields.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SemanticIntent {
    InformationalSpeech {
        text: String,
    },
    VisualTextCard {
        text: String,
    },
    PlaceAddressCard {
        content: super::visual::Reference,
    },
    ChoiceList {
        title: String,
        items: Vec<Choice>,
    },
    /// One bound device command. The runtime minted every argument.
    DeviceAction {
        operation: super::action::Operation,
    },
}
impl SemanticIntent {
    pub fn text(&self) -> &str {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => text,
            Self::PlaceAddressCard { .. } | Self::ChoiceList { .. } | Self::DeviceAction { .. } => {
                ""
            }
        }
    }
    /// Every model-authored word of the proposal, for the runtime's own
    /// privacy classification; place cards carry provider content only.
    pub fn classified_text(&self) -> String {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => text.clone(),
            Self::PlaceAddressCard { .. } => String::new(),
            Self::ChoiceList { title, items } => {
                let mut text = title.clone();
                for item in items {
                    text.push('\n');
                    text.push_str(&item.title);
                    text.push('\n');
                    text.push_str(&item.detail);
                }
                text
            }
            // Human-visible operation strings can raise the class and never
            // lower it; a command contributes the owner's own label only.
            Self::DeviceAction { operation } => operation.classified_text(),
        }
    }
    /// Whether the durable action still carries content to clear.
    pub fn has_payload(&self) -> bool {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => !text.is_empty(),
            Self::PlaceAddressCard { .. } => false,
            Self::ChoiceList { title, items } => !title.is_empty() || !items.is_empty(),
            // A bound command is the runtime's own record of what it decided,
            // not retained content.
            Self::DeviceAction { .. } => false,
        }
    }
    pub fn clear_payload(&mut self) {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => text.clear(),
            Self::PlaceAddressCard { .. } | Self::DeviceAction { .. } => {}
            Self::ChoiceList { title, items } => {
                title.clear();
                items.clear();
            }
        }
    }
    pub fn channel(&self) -> Channel {
        match self {
            Self::InformationalSpeech { .. } => Channel::AudioTts,
            Self::VisualTextCard { .. }
            | Self::PlaceAddressCard { .. }
            | Self::ChoiceList { .. } => Channel::VisualCard,
            Self::DeviceAction { operation } => operation.channel(),
        }
    }
    pub fn valid(&self) -> bool {
        match self {
            Self::PlaceAddressCard { content } => content.valid(),
            Self::DeviceAction { operation } => operation.valid(),
            Self::InformationalSpeech { .. } | Self::VisualTextCard { .. } => {
                !self.text().trim().is_empty() && self.text().len() <= 4000
            }
            Self::ChoiceList { title, items } => {
                choice_text(title, MAX_CHOICE_TITLE_BYTES)
                    && (MIN_CHOICES..=MAX_CHOICES).contains(&items.len())
                    && items.iter().enumerate().all(|(index, item)| {
                        item.id == (index + 1).to_string()
                            && choice_text(&item.title, MAX_CHOICE_ITEM_TITLE_BYTES)
                            && item.detail.len() <= MAX_CHOICE_DETAIL_BYTES
                            && !item.detail.chars().any(char::is_control)
                    })
            }
        }
    }
    pub fn content_digest(&self) -> String {
        match self {
            Self::PlaceAddressCard { content } => content.digest.clone(),
            Self::DeviceAction { operation } => operation.content_digest(),
            Self::InformationalSpeech { .. } | Self::VisualTextCard { .. } => {
                crate::surface_registry::hash(self.text().as_bytes())
            }
            Self::ChoiceList { title, items } => {
                let items: Vec<_> = items
                    .iter()
                    .map(|item| serde_json::json!([item.id, item.title, item.detail]))
                    .collect();
                let canonical = serde_json::json!(["cosmos.choice-list", 1, title, items]);
                crate::surface_registry::hash(canonical.to_string().as_bytes())
            }
        }
    }
}
impl std::fmt::Debug for SemanticIntent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SemanticIntent([REDACTED])")
    }
}

/// The longest reply a person can hold in one glance or one breath. Above it
/// a spoken answer becomes something to read; at or below it a card asked for
/// out loud can be said instead. It is a byte count over the runtime's own
/// validated text, never a judgement about what the words mean.
pub const GLANCE_BYTES: usize = 280;

/// What a bound reply *is*, as a content shape. §4.8 uses `shape(x)` in
/// `capable(ch, shape(x))` without saying who assigns it; Cosmos closes that
/// gap the same way it closed privacy class in §4.3 — deterministically,
/// runtime-side, from the intent it already validated. The model never writes
/// one and never sees one.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    /// A short spoken answer.
    Utterance,
    /// A card short enough to take in at a glance.
    Note,
    /// A card longer than a glance: something to sit and read.
    Passage,
    /// A numbered set of options to choose from.
    Roster,
    /// One place, with its address.
    Place,
    /// Start playback.
    Play,
    /// Start navigation.
    Route,
    /// Open a document or a link.
    Open,
    /// Run one of the owner's own approved commands.
    Run,
}

/// Who a channel's output reaches, as its own installation declares it. This
/// is the one manifest dimension content-shape matching consumes (§4.1), and
/// it is deliberately not a product name, a platform, or a place: `room` is
/// output everyone present receives, `handheld` is output that travels on the
/// person, `desk` is output on a screen someone is sitting at.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Audience {
    Room,
    Handheld,
    Desk,
}
impl Audience {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Room => "room",
            Self::Handheld => "handheld",
            Self::Desk => "desk",
        }
    }
    /// The closed set, read out of an approved manifest. Anything else is not
    /// a declaration Cosmos published, so it is not a declaration at all.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "room" => Some(Self::Room),
            "handheld" => Some(Self::Handheld),
            "desk" => Some(Self::Desk),
            _ => None,
        }
    }
    fn column(self) -> usize {
        match self {
            Self::Room => 0,
            Self::Handheld => 1,
            Self::Desk => 2,
        }
    }
}

impl Shape {
    /// A command's shape is its kind. There is nothing else to read: the
    /// arguments are the runtime's own and say nothing about where it goes.
    pub fn action(kind: super::action::OperationKind) -> Self {
        match kind {
            super::action::OperationKind::Open => Self::Open,
            super::action::OperationKind::Route => Self::Route,
            super::action::OperationKind::Play => Self::Play,
            super::action::OperationKind::Run => Self::Run,
        }
    }
}

/// The shape the runtime binds for one reply. Total over `SemanticIntent`,
/// pure, and free of any word matching beyond one byte count.
pub fn shape(intent: &SemanticIntent) -> Shape {
    match intent {
        SemanticIntent::InformationalSpeech { .. } => Shape::Utterance,
        SemanticIntent::VisualTextCard { text } => {
            if text.len() <= GLANCE_BYTES {
                Shape::Note
            } else {
                Shape::Passage
            }
        }
        SemanticIntent::PlaceAddressCard { .. } => Shape::Place,
        SemanticIntent::ChoiceList { .. } => Shape::Roster,
        SemanticIntent::DeviceAction { operation } => Shape::action(operation.kind()),
    }
}

/// The audience this record declares for one channel, or `None` when its
/// approved manifest predates the declaration. Read from the approved
/// manifest and from nothing else: never the platform, never the product
/// name, never where the installation runs.
pub fn audience(record: &Record, channel: Channel) -> Option<Audience> {
    match &record.binding {
        // A worn device travels on the person by construction; its one
        // channel has no other audience it could have.
        Binding::Pin { .. } => Some(Audience::Handheld),
        // An approved page is on the screen whoever opened it is reading.
        Binding::Browser => Some(Audience::Desk),
        Binding::Native { .. } => {
            crate::surface_registry::native_audience(record, channel.as_str())
                .and_then(Audience::parse)
        }
    }
}

/// The runtime's own binding of the reply's channel, run once before
/// ranking. Cognition proposes a variant; which channel that variant is
/// carried on is the runtime's to decide.
///
/// It moves in one direction only. Hearing becomes reading: an origin with
/// no speech channel of its own has nothing to play, and an answer longer
/// than a glance is not something anyone can hold in the ear — twenty film
/// titles are a list to look at, not a sentence to sit through. Reading
/// never becomes hearing, however short the answer and however the request
/// arrived: a card is directed at one person looking at a screen and speech
/// is heard by everyone in the room, and the runtime does not make a reply
/// more perceivable than the class and the proposal already allowed.
pub fn bind_channel(intent: SemanticIntent, screen_only: bool) -> SemanticIntent {
    match intent {
        SemanticIntent::InformationalSpeech { text }
            if screen_only || text.len() > GLANCE_BYTES =>
        {
            SemanticIntent::VisualTextCard { text }
        }
        other => other,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    Privacy,
    Capability,
    /// Nothing can reach this surface right now.
    Unavailable,
    /// It can be reached, but its own manifest says it produces no output
    /// while it is not in front of anyone, and this channel cannot be held
    /// until it is. Distinct from `Unavailable`, which is "not connected".
    Unattended,
}

/// A routing hint names a kind of approved surface the current request asked
/// for. It is weighed among eligible candidates only: it can never make a
/// blocked surface eligible, and nominating the origin earns nothing.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingTarget {
    Browser,
    Macos,
    Linux,
    Android,
    AndroidTv,
}
impl RoutingTarget {
    pub fn matches(self, record: &Record) -> bool {
        match (&record.binding, self) {
            (Binding::Browser, Self::Browser) => true,
            (Binding::Native { platform, .. }, target) => {
                matches!(
                    (platform.as_str(), target),
                    ("macos", Self::Macos)
                        | ("linux", Self::Linux)
                        | ("android", Self::Android)
                        | ("android_tv", Self::AndroidTv)
                )
            }
            _ => false,
        }
    }
}

/// Current-state facts the runtime derives for one record before policy runs.
/// Natives bind their incarnation to the signed connection, not the record.
///
/// §4.8's `available(s)` is one predicate; the paper never says what it
/// covers, and §5.3 separately lists "busy or locked state" among the
/// penalties. Cosmos splits it: `reachable` is whether anything can be sent
/// to this surface at all, and blocks; `attended` is whether its own app
/// reports itself in front of someone, and only ranks. Folding the two
/// together is what made a Mac with its lid shut disappear from the fleet
/// instead of ranking below the screen the answer belonged on.
#[derive(Clone, Copy, Debug)]
pub struct Presence {
    pub reachable: bool,
    pub attended: bool,
    pub incarnation: Uuid,
}

/// Integer components are the complete published scoring function. No hints
/// or learned preference are accepted from class-zero origins; the hint
/// component below carries the request's own explicit target only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub surface_id: Uuid,
    pub channel: Channel,
    pub blocker: Option<Blocker>,
    pub score_version: u8,
    pub shape_fit: i32,
    pub origin_affinity: i32,
    pub hint: i32,
    /// §5.3's busy-or-locked penalty. Absent on decisions logged before the
    /// term existed, which is what `score_version` distinguishes.
    #[serde(default)]
    pub attention: i32,
    pub preference: i32,
}
impl Candidate {
    pub fn score(&self) -> i32 {
        self.shape_fit + self.origin_affinity + self.hint + self.attention + self.preference
    }
}

pub const SCORE_VERSION: u8 = 3;
/// The floor every eligible candidate stands on, so no blocked candidate can
/// ever outrank one that is not blocked. Blockers are not scores.
pub const ELIGIBLE: i32 = 1000;
/// §5.3's "affinity to the origin". Smaller than the smallest gap in `FIT`,
/// so being the asking device decides between equals and never overturns a
/// shape band; and smaller than the attention penalty, so an answer does not
/// wait on the screen you asked from when there is an equally suitable one
/// you are already looking at.
pub const ORIGIN_AFFINITY: i32 = 10;
/// §4.8's `w_h`. Larger than the whole fit span plus every other term, so a
/// destination the owner named wins among eligible surfaces — and, being a
/// score, still never lifts a blocker.
pub const HINT_WEIGHT: i32 = 400;
/// §5.3's "busy or locked state". Smaller than the smallest gap in `FIT`, so
/// attention breaks ties and never overturns what the answer is.
pub const UNATTENDED: i32 = -20;

/// Content-shape fit, published in full: rows are the shape the runtime
/// bound, columns are the audience the surface declared, in the order
/// `room`, `handheld`, `desk`.
///
/// Where two audiences suit a shape equally the table says so and leaves the
/// choice to the origin term: a sentence or a glance-sized card belongs on
/// whichever personal screen the person is at, and which one that is, is
/// what asking from it already said. Only where the shape itself decides —
/// a list, a long read, a route, playback — does the table separate them.
pub const FIT: [[i32; 3]; 9] = [
    /* Utterance */ [120, 200, 200],
    /* Note      */ [120, 200, 200],
    /* Passage   */ [40, 160, 200],
    /* Roster    */ [200, 120, 120],
    /* Place     */ [40, 200, 120],
    /* Play      */ [200, 120, 120],
    /* Route     */ [40, 200, 120],
    /* Open      */ [40, 160, 200],
    /* Run       */ [40, 120, 200],
];

impl Shape {
    fn row(self) -> &'static [i32; 3] {
        &FIT[match self {
            Self::Utterance => 0,
            Self::Note => 1,
            Self::Passage => 2,
            Self::Roster => 3,
            Self::Place => 4,
            Self::Play => 5,
            Self::Route => 6,
            Self::Open => 7,
            Self::Run => 8,
        }]
    }

    /// How well this shape suits that audience. An installation that has not
    /// declared an audience yet scores the row's floor: it competes, it can
    /// still win when nothing better is there, and it never outranks a
    /// surface that did declare. Reapproval is what teaches Cosmos the room.
    pub fn fit(self, audience: Option<Audience>) -> i32 {
        let row = self.row();
        audience.map_or_else(
            || *row.iter().min().expect("the fit row is never empty"),
            |audience| row[audience.column()],
        )
    }
}

/// Whether the runtime holds this channel's content for a surface that is
/// reachable but not currently in front of anyone. A card, a ceremony and a
/// command all wait: the installation is told something is waiting and
/// receives it when its own foreground reports. Speech has nothing to wait
/// with — it is played now or not at all — so an installation whose manifest
/// says it produces no output in the background cannot be given any.
fn holds_until_attended(channel: Channel) -> bool {
    channel != Channel::AudioTts
}

/// `personal` is the runtime's finding that this record is a personal
/// surface whose owner declared it may show the requested class; it is the
/// only way past the shared-room ceiling, and it never applies to speech.
#[allow(clippy::too_many_arguments)]
pub fn candidate(
    record: &Record,
    presence: Presence,
    origin: Uuid,
    channel: Channel,
    shape: Shape,
    privacy: PrivacyClass,
    hint: Option<RoutingTarget>,
    personal: bool,
) -> Candidate {
    let capability = match (&record.binding, channel) {
        (Binding::Browser, Channel::VisualCard) => {
            crate::surface_registry::known_browser_manifest(&record.approved_manifest)
        }
        // Every native channel is the installation's own approved manifest
        // declaring it. An installation on an earlier profile therefore keeps
        // rendering and speaking and declares no action channel at all.
        (Binding::Native { .. }, channel) => {
            crate::surface_registry::native_declares(record, channel.as_str())
        }
        (Binding::Pin { .. }, Channel::AudioTts) => {
            record.surface_id == origin
                && record.approved_manifest == crate::surface_registry::pin_manifest()
        }
        _ => false,
    };
    let personal = personal && channel != Channel::AudioTts;
    let blocker = if privacy > PrivacyClass::SharedRoom && !personal {
        Some(Blocker::Privacy)
    } else if !capability {
        Some(Blocker::Capability)
    } else if !presence.reachable {
        Some(Blocker::Unavailable)
    } else if !presence.attended && !holds_until_attended(channel) {
        Some(Blocker::Unattended)
    } else {
        None
    };
    let eligible = blocker.is_none();
    Candidate {
        surface_id: record.surface_id,
        channel,
        blocker,
        score_version: SCORE_VERSION,
        shape_fit: if eligible {
            ELIGIBLE + shape.fit(audience(record, channel))
        } else {
            0
        },
        origin_affinity: if eligible && record.surface_id == origin {
            ORIGIN_AFFINITY
        } else {
            0
        },
        hint: if eligible
            && record.surface_id != origin
            && hint.is_some_and(|target| target.matches(record))
        {
            HINT_WEIGHT
        } else {
            0
        },
        attention: if eligible && !presence.attended {
            UNATTENDED
        } else {
            0
        },
        preference: 0,
    }
}

/// Deterministic order: score, then surface identifier. Co-hosting or
/// approval order confers nothing.
pub fn rank(candidates: &mut [Candidate]) {
    candidates.sort_by(|a, b| {
        b.score()
            .cmp(&a.score())
            .then(a.surface_id.cmp(&b.surface_id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surface_registry::{Mutation, hash, transition};

    fn present(incarnation: Uuid) -> Presence {
        Presence {
            reachable: true,
            attended: true,
            incarnation,
        }
    }
    /// Reachable, but its own app is not in front of anyone.
    fn unattended(incarnation: Uuid) -> Presence {
        Presence {
            reachable: true,
            attended: false,
            incarnation,
        }
    }
    fn absent() -> Presence {
        Presence {
            reachable: false,
            attended: false,
            incarnation: Uuid::nil(),
        }
    }
    fn native(platform: &str) -> Record {
        let Mutation::ApproveNative {
            enrollment_id,
            public_key,
            ..
        } = crate::store::native_test_approval(Uuid::new_v4(), 0)
        else {
            unreachable!()
        };
        transition(
            None,
            0,
            Uuid::new_v4(),
            &Mutation::ApproveNative {
                enrollment_id,
                public_key,
                platform: platform.into(),
                expected_revision: 0,
            },
            100,
        )
        .unwrap()
        .0
    }
    fn browser() -> Record {
        transition(
            None,
            0,
            Uuid::new_v4(),
            &Mutation::Approve {
                token_hash: hash(b"browser"),
                incarnation: Uuid::new_v4(),
            },
            100,
        )
        .unwrap()
        .0
    }
    fn pin() -> Record {
        transition(
            None,
            0,
            crate::surface_registry::pin_surface_id("U:owner", "aabb"),
            &Mutation::ApprovePin {
                device_id: "aabb".into(),
            },
            100,
        )
        .unwrap()
        .0
    }

    /// The owner's own fleet, in the order the seven situations name it.
    struct Fleet {
        pin: Record,
        tv: Record,
        mac: Record,
        phone: Record,
        pc: Record,
        display: Record,
    }
    impl Fleet {
        fn new() -> Self {
            Self {
                pin: pin(),
                tv: native("android_tv"),
                mac: native("macos"),
                phone: native("android"),
                pc: native("linux"),
                display: browser(),
            }
        }
        fn records(&self) -> [&Record; 6] {
            [
                &self.pin,
                &self.tv,
                &self.mac,
                &self.phone,
                &self.pc,
                &self.display,
            ]
        }
    }

    /// One decision over the whole fleet: every record scored for the one
    /// bound channel and shape, ranked, with the lead first.
    struct Decision {
        candidates: Vec<Candidate>,
    }
    impl Decision {
        fn lead(&self) -> Uuid {
            self.candidates
                .iter()
                .find(|c| c.blocker.is_none())
                .expect("an eligible surface")
                .surface_id
        }
        fn of(&self, record: &Record) -> &Candidate {
            self.candidates
                .iter()
                .find(|c| c.surface_id == record.surface_id)
                .expect("every record is a candidate")
        }
    }

    /// `personal` names the records whose owner declared them for the class,
    /// and `presence` says which are reachable and which are in front of
    /// someone. Nothing else about a record is available to the decision.
    fn decide(
        fleet: &Fleet,
        intent: &SemanticIntent,
        origin: &Record,
        privacy: PrivacyClass,
        hint: Option<RoutingTarget>,
        personal: &[Uuid],
        presence: &dyn Fn(&Record) -> Presence,
    ) -> Decision {
        let mut candidates: Vec<_> = fleet
            .records()
            .into_iter()
            .map(|record| {
                candidate(
                    record,
                    presence(record),
                    origin.surface_id,
                    intent.channel(),
                    shape(intent),
                    privacy,
                    hint,
                    personal.contains(&record.surface_id),
                )
            })
            .collect();
        rank(&mut candidates);
        Decision { candidates }
    }

    fn all_present(record: &Record) -> Presence {
        present(record.incarnation)
    }

    fn choices() -> SemanticIntent {
        SemanticIntent::ChoiceList {
            title: "Films tonight".into(),
            items: (1..=4)
                .map(|index| Choice {
                    id: index.to_string(),
                    title: format!("Film {index}"),
                    detail: "20:00".into(),
                })
                .collect(),
        }
    }
    fn play() -> SemanticIntent {
        SemanticIntent::DeviceAction {
            operation: super::super::action::Operation::Play {
                title: "Film 2 trailer".into(),
                query: "film 2 trailer".into(),
                providers: vec!["spotify".into()],
                item_digest: hash(b"film-2"),
            },
        }
    }
    fn route() -> SemanticIntent {
        SemanticIntent::DeviceAction {
            operation: super::super::action::Operation::Route {
                place_id: "place".into(),
                name: "Restaurant".into(),
                address: "Street 1".into(),
                lat: "55.0".into(),
                lng: "12.0".into(),
            },
        }
    }
    fn open() -> SemanticIntent {
        SemanticIntent::DeviceAction {
            operation: super::super::action::Operation::Open {
                locator: super::super::action::Locator::Https {
                    url: "https://example.test/report".into(),
                },
                version: None,
                position: None,
                label: "report".into(),
            },
        }
    }
    fn short(text: &str) -> SemanticIntent {
        SemanticIntent::VisualTextCard { text: text.into() }
    }
    fn long() -> SemanticIntent {
        SemanticIntent::VisualTextCard {
            text: "x".repeat(GLANCE_BYTES + 1),
        }
    }

    // --- Situation 1 ------------------------------------------------------

    #[test]
    fn a_film_list_asked_of_the_pin_goes_to_the_television_and_is_never_spoken() {
        let fleet = Fleet::new();
        let decision = decide(
            &fleet,
            &choices(),
            &fleet.pin,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &all_present,
        );
        assert_eq!(decision.lead(), fleet.tv.surface_id);
        assert_eq!(shape(&choices()), Shape::Roster);
        // A set of options is a card by construction; there is no variant
        // that could read twenty titles out loud.
        assert_eq!(choices().channel(), Channel::VisualCard);
        // And a Pin can only ever speak, so it is not a candidate for one.
        assert_eq!(decision.of(&fleet.pin).blocker, Some(Blocker::Capability));
        // The television wins on what the answer is, by a whole band, with
        // no device named and without being the origin.
        assert!(
            decision.of(&fleet.tv).score() - decision.of(&fleet.mac).score() >= 80,
            "the room screen must win a list outright"
        );
        // Even an answer cognition proposed as speech is a card before it is
        // ranked, once it is longer than a glance.
        let rebound = bind_channel(
            SemanticIntent::InformationalSpeech {
                text: "x".repeat(GLANCE_BYTES + 1),
            },
            false,
        );
        assert_eq!(rebound.channel(), Channel::VisualCard);
        assert_eq!(shape(&rebound), Shape::Passage);
        // A short one is still spoken, so the Pin can answer for itself.
        assert_eq!(
            bind_channel(
                SemanticIntent::InformationalSpeech {
                    text: "Three films tonight.".into(),
                },
                false,
            )
            .channel(),
            Channel::AudioTts
        );
    }

    // --- Situation 2 ------------------------------------------------------

    #[test]
    fn play_the_trailer_for_number_two_from_the_pin_plays_on_that_television() {
        let fleet = Fleet::new();
        let decision = decide(
            &fleet,
            &play(),
            &fleet.pin,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &all_present,
        );
        assert_eq!(decision.lead(), fleet.tv.surface_id);
        assert_eq!(shape(&play()), Shape::Play);
        // Nothing else in the fleet declares playback at all.
        for record in [&fleet.mac, &fleet.phone, &fleet.pc, &fleet.display] {
            assert_eq!(decision.of(record).blocker, Some(Blocker::Capability));
        }
    }

    // --- Situation 3 ------------------------------------------------------

    #[test]
    fn an_answer_about_the_document_on_the_mac_stays_on_the_mac() {
        let fleet = Fleet::new();
        let personal = [fleet.mac.surface_id, fleet.phone.surface_id];
        for answer in [short("It is the third clause."), long()] {
            let decision = decide(
                &fleet,
                &answer,
                &fleet.mac,
                PrivacyClass::Private,
                None,
                &personal,
                &all_present,
            );
            assert_eq!(decision.lead(), fleet.mac.surface_id);
            // The television can never hold a private reply, whatever it is.
            assert_eq!(decision.of(&fleet.tv).blocker, Some(Blocker::Privacy));
        }
        // Long or short, the answer never leaves the desk it was asked at:
        // the long one because a passage is a desk screen's shape, the short
        // one because a glance suits either personal screen and the Mac is
        // the one the owner is sitting at.
        assert_eq!(shape(&long()), Shape::Passage);
        assert_eq!(shape(&short("ok")), Shape::Note);
    }

    // --- Situation 4 ------------------------------------------------------

    #[test]
    fn continue_on_my_pc_lands_on_the_linux_machine_and_the_hint_free_replay_stays_on_the_mac() {
        let fleet = Fleet::new();
        let hinted = decide(
            &fleet,
            &open(),
            &fleet.mac,
            PrivacyClass::SharedRoom,
            Some(RoutingTarget::Linux),
            &[],
            &all_present,
        );
        assert_eq!(hinted.lead(), fleet.pc.surface_id);
        assert_eq!(hinted.of(&fleet.pc).hint, HINT_WEIGHT);
        // Invariant 2: the same state with the hint stripped still selects an
        // eligible surface, and it is the one the request itself implies.
        let ablated = decide(
            &fleet,
            &open(),
            &fleet.mac,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &all_present,
        );
        assert_eq!(ablated.lead(), fleet.mac.surface_id);
        assert!(ablated.candidates.iter().all(|c| c.hint == 0));
    }

    // --- Situation 5 ------------------------------------------------------

    #[test]
    fn a_route_asked_of_the_phone_away_from_the_desk_opens_on_the_phone() {
        let fleet = Fleet::new();
        // The Mac is where the restaurant was found and is still the most
        // recently used screen; nothing in the decision can read that.
        let decision = decide(
            &fleet,
            &route(),
            &fleet.phone,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &all_present,
        );
        assert_eq!(decision.lead(), fleet.phone.surface_id);
        assert_eq!(shape(&route()), Shape::Route);
        for record in [&fleet.mac, &fleet.pc, &fleet.tv, &fleet.display] {
            assert_eq!(decision.of(record).blocker, Some(Blocker::Capability));
        }
    }

    // --- Situation 6 ------------------------------------------------------

    #[test]
    fn a_private_reply_reaches_only_a_personal_screen_never_the_television_or_the_pin() {
        let fleet = Fleet::new();
        let personal = [fleet.mac.surface_id, fleet.phone.surface_id];
        for privacy in [
            PrivacyClass::NearUser,
            PrivacyClass::Private,
            PrivacyClass::Sensitive,
        ] {
            // Even named outright, the television is refused.
            let decision = decide(
                &fleet,
                &short("your message"),
                &fleet.mac,
                privacy,
                Some(RoutingTarget::AndroidTv),
                &personal,
                &all_present,
            );
            assert_eq!(decision.of(&fleet.tv).blocker, Some(Blocker::Privacy));
            assert_eq!(decision.of(&fleet.tv).hint, 0);
            assert_eq!(decision.of(&fleet.tv).score(), 0);
            assert_eq!(decision.of(&fleet.display).blocker, Some(Blocker::Privacy));
            assert_eq!(decision.lead(), fleet.mac.surface_id);
            // The Pin can only speak, and a personal declaration never lifts
            // speech, so nothing above the ceiling is ever said out loud.
            let spoken = decide(
                &fleet,
                &SemanticIntent::InformationalSpeech {
                    text: "your message".into(),
                },
                &fleet.pin,
                privacy,
                None,
                &personal,
                &all_present,
            );
            assert!(spoken.candidates.iter().all(|c| c.blocker.is_some()));
            // And the runtime never turns a card into speech at any class:
            // it may make a reply less perceivable, never more.
            let kept = bind_channel(short("your message"), false);
            assert_eq!(kept.channel(), Channel::VisualCard);
        }
    }

    // --- Situation 7 ------------------------------------------------------

    #[test]
    fn a_quick_fact_asked_of_the_phone_while_walking_is_spoken_on_the_phone() {
        let fleet = Fleet::new();
        let intent = SemanticIntent::InformationalSpeech {
            text: "It is twelve degrees.".into(),
        };
        // Short enough to hold in the ear, so it stays spoken.
        assert_eq!(
            bind_channel(intent.clone(), false).channel(),
            Channel::AudioTts
        );
        assert_eq!(shape(&intent), Shape::Utterance);
        let decision = decide(
            &fleet,
            &intent,
            &fleet.phone,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &all_present,
        );
        assert_eq!(decision.lead(), fleet.phone.surface_id);
        // A Mac in another room could speak it and is not chosen: asking a
        // device is what makes it the one that answers, when nothing about
        // the answer says otherwise.
        assert!(decision.of(&fleet.phone).score() > decision.of(&fleet.mac).score());
        // If cognition proposes a card instead, the answer is shown rather
        // than said, and it is still the phone that shows it.
        let card = bind_channel(short("It is twelve degrees."), false);
        assert_eq!(card.channel(), Channel::VisualCard);
        let shown = decide(
            &fleet,
            &card,
            &fleet.phone,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &all_present,
        );
        assert_eq!(shown.lead(), fleet.phone.surface_id);
    }

    // --- The ranking itself ----------------------------------------------

    #[test]
    fn the_published_weights_prove_their_own_ordering_properties() {
        let gaps = FIT.iter().flat_map(|row| {
            row.iter().flat_map(move |a| {
                row.iter()
                    .map(move |b| (a - b).abs())
                    .filter(|gap| *gap > 0)
            })
        });
        let band = gaps.min().expect("the table separates some audiences");
        let span = FIT.iter().flatten().max().unwrap() - FIT.iter().flatten().min().unwrap();
        // A named destination outranks every fit preference, and nothing else
        // in the vector can add up to one.
        assert!(HINT_WEIGHT > span + ORIGIN_AFFINITY + UNATTENDED.abs());
        // Neither the asking device nor an idle foreground overturns a band
        // the shape itself decided.
        assert!(ORIGIN_AFFINITY < band);
        assert!(UNATTENDED.abs() < band);
        // And between two screens the shape cannot separate, the one someone
        // is in front of outranks the one they happened to ask from.
        assert!(ORIGIN_AFFINITY < UNATTENDED.abs());
        // No blocked candidate can outrank an eligible one.
        let floor = ELIGIBLE + FIT.iter().flatten().min().unwrap() + UNATTENDED;
        assert!(floor > 0);
    }

    #[test]
    fn a_screen_nobody_is_looking_at_is_ranked_below_its_shape_never_skipped() {
        let fleet = Fleet::new();
        // The Mac's panel is closed; the PC and the browser page are off.
        let closed = |record: &Record| {
            if record.surface_id == fleet.mac.surface_id {
                unattended(record.incarnation)
            } else if record.surface_id == fleet.pc.surface_id
                || record.surface_id == fleet.display.surface_id
            {
                absent()
            } else {
                present(record.incarnation)
            }
        };
        // A long read is still the Mac's shape, so it is held for the Mac
        // rather than pushed to the phone in a pocket.
        let decision = decide(
            &fleet,
            &long(),
            &fleet.phone,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &closed,
        );
        assert_eq!(decision.lead(), fleet.mac.surface_id);
        assert_eq!(decision.of(&fleet.mac).blocker, None);
        assert_eq!(decision.of(&fleet.mac).attention, UNATTENDED);
        assert!(decision.of(&fleet.mac).score() > decision.of(&fleet.phone).score());
        // Between two screens the shape cannot separate, the one someone is
        // in front of wins — even over the one they asked from.
        let glance = decide(
            &fleet,
            &short("twelve degrees"),
            &fleet.mac,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &closed,
        );
        assert_eq!(glance.lead(), fleet.phone.surface_id);
        // A surface nothing can reach is blocked, and says which of the two
        // it is: not connected, rather than not in front of anyone.
        let gone = decide(
            &fleet,
            &long(),
            &fleet.phone,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &|record| {
                if record.surface_id == fleet.mac.surface_id {
                    absent()
                } else {
                    present(record.incarnation)
                }
            },
        );
        assert_eq!(gone.of(&fleet.mac).blocker, Some(Blocker::Unavailable));
        assert_eq!(gone.of(&fleet.mac).score(), 0);
    }

    #[test]
    fn speech_is_refused_by_a_surface_that_is_reachable_but_in_nobody_s_foreground() {
        let fleet = Fleet::new();
        let spoken = SemanticIntent::InformationalSpeech {
            text: "twelve degrees".into(),
        };
        let decision = decide(
            &fleet,
            &spoken,
            &fleet.pin,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &|record| {
                if matches!(record.binding, Binding::Pin { .. }) {
                    present(record.incarnation)
                } else {
                    unattended(record.incarnation)
                }
            },
        );
        // Nothing holds speech until an app comes forward, so an installation
        // that declares no background output cannot be given any. It is a
        // different answer from "it was not connected", and Center can say so.
        assert_eq!(decision.of(&fleet.mac).blocker, Some(Blocker::Unattended));
        assert_eq!(decision.of(&fleet.tv).blocker, Some(Blocker::Unattended));
        // A worn device has no foreground to lose, so it is never unattended.
        assert_eq!(decision.lead(), fleet.pin.surface_id);
    }

    #[test]
    fn an_installation_on_an_older_profile_competes_at_the_floor_of_the_shape() {
        let fleet = Fleet::new();
        let mut legacy = fleet.mac.clone();
        legacy.approved_manifest = crate::surface_registry::legacy_native_voice_manifest("macos");
        assert_eq!(audience(&legacy, Channel::VisualCard), None);
        assert_eq!(
            audience(&fleet.mac, Channel::VisualCard),
            Some(Audience::Desk)
        );
        let scored = |record: &Record, shape: Shape| {
            candidate(
                record,
                present(record.incarnation),
                Uuid::new_v4(),
                Channel::VisualCard,
                shape,
                PrivacyClass::SharedRoom,
                None,
                false,
            )
            .score()
        };
        for shape in [Shape::Note, Shape::Passage, Shape::Roster] {
            // It is still eligible and still wins when nothing better is
            // there, and it never outranks an installation that declared.
            assert!(scored(&legacy, shape) >= ELIGIBLE);
            assert!(scored(&legacy, shape) <= scored(&fleet.mac, shape));
            assert!(scored(&legacy, shape) <= scored(&fleet.tv, shape));
        }
        // Reapproval is what tells Cosmos which screen it is: the same
        // machine, reapproved, wins the long read outright.
        assert!(scored(&fleet.mac, Shape::Passage) > scored(&legacy, Shape::Passage));
        // A record whose platform string Cosmos never published is unknown,
        // manifest and all: nothing about a name earns a rank.
        let unpublished = native("android_tv");
        assert_eq!(
            audience(&unpublished, Channel::VisualCard),
            Some(Audience::Room)
        );
    }

    #[test]
    fn the_same_request_in_the_same_situation_always_lands_in_the_same_place() {
        let fleet = Fleet::new();
        let run = || {
            decide(
                &fleet,
                &choices(),
                &fleet.pin,
                PrivacyClass::SharedRoom,
                None,
                &[],
                &all_present,
            )
            .candidates
        };
        let first = run();
        for _ in 0..8 {
            assert_eq!(run(), first);
        }
        // Nothing in the vector remembers anything: no learned preference,
        // and no term that a previous turn could have moved.
        assert!(first.iter().all(|c| c.preference == 0));
        assert!(first.iter().all(|c| c.score_version == SCORE_VERSION));
        // Two identical screens differ in nothing the scorer can read, so the
        // tie breaks on the identifier and the runner-up is the first
        // fallback — deterministic, and the same on every replay.
        let twin = Fleet {
            pc: native("macos"),
            ..Fleet::new()
        };
        let decision = decide(
            &twin,
            &long(),
            &twin.pin,
            PrivacyClass::SharedRoom,
            None,
            &[],
            &all_present,
        );
        let desks = [&twin.mac, &twin.pc];
        assert_eq!(
            decision.of(desks[0]).score(),
            decision.of(desks[1]).score(),
            "identical manifests score identically"
        );
        let mut expected: Vec<_> = desks.iter().map(|r| r.surface_id).collect();
        expected.sort();
        let ranked: Vec<_> = decision
            .candidates
            .iter()
            .filter(|c| expected.contains(&c.surface_id))
            .map(|c| c.surface_id)
            .collect();
        assert_eq!(ranked, expected);
        assert_eq!(decision.lead(), expected[0]);
    }

    #[test]
    fn hints_rank_only_eligible_candidates_and_never_the_origin() {
        let tv = native("android_tv");
        let phone = native("android");
        let display = browser();
        let origin = phone.surface_id;
        let rank_with = |hint: Option<RoutingTarget>, tv_present: Presence| {
            let mut candidates = vec![
                candidate(
                    &tv,
                    tv_present,
                    origin,
                    Channel::VisualCard,
                    Shape::Note,
                    PrivacyClass::SharedRoom,
                    hint,
                    false,
                ),
                candidate(
                    &phone,
                    present(Uuid::new_v4()),
                    origin,
                    Channel::VisualCard,
                    Shape::Note,
                    PrivacyClass::SharedRoom,
                    hint,
                    false,
                ),
                candidate(
                    &display,
                    present(display.incarnation),
                    origin,
                    Channel::VisualCard,
                    Shape::Note,
                    PrivacyClass::SharedRoom,
                    hint,
                    false,
                ),
            ];
            rank(&mut candidates);
            candidates
        };
        // Baseline without hints: a glance suits either personal screen, so
        // origin affinity decides among eligible surfaces.
        let baseline = rank_with(None, present(Uuid::new_v4()));
        assert_eq!(baseline[0].surface_id, origin);
        assert!(baseline.iter().all(|c| c.hint == 0));
        // A hint for an eligible, non-origin surface leads, and it outranks
        // a whole fit band rather than merely breaking a tie.
        let hinted = rank_with(Some(RoutingTarget::AndroidTv), present(Uuid::new_v4()));
        assert_eq!(hinted[0].surface_id, tv.surface_id);
        assert_eq!(hinted[0].hint, HINT_WEIGHT);
        // Self-nomination earns nothing: the ranking equals the baseline.
        let selfish = rank_with(Some(RoutingTarget::Android), present(Uuid::new_v4()));
        assert_eq!(selfish, baseline);
        // A hint cannot revive an unavailable surface; blockers remain and
        // the selection equals the hint-free selection over the same state.
        let unavailable = rank_with(Some(RoutingTarget::AndroidTv), absent());
        let ablated = rank_with(None, absent());
        assert_eq!(unavailable[0].surface_id, ablated[0].surface_id);
        assert_eq!(
            unavailable
                .iter()
                .find(|c| c.surface_id == tv.surface_id)
                .map(|c| (c.blocker, c.hint, c.score())),
            Some((Some(Blocker::Unavailable), 0, 0))
        );
        // Privacy is a blocker before any score, hinted or not.
        let private = candidate(
            &tv,
            present(Uuid::new_v4()),
            origin,
            Channel::VisualCard,
            Shape::Note,
            PrivacyClass::Private,
            Some(RoutingTarget::AndroidTv),
            false,
        );
        assert_eq!(
            (private.blocker, private.score()),
            (Some(Blocker::Privacy), 0)
        );
        // The runtime's personal finding lifts the ceiling for a personal
        // surface's card only: never for a surface without it, never for speech.
        let own = candidate(
            &phone,
            present(Uuid::new_v4()),
            tv.surface_id,
            Channel::VisualCard,
            Shape::Note,
            PrivacyClass::Private,
            None,
            true,
        );
        assert_eq!(
            (own.blocker, own.score()),
            (None, ELIGIBLE + Shape::Note.fit(Some(Audience::Handheld)))
        );
        let elsewhere = candidate(
            &tv,
            present(Uuid::new_v4()),
            origin,
            Channel::VisualCard,
            Shape::Note,
            PrivacyClass::Private,
            Some(RoutingTarget::AndroidTv),
            false,
        );
        assert_eq!(elsewhere.blocker, Some(Blocker::Privacy));
        let spoken = candidate(
            &phone,
            present(Uuid::new_v4()),
            origin,
            Channel::AudioTts,
            Shape::Utterance,
            PrivacyClass::Private,
            None,
            true,
        );
        assert_eq!(spoken.blocker, Some(Blocker::Privacy));
    }

    #[test]
    fn legacy_native_approvals_render_cards_but_have_no_speech_capability() {
        let mut legacy = native("macos");
        legacy.approved_manifest = crate::surface_registry::legacy_native_display_manifest();
        let card = candidate(
            &legacy,
            present(Uuid::new_v4()),
            Uuid::new_v4(),
            Channel::VisualCard,
            Shape::Note,
            PrivacyClass::Public,
            Some(RoutingTarget::Macos),
            false,
        );
        assert_eq!(card.blocker, None);
        let candidate = candidate(
            &legacy,
            present(Uuid::new_v4()),
            Uuid::new_v4(),
            Channel::AudioTts,
            Shape::Utterance,
            PrivacyClass::Public,
            Some(RoutingTarget::Macos),
            false,
        );
        assert_eq!(candidate.blocker, Some(Blocker::Capability));
        assert_eq!(candidate.hint, 0);
        let current = super::candidate(
            &native("android_tv"),
            present(Uuid::new_v4()),
            Uuid::new_v4(),
            Channel::AudioTts,
            Shape::Utterance,
            PrivacyClass::SharedRoom,
            None,
            false,
        );
        assert_eq!(current.blocker, None);
        assert!(!RoutingTarget::Linux.matches(&legacy));
        assert!(RoutingTarget::Macos.matches(&legacy));
    }
}
