//! Transient Places address cards. The durable runtime stores references only.
//! Cache membership is not delivery authorization; callers must CheckDelivery.

use super::{Action, Channel, RuntimeError, SemanticIntent, TurnFence};
use crate::backends::{lookup::LookupError, places};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const TTL_MS: i64 = 60_000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_CARDS: usize = 128;
const MAX_PRINCIPAL_CARDS: usize = 4;
const MAX_WIRE_BYTES: usize = 8192;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub id: Uuid,
    pub digest: String,
    pub expires_at_ms: i64,
}

impl Reference {
    pub fn valid(&self) -> bool {
        !self.id.is_nil()
            && self.digest.len() == 64
            && self
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && (1..=MAX_SAFE_INTEGER).contains(&self.expires_at_ms)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    place_id: String,
    name: String,
    address: String,
    source_url: Option<String>,
}

#[derive(Serialize)]
pub struct Card {
    kind: &'static str,
    query: String,
    items: Vec<Item>,
    attributions: Vec<String>,
}

impl fmt::Debug for Card {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Card([REDACTED])")
    }
}

impl Card {
    pub fn from_lookup(
        query: &str,
        evidence: &places::LookupEvidence,
    ) -> Result<Self, LookupError> {
        fn text(value: &str, maximum: usize) -> bool {
            !value.trim().is_empty()
                && value.len() <= maximum
                && !value.chars().any(char::is_control)
        }
        if !text(query, 512) {
            return Err(LookupError::InvalidQuery);
        }
        if evidence.places.len() > 4 || evidence.html_attributions.len() > 16 {
            return Err(LookupError::Oversized);
        }
        let mut items = Vec::with_capacity(evidence.places.len());
        for place in &evidence.places {
            if !text(&place.place_id, 1024)
                || place.place_id.chars().any(char::is_whitespace)
                || !text(&place.name, 256)
                || !text(&place.address, 512)
            {
                return Err(LookupError::Malformed);
            }
            if let Some(value) = &place.source_url {
                if value.len() > 2048
                    || value.chars().any(|c| c.is_whitespace() || c.is_control())
                    || value.contains('\\')
                {
                    return Err(LookupError::Malformed);
                }
                let url = reqwest::Url::parse(value).map_err(|_| LookupError::Malformed)?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.port().is_some()
                    || !matches!(url.host_str(), Some("maps.google.com" | "www.google.com"))
                    || (url.host_str() == Some("www.google.com")
                        && url.path() != "/maps"
                        && !url.path().starts_with("/maps/"))
                {
                    return Err(LookupError::Malformed);
                }
            }
            items.push(Item {
                place_id: place.place_id.clone(),
                name: place.name.clone(),
                address: place.address.clone(),
                source_url: place.source_url.clone(),
            });
        }
        if evidence
            .html_attributions
            .iter()
            .any(|value| value.trim().is_empty() || value.len() > 2048)
        {
            return Err(LookupError::Malformed);
        }
        let card = Self {
            kind: "places",
            query: query.to_owned(),
            items,
            attributions: evidence.html_attributions.clone(),
        };
        if serde_json::to_vec(&card)
            .map_err(|_| LookupError::Malformed)?
            .len()
            > MAX_WIRE_BYTES
        {
            return Err(LookupError::Oversized);
        }
        Ok(card)
    }

    pub fn value(&self) -> serde_json::Value {
        // This type contains only bounded strings, arrays and null: serialization
        // cannot fail and never includes coordinates or other provider fields.
        serde_json::to_value(self).expect("bounded address card serializes")
    }

    pub fn digest(&self) -> String {
        let items: Vec<_> = self
            .items
            .iter()
            .map(|item| {
                serde_json::json!([item.place_id, item.name, item.address, item.source_url,])
            })
            .collect();
        let canonical = serde_json::json!([
            "cosmos.place-address-card",
            1,
            self.query,
            items,
            self.attributions,
        ]);
        crate::surface_registry::hash(canonical.to_string().as_bytes())
    }
}

struct Entry {
    principal: String,
    fence: TurnFence,
    reference: Reference,
    card: Arc<Card>,
    committed: bool,
}

#[derive(Default)]
pub struct Cache {
    entries: Mutex<BTreeMap<Uuid, Entry>>,
}

impl fmt::Debug for Cache {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Cache([REDACTED])")
    }
}

impl Cache {
    pub fn stage(
        self: &Arc<Self>,
        principal: &str,
        fence: &TurnFence,
        card: Card,
        now: i64,
    ) -> Result<Pending, RuntimeError> {
        let expires_at_ms = now
            .checked_add(TTL_MS)
            .filter(|expires| (1..=MAX_SAFE_INTEGER).contains(expires))
            .ok_or(RuntimeError::InvalidRequest)?;
        if now < 0
            || principal.trim().is_empty()
            || principal.len() > 1024
            || principal.chars().any(char::is_control)
            || fence.turn_id.is_nil()
            || fence.worker.is_nil()
            || fence.origin_surface.is_nil()
            || fence.generation == 0
        {
            return Err(RuntimeError::InvalidRequest);
        }
        let mut entries = self.entries.lock().map_err(|_| RuntimeError::Unavailable)?;
        entries.retain(|_, entry| entry.reference.expires_at_ms > now);
        if entries.len() >= MAX_CARDS
            || entries
                .values()
                .filter(|entry| entry.principal == principal)
                .count()
                >= MAX_PRINCIPAL_CARDS
        {
            return Err(RuntimeError::Busy);
        }
        let mut id = Uuid::new_v4();
        while entries.contains_key(&id) {
            id = Uuid::new_v4();
        }
        let reference = Reference {
            id,
            digest: card.digest(),
            expires_at_ms,
        };
        entries.insert(
            id,
            Entry {
                principal: principal.to_owned(),
                fence: fence.clone(),
                reference: reference.clone(),
                card: Arc::new(card),
                committed: false,
            },
        );
        Ok(Pending {
            cache: self.clone(),
            reference,
            committed: false,
        })
    }

    /// A matching entry is only content availability. CheckDelivery remains the
    /// caller's authority for current routing, privacy and browser incarnation.
    /// A durable action can become deliverable before Pending::commit executes;
    /// staged exact matches remain readable to avoid that cross-thread race.
    pub fn get(&self, principal: &str, action: &Action, now: i64) -> Option<Arc<Card>> {
        let SemanticIntent::PlaceAddressCard { content } = &action.intent else {
            return None;
        };
        if now < 0
            || !content.valid()
            || action.channel != Channel::VisualCard
            || action.content_digest != content.digest
            || action.display_expires_at_ms != content.expires_at_ms
            || now >= content.expires_at_ms
        {
            return None;
        }
        let mut entries = self.entries.lock().ok()?;
        entries.retain(|_, entry| entry.reference.expires_at_ms > now);
        let entry = entries.get(&content.id)?;
        if entry.principal != principal
            || entry.reference != *content
            || entry.fence.turn_id != action.turn_id
            || entry.fence.generation != action.generation
            || entry.fence.worker != action.worker
            || entry.card.digest() != action.content_digest
        {
            return None;
        }
        Some(entry.card.clone())
    }

    pub fn remove(&self, id: Uuid) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&id);
        }
    }

    pub fn discard_turn(&self, principal: &str, fence: &TurnFence) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, entry| {
                entry.principal != principal || !same_fence(&entry.fence, fence)
            });
        }
    }

    pub fn prune_expired(&self, now: i64) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, entry| entry.reference.expires_at_ms > now);
        }
    }

    pub fn bindings(&self) -> Vec<(String, TurnFence, Reference)> {
        self.entries
            .lock()
            .map(|entries| {
                entries
                    .values()
                    .filter(|entry| entry.committed)
                    .map(|entry| {
                        (
                            entry.principal.clone(),
                            entry.fence.clone(),
                            entry.reference.clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn same_fence(left: &TurnFence, right: &TurnFence) -> bool {
    left.turn_id == right.turn_id
        && left.generation == right.generation
        && left.worker == right.worker
        && left.origin_surface == right.origin_surface
}

pub struct Pending {
    cache: Arc<Cache>,
    reference: Reference,
    committed: bool,
}

impl fmt::Debug for Pending {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Pending([REDACTED])")
    }
}

impl Pending {
    pub fn reference(&self) -> &Reference {
        &self.reference
    }

    pub fn commit(mut self) {
        if let Ok(mut entries) = self.cache.entries.lock()
            && let Some(entry) = entries.get_mut(&self.reference.id)
            && entry.reference == self.reference
        {
            entry.committed = true;
            self.committed = true;
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if !self.committed {
            self.cache.remove(self.reference.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambiance::{ActionStatus, PrivacyClass};

    fn evidence() -> places::LookupEvidence {
        places::LookupEvidence {
            places: vec![places::LookupPlace {
                place_id: "place-one".into(),
                name: "Cafe".into(),
                address: "1 Example Street".into(),
                latitude: 55.6761,
                longitude: 12.5683,
                source_url: None,
            }],
            html_attributions: vec!["Google Maps".into()],
            privacy_floor: PrivacyClass::SharedRoom,
        }
    }

    fn card() -> Card {
        Card::from_lookup("Cafe Copenhagen", &evidence()).unwrap()
    }

    fn fence() -> TurnFence {
        TurnFence {
            turn_id: Uuid::new_v4(),
            generation: 1,
            worker: Uuid::new_v4(),
            origin_surface: Uuid::new_v4(),
        }
    }

    fn action(fence: &TurnFence, reference: &Reference) -> Action {
        let id = Uuid::new_v4();
        Action {
            id,
            root_id: id,
            turn_id: fence.turn_id,
            generation: fence.generation,
            worker: fence.worker,
            surface_id: Uuid::new_v4(),
            channel: Channel::VisualCard,
            incarnation: Uuid::new_v4(),
            content_digest: reference.digest.clone(),
            intent: SemanticIntent::PlaceAddressCard {
                content: reference.clone(),
            },
            privacy: PrivacyClass::SharedRoom,
            status: ActionStatus::Dispatched,
            deadline_ms: 3100,
            display_expires_at_ms: reference.expires_at_ms,
            confirmation_root: None,
            origin_surface: Uuid::nil(),
            expression: false,
            attempts: 1,
            fallbacks: Vec::new(),
        }
    }

    #[test]
    fn ambiance_places_visual_digest_vector_and_reference_contain_no_durable_business_content() {
        let card = card();
        assert_eq!(
            card.value(),
            serde_json::json!({"kind":"places","query":"Cafe Copenhagen",
            "items":[{"placeId":"place-one","name":"Cafe","address":"1 Example Street","sourceUrl":null}],
            "attributions":["Google Maps"]})
        );
        assert_eq!(
            card.digest(),
            "722ed289e35fee70beb99082de72d733f5eb4a705b2e2156b9aa7596b4dad578"
        );
        assert_eq!(format!("{card:?}"), "Card([REDACTED])");
        let cache = Arc::new(Cache::default());
        let fence = fence();
        let pending = cache.stage("owner", &fence, card, 100).unwrap();
        let serialized = serde_json::to_value(pending.reference()).unwrap();
        assert_eq!(serialized.as_object().unwrap().len(), 3);
        assert_eq!(serialized["expiresAtMs"], 60100);
        let durable = serde_json::to_string(&action(&fence, pending.reference())).unwrap();
        for raw in [
            "Cafe",
            "Copenhagen",
            "1 Example Street",
            "place-one",
            "Google Maps",
            "55.6761",
        ] {
            assert!(
                !durable.contains(raw),
                "only the content reference belongs in the action"
            );
            assert!(!format!("{cache:?}").contains(raw));
        }
    }

    #[test]
    fn ambiance_places_visual_reference_is_strict_and_javascript_safe() {
        let valid = Reference {
            id: Uuid::new_v4(),
            digest: "ab".repeat(32),
            expires_at_ms: MAX_SAFE_INTEGER,
        };
        assert!(valid.valid());
        let mut changed = valid.clone();
        changed.id = Uuid::nil();
        assert!(!changed.valid());
        changed = valid.clone();
        changed.digest = "AB".repeat(32);
        assert!(!changed.valid());
        changed = valid.clone();
        changed.expires_at_ms += 1;
        assert!(!changed.valid());
        changed.expires_at_ms = 0;
        assert!(!changed.valid());
        let mut unknown = serde_json::to_value(&valid).unwrap();
        unknown["query"] = "not durable".into();
        assert!(serde_json::from_value::<Reference>(unknown).is_err());
    }

    #[test]
    fn ambiance_places_visual_card_preserves_all_attribution_and_rejects_whole_oversized_payload() {
        let mut source = evidence();
        source.html_attributions = vec![
            "<a href=\"https://example.org\">Credit</a>\n".into(),
            "Credit again".into(),
            "Credit again".into(),
        ];
        let card = Card::from_lookup("Cafe Copenhagen", &source).unwrap();
        assert_eq!(
            card.value()["attributions"],
            serde_json::json!(source.html_attributions)
        );
        assert_eq!(
            card.value()["items"][0]["sourceUrl"],
            serde_json::Value::Null
        );
        assert!(card.value()["items"][0].get("latitude").is_none());
        let mut oversized = evidence();
        oversized.places = (0..4)
            .map(|_| places::LookupPlace {
                place_id: "i".repeat(1024),
                name: "n".repeat(256),
                address: "a".repeat(512),
                latitude: 0.0,
                longitude: 0.0,
                source_url: None,
            })
            .collect();
        oversized.html_attributions = vec!["c".repeat(1024), "d".repeat(1024)];
        assert_eq!(
            Card::from_lookup("q", &oversized).err(),
            Some(LookupError::Oversized)
        );
        source.html_attributions.push("  ".into());
        assert_eq!(
            Card::from_lookup("q", &source).err(),
            Some(LookupError::Malformed)
        );
    }

    #[test]
    fn ambiance_places_visual_staged_exact_delivery_is_available_without_exposing_maintenance_binding()
     {
        let cache = Arc::new(Cache::default());
        let fence = fence();
        let pending = cache.stage("owner", &fence, card(), 100).unwrap();
        let action = action(&fence, pending.reference());
        assert!(cache.bindings().is_empty());
        assert!(
            cache.get("owner", &action, 101).is_some(),
            "CheckDelivery can precede Pending::commit"
        );
        let mut wrong = action.clone();
        wrong.content_digest = "0".repeat(64);
        assert!(cache.get("owner", &wrong, 101).is_none());
        wrong = action.clone();
        if let SemanticIntent::PlaceAddressCard { content } = &mut wrong.intent {
            content.id = Uuid::new_v4();
        }
        assert!(cache.get("owner", &wrong, 101).is_none());
        drop(pending);
        assert!(
            cache.get("owner", &action, 102).is_none(),
            "failed proposal guard removes staged content"
        );
    }

    #[test]
    fn ambiance_places_visual_commit_binds_principal_fence_digest_and_expiry() {
        let cache = Arc::new(Cache::default());
        let fence = fence();
        let pending = cache.stage("owner", &fence, card(), 100).unwrap();
        let action = action(&fence, pending.reference());
        pending.commit();
        assert_eq!(cache.bindings().len(), 1);
        assert!(cache.get("owner", &action, 101).is_some());
        assert!(cache.get("someone-else", &action, 101).is_none());
        let mut wrong = action.clone();
        wrong.turn_id = Uuid::new_v4();
        assert!(cache.get("owner", &wrong, 101).is_none());
        wrong = action.clone();
        wrong.worker = Uuid::new_v4();
        assert!(cache.get("owner", &wrong, 101).is_none());
        wrong = action.clone();
        wrong.generation += 1;
        assert!(cache.get("owner", &wrong, 101).is_none());
        wrong = action.clone();
        wrong.display_expires_at_ms -= 1;
        assert!(cache.get("owner", &wrong, 101).is_none());
        wrong = action.clone();
        wrong.channel = Channel::AudioTts;
        assert!(cache.get("owner", &wrong, 101).is_none());
        assert!(cache.get("owner", &action, 60100).is_none());
        cache.prune_expired(60100);
        assert!(cache.bindings().is_empty());
    }

    #[test]
    fn ambiance_places_visual_caps_include_staged_entries_and_expiry_reclaims_capacity() {
        let cache = Arc::new(Cache::default());
        let fence = fence();
        let mut pending = Vec::new();
        for _ in 0..MAX_PRINCIPAL_CARDS {
            pending.push(cache.stage("owner", &fence, card(), 100).unwrap());
        }
        assert_eq!(
            cache.stage("owner", &fence, card(), 100).err(),
            Some(RuntimeError::Busy)
        );
        pending.pop();
        cache.stage("owner", &fence, card(), 100).unwrap().commit();
        let another = cache.stage("owner", &fence, card(), 60100).unwrap();
        drop(pending);
        assert!(cache.bindings().is_empty());
        another.commit();
        let global = Arc::new(Cache::default());
        for index in 0..MAX_CARDS {
            global
                .stage(
                    &format!("owner-{}", index / MAX_PRINCIPAL_CARDS),
                    &fence,
                    card(),
                    100,
                )
                .unwrap()
                .commit();
        }
        assert_eq!(
            global.stage("new-owner", &fence, card(), 100).err(),
            Some(RuntimeError::Busy)
        );
        assert_eq!(global.bindings().len(), MAX_CARDS);
        global.prune_expired(60100);
        assert!(global.bindings().is_empty());
    }

    #[test]
    fn ambiance_places_visual_discard_and_remove_never_cross_principal_or_turn_boundaries() {
        let cache = Arc::new(Cache::default());
        let first = fence();
        let second = fence();
        let one = cache.stage("owner", &first, card(), 100).unwrap();
        let one_action = action(&first, one.reference());
        one.commit();
        let two = cache.stage("owner", &second, card(), 100).unwrap();
        let two_action = action(&second, two.reference());
        two.commit();
        cache.discard_turn("someone-else", &first);
        assert!(cache.get("owner", &one_action, 101).is_some());
        cache.discard_turn("owner", &first);
        assert!(cache.get("owner", &one_action, 101).is_none());
        assert!(cache.get("owner", &two_action, 101).is_some());
        let id = cache.bindings()[0].2.id;
        cache.remove(id);
        assert!(cache.bindings().is_empty());
        assert!(cache.get("owner", &two_action, 101).is_none());
    }
}
