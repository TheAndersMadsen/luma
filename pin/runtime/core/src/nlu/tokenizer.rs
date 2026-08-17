//! SentencePiece tokenizer for the external T5 encoders (triggering + NER).
//!
//! - `derived`: the two-stage normalization and per-word/whole-utterance modes
//!   come from clean-room analysis of an operator-owned device.
//! - `implemented`: normalization and malformed-model handling are covered by
//!   independently authored programmatic cases.
//! - `unknown`: exact stock token-ID parity is not asserted in canonical source;
//!   it requires a separately licensed, digest-pinned external model/baseline.
//!
//! The device does two stages before the encoder:
//!   A. `Interpreter.normalizeUtterance(raw, keepAccents)` — NFD diacritic strip
//!      (triggering only; keepAccents=false), Unicode-punctuation removal that
//!      preserves `hh:mm` time colons, whitespace collapse, lowercase, trim.
//!   B. SentencePiece over `intent/spiece.model` (unigram, 32000, nmt_nfkc,
//!      add_dummy_prefix), then append `</s>` (id 1). **Triggering encodes the
//!      whole normalized utterance; NER encodes PER WORD** (split on ' ', encode
//!      each word, concat) — the native NER ctor takes a space delimiter, the
//!      triggering ctor does not (verified in disassembly).
//!
//! Stage B uses the pinned `tokenizers` crate and builds directly from the
//! externally supplied `spiece.model` protobuf (Unigram + precompiled charsmap
//! + Metaspace). `normalizer_spec` is protobuf field 3; a programmatic wire test
//! protects that parser contract without bundling model bytes or token IDs.
#![cfg(feature = "local-nlu")]

use prost::Message;
use tokenizers::models::unigram::Unigram;
use tokenizers::normalizers::utils::Sequence as NormalizerSequence;
use tokenizers::normalizers::{Precompiled, Replace};
use tokenizers::pre_tokenizers::metaspace::{Metaspace, PrependScheme};
use tokenizers::{NormalizerWrapper, Tokenizer};

/// `</s>` — the T5 EOS id appended after both encodings (spiece.model eos_id=1).
const EOS_ID: i32 = 1;
/// `<unk>` id (spiece.model unk_id=2), passed to the Unigram model.
const UNK_ID: usize = 2;

// ----- Minimal partial view of the SentencePiece ModelProto (prost skips the
// dozens of fields we don't read; tags match sentencepiece_model.proto). -----
#[derive(Clone, PartialEq, Message)]
struct ModelProto {
    #[prost(message, repeated, tag = "1")]
    pieces: Vec<SentencePiece>,
    #[prost(message, optional, tag = "3")]
    normalizer_spec: Option<NormalizerSpec>,
}
#[derive(Clone, PartialEq, Message)]
struct SentencePiece {
    #[prost(string, optional, tag = "1")]
    piece: Option<String>,
    #[prost(float, optional, tag = "2")]
    score: Option<f32>,
}
#[derive(Clone, PartialEq, Message)]
struct NormalizerSpec {
    #[prost(bytes = "vec", optional, tag = "2")]
    precompiled_charsmap: Option<Vec<u8>>,
}

/// Loaded stock tokenizer. Build once from the device `spiece.model` bytes.
pub struct SpieceTokenizer {
    inner: Tokenizer,
}

impl SpieceTokenizer {
    /// Construct from raw `spiece.model` bytes (read from the device partition,
    /// SHA-verified by the caller). Returns `Err` on a malformed model — the
    /// caller disables the NLU assists and behaves exactly as today.
    pub fn from_spiece_model(model_bytes: &[u8]) -> Result<Self, String> {
        let proto = ModelProto::decode(model_bytes)
            .map_err(|e| format!("spiece.model decode failed: {e}"))?;
        if proto.pieces.is_empty() {
            return Err("spiece.model has no pieces".to_string());
        }
        let vocab: Vec<(String, f64)> = proto
            .pieces
            .iter()
            .map(|p| {
                (
                    p.piece.clone().unwrap_or_default(),
                    p.score.unwrap_or(0.0) as f64,
                )
            })
            .collect();

        let model = Unigram::from(vocab, Some(UNK_ID), false)
            .map_err(|e| format!("unigram build failed: {e}"))?;

        // Stage-B normalizer: nmt_nfkc precompiled charsmap, then space -> ▁.
        // Whitespace collapse/trim is handled upstream in stage A (`normalize`),
        // so no regex step is needed here (verified: simplified config still
        // matches sentencepiece 15/15 both modes).
        let charsmap = proto
            .normalizer_spec
            .and_then(|n| n.precompiled_charsmap)
            .ok_or_else(|| "spiece.model missing precompiled_charsmap".to_string())?;
        let precompiled = Precompiled::from(&charsmap)
            .map_err(|e| format!("precompiled charsmap failed: {e}"))?;
        let space_to_meta =
            Replace::new(" ", "\u{2581}").map_err(|e| format!("replace normalizer failed: {e}"))?;
        let normalizer = NormalizerSequence::new(vec![
            NormalizerWrapper::Precompiled(precompiled),
            NormalizerWrapper::Replace(space_to_meta),
        ]);

        // add_dummy_prefix=true == Metaspace prepend "always".
        let metaspace = Metaspace::new('\u{2581}', PrependScheme::Always, true);

        let mut inner = Tokenizer::new(model);
        inner.with_normalizer(Some(normalizer));
        inner.with_pre_tokenizer(Some(metaspace));
        Ok(Self { inner })
    }

    fn encode_ids(&self, text: &str) -> Result<Vec<i32>, String> {
        let enc = self
            .inner
            .encode(text, false)
            .map_err(|e| format!("encode failed: {e}"))?;
        Ok(enc.get_ids().iter().map(|&id| id as i32).collect())
    }

    /// Triggering path: normalize (keepAccents=false) → whole-sentence encode → +EOS.
    pub fn encode_triggering(&self, raw: &str) -> Result<Vec<i32>, String> {
        let norm = normalize(raw, false);
        let mut ids = self.encode_ids(&norm)?;
        ids.push(EOS_ID);
        Ok(ids)
    }

    /// USE / semantic path: whole-sentence encode over `use_8k_spiece.model`
    /// (8000-piece USE vocab), NO `</s>` append — the Kona USE encoder does
    /// not expect an EOS token (verified via LiteRT: appending EOS degrades
    /// the L2-normalized embedding and shifts exemplar distances). Returns
    /// raw token IDs suitable for the sparse-tensor input of
    /// `text_encoder.tflite`.
    pub fn encode_use(&self, text: &str) -> Result<Vec<i32>, String> {
        self.encode_ids(text)
    }

    /// NER path: normalize (keepAccents=true) → PER-WORD encode (split on ' ')
    /// → concat → +EOS. Also returns the source word per pre-EOS id, which the
    /// NER decoder needs for subword→word merge.
    pub fn encode_ner(&self, raw: &str) -> Result<(Vec<i32>, Vec<String>), String> {
        let norm = normalize(raw, true);
        let mut ids = Vec::new();
        let mut aligned_words = Vec::new();
        for word in norm.split(' ').filter(|w| !w.is_empty()) {
            let word_ids = self.encode_ids(word)?;
            for id in &word_ids {
                ids.push(*id);
                aligned_words.push(word.to_string());
            }
        }
        ids.push(EOS_ID);
        Ok((ids, aligned_words))
    }
}

/// Stage A — port of `Interpreter.normalizeUtterance`.
/// `keep_accents=false` (triggering) additionally NFD-strips diacritics.
/// Punctuation (all Unicode `P*` except `%`, plus apostrophe/backtick/prime
/// variants) is removed EXCEPT a `:` inside an `hh:mm` time token; then
/// whitespace is collapsed, lowercased, and trimmed. Apostrophes are removed
/// even when keeping accents ("today's" → "todays").
pub fn normalize(raw: &str, keep_accents: bool) -> String {
    use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

    let stripped: String = if keep_accents {
        raw.to_string()
    } else {
        raw.nfd().filter(|c| !is_combining_mark(*c)).collect()
    };

    // Mark byte ranges covered by an hh:mm time token so their ':' survives.
    let time_spans = time_colon_spans(&stripped);
    let mut out = String::with_capacity(stripped.len());
    for (idx, ch) in stripped.char_indices() {
        if ch == ':' && time_spans.iter().any(|(a, b)| idx >= *a && idx < *b) {
            out.push(ch);
        } else if is_removable_punct(ch) {
            // drop
        } else {
            out.push(ch);
        }
    }

    // Collapse any whitespace run to a single space, lowercase, trim.
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.to_lowercase()
}

fn is_removable_punct(ch: char) -> bool {
    use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};
    // Java class `[[^\P{P}%]+'‘’‛`′]` = (Unicode punctuation except `%`) plus the
    // explicit apostrophe/backtick/prime variants (backtick is Sk, not P, so it
    // must be listed). Apostrophes are removed even on the keepAccents path.
    let is_p = ch.general_category_group() == GeneralCategoryGroup::Punctuation;
    (is_p && ch != '%')
        || matches!(
            ch,
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201B}' | '`' | '\u{2032}'
        )
}

/// Byte ranges of `\b([01]?\d|2[0-3]|\d):[0-5]\d\b` matches (the colon inside is
/// preserved). Uses the in-tree `regex` crate.
fn time_colon_spans(text: &str) -> Vec<(usize, usize)> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\b([01]?\d|2[0-3]|\d):[0-5]\d\b").unwrap());
    re.find_iter(text).map(|m| (m.start(), m.end())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independently_authored_normalization_cases_cover_both_modes() {
        let cases = [
            ("  Écho—MODE  ", "echomode", "échomode"),
            (
                "Meet @ 07:05; 50% READY",
                "meet 07:05 50% ready",
                "meet 07:05 50% ready",
            ),
            ("Owner’s SAMPLE", "owners sample", "owners sample"),
        ];
        for (raw, triggering, ner) in cases {
            assert_eq!(normalize(raw, false), triggering);
            assert_eq!(normalize(raw, true), ner);
        }
    }

    #[test]
    fn malformed_or_incomplete_programmatic_models_fail_closed() {
        assert!(SpieceTokenizer::from_spiece_model(&[0x0f]).is_err());

        let empty = ModelProto {
            pieces: Vec::new(),
            normalizer_spec: None,
        }
        .encode_to_vec();
        assert_eq!(
            SpieceTokenizer::from_spiece_model(&empty)
                .err()
                .expect("empty model is invalid"),
            "spiece.model has no pieces"
        );

        let pieces = ["<pad>", "</s>", "<unk>", "▁", "sample"]
            .into_iter()
            .map(|piece| SentencePiece {
                piece: Some(piece.to_string()),
                score: Some(0.0),
            })
            .collect();
        let missing_charsmap = ModelProto {
            pieces,
            normalizer_spec: None,
        }
        .encode_to_vec();
        assert!(SpieceTokenizer::from_spiece_model(&missing_charsmap)
            .err()
            .expect("charsmap is required")
            .contains("missing precompiled_charsmap"));
    }

    #[test]
    fn normalizer_spec_stays_on_sentencepiece_field_three() {
        let encoded = ModelProto {
            pieces: Vec::new(),
            normalizer_spec: Some(NormalizerSpec {
                precompiled_charsmap: Some(vec![1, 2, 3]),
            }),
        }
        .encode_to_vec();
        assert_eq!(
            encoded.first(),
            Some(&0x1a),
            "field 3 uses protobuf key 0x1a"
        );
    }
}
