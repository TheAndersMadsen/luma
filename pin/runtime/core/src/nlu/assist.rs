#![cfg(feature = "local-nlu")]
//! `NluAssist` — the single facade the tool-calling layer consumes.
//!
//! Every method is fail-open: `None` on any failure (missing model, digest
//! mismatch, tokenizer error, timeout, below-gate confidence) and the caller
//! behaves exactly as today. Outputs are untrusted DATA for prompts, arg
//! coercion, ranking, one nudge, and the content-free census — never action
//! authority.

use std::sync::Mutex;

use crate::nlu::assets::{
    ApkAssets, CENTROIDS_ENTRY, CENTROIDS_SHA256, IRONMAN_APK_PATH, LABEL_MAP_ENTRY,
    LABEL_MAP_SHA256, NER_ENCODER_ENTRY, NER_ENCODER_SHA256, SEMANTIC_EXEMPLARS_ENTRY,
    SEMANTIC_EXEMPLARS_SHA256, SPIECE_ENTRY, SPIECE_SHA256, TEXT_ENCODER_ENTRY,
    TEXT_ENCODER_SHA256, TRIGGERING_ENCODER_ENTRY, TRIGGERING_ENCODER_SHA256, USE_SPIECE_ENTRY,
    USE_SPIECE_SHA256,
};
use crate::nlu::encoder::{NluEncoders, TextEncoder, TRIGGERING_INPUT_BYTE_CAP};
use crate::nlu::ner_post::{self, NerSlots, NerToken};
use crate::nlu::semantic::{SemanticHit, SemanticInterpreter};
use crate::nlu::tokenizer::SpieceTokenizer;
use crate::nlu::triggering::{CentroidTable, EntryIntent};

/// Derived from the operator-owned stock native decoder: plain `expf`/sum
/// softmax without max-subtraction.
fn softmax_confidence(row: &[f32], index: usize) -> f64 {
    let sum: f64 = row.iter().map(|v| (*v as f64).exp()).sum();
    if sum == 0.0 {
        return 0.0;
    }
    (row[index] as f64).exp() / sum
}

pub struct NluAssist {
    tokenizer: SpieceTokenizer,
    centroids: CentroidTable,
    labels: Vec<String>,
    encoders: Mutex<NluEncoders>,
    /// Semantic interpreter (S3). Live on-device: the Kona USE encoder
    /// produces 512-d L2-normalized embeddings; the algorithmic half
    /// (brute-force k=1 NN, 0.4 sq-L2 radius, validity gate) is fully
    /// wired in `SemanticInterpreter`.
    semantic: SemanticInterpreter,
}

impl NluAssist {
    /// Load everything from the device's stock APK. `None` (assists disabled)
    /// on any failure. Called once at server init.
    pub fn build() -> Option<std::sync::Arc<Self>> {
        Self::build_from_apk(IRONMAN_APK_PATH)
    }

    fn build_from_apk(path: &str) -> Option<std::sync::Arc<Self>> {
        let apk = ApkAssets::open(path)?;
        let spiece = apk.read_verified(SPIECE_ENTRY, SPIECE_SHA256)?;
        let ner_model = apk.read_verified(NER_ENCODER_ENTRY, NER_ENCODER_SHA256)?;
        // Observed: stock ships no digest manifest for these four, so their
        // digests were measured from the operator-owned pinned firmware. The
        // triggering encoder decides intent, so it gets the same verification
        // as the rest rather than a size heuristic.
        let triggering_model =
            apk.read_verified(TRIGGERING_ENCODER_ENTRY, TRIGGERING_ENCODER_SHA256)?;
        let centroids_json = apk.read_verified(CENTROIDS_ENTRY, CENTROIDS_SHA256)?;
        let label_map = apk.read_verified(LABEL_MAP_ENTRY, LABEL_MAP_SHA256)?;
        let semantic_json =
            apk.read_verified(SEMANTIC_EXEMPLARS_ENTRY, SEMANTIC_EXEMPLARS_SHA256)?;

        // ── Semantic (S3) — Kona USE encoder + exemplar table ──────────
        // The USE SentencePiece vocab (8000-piece) is separate from the
        // T5 32k vocab shared by triggering+NER; the text encoder model
        // is a distinct 7.1 MB USE-lite graph (different architecture).
        // Either asset failing to load/disable keeps the exemplar table
        // loaded but disables live encoding (semantic_hit returns None).
        let use_spiece = apk.read_verified(USE_SPIECE_ENTRY, USE_SPIECE_SHA256);
        let text_encoder_model = apk.read_verified(TEXT_ENCODER_ENTRY, TEXT_ENCODER_SHA256);
        let text_encoder = match (use_spiece, text_encoder_model) {
            (Some(sp), Some(m)) if m.len() >= 1_000_000 => TextEncoder::load(m, sp),
            _ => {
                tracing::warn!("semantic encoder assets unavailable; S3 inert");
                None
            }
        };
        let encoder_fn: Option<Box<dyn Fn(&str) -> Option<Vec<f32>> + Send + Sync>> = text_encoder
            .map(|te| {
                let size = te.model_size();
                tracing::info!(text_encoder_bytes = size, "semantic encoder loaded");
                let encoder = Mutex::new(te);
                Box::new(move |normalized: &str| encoder.lock().ok()?.encode(normalized))
                    as Box<dyn Fn(&str) -> Option<Vec<f32>> + Send + Sync>
            });

        let tokenizer = SpieceTokenizer::from_spiece_model(&spiece).ok()?;
        let centroids = CentroidTable::parse(std::str::from_utf8(&centroids_json).ok()?).ok()?;
        let semantic =
            SemanticInterpreter::from_json(std::str::from_utf8(&semantic_json).ok()?, encoder_fn)
                .ok()?;
        let labels: Vec<String> = serde_json::from_slice::<serde_json::Value>(&label_map)
            .ok()?
            .get(0)?
            .get("labels")?
            .as_array()?
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        if labels.len() != crate::nlu::encoder::NER_LABELS {
            return None;
        }
        let encoders = NluEncoders::load(triggering_model, ner_model)?;
        let (t, n) = encoders.model_sizes();
        tracing::info!(triggering_bytes = t, ner_bytes = n, "nlu assists loaded");
        Some(std::sync::Arc::new(Self {
            tokenizer,
            centroids,
            labels,
            encoders: Mutex::new(encoders),
            semantic,
        }))
    }

    /// Classify the utterance against the stock centroids (triggering-mode
    /// tokenization: diacritics stripped, whole utterance, 253-byte cap).
    pub fn entry_intent(&self, utterance: &str) -> Option<EntryIntent> {
        // Stock caps the tokenizer input at 253 bytes for triggering.
        if crate::nlu::tokenizer::normalize(utterance, false).len() > TRIGGERING_INPUT_BYTE_CAP {
            return None;
        }
        let ids = self.tokenizer.encode_triggering(utterance).ok()?;
        let embedding = self.encoders.lock().ok()?.triggering_embed(&ids)?;
        // Stock scores only allowlisted intents; server-side the census wants
        // ALL intents, and the nudge consumer filters on Play itself.
        self.centroids.classify(&embedding, |_| true)
    }

    /// Extract calibrated music slots (NER-mode tokenization: accents kept,
    /// per-word encode). Returns `None` unless the stock gates pass.
    pub fn music_slots(&self, utterance: &str) -> Option<NerSlots> {
        let (ids, aligned_words) = self.tokenizer.encode_ner(utterance).ok()?;
        let normalized = crate::nlu::tokenizer::normalize(utterance, true);
        let rows = self.encoders.lock().ok()?.ner_logits(&ids)?;
        // Discard the EOS position; merge sub-word groups (last subword's
        // label+confidence wins), exactly like the native decoder.
        let scored = rows.len().checked_sub(1)?;
        if scored != aligned_words.len() {
            return None;
        }
        let mut tokens: Vec<NerToken> = Vec::new();
        let mut group_start = 0usize;
        for position in 0..scored {
            let is_last_of_group =
                position + 1 == scored || aligned_words[position + 1] != aligned_words[position];
            if is_last_of_group {
                let row = &rows[position];
                let (label_index, _) = row
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
                tokens.push(NerToken {
                    label: self.labels.get(label_index)?.clone(),
                    confidence: softmax_confidence(row, label_index),
                    value: aligned_words[position].clone(),
                });
                group_start = position + 1;
            }
        }
        let _ = group_start;
        ner_post::extract_slots(&normalized, &tokens).ok()
    }

    /// Semantic interpreter hit (S3). Runs AFTER triggering — the stock
    /// semantic stage is a second opinion that fires alongside, not above,
    /// the centroid decision. Live on Android with `local-nlu` (Kona USE
    /// encoder wired); inert on host / without the feature.
    pub fn semantic_hit(&self, utterance: &str) -> Option<SemanticHit> {
        self.semantic.interpret(utterance)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `implemented`: this numeric row is independently authored and verifies
    /// only the softmax adapter contract, never model quality or stock parity.
    #[test]
    fn programmatic_softmax_row_is_normalized() {
        let row = [0.0_f32, 1.0, -1.0];
        let probabilities: Vec<f64> = (0..row.len())
            .map(|index| softmax_confidence(&row, index))
            .collect();
        assert!((probabilities.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        assert!(probabilities[1] > probabilities[0]);
        assert!(probabilities[0] > probabilities[2]);
    }
}
