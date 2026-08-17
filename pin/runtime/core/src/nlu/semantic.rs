//! Semantic interpreter — exact port of the stock SEMANTIC layer (S3).
//!
//! The stock Pin runs a second on-device NLU stage AFTER the triggering/NER
//! ladder: a 404-exemplar, 512-dim semantic interpreter with HNSW k=1
//! nearest-neighbor and a 0.4 squared-L2 rejection radius. Each exemplar
//! carries a closed-set interpretation JSON string (46 distinct labels —
//! `{"GetCurrentTime": {}}`, `{"NOT_CallPerson": {"To":["911"]}}`, …). A hit
//! must both fall inside the radius AND land on an interpretation that is
//! present in the exemplar catalog (the **validity gate**) — this is the
//! stock's defense against the HNSW graph returning a neighbor whose label
//! isn't actually actionable.
//!
//! # Encoder status
//!
//! The encoder is Google's "Kona" Universal Sentence Encoder (USE-lite),
//! shipped at `assets/text_encoder/text_encoder.tflite` with a separate
//! 8000-piece SentencePiece vocabulary (`use_8k_spiece.model`). The full
//! I/O contract (host-verified via LiteRT 2026-07-24):
//!
//! - **Input**: 3× `I64` sparse-tensor components — `dense_shape=[1,N]`,
//!   `indices=[[0,0],[0,1],…,[0,N-1]]`, `values=token_ids` (raw USE
//!   SentencePiece IDs, NO `<s>`/`</s>` sentinels).
//! - **Output**: `F32 [1, 512]` — L2-normalized (‖emb‖₂ ≈ 1.0).
//! - **Preprocessing**: `normalize_utterance()` (NFD diacritic strip →
//!   lowercase → punctuation strip preserving `hh:mm` → whitespace
//!   collapse) → `SpieceTokenizer::encode_use()` (whole-sentence USE
//!   vocab, no EOS append) → sparse tensor assembly.
//! - **Postprocessing**: none — the graph tail applies `tanh` then
//!   `L2_NORMALIZATION`, so the output is unit-length by construction.
//!
//! The encoder runs on-device only (Android + `local-nlu` feature) behind
//! the stock TFLite 2.11.0 C library. On other builds, the constructor
//! receives `None` and `encode()` returns `None` — the semantic stage
//! fails open to exactly today's behavior.
//!
//! The algorithmic half — brute-force k=1 NN over the precomputed exemplar
//! vectors, the 0.4 squared-L2 radius, the validity gate — is fully
//! exercised and tested against the stock exemplar asset via
//! `interpret_with_embedding`, which accepts a precomputed vector. With
//! the encoder wired, `interpret()` becomes a one-step call.
//!
//! # Why brute force instead of HNSW
//!
//! HNSW is a native library on the stock side; for 404 × 512 a linear scan
//! in Rust is a few tens of microseconds and has exactly the same recall as
//! the native graph (k=1, exact). No native dep, no FFI, bit-exact.

use std::collections::HashSet;

#[cfg(feature = "local-nlu")]
use unicode_normalization::UnicodeNormalization;

use crate::nlu::triggering::EMBEDDING_DIM;
/// APK asset path for the exemplar table (stock ironman.apk).
pub const SEMANTIC_EXEMPLARS_ENTRY: &str =
    "assets/semantic/semantic_distance_interpreter_tokens.json";

/// Squared-L2 radius under which a neighbor is accepted. Stock ships 0.4.
pub const SEMANTIC_RADIUS_SQ: f32 = 0.4;

/// One parsed exemplar: a 512-d vector plus its closed-set interpretation.
#[derive(Clone, Debug)]
pub struct Exemplar {
    /// Stock interpretation JSON string, e.g. `{"GetCurrentTime": {}}`.
    pub interpretation: String,
    /// 512-d precomputed embedding from the stock asset.
    pub embedding: Vec<f32>,
}

/// The outcome of a semantic query.
#[derive(Clone, Debug, PartialEq)]
pub struct SemanticHit {
    /// The exemplar's interpretation (closed-set; passes the validity gate).
    pub interpretation: String,
    /// Squared L2 distance to the winning exemplar.
    pub distance_sq: f32,
    /// Index of the winning exemplar in the loaded table.
    pub exemplar_index: usize,
}

/// The semantic interpreter. Loaded once from the stock exemplar JSON; owns
/// the closed-set catalog used by the validity gate.
pub struct SemanticInterpreter {
    exemplars: Vec<Exemplar>,
    /// The validity gate: the closed set of interpretations present in the
    /// exemplar table. Stock checks `catalog.contains(hit.interpretation)`
    /// after the HNSW query; we mirror that exactly.
    catalog: HashSet<String>,
    /// The live encoder closure. Captures the Kona USE `TextEncoder` + the
    /// USE `SpieceTokenizer` by move. Only present with `local-nlu` (which
    /// is when the encoder types exist). Without it, `encode()` is inert
    /// and `interpret()` always returns `None`.
    #[cfg(feature = "local-nlu")]
    encoder_fn: Option<Box<dyn Fn(&str) -> Option<Vec<f32>> + Send + Sync>>,
}

impl SemanticInterpreter {
    /// Parse the exemplar JSON (`{"examples": [{"tokens": [...],
    /// "interpretation": "..."}]}`). Every exemplar must have exactly 512
    /// dims; any deviation is a load-time error (fail-open at the caller).
    ///
    /// `encoder_fn` is the live USE encoder closure (provided by the caller
    /// when running on Android with `local-nlu`). Pass `None` on host /
    /// without the feature — `encode()` then returns `None` and the
    /// algorithmic half stays testable via `interpret_with_embedding`.
    pub fn from_json(
        json: &str,
        #[cfg(feature = "local-nlu")] encoder_fn: Option<
            Box<dyn Fn(&str) -> Option<Vec<f32>> + Send + Sync>,
        >,
    ) -> Result<Self, String> {
        let root: serde_json::Value =
            serde_json::from_str(json).map_err(|e| format!("semantic json parse: {e}"))?;
        let examples = root
            .get("examples")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "semantic json: missing `examples` array".to_string())?;
        if examples.is_empty() {
            return Err("semantic json: `examples` is empty".to_string());
        }
        let mut exemplars = Vec::with_capacity(examples.len());
        let mut catalog = HashSet::with_capacity(examples.len());
        for (slot, entry) in examples.iter().enumerate() {
            let interpretation = entry
                .get("interpretation")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("semantic slot {slot}: missing `interpretation`"))?
                .to_string();
            let tokens = entry
                .get("tokens")
                .and_then(|v| v.as_array())
                .ok_or_else(|| format!("semantic slot {slot}: missing `tokens`"))?;
            if tokens.len() != EMBEDDING_DIM {
                return Err(format!(
                    "semantic slot {slot}: {} dims (expected {EMBEDDING_DIM})",
                    tokens.len()
                ));
            }
            let embedding: Vec<f32> = tokens
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    v.as_f64()
                        .map(|n| n as f32)
                        .ok_or_else(|| format!("semantic slot {slot} dim {i}: non-numeric token"))
                })
                .collect::<Result<_, _>>()?;
            catalog.insert(interpretation.clone());
            exemplars.push(Exemplar {
                interpretation,
                embedding,
            });
        }
        Ok(Self {
            exemplars,
            catalog,
            #[cfg(feature = "local-nlu")]
            encoder_fn,
        })
    }

    /// Number of exemplars loaded.
    pub fn len(&self) -> usize {
        self.exemplars.len()
    }

    /// Whether the interpreter loaded any exemplars.
    pub fn is_empty(&self) -> bool {
        self.exemplars.is_empty()
    }

    /// The closed set of interpretations in the loaded exemplar table.
    pub fn catalog(&self) -> &HashSet<String> {
        &self.catalog
    }

    /// Encode a normalized utterance to a 512-d L2-normalized vector via
    /// the Kona USE encoder.
    ///
    /// The encoder is wired on Android with the `local-nlu` feature; on
    /// other builds this returns `None` and `interpret()` is inert. The
    /// algorithmic half (NN + radius + validity) stays testable via
    /// [`interpret_with_embedding`], which accepts a precomputed vector —
    /// the host-side tests exercise it with the stock exemplar table.
    ///
    /// [`interpret_with_embedding`]: Self::interpret_with_embedding
    pub fn encode(&self, normalized: &str) -> Option<Vec<f32>> {
        #[cfg(feature = "local-nlu")]
        {
            (self.encoder_fn.as_ref()?)(normalized)
        }
        #[cfg(not(feature = "local-nlu"))]
        {
            let _ = normalized;
            None
        }
    }

    /// Brute-force k=1 nearest neighbor over the precomputed exemplar
    /// vectors, with the 0.4 squared-L2 radius and the validity gate.
    ///
    /// This is the full stock decision minus the encoder: the HNSW graph on
    /// the stock side returns the same k=1 neighbor that the linear scan
    /// finds here, and the post-filter (radius + catalog membership) is
    /// byte-identical. With 404 exemplars the linear scan is ~200K FMAs —
    /// tens of microseconds in release mode, well under the chat-turn step budget.
    pub fn interpret_with_embedding(&self, embedding: &[f32]) -> Option<SemanticHit> {
        if embedding.len() != EMBEDDING_DIM {
            return None;
        }
        let mut best: Option<SemanticHit> = None;
        for (index, exemplar) in self.exemplars.iter().enumerate() {
            let distance_sq = squared_l2(embedding, &exemplar.embedding);
            if distance_sq >= SEMANTIC_RADIUS_SQ {
                continue;
            }
            // Validity gate: the interpretation must be in the closed
            // catalog. With exemplars parsed from the asset this is
            // structurally always true, but we keep the check to mirror
            // stock's post-HNSW guard and to be defensive if the table is
            // ever filtered (e.g. allowlist prunes a subset).
            if !self.catalog.contains(&exemplar.interpretation) {
                continue;
            }
            let better = match &best {
                None => true,
                Some(current) => current.distance_sq > distance_sq,
            };
            if better {
                best = Some(SemanticHit {
                    interpretation: exemplar.interpretation.clone(),
                    distance_sq,
                    exemplar_index: index,
                });
            }
        }
        best
    }

    /// Entry point: normalize → encode → k=1 NN → validity gate.
    ///
    /// Live on Android with `local-nlu` (encoder wired); inert elsewhere
    /// (`encode()` returns `None` → this returns `None`). The algorithmic
    /// half is always testable via `interpret_with_embedding`.
    pub fn interpret(&self, utterance: &str) -> Option<SemanticHit> {
        let normalized = normalize_utterance(utterance);
        let embedding = self.encode(&normalized)?;
        self.interpret_with_embedding(&embedding)
    }
}

/// Stock utterance normalization (SEMANTIC pre-pass):
///
/// 1. NFD-decompose and drop combining marks (diacritic strip).
/// 2. Lowercase.
/// 3. Strip punctuation EXCEPT colons that sit between two digits (i.e.
///    preserve `hh:mm` time expressions).
/// 4. Collapse runs of whitespace to a single space.
/// 5. Trim leading/trailing whitespace.
///
/// Matches the stock native preprocessor that runs ahead of the semantic
/// encoder. The triggering stage uses a DIFFERENT normalization (no
/// lowercase, 253-byte cap); this one is the SEMANTIC-specific pipeline.
pub fn normalize_utterance(text: &str) -> String {
    // 1. NFD + strip combining marks (diacritic strip). Only runs when the
    //    `unicode-normalization` dep is available (the `local-nlu` feature);
    //    without it we fall through to a simpler ASCII-only pipeline so the
    //    rest of the module still compiles and tests run on every build.
    #[cfg(feature = "local-nlu")]
    let stripped: String = text.nfd().filter(|c| !is_combining_mark(*c)).collect();
    #[cfg(not(feature = "local-nlu"))]
    let stripped: String = text.to_string();
    // 2. Lowercase.
    let lowered = stripped.to_lowercase();
    // 3. Punctuation removal preserving hh:mm.
    let chars: Vec<char> = lowered.chars().collect();
    let mut kept = String::with_capacity(chars.len());
    for (i, c) in chars.iter().enumerate() {
        if c.is_ascii_digit() || c.is_alphabetic() || c.is_whitespace() {
            kept.push(*c);
            continue;
        }
        if *c == ':' {
            // Preserve when both neighbors are ASCII digits (hh:mm).
            let prev_digit = i > 0 && chars[i - 1].is_ascii_digit();
            let next_digit = i + 1 < chars.len() && chars[i + 1].is_ascii_digit();
            if prev_digit && next_digit {
                kept.push(*c);
                continue;
            }
        }
        // Everything else (punctuation, symbols) → space.
        kept.push(' ');
    }
    // 4. Collapse whitespace.
    let collapsed: String = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    // 5. Trim (split_whitespace already did, but be explicit).
    collapsed.trim().to_string()
}

fn is_combining_mark(c: char) -> bool {
    // Unicode category M (Mark): Mn + Mc + Me. The `unicode-normalization`
    // crate re-exports the predicate via the `char` module.
    #[cfg(feature = "local-nlu")]
    {
        unicode_normalization::char::is_combining_mark(c)
    }
    #[cfg(not(feature = "local-nlu"))]
    {
        // Without the dep we can't do full NFD stripping; approximate by
        // treating ASCII combining-range codepoints as marks. This branch
        // only runs in feature-off builds, where the semantic stage is
        // inert anyway (the encoder stub returns `None`).
        let _ = c;
        false
    }
}

/// Squared L2 in f64 accumulation (matches the triggering module's `l2_distance`
/// except we return the unsquared sum — stock's semantic gate is `sq < 0.4`,
/// not `sqrt < 0.4`).
fn squared_l2(a: &[f32], b: &[f32]) -> f32 {
    let mut sum = 0.0f64;
    for (x, y) in a.iter().zip(b.iter()) {
        let d = (*x - *y) as f64;
        sum += d * d;
    }
    sum as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `None` when the stock workspace is absent (fresh clone / CI).
    fn stock_exemplars_json() -> Option<String> {
        crate::nlu::stock_assets::stock_asset_text(
            "semantic/semantic_distance_interpreter_tokens.json",
        )
    }

    /// `None` when the stock workspace is absent (fresh clone / CI).
    fn stock_interpreter() -> Option<SemanticInterpreter> {
        Some(
            SemanticInterpreter::from_json(
                &stock_exemplars_json()?,
                #[cfg(feature = "local-nlu")]
                None,
            )
            .expect("stock parses"),
        )
    }

    // ── normalize_utterance ────────────────────────────────────────────

    #[cfg(feature = "local-nlu")]
    #[test]
    fn normalize_strips_diacritics_lowercases_and_collapses_whitespace() {
        // NFD: é → e + combining acute; the combining mark is dropped.
        // Only runs with the `local-nlu` feature — without
        // `unicode-normalization` the diacritic strip is a no-op and the
        // `cafe resume` assertion wouldn't hold.
        let out = normalize_utterance("  Café   résumé ");
        assert_eq!(out, "cafe resume");
    }

    #[cfg(not(feature = "local-nlu"))]
    #[test]
    fn normalize_lowercases_and_collapses_whitespace_without_unicode_dep() {
        // Without `unicode-normalization` the diacritic strip is a no-op
        // (the encoder stub is also inert in this build), but lowercase +
        // whitespace collapse still run.
        let out = normalize_utterance("  Café   résumé ");
        assert_eq!(out, "café résumé");
    }

    #[test]
    fn normalize_preserves_hhmm_but_strips_other_colons() {
        // "meet at 7:30 pm:" — the hh:mm colon stays, the trailing colon
        // becomes a space.
        let out = normalize_utterance("Meet at 7:30 pm:");
        assert_eq!(out, "meet at 7:30 pm");
    }

    #[test]
    fn normalize_drops_question_marks_and_apostrophes() {
        // Punctuation becomes a space, then whitespace collapses. So the
        // apostrophe in "What's" becomes "what s" (matching the stock
        // normalizer's per-char replacement).
        let out = normalize_utterance("What's the weather?");
        assert_eq!(out, "what s the weather");
    }

    // ── exemplar table loading ─────────────────────────────────────────

    #[test]
    fn parses_the_real_stock_exemplar_table() {
        let Some(interp) = stock_interpreter() else {
            return; // stock workspace absent (fresh clone / CI)
        };
        assert_eq!(interp.len(), 404);
        assert_eq!(interp.catalog().len(), 46);
        // A handful of expected catalog members.
        for expected in [
            r#"{"GetCurrentTime": {}}"#,
            r#"{"NOT_CallPerson": {"To":["911"]}}"#,
            r#"{"TurnOnWifi":{}}"#,
        ] {
            assert!(
                interp.catalog().contains(expected),
                "missing catalog member: {expected}"
            );
        }
    }

    // ── brute-force k=1 NN ─────────────────────────────────────────────

    #[test]
    fn nn_returns_the_exact_exemplar_at_zero_distance() {
        let Some(interp) = stock_interpreter() else {
            return; // stock workspace absent (fresh clone / CI)
        };
        // Querying with exemplar #7's own vector must return exemplar #7 at
        // squared distance 0 (or within rounding of 0).
        let target = interp.exemplars[7].embedding.clone();
        let expected_label = interp.exemplars[7].interpretation.clone();
        let hit = interp
            .interpret_with_embedding(&target)
            .expect("exemplar should find itself");
        assert_eq!(hit.interpretation, expected_label);
        assert_eq!(hit.exemplar_index, 7);
        assert!(hit.distance_sq < 1e-6, "self-distance should be ~0");
    }

    #[test]
    fn nn_rejects_orthogonal_vectors_outside_the_radius() {
        let Some(interp) = stock_interpreter() else {
            return; // stock workspace absent (fresh clone / CI)
        };
        // A 512-d vector of constant 1.0 has squared norm 512; stock
        // exemplars are small (tanh-bounded, ~= 512 * 0.03^2 ~= 0.5
        // total). The squared distance from `ones` to any exemplar is on
        // the order of 500, far above the 0.4 radius → rejection.
        let orthogonal = vec![1.0f32; EMBEDDING_DIM];
        assert!(
            interp.interpret_with_embedding(&orthogonal).is_none(),
            "orthogonal probe must be rejected by the 0.4 radius"
        );
    }

    #[test]
    fn nn_rejects_wrong_dimension_input() {
        let Some(interp) = stock_interpreter() else {
            return; // stock workspace absent (fresh clone / CI)
        };
        assert!(interp.interpret_with_embedding(&[0.0; 128]).is_none());
        assert!(interp.interpret_with_embedding(&[]).is_none());
    }

    #[test]
    fn interpret_is_inert_without_encoder() {
        // Without the `local-nlu` feature (the host default), no encoder
        // closure is provided, so `encode()` returns `None` and `interpret`
        // is inert. With the feature, passing `None` has the same effect.
        let Some(exemplars) = stock_exemplars_json() else {
            return; // stock workspace absent (fresh clone / CI)
        };
        let interp = SemanticInterpreter::from_json(
            &exemplars,
            #[cfg(feature = "local-nlu")]
            None,
        )
        .unwrap();
        assert!(interp.interpret("what time is it").is_none());
    }
}
