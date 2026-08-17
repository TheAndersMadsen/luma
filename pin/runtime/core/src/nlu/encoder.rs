#![cfg(feature = "local-nlu")]
//! TFLite encoder sessions for the stock NLU models.
//!
//! Android-only at runtime: the externally supplied, digest-pinned `libtensorflowlite_jni.so`
//! (TFLite 2.11.0 C API) is an aarch64 ELF, so host builds compile this
//! module but construct no interpreter (`NluEncoders::load` returns `None`
//! off-device and the assists stay disabled — fail-open by construction).
//!
//! Derived tensor contract from operator-owned stock artifact analysis:
//! input tensors are `serving_attention_mask`→0 and `serving_input_ids`→1,
//! both I32 `[1, N]`, resized per call. The triggering encoder emits
//! per-token `[1, seq, 512]` and the sentence embedding is the **mean pool
//! over seq** (LiteRT-validated; single-vector assumptions are wrong). The
//! NER encoder emits `[1, seq, 18]` logits consumed per position.

pub const TRIGGERING_INPUT_BYTE_CAP: usize = 253;
pub const EMBEDDING_DIM: usize = 512;
pub const NER_LABELS: usize = 18;

#[cfg(target_os = "android")]
mod imp {
    use super::{EMBEDDING_DIM, NER_LABELS};
    use tflitec::interpreter::{Interpreter, Options};
    use tflitec::model::Model;
    use tflitec::tensor::Shape;

    /// One loaded encoder pair. The models' backing bytes are owned here and
    /// must outlive the interpreters.
    pub struct NluEncoders {
        triggering_bytes: &'static [u8],
        ner_bytes: &'static [u8],
        triggering: Interpreter<'static>,
        ner: Interpreter<'static>,
    }

    // Interpreter invocations are serialized behind a mutex in the facade;
    // the raw TfLite interpreter is not Sync but is safe to move.
    unsafe impl Send for NluEncoders {}

    impl NluEncoders {
        /// Build both interpreters from verified model bytes. Leaks the two
        /// model buffers deliberately: they live for the process lifetime
        /// (one load at startup), which gives the interpreters a 'static
        /// backing without self-referential structs.
        pub fn load(triggering_model: Vec<u8>, ner_model: Vec<u8>) -> Option<Self> {
            let triggering_bytes: &'static [u8] = Box::leak(triggering_model.into_boxed_slice());
            let ner_bytes: &'static [u8] = Box::leak(ner_model.into_boxed_slice());
            // The Interpreter borrows the Model for 'static, so the Model must
            // also outlive the process — leak it alongside the byte buffers.
            let triggering_model: &'static Model =
                Box::leak(Box::new(Model::from_bytes(triggering_bytes).ok()?));
            let ner_model: &'static Model = Box::leak(Box::new(Model::from_bytes(ner_bytes).ok()?));
            let triggering = Interpreter::new(triggering_model, Some(Options::default())).ok()?;
            let ner = Interpreter::new(ner_model, Some(Options::default())).ok()?;
            Some(Self {
                triggering_bytes,
                ner_bytes,
                triggering,
                ner,
            })
        }

        fn run(interpreter: &Interpreter<'static>, ids: &[i32]) -> Option<Vec<f32>> {
            let n = ids.len();
            if n == 0 {
                return None;
            }
            let shape = Shape::new(vec![1, n]);
            interpreter.resize_input(0, shape.clone()).ok()?;
            interpreter.resize_input(1, shape).ok()?;
            interpreter.allocate_tensors().ok()?;
            let mask = vec![1i32; n];
            // Contract: attention_mask -> 0, input_ids -> 1.
            interpreter.copy(&mask, 0).ok()?;
            interpreter.copy(ids, 1).ok()?;
            interpreter.invoke().ok()?;
            let output = interpreter.output(0).ok()?;
            Some(output.data::<f32>().to_vec())
        }

        /// Mean-pooled 512-d sentence embedding.
        pub fn triggering_embed(&self, ids: &[i32]) -> Option<Vec<f32>> {
            let flat = Self::run(&self.triggering, ids)?;
            let seq = flat.len() / EMBEDDING_DIM;
            if seq == 0 || flat.len() % EMBEDDING_DIM != 0 {
                return None;
            }
            let mut pooled = vec![0.0f32; EMBEDDING_DIM];
            for token in 0..seq {
                for (d, value) in pooled.iter_mut().enumerate() {
                    *value += flat[token * EMBEDDING_DIM + d];
                }
            }
            for value in pooled.iter_mut() {
                *value /= seq as f32;
            }
            Some(pooled)
        }

        /// Per-token 18-way logit rows.
        pub fn ner_logits(&self, ids: &[i32]) -> Option<Vec<[f32; NER_LABELS]>> {
            let flat = Self::run(&self.ner, ids)?;
            let seq = flat.len() / NER_LABELS;
            if seq == 0 || flat.len() % NER_LABELS != 0 {
                return None;
            }
            Some(
                (0..seq)
                    .map(|token| {
                        let mut row = [0.0f32; NER_LABELS];
                        row.copy_from_slice(&flat[token * NER_LABELS..(token + 1) * NER_LABELS]);
                        row
                    })
                    .collect(),
            )
        }

        pub fn model_sizes(&self) -> (usize, usize) {
            (self.triggering_bytes.len(), self.ner_bytes.len())
        }
    }

    /// The SEMANTIC encoder — Google "Kona" Universal Sentence Encoder (USE).
    ///
    /// # I/O contract (host-verified via LiteRT 2026-07-24)
    ///
    /// **Input** — three tensors forming a SparseTensor of rank 2:
    ///
    /// | Index | Name            | dtype  | shape     | content                      |
    /// |-------|-----------------|--------|-----------|------------------------------|
    /// | 0     | `Placeholder`   | `I64`  | `[2]`     | `dense_shape = [1, N]`       |
    /// | 1     | `Placeholder_2` | `I64`  | `[N, 2]`  | `indices = [[0,0],[0,1],…,[0,N-1]]` |
    /// | 2     | `Placeholder_1` | `I64`  | `[N]`     | `values = token_ids` (USE vocab) |
    ///
    /// N = number of SentencePiece token IDs from `use_8k_spiece.model`
    /// (8000-piece unigram, nmt_nfkc, `add_dummy_prefix=true`). The model
    /// does NOT expect `<s>`/`</s>` sentinels — pass the raw token IDs
    /// only (verified: appending EOS shifts the embedding and degrades
    /// exemplar distances).
    ///
    /// **Output** — single tensor, L2-normalized 512-d embedding:
    ///
    /// | Index | Name                                          | dtype  | shape      |
    /// |-------|-----------------------------------------------|--------|------------|
    /// | 0     | `Encoder_en/hidden_layers/l2_normalize`       | `F32`  | `[1, 512]` |
    ///
    /// Output L2 norm is ≈ 1.0 (in-graph L2-normalization). The exemplar
    /// vectors in `semantic_distance_interpreter_tokens.json` are also
    /// L2-normalized, so squared-L2 distance ≈ 2(1 − cos) and the stock
    /// 0.4 radius maps cleanly.
    ///
    /// **Architecture** — KonaTransformer (USE-lite), 2 layers, 512-dim
    /// hidden, d_ff 1536, sinusoidal position encoding, tanh + L2-norm
    /// head. Vocab embedding `[8002, 256]`. Weight-quantized int8.
    ///
    /// **Preprocessing** — `normalize_utterance()` (NFD diacritic strip,
    /// lowercase, punctuation removal preserving `hh:mm`, whitespace
    /// collapse) → `SpieceTokenizer::encode_use()` (whole-sentence USE
    /// vocab encode, no EOS append) → sparse tensor assembly above.
    ///
    /// **Sample inputs** (host-verified):
    ///
    /// ```text
    /// "what time is it"  → ids=[87,99,18,21]  → closest exemplar: GetCurrentTime (sq_l2=0.0009)
    /// "take a photo"     → ids=[188,11,2129]   → closest exemplar: CapturePhotograph (sq_l2=0.0009)
    /// "lock the device"  → ids=[2751,9,3014]   → closest exemplar: LockDevice (sq_l2=0.0005)
    /// "turn on wifi"     → ids=[867,25,2044,1433] → closest exemplar: TurnOnWifi (sq_l2=0.0008)
    /// "what s the time"  → ids=[87,429,9,99]   → closest exemplar: GetCurrentTime (sq_l2=0.4072, JUST outside 0.4 radius)
    /// "play smooth criminal by michael jackson" → ids (9 tokens) → closest: NOT_CallPerson (sq_l2=0.497, rejected)
    /// ```
    pub struct TextEncoder {
        /// Leaked model bytes — outlives the interpreter (same pattern as
        /// `NluEncoders.triggering_bytes`).
        model_bytes: &'static [u8],
        interpreter: Interpreter<'static>,
        /// The USE SentencePiece tokenizer (use_8k_spiece.model, 8000 pieces).
        /// Loaded alongside the model so the caller doesn't need to manage
        /// a separate tokenizer instance.
        tokenizer: crate::nlu::tokenizer::SpieceTokenizer,
    }

    unsafe impl Send for TextEncoder {}

    impl TextEncoder {
        /// Load the USE encoder from its model bytes and the accompanying
        /// SentencePiece vocabulary. Returns `None` on any failure (bad
        /// model, tokenizer parse error). The caller passes the bytes read
        /// from `assets/text_encoder/text_encoder.tflite` and
        /// `assets/text_encoder/use_8k_spiece.model`.
        pub fn load(model: Vec<u8>, use_spiece_model: Vec<u8>) -> Option<Self> {
            let tokenizer =
                crate::nlu::tokenizer::SpieceTokenizer::from_spiece_model(&use_spiece_model)
                    .ok()?;
            let model_bytes: &'static [u8] = Box::leak(model.into_boxed_slice());
            let model_ref: &'static Model =
                Box::leak(Box::new(Model::from_bytes(model_bytes).ok()?));
            let interpreter = Interpreter::new(model_ref, Some(Options::default())).ok()?;
            Some(Self {
                model_bytes,
                interpreter,
                tokenizer,
            })
        }

        /// Encode a **pre-normalized** utterance to a 512-d L2-normalized
        /// embedding. The normalization (`normalize_utterance` in
        /// `semantic.rs`) must have already been applied by the caller —
        /// this method only tokenizes and runs the model.
        pub fn encode(&self, normalized: &str) -> Option<Vec<f32>> {
            let ids = self.tokenizer.encode_use(normalized).ok()?;
            let n = ids.len();
            if n == 0 {
                return None;
            }
            // Sparse tensor components: dense_shape=[1,N], indices=[[0,i]…],
            // values=ids. All I64 (the Kona model's SparseTensor input is
            // INT64, NOT INT32 — differs from the triggering/NER encoders
            // which take dense I32 inputs).
            let dense_shape: [i64; 2] = [1, n as i64];
            let mut indices = Vec::with_capacity(n * 2);
            for i in 0..n {
                indices.push(0i64);
                indices.push(i as i64);
            }
            let values: Vec<i64> = ids.into_iter().map(|id| id as i64).collect();

            // The model's default tensor shapes are for a minimal sparse
            // tensor; resize the dynamic-dim inputs (indices, values) to
            // match the actual token count before allocating.
            use tflitec::tensor::Shape;
            self.interpreter
                .resize_input(1, Shape::new(vec![n, 2]))
                .ok()?;
            self.interpreter.resize_input(2, Shape::new(vec![n])).ok()?;
            self.interpreter.allocate_tensors().ok()?;

            // Input contract: attention-like dense_shape→0, indices→1, values→2.
            self.interpreter.copy(&dense_shape, 0).ok()?;
            self.interpreter.copy(&indices, 1).ok()?;
            self.interpreter.copy(&values, 2).ok()?;
            self.interpreter.invoke().ok()?;

            let output = self.interpreter.output(0).ok()?;
            let flat = output.data::<f32>();
            if flat.len() != EMBEDDING_DIM {
                return None;
            }
            Some(flat.to_vec())
        }

        /// The size of the loaded model bytes (for diagnostics).
        pub fn model_size(&self) -> usize {
            self.model_bytes.len()
        }
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use super::NER_LABELS;

    /// Host stub: no TFLite runtime off-device. Everything returns `None`,
    /// which disables the assists exactly like a missing model on-device.
    pub struct NluEncoders;

    impl NluEncoders {
        pub fn load(_triggering_model: Vec<u8>, _ner_model: Vec<u8>) -> Option<Self> {
            None
        }
        pub fn triggering_embed(&self, _ids: &[i32]) -> Option<Vec<f32>> {
            None
        }
        pub fn ner_logits(&self, _ids: &[i32]) -> Option<Vec<[f32; NER_LABELS]>> {
            None
        }
        pub fn model_sizes(&self) -> (usize, usize) {
            (0, 0)
        }
    }

    /// Host stub: no TFLite runtime off-device. See the Android-impl
    /// docstring for the full I/O contract.
    pub struct TextEncoder;

    impl TextEncoder {
        pub fn load(_model: Vec<u8>, _use_spiece_model: Vec<u8>) -> Option<Self> {
            None
        }
        pub fn encode(&self, _normalized: &str) -> Option<Vec<f32>> {
            None
        }
        pub fn model_size(&self) -> usize {
            0
        }
    }
}

pub use imp::NluEncoders;
pub use imp::TextEncoder;
