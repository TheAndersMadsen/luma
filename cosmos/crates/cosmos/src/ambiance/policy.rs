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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Channel {
    #[serde(rename = "visual.card")]
    VisualCard,
    #[serde(rename = "audio.tts")]
    AudioTts,
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
    InformationalSpeech { text: String },
    VisualTextCard { text: String },
    PlaceAddressCard { content: super::visual::Reference },
    ChoiceList { title: String, items: Vec<Choice> },
}
impl SemanticIntent {
    pub fn text(&self) -> &str {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => text,
            Self::PlaceAddressCard { .. } | Self::ChoiceList { .. } => "",
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
        }
    }
    /// Whether the durable action still carries content to clear.
    pub fn has_payload(&self) -> bool {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => !text.is_empty(),
            Self::PlaceAddressCard { .. } => false,
            Self::ChoiceList { title, items } => !title.is_empty() || !items.is_empty(),
        }
    }
    pub fn clear_payload(&mut self) {
        match self {
            Self::InformationalSpeech { text } | Self::VisualTextCard { text } => text.clear(),
            Self::PlaceAddressCard { .. } => {}
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
        }
    }
    pub fn valid(&self) -> bool {
        match self {
            Self::PlaceAddressCard { content } => content.valid(),
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocker {
    Privacy,
    Capability,
    Unavailable,
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
#[derive(Clone, Copy, Debug)]
pub struct Presence {
    pub available: bool,
    pub incarnation: Uuid,
}

/// Integer components are the complete published v1 scoring function. No
/// hints or learned preference are accepted from class-zero origins; the
/// hint component below carries the request's own explicit target only.
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
    pub preference: i32,
}
impl Candidate {
    pub fn score(&self) -> i32 {
        self.shape_fit + self.origin_affinity + self.hint + self.preference
    }
}

pub const HINT_WEIGHT: i32 = 100;

/// `personal` is the runtime's finding that this record is a personal
/// surface whose owner declared it may show the requested class; it is the
/// only way past the shared-room ceiling, and it never applies to speech.
pub fn candidate(
    record: &Record,
    presence: Presence,
    origin: Uuid,
    channel: Channel,
    privacy: PrivacyClass,
    hint: Option<RoutingTarget>,
    personal: bool,
) -> Candidate {
    let capability = match (&record.binding, channel) {
        (Binding::Browser, Channel::VisualCard) => {
            crate::surface_registry::known_browser_manifest(&record.approved_manifest)
        }
        (Binding::Native { .. }, Channel::VisualCard) => {
            crate::surface_registry::known_native_manifest(&record.approved_manifest)
        }
        (Binding::Native { .. }, Channel::AudioTts) => {
            record.approved_manifest == crate::surface_registry::native_manifest()
        }
        (Binding::Pin { .. }, Channel::AudioTts) => {
            record.surface_id == origin
                && record.approved_manifest == crate::surface_registry::pin_manifest()
        }
        _ => false,
    };
    let personal = personal && channel == Channel::VisualCard;
    let blocker = if privacy > PrivacyClass::SharedRoom && !personal {
        Some(Blocker::Privacy)
    } else if !capability {
        Some(Blocker::Capability)
    } else if !presence.available {
        Some(Blocker::Unavailable)
    } else {
        None
    };
    let eligible = blocker.is_none();
    Candidate {
        surface_id: record.surface_id,
        channel,
        blocker,
        score_version: 2,
        shape_fit: if eligible { 1000 } else { 0 },
        origin_affinity: if eligible && record.surface_id == origin {
            10
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
            available: true,
            incarnation,
        }
    }
    fn absent() -> Presence {
        Presence {
            available: false,
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
                    PrivacyClass::SharedRoom,
                    hint,
                    false,
                ),
                candidate(
                    &phone,
                    present(Uuid::new_v4()),
                    origin,
                    Channel::VisualCard,
                    PrivacyClass::SharedRoom,
                    hint,
                    false,
                ),
                candidate(
                    &display,
                    present(display.incarnation),
                    origin,
                    Channel::VisualCard,
                    PrivacyClass::SharedRoom,
                    hint,
                    false,
                ),
            ];
            rank(&mut candidates);
            candidates
        };
        // Baseline without hints: origin affinity wins among eligible surfaces.
        let baseline = rank_with(None, present(Uuid::new_v4()));
        assert_eq!(baseline[0].surface_id, origin);
        assert!(baseline.iter().all(|c| c.hint == 0));
        // A hint for an eligible, non-origin surface leads.
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
            PrivacyClass::Private,
            None,
            true,
        );
        assert_eq!((own.blocker, own.score()), (None, 1000));
        let elsewhere = candidate(
            &tv,
            present(Uuid::new_v4()),
            origin,
            Channel::VisualCard,
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
            PrivacyClass::Private,
            None,
            true,
        );
        assert_eq!(spoken.blocker, Some(Blocker::Privacy));
    }

    #[test]
    fn legacy_native_approvals_render_cards_but_have_no_speech_capability() {
        let mut legacy = native("macos");
        legacy.approved_manifest = crate::surface_registry::legacy_native_manifest();
        let card = candidate(
            &legacy,
            present(Uuid::new_v4()),
            Uuid::new_v4(),
            Channel::VisualCard,
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
            PrivacyClass::SharedRoom,
            None,
            false,
        );
        assert_eq!(current.blocker, None);
        assert!(!RoutingTarget::Linux.matches(&legacy));
        assert!(RoutingTarget::Macos.matches(&legacy));
    }
}
