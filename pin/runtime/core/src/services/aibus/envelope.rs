use tonic::Status;

use crate::proto::common::encryption::{self, EncryptedData};
#[cfg(test)]
use crate::tier_a::proto_kids;

impl EncryptedData {
    /// Create an unencrypted EncryptedData envelope with the given kid and plaintext proto bytes.
    /// `kid` must be the fully-qualified Java class name of the inner proto.
    pub fn new(kid: &str, data: Vec<u8>) -> Self {
        encryption::EncryptedData {
            encryption_information: Some(encryption::EncryptionInformation { kid: kid.into() }),
            data,
        }
    }

    /// Create a stub EncryptedData envelope with the given kid and empty data.
    pub fn stub(kid: &str) -> Self {
        Self::new(kid, Vec::new())
    }
}

/// Decode the plaintext proto bytes from an EncryptedData envelope.
pub(super) fn unwrap_plaintext_data(
    encrypted: &Option<encryption::EncryptedData>,
) -> Result<&[u8], Status> {
    encrypted
        .as_ref()
        .map(|ed| ed.data.as_slice())
        .ok_or_else(|| Status::invalid_argument("missing encrypted data envelope"))
}

/// Decode a bounded plaintext envelope only when its inner proto KID exactly
/// matches the expected fully-qualified message name.
///
/// KID validation is important even with the plaintext encryption hook: it
/// prevents one valid protobuf payload from being confused for a different
/// RPC's inner message. Error text deliberately omits payload bytes and the
/// untrusted received KID.
pub(super) fn unwrap_plaintext_data_for_kid<'a>(
    encrypted: &'a Option<encryption::EncryptedData>,
    expected_kid: &str,
    maximum_bytes: usize,
) -> Result<&'a [u8], Status> {
    let encrypted = encrypted
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("missing encrypted data envelope"))?;
    let kid = encrypted
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .filter(|kid| !kid.is_empty())
        .ok_or_else(|| Status::invalid_argument("encrypted data envelope missing KID"))?;
    if kid != expected_kid {
        return Err(Status::invalid_argument(format!(
            "encrypted data envelope KID does not match {expected_kid}"
        )));
    }
    if encrypted.data.len() > maximum_bytes {
        return Err(Status::invalid_argument(
            "encrypted data payload is too large",
        ));
    }
    Ok(&encrypted.data)
}

#[cfg(test)]
mod tests {
    use prost::Message as _;
    use tonic::Code;

    use super::*;

    fn envelope(kid: Option<&str>, data: Vec<u8>) -> Option<EncryptedData> {
        Some(EncryptedData {
            encryption_information: kid.map(|kid| encryption::EncryptionInformation {
                kid: kid.to_string(),
            }),
            data,
        })
    }

    #[test]
    fn strict_unwrap_accepts_only_matching_bounded_payload() {
        let encrypted = envelope(Some(proto_kids::GEO_LOCATE_REQUEST), vec![1, 2, 3]);
        let bytes =
            unwrap_plaintext_data_for_kid(&encrypted, proto_kids::GEO_LOCATE_REQUEST, 3).unwrap();
        assert_eq!(bytes, [1, 2, 3]);
    }

    #[test]
    fn strict_unwrap_rejects_missing_mismatched_and_oversized_envelopes() {
        let missing = unwrap_plaintext_data_for_kid(&None, "expected", 10).unwrap_err();
        assert_eq!(missing.code(), Code::InvalidArgument);

        let no_kid =
            unwrap_plaintext_data_for_kid(&envelope(None, vec![]), "expected", 10).unwrap_err();
        assert_eq!(no_kid.code(), Code::InvalidArgument);

        let mismatch = unwrap_plaintext_data_for_kid(
            &envelope(Some("received-sensitive-value"), vec![]),
            "expected",
            10,
        )
        .unwrap_err();
        assert_eq!(mismatch.code(), Code::InvalidArgument);
        assert!(!mismatch.message().contains("received-sensitive-value"));

        let oversized =
            unwrap_plaintext_data_for_kid(&envelope(Some("expected"), vec![0; 11]), "expected", 10)
                .unwrap_err();
        assert_eq!(oversized.code(), Code::InvalidArgument);
    }

    #[test]
    fn envelope_wire_layout_matches_stock_field_numbers() {
        let encoded = envelope(Some("x"), vec![0xaa]).unwrap().encode_to_vec();
        assert_eq!(encoded, [0x0a, 0x03, 0x0a, 0x01, b'x', 0x12, 0x01, 0xaa]);
    }
}
