#![cfg(feature = "local-nlu")]
//! Stock model asset loading — read from the device's own `ironman.apk`, never
//! bundled in canonical source.
//!
//! The APK is a plain zip whose big `.tflite` entries are STORED
//! (uncompressed) and whose small config entries are DEFLATE'd — verified
//! on-device. This is a minimal central-directory reader for exactly that
//! shape: no zip64, no encryption, no multi-disk (an APK is none of those).
//! Every extracted model is SHA-256-verified against the pinned digest before
//! it reaches an interpreter; any mismatch disables the assists (fail-open).

use sha2::{Digest, Sha256};

/// Stock asset paths inside `ironman.apk`.
pub const IRONMAN_APK_PATH: &str = "/system/priv-app/ironman/ironman.apk";
pub const NER_ENCODER_ENTRY: &str = "assets/ner/encoder.tflite";
pub const TRIGGERING_ENCODER_ENTRY: &str = "assets/lu_triggering/encoder.tflite";
pub const CENTROIDS_ENTRY: &str = "assets/lu_triggering/centroids.json";
pub const LABEL_MAP_ENTRY: &str = "assets/ner/label_map.json";
pub const SPIECE_ENTRY: &str = "assets/intent/spiece.model";
pub const SEMANTIC_EXEMPLARS_ENTRY: &str =
    "assets/semantic/semantic_distance_interpreter_tokens.json";
/// Stock USE text encoder model (`assets/text_encoder/text_encoder.tflite`).
/// Kona USE-lite int8, 7.1 MB. Produces 512-d L2-normalized embeddings from
/// sparse-tensor inputs over `use_8k_spiece.model` tokens.
pub const TEXT_ENCODER_ENTRY: &str = "assets/text_encoder/text_encoder.tflite";
/// USE SentencePiece vocabulary (`assets/text_encoder/use_8k_spiece.model`).
/// 8000-piece unigram, distinct from the T5 32k vocab shared by
/// triggering+NER.
pub const USE_SPIECE_ENTRY: &str = "assets/text_encoder/use_8k_spiece.model";

/// Observed: these digests were measured from an operator-owned stock artifact
/// and verified against the owned device before being pinned here.
pub const NER_ENCODER_SHA256: &str =
    "bf3bdf372c0ee82743d6198d778cbf79160d821590b60c3a8dbd8bb876c708b3";
pub const SPIECE_SHA256: &str = "d60acb128cf7b7f2536e8f38a5b18a05535c9e14c7a355904270e15b0945ea86";
/// SHA-256 of `assets/text_encoder/text_encoder.tflite` (7.1 MB Kona USE).
pub const TEXT_ENCODER_SHA256: &str =
    "3b895eb08a9d308c8dadea352c1adf6501b0d6901b40ee862dc4238fd26c8cde";
/// SHA-256 of `assets/text_encoder/use_8k_spiece.model` (415 KB USE vocab).
pub const USE_SPIECE_SHA256: &str =
    "712eb3d2802844084619ef5780e17846e203d3165144832425a11bbcea9de1bb";
/// SHA-256 of `assets/lu_triggering/encoder.tflite` (34 MB T5 encoder). Stock
/// ships no digest manifest for this entry, so the observed value is pinned
/// directly here. It decides intent, so it is digest- rather than size-checked.
pub const TRIGGERING_ENCODER_SHA256: &str =
    "bffa4278a569b2b45b3e4583a97d2f518fe43bcab9302949a37cbf1efe34cfb2";
/// SHA-256 of `assets/lu_triggering/centroids.json` (17 intent centroids).
pub const CENTROIDS_SHA256: &str =
    "824a4f4898b4b4caa88228a81fae78fe68eb132b53a2d0fa5b97f3716161df1f";
/// SHA-256 of `assets/ner/label_map.json` (NER slot labels).
pub const LABEL_MAP_SHA256: &str =
    "24ef96cc835175a049fe835c867f6b1bb507a629c0980af98f9b1f73b7ec22fd";
/// SHA-256 of `assets/semantic/semantic_distance_interpreter_tokens.json`
/// (404 exemplars x 512 dims).
pub const SEMANTIC_EXEMPLARS_SHA256: &str =
    "4eb44688bb478803e2a4f8b511cb5ae516c4438a8de7a5b28ce47bfeaca0455e";

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const METHOD_STORED: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

struct Entry {
    method: u16,
    local_header_offset: u64,
    compressed_size: u64,
    uncompressed_size: u64,
}

/// One opened APK with its parsed central directory.
pub struct ApkAssets {
    bytes: Vec<u8>,
    entries: std::collections::HashMap<String, Entry>,
}

fn u16le(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn u32le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

impl ApkAssets {
    /// Read and index an APK. The whole file is read once (~150 MB for
    /// ironman) and dropped after the needed entries are extracted at
    /// startup; steady-state memory holds only the models themselves.
    pub fn open(path: &str) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        // Find the end-of-central-directory record (scan the max comment
        // window from the tail).
        let tail_start = bytes.len().saturating_sub(22 + u16::MAX as usize);
        let eocd = (tail_start..bytes.len().checked_sub(21)?)
            .rev()
            .find(|&at| u32le(&bytes, at) == Some(EOCD_SIGNATURE))?;
        let entry_count = u16le(&bytes, eocd + 10)? as usize;
        let central_offset = u32le(&bytes, eocd + 16)? as usize;

        let mut entries = std::collections::HashMap::with_capacity(entry_count);
        let mut at = central_offset;
        for _ in 0..entry_count {
            if u32le(&bytes, at) != Some(CENTRAL_SIGNATURE) {
                return None;
            }
            let method = u16le(&bytes, at + 10)?;
            let compressed_size = u32le(&bytes, at + 20)? as u64;
            let uncompressed_size = u32le(&bytes, at + 24)? as u64;
            let name_len = u16le(&bytes, at + 28)? as usize;
            let extra_len = u16le(&bytes, at + 30)? as usize;
            let comment_len = u16le(&bytes, at + 32)? as usize;
            let local_header_offset = u32le(&bytes, at + 42)? as u64;
            let name = std::str::from_utf8(bytes.get(at + 46..at + 46 + name_len)?)
                .ok()?
                .to_string();
            entries.insert(
                name,
                Entry {
                    method,
                    local_header_offset,
                    compressed_size,
                    uncompressed_size,
                },
            );
            at += 46 + name_len + extra_len + comment_len;
        }
        Some(Self { bytes, entries })
    }

    /// Extract one entry (stored or deflated). Bounded by the central
    /// directory's declared sizes; returns `None` on any inconsistency.
    pub fn read(&self, name: &str) -> Option<Vec<u8>> {
        let entry = self.entries.get(name)?;
        let lho = usize::try_from(entry.local_header_offset).ok()?;
        if u32le(&self.bytes, lho) != Some(LOCAL_SIGNATURE) {
            return None;
        }
        // Local header name/extra lengths may differ from central ones.
        let name_len = u16le(&self.bytes, lho + 26)? as usize;
        let extra_len = u16le(&self.bytes, lho + 28)? as usize;
        let data_start = lho + 30 + name_len + extra_len;
        let compressed = self
            .bytes
            .get(data_start..data_start + usize::try_from(entry.compressed_size).ok()?)?;
        match entry.method {
            METHOD_STORED => Some(compressed.to_vec()),
            METHOD_DEFLATE => {
                use std::io::Read as _;
                let mut out = Vec::with_capacity(usize::try_from(entry.uncompressed_size).ok()?);
                flate2::read::DeflateDecoder::new(compressed)
                    .read_to_end(&mut out)
                    .ok()?;
                (out.len() as u64 == entry.uncompressed_size).then_some(out)
            }
            _ => None,
        }
    }

    /// Extract and SHA-256-verify one entry against a pinned hex digest.
    pub fn read_verified(&self, name: &str, expected_sha256_hex: &str) -> Option<Vec<u8>> {
        let bytes = self.read(name)?;
        let digest = Sha256::digest(&bytes);
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        if hex == expected_sha256_hex {
            Some(bytes)
        } else {
            tracing::warn!(entry = name, "nlu asset digest mismatch; assist disabled");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a tiny in-memory zip with one stored and one deflated entry and
    /// verify the reader roundtrips both. (Wire-format test; the real APK is
    /// exercised on-device.)
    fn build_zip(entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
        use std::io::Write as _;
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in entries {
            let offset = out.len() as u32;
            let (method, payload): (u16, Vec<u8>) = if *deflate {
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(data).unwrap();
                (METHOD_DEFLATE, encoder.finish().unwrap())
            } else {
                (METHOD_STORED, data.to_vec())
            };
            // local header
            out.extend_from_slice(&LOCAL_SIGNATURE.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]); // version, flags
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 8]); // time, date, crc (unchecked)
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&payload);
            // central record
            central.extend_from_slice(&CENTRAL_SIGNATURE.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0]); // versions, flags
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 8]); // time, date, crc
            central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]); // extra/comment/disk/attrs
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let central_offset = out.len() as u32;
        out.extend_from_slice(&central);
        let central_size = out.len() as u32 - central_offset;
        out.extend_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        out.extend_from_slice(&[0; 4]); // disk numbers
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&central_size.to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn reads_stored_and_deflated_entries_and_verifies_digests() {
        let model = vec![7u8; 4096];
        let config = br#"{"labels":["O"]}"#.to_vec();
        let zip = build_zip(&[
            ("assets/x/encoder.tflite", &model, false),
            ("assets/x/config.json", &config, true),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake.apk");
        std::fs::write(&path, &zip).unwrap();
        let apk = ApkAssets::open(path.to_str().unwrap()).expect("opens");
        assert_eq!(apk.read("assets/x/encoder.tflite").unwrap(), model);
        assert_eq!(apk.read("assets/x/config.json").unwrap(), config);
        assert!(apk.read("assets/missing").is_none());

        let digest: String = Sha256::digest(&model)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(apk
            .read_verified("assets/x/encoder.tflite", &digest)
            .is_some());
        assert!(apk
            .read_verified("assets/x/encoder.tflite", &"0".repeat(64))
            .is_none());
    }
}
