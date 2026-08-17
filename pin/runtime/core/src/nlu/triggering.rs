//! Triggering-centroid decision layer — exact port of the stock semantics.
//!
//! Derived from operator-owned `liblu_triggering.so` analysis. The stock
//! classifier embeds the
//! utterance to a tanh-bounded 512-d vector (NOT L2-normalized) and scores it
//! against 17 centroids with **Euclidean L2** distance — the `cosine_distance`
//! package naming elsewhere is a misnomer. A centroid is eligible only when
//! `distance < radius` (loose); the winner is the minimum-distance eligible
//! centroid (ties favor the lower slot index via strict `>` comparison); the
//! `autocomplete` flag is `distance < strict_radius`, and `strict_radius = -1`
//! disables that tier. This module owns table parsing and the decision; the
//! encoder is supplied by the feature-gated runtime.

use serde::Deserialize;

pub const EMBEDDING_DIM: usize = 512;

/// One centroid entry from `lu_triggering/centroids.json`. The shipped file
/// is a bare array whose numeric fields (including every embedding element)
/// are JSON strings — `RawCentroid` mirrors that wire shape exactly and
/// [`CentroidTable::parse`] converts it.
#[derive(Clone, Debug, Deserialize)]
struct RawCentroid {
    triggering_str: String,
    index: String,
    strict_radius: String,
    radius: String,
    embedding: Vec<String>,
}

/// One parsed centroid.
#[derive(Clone, Debug)]
pub struct Centroid {
    /// The intent name the stock parser reports (e.g. `Play`, `CallPerson`).
    pub triggering_str: String,
    /// Stock catalog index (0..800 range, not the array slot).
    pub index: i64,
    pub strict_radius: f64,
    pub radius: f64,
    /// 512-d embedding.
    pub tokens: Vec<f32>,
}

/// The classification a caller receives. Content-free by construction: the
/// intent string comes from the shipped closed set, never from the utterance.
#[derive(Clone, Debug, PartialEq)]
pub struct EntryIntent {
    pub intent: String,
    pub distance: f64,
    /// Winner's array slot (tie-break order matches stock).
    pub slot: usize,
    /// True when inside the strict radius — stock's high-precision
    /// "autocomplete" tier. This is the tier the S2 nudge gate uses.
    pub autocomplete: bool,
}

#[derive(Clone, Debug)]
pub struct CentroidTable {
    centroids: Vec<Centroid>,
}

impl CentroidTable {
    /// Parse `centroids.json` (a bare array with string-encoded numerics).
    /// Rejects entries whose vector is not exactly 512-d or whose numerics do
    /// not parse, so a truncated or malformed asset fails loudly at load, not
    /// silently at classify time.
    pub fn parse(json: &str) -> Result<Self, String> {
        let raw: Vec<RawCentroid> =
            serde_json::from_str(json).map_err(|error| error.to_string())?;
        if raw.is_empty() {
            return Err("centroid table is empty".to_string());
        }
        let mut centroids = Vec::with_capacity(raw.len());
        for (slot, entry) in raw.into_iter().enumerate() {
            if entry.embedding.len() != EMBEDDING_DIM {
                return Err(format!(
                    "centroid slot {slot} has {} dims (expected {EMBEDDING_DIM})",
                    entry.embedding.len()
                ));
            }
            let parse_f64 = |value: &str, field: &str| -> Result<f64, String> {
                value
                    .parse::<f64>()
                    .map_err(|_| format!("centroid slot {slot}: bad {field} '{value}'"))
            };
            let tokens = entry
                .embedding
                .iter()
                .map(|value| value.parse::<f32>())
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|_| format!("centroid slot {slot}: non-numeric embedding element"))?;
            centroids.push(Centroid {
                index: parse_f64(&entry.index, "index")? as i64,
                strict_radius: parse_f64(&entry.strict_radius, "strict_radius")?,
                radius: parse_f64(&entry.radius, "radius")?,
                triggering_str: entry.triggering_str,
                tokens,
            });
        }
        Ok(Self { centroids })
    }

    pub fn len(&self) -> usize {
        self.centroids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.centroids.is_empty()
    }

    /// Stock decision: score ONLY centroids whose intent passes the caller's
    /// allowlist filter (stock scores only `getSeqAllowList` members),
    /// eligibility = `distance < radius`, winner = strict minimum, tie favors
    /// the earlier slot, autocomplete = `distance < strict_radius` (a -1
    /// strict radius never autocompletes).
    pub fn classify<F>(&self, embedding: &[f32], allow: F) -> Option<EntryIntent>
    where
        F: Fn(&str) -> bool,
    {
        if embedding.len() != EMBEDDING_DIM {
            return None;
        }
        let mut winner: Option<EntryIntent> = None;
        for (slot, centroid) in self.centroids.iter().enumerate() {
            if !allow(&centroid.triggering_str) {
                continue;
            }
            let distance = l2_distance(embedding, &centroid.tokens);
            if distance >= centroid.radius {
                continue;
            }
            let better = match &winner {
                None => true,
                // Strict `>` in stock's min scan: a later equal distance does
                // not displace the earlier winner.
                Some(current) => current.distance > distance,
            };
            if better {
                winner = Some(EntryIntent {
                    intent: centroid.triggering_str.clone(),
                    distance,
                    slot,
                    autocomplete: centroid.strict_radius >= 0.0
                        && distance < centroid.strict_radius,
                });
            }
        }
        winner
    }
}

/// Euclidean L2 accumulated in f64, matching the native implementation
/// (`fsub → square → f64 accumulate → fsqrt`).
fn l2_distance(a: &[f32], b: &[f32]) -> f64 {
    let mut sum = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let d = (*x - *y) as f64;
        sum += d * d;
    }
    sum.sqrt()
}

/// Whether an intent string is the stock Play intent (both wire spellings).
pub fn is_play_intent(intent: &str) -> bool {
    intent == "Play" || intent == "{\"Play\":{}}"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_json(entries: &[(&str, f64, f64, f32)]) -> String {
        // Real wire shape: bare array, string-encoded numerics, `embedding`
        // field. Each entry gets a constant-valued 512-d vector so distances
        // are exact.
        let examples: Vec<String> = entries
            .iter()
            .map(|(intent, strict, loose, fill)| {
                let vec = vec![format!("\"{fill}\""); EMBEDDING_DIM].join(",");
                format!(
                    r#"{{"triggering_str":"{intent}","index":"200","strict_radius":"{strict}","radius":"{loose}","embedding":[{vec}]}}"#
                )
            })
            .collect();
        format!("[{}]", examples.join(","))
    }

    fn zeros() -> Vec<f32> {
        vec![0.0; EMBEDDING_DIM]
    }

    #[test]
    fn parses_the_real_stock_centroid_table() {
        let Some(json) = crate::nlu::stock_assets::stock_asset_text("lu_triggering/centroids.json")
        else {
            return; // stock workspace absent (fresh clone / CI)
        };
        let table = CentroidTable::parse(&json).expect("stock table parses");
        assert_eq!(table.len(), 17, "stock ships 17 centroids");
        // The teardown-documented Play thresholds hold.
        let play = table
            .centroids
            .iter()
            .find(|c| is_play_intent(&c.triggering_str))
            .expect("Play centroid present");
        assert!(
            (play.strict_radius - 1.512).abs() < 0.01,
            "{}",
            play.strict_radius
        );
        assert!((play.radius - 1.832).abs() < 0.01, "{}", play.radius);
    }

    #[test]
    fn eligibility_uses_the_loose_radius_and_winner_is_min_distance() {
        // Constant vectors: distance from zeros = |fill| * sqrt(512).
        // sqrt(512) ≈ 22.63 → fill 0.05 → ≈1.131; fill 0.07 → ≈1.584.
        let json = table_json(&[
            ("A", -1.0, 1.2, 0.05), // dist ≈1.131 < 1.2 → eligible
            ("B", -1.0, 2.0, 0.07), // dist ≈1.584 < 2.0 → eligible but farther
            ("C", -1.0, 1.0, 0.09), // dist ≈2.036 ≥ 1.0 → ineligible
        ]);
        let table = CentroidTable::parse(&json).unwrap();
        let intent = table.classify(&zeros(), |_| true).unwrap();
        assert_eq!(intent.intent, "A");
        assert!(!intent.autocomplete, "strict=-1 never autocompletes");
    }

    #[test]
    fn autocomplete_requires_the_strict_radius() {
        let json = table_json(&[("Play", 1.2, 1.9, 0.05)]); // dist ≈1.131
        let table = CentroidTable::parse(&json).unwrap();
        let hit = table.classify(&zeros(), |_| true).unwrap();
        assert!(hit.autocomplete, "1.131 < strict 1.2");
        let json = table_json(&[("Play", 1.0, 1.9, 0.05)]);
        let table = CentroidTable::parse(&json).unwrap();
        let hit = table.classify(&zeros(), |_| true).unwrap();
        assert!(!hit.autocomplete, "1.131 >= strict 1.0");
    }

    #[test]
    fn allowlist_excludes_centroids_from_scoring_entirely() {
        let json = table_json(&[
            ("Blocked", -1.0, 2.0, 0.05), // nearest, but not allowlisted
            ("Allowed", -1.0, 2.0, 0.07),
        ]);
        let table = CentroidTable::parse(&json).unwrap();
        let hit = table
            .classify(&zeros(), |intent| intent == "Allowed")
            .unwrap();
        assert_eq!(hit.intent, "Allowed");
        // Nothing allowlisted → no classification at all.
        assert!(table.classify(&zeros(), |_| false).is_none());
    }

    #[test]
    fn earlier_slot_wins_exact_ties() {
        let json = table_json(&[("First", -1.0, 2.0, 0.05), ("Second", -1.0, 2.0, 0.05)]);
        let table = CentroidTable::parse(&json).unwrap();
        let hit = table.classify(&zeros(), |_| true).unwrap();
        assert_eq!((hit.intent.as_str(), hit.slot), ("First", 0));
    }

    #[test]
    fn wrong_dimension_embedding_classifies_nothing() {
        let json = table_json(&[("A", -1.0, 2.0, 0.0)]);
        let table = CentroidTable::parse(&json).unwrap();
        assert!(table.classify(&[0.0; 8], |_| true).is_none());
    }
}
