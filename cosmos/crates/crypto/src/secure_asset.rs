//! Clean-room decoder for the device's data-protection `HMSA` envelope.
//!
//! This is intentionally separate from the `HMCT` service-channel envelope in
//! `lib.rs`. A stock Pin protects durable wearer data with a C1 AES-KW key: the
//! envelope wraps a random AES-GCM content key and authenticates the exact nested
//! asset-binding buffer. Treating that byte string as `HMCT` can never succeed.

use aes_gcm::aes::{
    Aes128,
    cipher::{BlockDecrypt, KeyInit as BlockKeyInit, generic_array::GenericArray},
};
use aes_gcm::{
    Aes128Gcm, Nonce,
    aead::{Aead, KeyInit as AeadKeyInit, Payload},
};

use crate::secure_asset_generated::cosmos::krypton::secureasset as wire;

const AES_KW_ALGORITHM: u8 = 1;
const WRAPPED_CEK_LEN: usize = 24;
const CONTENT_KEY_LEN: usize = 16;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
const AES_KW_IV: [u8; 8] = [0xA6; 8];

/// The semantic binding expected inside an `HMSA` envelope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssetBinding {
    pub encoding: u8,
    pub domain: i32,
    pub object_id: i32,
    pub require_empty_metadata: bool,
}

/// Stock NotableEvents `google.protobuf.Struct` EventData binding.
pub const NOTABLE_EVENT_DATA: AssetBinding = AssetBinding {
    encoding: 0,
    domain: 3,
    object_id: 1,
    require_empty_metadata: true,
};

/// Stock Notes `humane.capture.Note` protobuf binding.
///
/// `observed`: an operator-owned Pin protects this payload with encoding 0,
/// Notes domain 6, object id 1, and no metadata.  Keeping it separate from
/// [`NOTABLE_EVENT_DATA`] is part of the authentication boundary: a valid HMSA
/// envelope for one durable-data type must not be accepted as another.
pub const NOTE_DATA: AssetBinding = AssetBinding {
    encoding: 0,
    domain: 6,
    object_id: 1,
    require_empty_metadata: true,
};

/// Stock Capture thumbnail JPEG binding.
///
/// `observed`: the photography upload worker protects each thumbnail with the
/// capture key and object id 4; the capture data-protection catalog maps domain
/// 2 / object 4 to a JPEG `ByteBuffer` named `Thumbnail`.
pub const CAPTURE_THUMBNAIL: AssetBinding = AssetBinding {
    encoding: 0,
    domain: 2,
    object_id: 4,
    require_empty_metadata: true,
};

/// Stock Capture full-resolution JPEG binding.
///
/// `observed`: `AssetUploadWorkerImpl.encryptAssetAtPath` protects a JPG with
/// the capture key and object id 2. The same photography data-protection catalog
/// that identifies thumbnails as domain 2/object 4 identifies the JPG frame as
/// domain 2/object 2. Keeping this distinct prevents a valid thumbnail envelope
/// from being accepted as the original frame.
pub const CAPTURE_JPEG: AssetBinding = AssetBinding {
    encoding: 0,
    domain: 2,
    object_id: 2,
    require_empty_metadata: true,
};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SecureAssetError {
    #[error("not an HMSA secure asset")]
    Identifier,
    #[error("malformed secure asset: {0}")]
    Malformed(&'static str),
    #[error("secure asset names a different key")]
    KidMismatch,
    #[error("secure asset uses an unsupported key algorithm")]
    Algorithm,
    #[error("secure asset has the wrong data-protection binding")]
    Binding,
    #[error("secure asset has an invalid cryptographic field length")]
    Length,
    #[error("secure asset content-key unwrap failed")]
    KeyWrap,
    #[error("secure asset authentication failed")]
    Authentication,
}

/// Open one device data-protection envelope.
///
/// `outer_kid` is the `EncryptedData.encryption_information.kid`. The nested
/// header must repeat it byte-for-byte; accepting a mismatch would let an
/// attacker choose one database lookup while authenticating another header.
pub fn open_secure_asset(
    kek: &[u8],
    outer_kid: &str,
    data: &[u8],
    expected: AssetBinding,
) -> Result<Vec<u8>, SecureAssetError> {
    if !wire::secure_asset_buffer_has_identifier(data) {
        return Err(SecureAssetError::Identifier);
    }
    let asset = wire::root_as_secure_asset(data)
        .map_err(|_| SecureAssetError::Malformed("outer flatbuffer"))?;

    let header_bytes = asset
        .header()
        .ok_or(SecureAssetError::Malformed("missing header"))?
        .bytes();
    let header = flatbuffers::root::<wire::Header<'_>>(header_bytes)
        .map_err(|_| SecureAssetError::Malformed("header flatbuffer"))?;
    let header_kid = header
        .kid()
        .ok_or(SecureAssetError::Malformed("missing header kid"))?
        .bytes();
    if header_kid != outer_kid.as_bytes() {
        return Err(SecureAssetError::KidMismatch);
    }
    if header.algorithm() != AES_KW_ALGORITHM {
        return Err(SecureAssetError::Algorithm);
    }

    let aad = asset
        .aad()
        .ok_or(SecureAssetError::Malformed("missing aad"))?
        .bytes();
    let binding = flatbuffers::root::<wire::AssetBinding<'_>>(aad)
        .map_err(|_| SecureAssetError::Malformed("aad flatbuffer"))?;
    let metadata = binding.metadata().map(|value| value.bytes()).unwrap_or(&[]);
    if binding.encoding() != expected.encoding
        || binding.domain() != expected.domain
        || binding.object_id() != expected.object_id
        || (expected.require_empty_metadata && !metadata.is_empty())
    {
        return Err(SecureAssetError::Binding);
    }

    let wrapped_cek = asset
        .wrapped_cek()
        .ok_or(SecureAssetError::Malformed("missing wrapped cek"))?
        .bytes();
    let iv = asset
        .iv()
        .ok_or(SecureAssetError::Malformed("missing iv"))?
        .bytes();
    let tag = asset
        .auth_tag()
        .ok_or(SecureAssetError::Malformed("missing auth tag"))?
        .bytes();
    let ciphertext = asset
        .ciphertext()
        .ok_or(SecureAssetError::Malformed("missing ciphertext"))?
        .bytes();
    if kek.len() != crate::AES_KEY_LEN
        || wrapped_cek.len() != WRAPPED_CEK_LEN
        || iv.len() != IV_LEN
        || tag.len() != TAG_LEN
    {
        return Err(SecureAssetError::Length);
    }

    let cek = aes_kw_unwrap(kek, wrapped_cek)?;
    if cek.len() != CONTENT_KEY_LEN {
        return Err(SecureAssetError::Length);
    }
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| SecureAssetError::Length)?;
    let mut ciphertext_and_tag = Vec::with_capacity(ciphertext.len() + tag.len());
    ciphertext_and_tag.extend_from_slice(ciphertext);
    ciphertext_and_tag.extend_from_slice(tag);
    cipher
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: &ciphertext_and_tag,
                // Authenticate the original nested FlatBuffer bytes verbatim.
                aad,
            },
        )
        .map_err(|_| SecureAssetError::Authentication)
}

/// RFC 3394 AES Key Unwrap for the observed AES-128-KW C1 key.
fn aes_kw_unwrap(kek: &[u8], wrapped: &[u8]) -> Result<Vec<u8>, SecureAssetError> {
    if kek.len() != crate::AES_KEY_LEN || wrapped.len() < 24 || wrapped.len() % 8 != 0 {
        return Err(SecureAssetError::Length);
    }
    let n = wrapped.len() / 8 - 1;
    let cipher = Aes128::new_from_slice(kek).map_err(|_| SecureAssetError::Length)?;
    let mut a: [u8; 8] = wrapped[..8]
        .try_into()
        .map_err(|_| SecureAssetError::Length)?;
    let mut r: Vec<[u8; 8]> = wrapped[8..]
        .chunks_exact(8)
        .map(|chunk| chunk.try_into().expect("chunks_exact yields eight bytes"))
        .collect();

    for j in (0..=5u64).rev() {
        for i in (1..=n).rev() {
            let t = n as u64 * j + i as u64;
            let mut block = [0u8; 16];
            let a_xor_t = u64::from_be_bytes(a) ^ t;
            block[..8].copy_from_slice(&a_xor_t.to_be_bytes());
            block[8..].copy_from_slice(&r[i - 1]);
            let mut block = GenericArray::clone_from_slice(&block);
            cipher.decrypt_block(&mut block);
            a.copy_from_slice(&block[..8]);
            r[i - 1].copy_from_slice(&block[8..]);
        }
    }
    if a != AES_KW_IV {
        return Err(SecureAssetError::KeyWrap);
    }
    Ok(r.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aes::cipher::BlockEncrypt;
    use flatbuffers::FlatBufferBuilder;

    const KID: &str = "d=;u=wearer;s=notableevents;a=;1;2";
    const KEK: [u8; 16] = [0x11; 16];
    const CEK: [u8; 16] = [0x22; 16];
    const IV: [u8; 12] = [0x33; 12];
    const PLAINTEXT: &[u8] = b"scrubbed protobuf Struct bytes";

    fn nested_header(kid: &str, algorithm: u8) -> Vec<u8> {
        let mut fbb = FlatBufferBuilder::new();
        let kid = fbb.create_vector(kid.as_bytes());
        let root = wire::Header::create(
            &mut fbb,
            &wire::HeaderArgs {
                kid: Some(kid),
                algorithm,
            },
        );
        fbb.finish(root, None);
        fbb.finished_data().to_vec()
    }

    fn nested_binding(binding: AssetBinding, metadata: &[u8]) -> Vec<u8> {
        let mut fbb = FlatBufferBuilder::new();
        let metadata = fbb.create_vector(metadata);
        let root = wire::AssetBinding::create(
            &mut fbb,
            &wire::AssetBindingArgs {
                encoding: binding.encoding,
                domain: binding.domain,
                object_id: binding.object_id,
                metadata: Some(metadata),
            },
        );
        fbb.finish(root, None);
        fbb.finished_data().to_vec()
    }

    fn aes_kw_wrap(kek: &[u8], clear: &[u8]) -> Vec<u8> {
        assert_eq!(clear.len() % 8, 0);
        let n = clear.len() / 8;
        let cipher = Aes128::new_from_slice(kek).unwrap();
        let mut a = AES_KW_IV;
        let mut r: Vec<[u8; 8]> = clear
            .chunks_exact(8)
            .map(|chunk| chunk.try_into().unwrap())
            .collect();
        for j in 0..=5u64 {
            for i in 1..=n {
                let mut block = [0u8; 16];
                block[..8].copy_from_slice(&a);
                block[8..].copy_from_slice(&r[i - 1]);
                let mut block = GenericArray::clone_from_slice(&block);
                cipher.encrypt_block(&mut block);
                let t = n as u64 * j + i as u64;
                a.copy_from_slice(
                    &(u64::from_be_bytes(block[..8].try_into().unwrap()) ^ t).to_be_bytes(),
                );
                r[i - 1].copy_from_slice(&block[8..]);
            }
        }
        let mut wrapped = a.to_vec();
        wrapped.extend(r.into_iter().flatten());
        wrapped
    }

    fn build_asset(
        header: &[u8],
        aad: &[u8],
        wrapped_cek: &[u8],
        iv: &[u8],
        tag: &[u8],
        ciphertext: &[u8],
    ) -> Vec<u8> {
        let mut fbb = FlatBufferBuilder::new();
        let header = fbb.create_vector(header);
        let aad = fbb.create_vector(aad);
        let wrapped_cek = fbb.create_vector(wrapped_cek);
        let iv = fbb.create_vector(iv);
        let tag = fbb.create_vector(tag);
        let ciphertext = fbb.create_vector(ciphertext);
        let root = wire::SecureAsset::create(
            &mut fbb,
            &wire::SecureAssetArgs {
                header: Some(header),
                aad: Some(aad),
                wrapped_cek: Some(wrapped_cek),
                iv: Some(iv),
                auth_tag: Some(tag),
                ciphertext: Some(ciphertext),
            },
        );
        wire::finish_secure_asset_buffer(&mut fbb, root);
        fbb.finished_data().to_vec()
    }

    fn fixture_for(binding: AssetBinding, plaintext: &[u8]) -> Vec<u8> {
        let header = nested_header(KID, AES_KW_ALGORITHM);
        let aad = nested_binding(binding, &[]);
        let cipher = Aes128Gcm::new_from_slice(&CEK).unwrap();
        let mut ciphertext_and_tag = cipher
            .encrypt(
                Nonce::from_slice(&IV),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .unwrap();
        let tag = ciphertext_and_tag.split_off(ciphertext_and_tag.len() - TAG_LEN);
        build_asset(
            &header,
            &aad,
            &aes_kw_wrap(&KEK, &CEK),
            &IV,
            &tag,
            &ciphertext_and_tag,
        )
    }

    fn fixture() -> Vec<u8> {
        fixture_for(NOTABLE_EVENT_DATA, PLAINTEXT)
    }

    #[test]
    fn opens_a_notable_event_secure_asset() {
        assert_eq!(
            open_secure_asset(&KEK, KID, &fixture(), NOTABLE_EVENT_DATA).unwrap(),
            PLAINTEXT
        );
    }

    #[test]
    fn note_binding_opens_only_as_note_data() {
        let plaintext = b"scrubbed humane.capture.Note protobuf bytes";
        let note = fixture_for(NOTE_DATA, plaintext);
        assert_eq!(
            open_secure_asset(&KEK, KID, &note, NOTE_DATA).unwrap(),
            plaintext
        );
        assert_eq!(
            open_secure_asset(&KEK, KID, &note, NOTABLE_EVENT_DATA),
            Err(SecureAssetError::Binding),
            "a valid note envelope must not authenticate as notable-event data"
        );
    }

    #[test]
    fn thumbnail_binding_opens_only_as_capture_thumbnail() {
        let plaintext = b"\xff\xd8\xffscrubbed-jpeg-fixture";
        let thumbnail = fixture_for(CAPTURE_THUMBNAIL, plaintext);
        assert_eq!(
            open_secure_asset(&KEK, KID, &thumbnail, CAPTURE_THUMBNAIL).unwrap(),
            plaintext,
        );
        assert_eq!(
            open_secure_asset(&KEK, KID, &thumbnail, NOTE_DATA),
            Err(SecureAssetError::Binding),
        );
    }

    #[test]
    fn jpeg_binding_opens_only_as_full_capture_jpeg() {
        let plaintext = b"full-resolution-jpeg";
        let jpeg = fixture_for(CAPTURE_JPEG, plaintext);
        assert_eq!(
            open_secure_asset(&KEK, KID, &jpeg, CAPTURE_JPEG).unwrap(),
            plaintext
        );
        assert_eq!(
            open_secure_asset(&KEK, KID, &jpeg, CAPTURE_THUMBNAIL),
            Err(SecureAssetError::Binding)
        );
    }

    #[test]
    fn rejects_wrong_outer_identifier_header_kid_algorithm_and_binding() {
        let mut wrong_identifier = fixture();
        wrong_identifier[4..8].copy_from_slice(b"NOPE");
        assert_eq!(
            open_secure_asset(&KEK, KID, &wrong_identifier, NOTABLE_EVENT_DATA),
            Err(SecureAssetError::Identifier)
        );

        let aad = nested_binding(NOTABLE_EVENT_DATA, &[]);
        let wrapped = aes_kw_wrap(&KEK, &CEK);
        let blank = build_asset(
            &nested_header("another-kid", AES_KW_ALGORITHM),
            &aad,
            &wrapped,
            &IV,
            &[0; TAG_LEN],
            b"x",
        );
        assert_eq!(
            open_secure_asset(&KEK, KID, &blank, NOTABLE_EVENT_DATA),
            Err(SecureAssetError::KidMismatch)
        );

        let bad_algorithm = build_asset(
            &nested_header(KID, 2),
            &aad,
            &wrapped,
            &IV,
            &[0; TAG_LEN],
            b"x",
        );
        assert_eq!(
            open_secure_asset(&KEK, KID, &bad_algorithm, NOTABLE_EVENT_DATA),
            Err(SecureAssetError::Algorithm)
        );

        let wrong_binding = AssetBinding {
            domain: 9,
            ..NOTABLE_EVENT_DATA
        };
        let aad = nested_binding(wrong_binding, &[]);
        let bad_binding = build_asset(
            &nested_header(KID, AES_KW_ALGORITHM),
            &aad,
            &wrapped,
            &IV,
            &[0; TAG_LEN],
            b"x",
        );
        assert_eq!(
            open_secure_asset(&KEK, KID, &bad_binding, NOTABLE_EVENT_DATA),
            Err(SecureAssetError::Binding)
        );
    }

    #[test]
    fn rejects_tampered_wrapped_key_iv_tag_and_ciphertext() {
        let asset = fixture();
        let parsed = wire::root_as_secure_asset(&asset).unwrap();
        let header = parsed.header().unwrap().bytes().to_vec();
        let aad = parsed.aad().unwrap().bytes().to_vec();
        let wrapped = parsed.wrapped_cek().unwrap().bytes().to_vec();
        let iv = parsed.iv().unwrap().bytes().to_vec();
        let tag = parsed.auth_tag().unwrap().bytes().to_vec();
        let ciphertext = parsed.ciphertext().unwrap().bytes().to_vec();

        for field in 0..4 {
            let mut bad_wrapped = wrapped.clone();
            let mut bad_iv = iv.clone();
            let mut bad_tag = tag.clone();
            let mut bad_ciphertext = ciphertext.clone();
            match field {
                0 => bad_wrapped[8] ^= 1,
                1 => bad_iv[0] ^= 1,
                2 => bad_tag[0] ^= 1,
                3 => bad_ciphertext[0] ^= 1,
                _ => unreachable!(),
            }
            let tampered = build_asset(
                &header,
                &aad,
                &bad_wrapped,
                &bad_iv,
                &bad_tag,
                &bad_ciphertext,
            );
            assert!(
                open_secure_asset(&KEK, KID, &tampered, NOTABLE_EVENT_DATA).is_err(),
                "tamper case {field} must fail closed"
            );
        }
    }
}
