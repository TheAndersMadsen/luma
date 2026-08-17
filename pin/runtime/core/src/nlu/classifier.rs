//! Generic quantized linear intent-head parser and evaluator.
//!
//! - `implemented`: shape, numeric, size, and SHA-256 checks are exercised with
//!   independently authored programmatic fixtures.
//! - `unknown`: no trained intent head has adequate provenance and licensing in
//!   canonical source, so no weights or encoder outputs are bundled here.
//! - `implemented`: a future operator-supplied head must remain external and
//!   enter through [`IntentHead::from_external_file`] with an expected digest.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read as _;
use std::path::Path;

const MAX_HEAD_BYTES: u64 = 256 * 1024;
const MAX_CLASSES: usize = 128;
const MAX_DIM: usize = 4_096;

#[derive(Deserialize)]
struct HeadArtifact {
    classes: Vec<String>,
    scale: Vec<f32>,
    bias: Vec<f32>,
    weight_i8: Vec<Vec<i8>>,
    dim: usize,
    reject_threshold: f32,
}

pub struct IntentHead {
    classes: Vec<String>,
    weight: Vec<Vec<f32>>,
    bias: Vec<f32>,
    dim: usize,
    threshold: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IntentPrediction {
    pub intent: String,
    pub confidence: f32,
}

impl IntentHead {
    /// Load an operator-controlled external artifact and bind it to an
    /// independently configured SHA-256 digest. The file is bounded before it
    /// is parsed and is never logged.
    pub fn from_external_file(path: &Path, expected_sha256: &str) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("intent head path must be absolute".into());
        }
        let file = std::fs::File::open(path)
            .map_err(|_| "intent head external asset is unavailable".to_string())?;
        let mut bytes = Vec::new();
        file.take(MAX_HEAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "intent head external asset is unreadable".to_string())?;
        if bytes.len() as u64 > MAX_HEAD_BYTES {
            return Err("intent head external asset exceeds size limit".into());
        }
        Self::from_verified_json(&bytes, expected_sha256)
    }

    /// Parse only after the exact external bytes match the caller's digest.
    pub fn from_verified_json(json: &[u8], expected_sha256: &str) -> Result<Self, String> {
        if expected_sha256.len() != 64
            || !expected_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("intent head SHA-256 must be 64 lowercase hex characters".into());
        }
        if json.len() as u64 > MAX_HEAD_BYTES {
            return Err("intent head external asset exceeds size limit".into());
        }
        let actual = Sha256::digest(json);
        let actual_hex: String = actual.iter().map(|byte| format!("{byte:02x}")).collect();
        if actual_hex != expected_sha256 {
            return Err("intent head SHA-256 mismatch".into());
        }
        let text = std::str::from_utf8(json)
            .map_err(|_| "intent head artifact must be UTF-8 JSON".to_string())?;
        Self::from_json(text)
    }

    pub(crate) fn from_json(json: &str) -> Result<Self, String> {
        if json.len() as u64 > MAX_HEAD_BYTES {
            return Err("intent head artifact exceeds size limit".into());
        }
        let a: HeadArtifact = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let n = a.classes.len();
        if !(2..=MAX_CLASSES).contains(&n) {
            return Err("intent head class count is out of bounds".into());
        }
        if !(1..=MAX_DIM).contains(&a.dim) {
            return Err("intent head dimension is out of bounds".into());
        }
        if a.weight_i8.len() != n || a.bias.len() != n || a.scale.len() != n {
            return Err("intent head artifact shape mismatch".into());
        }
        if a.weight_i8.iter().any(|row| row.len() != a.dim) {
            return Err("intent head weight row dimension mismatch".into());
        }
        if a.classes.iter().any(|class| class.trim().is_empty())
            || a.classes.iter().collect::<HashSet<_>>().len() != n
            || a.classes
                .iter()
                .filter(|class| class.as_str() == "OTHER")
                .count()
                != 1
        {
            return Err("intent head classes must be unique and contain one OTHER".into());
        }
        if a.scale
            .iter()
            .any(|scale| !scale.is_finite() || *scale <= 0.0)
            || a.bias.iter().any(|bias| !bias.is_finite())
        {
            return Err("intent head scale and bias must be finite".into());
        }
        if !a.reject_threshold.is_finite() || !(0.0..=1.0).contains(&a.reject_threshold) {
            return Err("intent head reject threshold must be between zero and one".into());
        }
        let weight = a
            .weight_i8
            .iter()
            .zip(&a.scale)
            .map(|(row, s)| row.iter().map(|&q| q as f32 * s).collect())
            .collect::<Vec<Vec<f32>>>();
        if weight.iter().flatten().any(|value| !value.is_finite()) {
            return Err("intent head dequantized weights must be finite".into());
        }
        Ok(Self {
            classes: a.classes,
            weight,
            bias: a.bias,
            dim: a.dim,
            threshold: a.reject_threshold,
        })
    }

    /// Classify an embedding whose dimension matches the verified head. `None`
    /// means invalid input, the `OTHER` reject class, or below-threshold output.
    pub fn classify(&self, embedding: &[f32]) -> Option<IntentPrediction> {
        if embedding.len() != self.dim || embedding.iter().any(|value| !value.is_finite()) {
            return None;
        }
        let mut logits: Vec<f32> = self
            .weight
            .iter()
            .zip(&self.bias)
            .map(|(row, b)| row.iter().zip(embedding).map(|(w, x)| w * x).sum::<f32>() + b)
            .collect();
        if logits.iter().any(|logit| !logit.is_finite()) {
            return None;
        }
        let max = logits.iter().cloned().fold(f32::MIN, f32::max);
        let mut sum = 0.0f32;
        for l in logits.iter_mut() {
            *l = (*l - max).exp();
            sum += *l;
        }
        // `total_cmp` keeps argmax panic-free. Non-finite input/logits and a
        // poisoned softmax are rejected above/below rather than classified.
        let (k, p) = logits
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))?;
        if !sum.is_finite() || sum <= 0.0 {
            return None;
        }
        let prob = p / sum;
        if !prob.is_finite() {
            return None;
        }
        let intent = &self.classes[k];
        if intent == "OTHER" || prob < self.threshold {
            return None;
        }
        Some(IntentPrediction {
            intent: intent.clone(),
            confidence: prob,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tier_a::native_actions;

    /// Two classes over a 2-d embedding, no zero coefficients, so every
    /// component of the input reaches every logit.
    fn artifact() -> String {
        format!(
            r#"{{
        "classes": ["{}", "OTHER"],
        "scale": [1.0, 1.0],
        "bias": [0.0, 0.0],
        "weight_i8": [[4, -4], [-4, 4]],
        "dim": 2,
        "reject_threshold": 0.5
    }}"#,
            native_actions::PLAY_MUSIC
        )
    }

    fn head() -> IntentHead {
        IntentHead::from_json(&artifact()).expect("test artifact parses")
    }

    #[test]
    fn finite_embeddings_still_classify() {
        let got = head().classify(&[1.0, 0.0]).expect("clean embedding fires");
        assert_eq!(got.intent, native_actions::PLAY_MUSIC);
        // Exact softmax value produced by the pre-NaN-fix argmax: the totality
        // fix must not move a single non-NaN probability.
        assert!(
            (got.confidence - 0.999_664_66).abs() < 1e-6,
            "confidence {} drifted from the pre-fix value",
            got.confidence
        );
    }

    #[test]
    fn a_nan_logit_falls_through_instead_of_panicking() {
        // Non-finite inputs are rejected before the matrix multiply.
        assert_eq!(head().classify(&[f32::NAN, 0.0]), None);

        assert_eq!(head().classify(&[f32::INFINITY, 1.0]), None);
        assert_eq!(head().classify(&[f32::NEG_INFINITY, -1.0]), None);
    }
}
