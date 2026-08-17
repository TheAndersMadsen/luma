//! Clean-room integration tests for the NLU decision ports.
//!
//! - `implemented`: centroids, embeddings, token triplets, and utterances are
//!   independently authored in code below.
//! - `unknown`: exact model-output parity is not asserted without a separately
//!   licensed, operator-controlled external baseline.

use super::ner_post::{extract_slots, parse_tokens};
use super::triggering::{CentroidTable, EMBEDDING_DIM};
use serde_json::json;

fn synthetic_centroid(intent: &str, coordinate: usize, value: f32) -> serde_json::Value {
    let mut embedding = vec!["0".to_string(); EMBEDDING_DIM];
    embedding[coordinate] = value.to_string();
    json!({
        "triggering_str": intent,
        "index": "1",
        "strict_radius": "0.10",
        "radius": "0.40",
        "embedding": embedding
    })
}

#[test]
fn synthetic_embedding_and_tokens_cross_the_decision_boundaries() {
    let table_json = serde_json::to_string(&vec![
        synthetic_centroid("SYNTHETIC_PRIMARY", 0, 0.0),
        synthetic_centroid("SYNTHETIC_SECONDARY", 0, 0.30),
    ])
    .expect("synthetic centroids serialize");
    let table = CentroidTable::parse(&table_json).expect("synthetic centroids parse");

    let mut embedding = vec![0.0_f32; EMBEDDING_DIM];
    embedding[0] = 0.05;
    let hit = table
        .classify(&embedding, |_| true)
        .expect("one synthetic centroid is in radius");
    assert_eq!(hit.intent, "SYNTHETIC_PRIMARY");
    assert!(hit.autocomplete);

    let encoded_tokens = [
        "O::0.99::request",
        "song_name::0.97::sample",
        "song_name::0.96::title",
        "artist_name::0.98::example",
    ]
    .map(str::to_string);
    let tokens = parse_tokens(&encoded_tokens);
    let slots = extract_slots("request sample title example", &tokens)
        .expect("independently authored tokens clear the gates");
    assert_eq!(slots.track.as_deref(), Some("sample title"));
    assert_eq!(slots.artist.as_deref(), Some("example"));
}

#[test]
fn synthetic_flow_fails_open_outside_its_contract() {
    let table_json =
        serde_json::to_string(&vec![synthetic_centroid("SYNTHETIC_PRIMARY", 0, 0.0)]).unwrap();
    let table = CentroidTable::parse(&table_json).unwrap();
    assert!(table.classify(&[0.0_f32; 8], |_| true).is_none());

    let encoded_tokens = ["song_name::0.74::sample"].map(str::to_string);
    let tokens = parse_tokens(&encoded_tokens);
    assert_eq!(
        extract_slots("request sample", &tokens)
            .expect_err("below-gate synthetic tokens must be rejected")
            .label(),
        "low_token_confidence"
    );
}
