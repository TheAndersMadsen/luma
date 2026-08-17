//! Local NLU assists for the chat-turn loop.
//!
//! - `derived`: post-processing contracts come from clean-room analysis of an
//!   operator-owned device.
//! - `implemented`: parser, decision, rejection, and fail-open behavior is
//!   covered with independently authored programmatic fixtures.
//! - `unknown`: exact model-output parity remains an external validation concern;
//!   canonical source contains no captured utterances, embeddings, token IDs, or
//!   trained model/head artifacts.
//!
//! - [`ner_post`] — the stock NER slot extraction semantics (gates, slot map,
//!   punts), fed by the stock NER encoder.
//! - [`triggering`] — the 17-centroid intent decision (L2, loose/strict
//!   radii, allowlist scoring), fed by the stock triggering encoder.
//!
//! The encoders run on a compatible, externally supplied and digest-pinned
//! TFLite C library behind the `local-nlu` Cargo feature; model weights are
//! loaded from stock partitions on-device with SHA-256 verification and are
//! never bundled into the Server APK.
//!
//! Product contract: every assist is fail-open untrusted DATA — NER slots
//! inform prompts/coercion/ranking, the entry intent gates one existing
//! nudge, and neither ever grants action authority. A missing model, hash
//! mismatch, timeout, or below-gate output yields exactly today's behavior.

#[cfg(feature = "local-nlu")]
pub mod assets;
#[cfg(feature = "local-nlu")]
pub mod assist;
/// Generic quantized linear intent-head evaluator. No trained head is bundled;
/// an operator-supplied artifact must be external and digest-bound.
pub mod classifier;
#[cfg(feature = "local-nlu")]
pub mod encoder;
pub mod ner_post;
pub mod semantic;
#[cfg(feature = "local-nlu")]
pub mod tokenizer;
pub mod triggering;

/// Stock assets read from the untracked reverse-engineering workspace. Tests
/// that need them skip when it is absent.
#[cfg(test)]
mod stock_assets;

/// Clean-room integration tests for the decision ports. All values are generated
/// programmatically and assert software contracts, not model quality.
#[cfg(test)]
mod e2e_tests;

/// Clean-room contract tests for external intent-head parsing and evaluation.
#[cfg(test)]
mod head_tests;

/// Feature-agnostic handle to the stock-NLU assists.
///
/// Exists in every build so call sites never need `cfg`. Without the
/// `local-nlu` feature (the default) it holds nothing and every query returns
/// `None`, so behavior is byte-identical to having no assists at all. With the
/// feature, `load()` reads and SHA-verifies the stock models from the device
/// APK; any failure (missing APK, digest mismatch, host build) also yields the
/// empty handle. Assist output is untrusted DATA: it informs prompts,
/// coercion, ranking and one nudge — never action authority.
#[derive(Clone, Default)]
pub struct NluAssists {
    #[cfg(feature = "local-nlu")]
    inner: Option<std::sync::Arc<assist::NluAssist>>,
}

impl NluAssists {
    /// Load once at server init. Never fails: a failure disables the assists.
    pub fn load() -> Self {
        #[cfg(feature = "local-nlu")]
        {
            let assists = Self {
                inner: assist::NluAssist::build(),
            };
            if !assists.is_active() {
                tracing::info!("nlu assists unavailable; running without local NLU");
            }
            assists
        }
        #[cfg(not(feature = "local-nlu"))]
        {
            Self::default()
        }
    }

    /// True when the assists are actually loaded and usable.
    ///
    /// Observability only — `load()` uses it for the startup log and tests use
    /// it to pin the empty-handle contract. Call sites must NOT branch on it:
    /// every query below already fails open with `None`, which is what keeps a
    /// missing model byte-identical to having no assists at all. Gating
    /// behavior on availability would break that contract.
    pub fn is_active(&self) -> bool {
        #[cfg(feature = "local-nlu")]
        {
            self.inner.is_some()
        }
        #[cfg(not(feature = "local-nlu"))]
        {
            false
        }
    }

    /// Stock triggering intent for the entry utterance (census + nudge gate).
    pub fn entry_intent(&self, _utterance: &str) -> Option<triggering::EntryIntent> {
        #[cfg(feature = "local-nlu")]
        {
            self.inner.as_ref()?.entry_intent(_utterance)
        }
        #[cfg(not(feature = "local-nlu"))]
        {
            None
        }
    }

    /// Calibrated music slots for a Play-shaped utterance (slot pre-pass).
    pub fn music_slots(&self, _utterance: &str) -> Option<ner_post::NerSlots> {
        #[cfg(feature = "local-nlu")]
        {
            self.inner.as_ref()?.music_slots(_utterance)
        }
        #[cfg(not(feature = "local-nlu"))]
        {
            None
        }
    }

    /// Semantic interpreter hit (S3). Live on Android with `local-nlu`
    /// (Kona USE encoder → 512-d L2-normalized → 404-exemplar k=1 NN with
    /// 0.4 squared-L2 radius + validity gate). Inert on host / without
    /// the feature — returns `None` to fail open.
    pub fn semantic_hit(&self, _utterance: &str) -> Option<semantic::SemanticHit> {
        #[cfg(feature = "local-nlu")]
        {
            self.inner.as_ref()?.semantic_hit(_utterance)
        }
        #[cfg(not(feature = "local-nlu"))]
        {
            None
        }
    }
}

#[cfg(test)]
mod assists_tests {
    use super::NluAssists;

    #[test]
    fn the_empty_handle_is_inactive_and_every_query_fails_open() {
        let assists = NluAssists::default();
        assert!(!assists.is_active());
        assert!(assists.entry_intent("play some jazz").is_none());
        assert!(assists.music_slots("play some jazz").is_none());
        assert!(assists.semantic_hit("play some jazz").is_none());
    }

    #[test]
    fn load_is_infallible_and_an_inactive_handle_answers_nothing() {
        // `load()` never fails; it degrades to the empty handle. On a host
        // build (with or without `local-nlu`) the stock APK is absent, so the
        // reported state must be inactive-and-silent rather than a panic.
        let assists = NluAssists::load();
        if !assists.is_active() {
            assert!(assists.entry_intent("play some jazz").is_none());
            assert!(assists.music_slots("play some jazz").is_none());
            assert!(assists.semantic_hit("play some jazz").is_none());
        }
    }
}
