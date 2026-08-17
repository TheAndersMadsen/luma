//! Clean-room implementation of the Carry service-scoped encrypted envelope.
//!
//! Independently authored from a behavioral specification of the client crypto
//! contracts (algorithms, sizes, field layout) — not copied from any private
//! source.
//!
//! Payload AEAD:   AES-128-GCM (12-byte nonce, 16-byte/128-bit tag, AAD).
//! Key transport:  RSA-OAEP (unwrap the device's ephemeral channel key).
//! Wire envelope:  FlatBuffer `CiphertextEnvelope{ kid, algo, aad, iv, authTag, ciphertext }`.
//!
//! The gRPC layer wraps this in `EncryptedData{ data = envelope bytes, encryption_information.kid }`.

#![allow(clippy::all, dead_code, unused_imports)]
#[allow(non_snake_case, non_camel_case_types, unused_imports, clippy::all)]
mod carry_ciphertext_generated;
pub mod secure_asset;
mod secure_asset_generated;
use carry_ciphertext_generated::carry::krypton::{
    CiphertextEnvelope, CiphertextEnvelopeArgs, KrAlgorithm,
};

use aes_gcm::{
    Aes128Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use rand::RngCore;
use rsa::{Oaep, RsaPrivateKey};
use sha1::Sha1;
use std::collections::HashMap;

pub const NONCE_LEN: usize = 12; // 96-bit GCM nonce
pub const TAG_LEN: usize = 16; // 128-bit GCM tag
pub const AES_KEY_LEN: usize = 16; // AES-128 (Krypton ephemeral-channel envelope path)

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("AEAD failure (bad key/tag/aad)")]
    Aead,
    #[error("malformed envelope: {0}")]
    Envelope(String),
    #[error("unknown key id: {0}")]
    UnknownKid(String),
    #[error("rsa unwrap failed")]
    RsaUnwrap,
    #[error("wrong key length (want 16): {0}")]
    KeyLen(usize),
    /// The durable key-material snapshot exists but could not be read or parsed.
    /// Deliberately distinct from a generation failure: the keypair the device
    /// wrapped to is still in that file, so this is not retryable and minting a
    /// replacement would strand the device for good.
    #[error("key material snapshot is unreadable; refusing to replace it")]
    SnapshotUnreadable,
}

/// The gRPC-level wrapper (`humane.common.encryption.EncryptedData`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncryptedData {
    /// The serialized `CiphertextEnvelope` FlatBuffer.
    pub data: Vec<u8>,
    /// `encryption_information.kid` — repeated here as the app does.
    pub kid: String,
}

/// Seal a plaintext for a channel key -> the serialized envelope + its kid.
pub fn seal(
    kid: &str,
    key: &[u8],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<EncryptedData, CryptoError> {
    if key.len() != AES_KEY_LEN {
        return Err(CryptoError::KeyLen(key.len()));
    }
    let cipher = Aes128Gcm::new(key.into());
    let mut iv = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);
    // aes-gcm returns ciphertext||tag; the envelope stores them separately.
    let mut ct_and_tag = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Aead)?;
    let tag = ct_and_tag.split_off(ct_and_tag.len() - TAG_LEN);
    let data = encode_envelope(kid.as_bytes(), aad, &iv, &tag, &ct_and_tag);
    Ok(EncryptedData {
        data,
        kid: kid.to_string(),
    })
}

/// Read the AAD an envelope was sealed with, without opening it.
///
/// The AAD names the payload type; a real device resolves the payload class from
/// it, so it must never be empty. Exposed so callers can assert the binding.
pub fn envelope_aad(data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let env = flatbuffers::root::<CiphertextEnvelope>(data)
        .map_err(|e| CryptoError::Envelope(e.to_string()))?;
    Ok(env.aad().map(|a| a.bytes().to_vec()).unwrap_or_default())
}

/// Open an envelope with the resolved channel key -> plaintext.
pub fn open(key: &[u8], enc: &EncryptedData) -> Result<Vec<u8>, CryptoError> {
    if key.len() != AES_KEY_LEN {
        return Err(CryptoError::KeyLen(key.len()));
    }
    let env = flatbuffers::root::<CiphertextEnvelope>(&enc.data)
        .map_err(|e| CryptoError::Envelope(e.to_string()))?;
    let iv = env
        .iv()
        .ok_or_else(|| CryptoError::Envelope("no iv".into()))?
        .bytes();
    let tag = env
        .authTag()
        .ok_or_else(|| CryptoError::Envelope("no tag".into()))?
        .bytes();
    let ct = env
        .ciphertext()
        .ok_or_else(|| CryptoError::Envelope("no ct".into()))?
        .bytes();
    let aad = env.aad().map(|a| a.bytes().to_vec()).unwrap_or_default();
    if iv.len() != NONCE_LEN || tag.len() != TAG_LEN {
        return Err(CryptoError::Envelope("bad iv/tag length".into()));
    }
    let cipher = Aes128Gcm::new(key.into());
    let mut ct_and_tag = ct.to_vec();
    ct_and_tag.extend_from_slice(tag);
    cipher
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: &ct_and_tag,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::Aead)
}

fn encode_envelope(kid: &[u8], aad: &[u8], iv: &[u8], tag: &[u8], ct: &[u8]) -> Vec<u8> {
    let mut fbb = flatbuffers::FlatBufferBuilder::new();
    let kid_v = fbb.create_vector(kid);
    let aad_v = fbb.create_vector(aad);
    let iv_v = fbb.create_vector(iv);
    let tag_v = fbb.create_vector(tag);
    let ct_v = fbb.create_vector(ct);
    let env = CiphertextEnvelope::create(
        &mut fbb,
        &CiphertextEnvelopeArgs {
            kid: Some(kid_v),
            algo: KrAlgorithm::AES_GCM,
            aad: Some(aad_v),
            iv: Some(iv_v),
            authTag: Some(tag_v),
            ciphertext: Some(ct_v),
        },
    );
    // Finish WITH the "HMCT" file identifier (written at bytes [4..8)) to match
    // the client's KrCiphertextEnvelope buffers byte-for-byte.
    carry_ciphertext_generated::carry::krypton::finish_ciphertext_envelope_buffer(&mut fbb, env);
    fbb.finished_data().to_vec()
}

/// Read the kid out of an envelope without decrypting (for key lookup / routing).
pub fn envelope_kid(data: &[u8]) -> Result<String, CryptoError> {
    let env = flatbuffers::root::<CiphertextEnvelope>(data)
        .map_err(|e| CryptoError::Envelope(e.to_string()))?;
    let kid = env
        .kid()
        .ok_or_else(|| CryptoError::Envelope("no kid".into()))?;
    Ok(String::from_utf8_lossy(kid.bytes()).into_owned())
}

/// Unwrap a device-uploaded ephemeral channel key with the server RSA private key.
/// Matches the client's `RSA/ECB/OAEPWithSHA1AndMGF1Padding`.
pub fn unwrap_channel_key(
    server_priv: &RsaPrivateKey,
    wrapped: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    server_priv
        .decrypt(Oaep::new::<Sha1>(), wrapped)
        .map_err(|_| CryptoError::RsaUnwrap)
}

/// The server's RSA-OAEP wrapping keypair. `EstablishWrappingKeys` publishes the
/// public DER to the device; the device RSA-OAEP-wraps its ephemeral AES-128
/// channel keys to it and uploads them via `ImportKeys`, which the server
/// unwraps here. Encapsulated so callers need no direct `rsa`/`rand` dependency.
pub struct WrappingKeypair {
    priv_key: RsaPrivateKey,
    public_der: Vec<u8>,
}

impl WrappingKeypair {
    /// Generate a fresh RSA-OAEP wrapping keypair (4096-bit, matching carry).
    pub fn generate() -> Result<Self, CryptoError> {
        use rsa::pkcs8::EncodePublicKey;
        let mut rng = rand::thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 4096).map_err(|_| CryptoError::RsaUnwrap)?;
        let public_der = rsa::RsaPublicKey::from(&priv_key)
            .to_public_key_der()
            .map_err(|_| CryptoError::RsaUnwrap)?
            .into_vec();
        Ok(Self {
            priv_key,
            public_der,
        })
    }

    /// SubjectPublicKeyInfo DER of the wrapping public key (goes in `ClearKey.jca_encoded`).
    pub fn public_der(&self) -> &[u8] {
        &self.public_der
    }

    /// PKCS#8 DER of the **private** key, so a server can keep one wrapping
    /// keypair across restarts.
    ///
    /// The device establishes wrapping keys once and caches the public half; it
    /// never re-establishes on error, so a keypair that dies with the process
    /// would make every later `ImportKeys` unwrap fail with no path back. Callers
    /// are responsible for storing these bytes as the long-lived private key
    /// material they are: never logged, never on the wire.
    pub fn private_pkcs8_der(&self) -> Result<Vec<u8>, CryptoError> {
        use rsa::pkcs8::EncodePrivateKey;
        self.priv_key
            .to_pkcs8_der()
            .map(|doc| doc.as_bytes().to_vec())
            .map_err(|_| CryptoError::RsaUnwrap)
    }

    /// Rebuild a keypair from [`WrappingKeypair::private_pkcs8_der`]. The public
    /// DER is recomputed rather than stored, so a restored keypair can never
    /// publish a public half that does not match its private one.
    pub fn from_private_pkcs8_der(der: &[u8]) -> Result<Self, CryptoError> {
        use rsa::pkcs8::{DecodePrivateKey, EncodePublicKey};
        let priv_key = RsaPrivateKey::from_pkcs8_der(der).map_err(|_| CryptoError::RsaUnwrap)?;
        let public_der = rsa::RsaPublicKey::from(&priv_key)
            .to_public_key_der()
            .map_err(|_| CryptoError::RsaUnwrap)?
            .into_vec();
        Ok(Self {
            priv_key,
            public_der,
        })
    }

    /// RSA-OAEP-unwrap an uploaded, wrapped ephemeral key -> the raw AES key bytes.
    pub fn unwrap(&self, wrapped: &[u8]) -> Result<Vec<u8>, CryptoError> {
        unwrap_channel_key(&self.priv_key, wrapped)
    }
}

/// Device-side inverse of [`WrappingKeypair::unwrap`]: RSA-OAEP-wrap an ephemeral
/// key to a wrapping public key (SPKI DER). This is what the device does before
/// `ImportKeys`; provided here for round-trip tests and simulation.
pub fn wrap_channel_key(public_der: &[u8], key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    use rsa::pkcs8::DecodePublicKey;
    let pk =
        rsa::RsaPublicKey::from_public_key_der(public_der).map_err(|_| CryptoError::RsaUnwrap)?;
    let mut rng = rand::thread_rng();
    pk.encrypt(&mut rng, Oaep::new::<Sha1>(), key)
        .map_err(|_| CryptoError::RsaUnwrap)
}

/// The server's per-device store of unwrapped ephemeral channel keys (kid -> AES key).
#[derive(Default)]
pub struct ChannelKeyStore {
    keys: HashMap<String, [u8; AES_KEY_LEN]>,
}

impl ChannelKeyStore {
    pub fn insert(&mut self, kid: String, key: [u8; AES_KEY_LEN]) {
        self.keys.insert(kid, key);
    }
    /// Whether any channel key has been established. Lets callers distinguish
    /// "the device never ran the key exchange" from "this envelope is bad".
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
    pub fn len(&self) -> usize {
        self.keys.len()
    }
    /// Forget a channel key, reporting whether it was held. The device can ask the
    /// server to drop a key (`RemoveKeys`), and the two sides must agree on the
    /// end state — a server that keeps a key the device believes gone will keep
    /// accepting envelopes the device will never send again.
    pub fn remove(&mut self, kid: &str) -> bool {
        self.keys.remove(kid).is_some()
    }
    /// Every established `{kid -> key}` pair, so a server can write the store to
    /// durable storage and reload it after a restart. The device uploads a
    /// channel key once and reuses its kid forever, so a store that only lives as
    /// long as the process ends the encrypted transport at the first redeploy.
    /// The bytes handed out here are the raw channel keys: they belong in a
    /// protected store, never in a log or on the wire.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &[u8; AES_KEY_LEN])> {
        self.keys.iter().map(|(kid, key)| (kid.as_str(), key))
    }
    pub fn seal(
        &self,
        kid: &str,
        plaintext: &[u8],
        aad: &[u8],
    ) -> Result<EncryptedData, CryptoError> {
        let key = self
            .keys
            .get(kid)
            .ok_or_else(|| CryptoError::UnknownKid(kid.into()))?;
        seal(kid, key, plaintext, aad)
    }
    pub fn open(&self, enc: &EncryptedData) -> Result<Vec<u8>, CryptoError> {
        let kid = if enc.kid.is_empty() {
            envelope_kid(&enc.data)?
        } else {
            enc.kid.clone()
        };
        let key = self
            .keys
            .get(&kid)
            .ok_or_else(|| CryptoError::UnknownKid(kid))?;
        open(key, enc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::RsaPublicKey;

    fn key() -> [u8; 16] {
        let mut k = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut k);
        k
    }

    #[test]
    fn round_trip_seals_and_opens() {
        let k = key();
        let enc = seal(
            "d=;u=;s=ai_bus.synapse;a=;abc;def",
            &k,
            b"what is the capital of France",
            b"",
        )
        .unwrap();
        assert_eq!(
            envelope_kid(&enc.data).unwrap(),
            "d=;u=;s=ai_bus.synapse;a=;abc;def"
        );
        assert_eq!(open(&k, &enc).unwrap(), b"what is the capital of France");
    }

    #[test]
    fn aad_is_authenticated() {
        let k = key();
        let enc = seal("kid", &k, b"secret", b"context-A").unwrap();
        let env = flatbuffers::root::<CiphertextEnvelope>(&enc.data).unwrap();
        assert_eq!(env.aad().unwrap().bytes(), b"context-A");
        let iv = env.iv().unwrap().bytes().to_vec();
        let tag = env.authTag().unwrap().bytes().to_vec();
        let mut ct = env.ciphertext().unwrap().bytes().to_vec();

        // tamper the ciphertext -> GCM tag check must fail.
        let mut bad_ct = ct.clone();
        bad_ct[0] ^= 0x01;
        let tampered = EncryptedData {
            data: encode_envelope(b"kid", b"context-A", &iv, &tag, &bad_ct),
            kid: "kid".into(),
        };
        assert!(open(&k, &tampered).is_err());

        // tamper the AAD (same iv/tag/ct) -> must fail, proving the tag covers AAD.
        let wrong_aad = EncryptedData {
            data: encode_envelope(b"kid", b"context-B", &iv, &tag, &ct),
            kid: "kid".into(),
        };
        assert!(open(&k, &wrong_aad).is_err());

        // untouched round-trip still opens.
        ct.clear();
        assert_eq!(open(&k, &enc).unwrap(), b"secret");
    }

    #[test]
    fn wrong_key_fails() {
        let enc = seal("kid", &key(), b"x", b"").unwrap();
        assert!(matches!(open(&key(), &enc), Err(CryptoError::Aead)));
    }

    #[test]
    fn keystore_routes_by_kid() {
        let mut store = ChannelKeyStore::default();
        store.insert("kid-1".into(), key());
        let enc = store.seal("kid-1", b"hello", b"").unwrap();
        assert_eq!(store.open(&enc).unwrap(), b"hello");
        assert!(store.seal("kid-unknown", b"x", b"").is_err());
    }

    #[test]
    fn rsa_oaep_unwraps_an_uploaded_key() {
        // model the device: wrap a fresh AES key to the server's RSA public key.
        let mut rng = rand::thread_rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let pub_key = RsaPublicKey::from(&priv_key);
        let aes_key = key();
        let wrapped = pub_key
            .encrypt(&mut rng, Oaep::new::<Sha1>(), &aes_key)
            .unwrap();
        let unwrapped = unwrap_channel_key(&priv_key, &wrapped).unwrap();
        assert_eq!(unwrapped, aes_key);
    }
}
