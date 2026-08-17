//! Operator provisioning: minting the **device-attestation** credential a Pin
//! presents to the onboarding gateway.
//!
//! A stock Pin ships with a factory attestation identity signed by Humane's
//! manufacturing CA. The clone has no such factory, so onboarding a device means
//! the operator issues it one: a client certificate whose subject is the
//! recovered `DEVICE_ATTESTATION_SUBJECT_PATTERN`
//! (`V:01:D:<deviceHex>:P:<product>`, `O=Humane`, `OU=DeviceAttestation`, per
//! `hu.ma.ne.core.DeviceConstants`), signed by the CA the onboarding edge trusts
//! for client mTLS.
//!
//! The edge verifies the presented certificate against that CA and forwards the
//! subject as the authenticated principal; [`crate::enrollment::device_id_from_subject`]
//! parses the device id back out. So a credential minted here — and only one
//! signed by the edge's trust anchor — carries a device past the auth gate and
//! into the OPAQUE ceremony.
//!
//! This is emphatically an **operator** capability, gated behind
//! `CARRY_ADMIN_TOKEN` at the HTTP layer: whoever can mint an attestation
//! certificate can enroll a device.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// PEM path of the CA the onboarding edge trusts for client mTLS. Device
/// attestation certificates are signed by this so the edge accepts them.
pub const ATTEST_CA_CERT_ENV: &str = "CARRY_ATTEST_CA_CERT";
/// PEM (PKCS#8) path of that CA's private key.
pub const ATTEST_CA_KEY_ENV: &str = "CARRY_ATTEST_CA_KEY";

/// A device the operator has issued an attestation credential for.
///
/// Recorded in this process at mint time — the console lives in the same
/// workload that mints, so this is exactly the set of devices the console
/// provisioned, and it is accurate even in the microservice topology where
/// *binding* completes in a different workload the console cannot observe. An
/// in-process roster a restart empties, labelled as such.
#[derive(Clone, Serialize)]
pub struct ProvisionedDevice {
    pub device_id: String,
    pub product: String,
    pub subject: String,
    /// Unix seconds when the credential was issued.
    pub provisioned_at_unix: i64,
}

static PROVISIONED: Mutex<Vec<ProvisionedDevice>> = Mutex::new(Vec::new());

fn record_provisioned(device_id: &str, product: &str, subject: &str) {
    let provisioned_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default();
    let mut roster = PROVISIONED
        .lock()
        .expect("provisioned roster is not poisoned");
    // Re-issuing a credential for a device replaces the earlier row.
    roster.retain(|device| device.device_id != device_id);
    roster.push(ProvisionedDevice {
        device_id: device_id.to_owned(),
        product: product.to_owned(),
        subject: subject.to_owned(),
        provisioned_at_unix,
    });
}

/// Every device provisioned from this console since the process started.
pub fn provisioned_devices() -> Vec<ProvisionedDevice> {
    PROVISIONED
        .lock()
        .expect("provisioned roster is not poisoned")
        .clone()
}

/// A freshly minted device-attestation credential, ready to hand to a Pin.
#[derive(Serialize)]
pub struct AttestationBundle {
    /// The hex device id written into the subject.
    pub device_id: String,
    /// The full subject CN the edge will authenticate and forward.
    pub subject: String,
    /// The device's attestation certificate (PEM).
    pub certificate_pem: String,
    /// The device's private key (PEM, PKCS#8). Minted here and never stored — the
    /// only copy leaves in this response.
    pub private_key_pem: String,
    /// The signing CA certificate (PEM), so the device can pin the trust anchor.
    pub ca_certificate_pem: String,
}

/// Why a provisioning request could not be fulfilled, mapped to an HTTP status by
/// the caller.
// `Debug` so `Result<_, ProvisionError>` can be unwrapped in tests — without it
// the whole crate's test binary fails to compile, not just this module's.
#[derive(Debug)]
pub enum ProvisionError {
    /// No attestation CA is configured — provisioning is disabled (503).
    NotConfigured,
    /// The requested device id or product is not a legal subject value (400).
    BadInput(&'static str),
    /// The configured CA could not be loaded or used to sign (500).
    Ca(String),
}

/// A device id is the hex string the subject pattern and
/// [`crate::enrollment::device_id_from_subject`] both require: non-empty ASCII
/// hex. Anything else would mint a subject the edge parses to a different device
/// — or to none.
fn validate_device_id(device_id: &str) -> Result<(), ProvisionError> {
    if device_id.is_empty() {
        return Err(ProvisionError::BadInput("device id must not be empty"));
    }
    if !device_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProvisionError::BadInput(
            "device id must be hex (0-9a-f); it is written into the certificate subject",
        ));
    }
    Ok(())
}

/// The stock Pin parser requires the product tag after `:P:` to be non-empty
/// ASCII hexadecimal. Anything broader mints a certificate that the edge can
/// authenticate but `DeviceAttestationManager` cannot use.
fn validate_product(product: &str) -> Result<(), ProvisionError> {
    if product.is_empty() {
        return Err(ProvisionError::BadInput("product must not be empty"));
    }
    if !product.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProvisionError::BadInput(
            "product must be hex (0-9a-f); the stock Pin parses it from the certificate subject",
        ));
    }
    Ok(())
}

/// The attestation CA, loaded from the configured PEM pair.
struct AttestCa {
    key: rcgen::KeyPair,
    certificate: rcgen::Certificate,
    certificate_pem: String,
}

impl AttestCa {
    fn from_env() -> Result<Option<Self>, String> {
        let cert_path = std::env::var(ATTEST_CA_CERT_ENV)
            .ok()
            .filter(|v| !v.is_empty());
        let key_path = std::env::var(ATTEST_CA_KEY_ENV)
            .ok()
            .filter(|v| !v.is_empty());
        match (cert_path, key_path) {
            (Some(cert), Some(key)) => Self::from_pem_files(&cert, &key).map(Some),
            (None, None) => Ok(None),
            _ => Err(format!(
                "{ATTEST_CA_CERT_ENV} and {ATTEST_CA_KEY_ENV} must be set together"
            )),
        }
    }

    fn from_pem_files(cert_path: &str, key_path: &str) -> Result<Self, String> {
        let cert_pem = std::fs::read_to_string(cert_path)
            .map_err(|error| format!("reading {ATTEST_CA_CERT_ENV} ({cert_path}): {error}"))?;
        let key_pem = std::fs::read_to_string(key_path)
            .map_err(|error| format!("reading {ATTEST_CA_KEY_ENV} ({key_path}): {error}"))?;

        let key = rcgen::KeyPair::from_pem(&key_pem)
            .map_err(|error| format!("{ATTEST_CA_KEY_ENV} is not a usable PKCS#8 key: {error}"))?;

        // The pair must actually be a pair, and only this comparison shows it.
        // `params.self_signed(&key)` below CANNOT: rcgen params carry the DN,
        // extensions and validity re-expressed from the certificate and never a
        // public key, so it signs with whatever key it is handed and succeeds on
        // a mismatched pair — the error message it used to be labelled with was a
        // claim the call could not support. A mismatch is otherwise silent all
        // the way to the device: we hand out an attestation certificate signed by
        // an unrelated key, the Pin presents it, and the handshake dies at Envoy
        // where this workload logs nothing at all. Onboarding is the one flow
        // with no wearer-side fallback, so it fails 100% with a green console.
        // Same check, same reason, as `enrollment::DucCa::from_pem`.
        {
            let mut reader = std::io::BufReader::new(cert_pem.as_bytes());
            let certificate_der = rustls_pemfile::certs(&mut reader)
                .next()
                .ok_or_else(|| format!("{ATTEST_CA_CERT_ENV} contains no certificate"))?
                .map_err(|error| format!("{ATTEST_CA_CERT_ENV} is not valid PEM: {error}"))?;
            let (_, parsed) =
                x509_parser::parse_x509_certificate(&certificate_der).map_err(|error| {
                    format!("{ATTEST_CA_CERT_ENV} is not a usable certificate: {error}")
                })?;
            if parsed.tbs_certificate.subject_pki.raw != key.public_key_der() {
                return Err(format!(
                    "{ATTEST_CA_KEY_ENV} is not the private key for {ATTEST_CA_CERT_ENV}"
                ));
            }
        }

        // rcgen signs with an issuer *parameter set* re-expressed from the loaded
        // CA. The re-signed object is never emitted; only `certificate_pem` (the
        // operator's own bytes) leaves. Mirrors `enrollment::DucCa::from_pem`.
        let params = rcgen::CertificateParams::from_ca_cert_pem(&cert_pem).map_err(|error| {
            format!("{ATTEST_CA_CERT_ENV} is not a usable CA certificate: {error}")
        })?;
        let certificate = params
            .self_signed(&key)
            .map_err(|error| format!("{ATTEST_CA_CERT_ENV} cannot be re-signed: {error}"))?;

        Ok(Self {
            key,
            certificate,
            certificate_pem: cert_pem,
        })
    }
}

/// Whether the attestation CA is usable — i.e. whether provisioning can actually
/// mint a credential on this deployment.
///
/// A REAL check, not an env-presence one. This used to read two variable names
/// and report `true`, which is the answer the operator console shows: a rotation
/// that replaced one file, a restore that mixed generations, or a mis-mounted
/// bind produced a green chip and 100% enrollment failure with no log line
/// anywhere, because the resulting certificate dies at the Envoy handshake and
/// never reaches this workload. [`AttestCa::from_pem_files`] parses the
/// certificate and refuses a key that is not its key, so asking it is the only
/// answer worth showing. Mirrors [`crate::enrollment::duc_ca_readiness`].
///
/// Called once per `admin_overview` render: two small file reads, a parse, and
/// one P-256 self-sign.
pub fn provisioning_configured() -> bool {
    match AttestCa::from_env() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(detail) => {
            // Loud, and on the workload that holds the material: this is the
            // only place the mismatch is visible before a wearer hits it.
            tracing::error!(
                %detail,
                "the configured device-attestation CA cannot mint credentials"
            );
            false
        }
    }
}

/// Mint a device-attestation credential for `device_id`/`product`.
///
/// The subject is built here to the recovered pattern; the device's private key
/// is generated here and returned once, never persisted.
pub fn mint(device_id: &str, product: &str) -> Result<AttestationBundle, ProvisionError> {
    validate_device_id(device_id)?;
    validate_product(product)?;

    let ca = AttestCa::from_env()
        .map_err(ProvisionError::Ca)?
        .ok_or(ProvisionError::NotConfigured)?;

    let subject = format!("V:01:D:{device_id}:P:{product}");

    let device_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|error| ProvisionError::Ca(format!("generating the device key: {error}")))?;

    let mut params = rcgen::CertificateParams::new(Vec::<String>::new())
        .map_err(|error| ProvisionError::Ca(format!("building certificate params: {error}")))?;
    let mut distinguished_name = rcgen::DistinguishedName::new();
    distinguished_name.push(rcgen::DnType::CommonName, subject.clone());
    distinguished_name.push(rcgen::DnType::OrganizationName, "Humane");
    distinguished_name.push(rcgen::DnType::OrganizationalUnitName, "DeviceAttestation");
    params.distinguished_name = distinguished_name;
    params.is_ca = rcgen::IsCa::ExplicitNoCa;
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.use_authority_key_identifier_extension = true;

    let certificate = params
        .signed_by(&device_key, &ca.certificate, &ca.key)
        .map_err(|error| ProvisionError::Ca(format!("signing the device certificate: {error}")))?;

    record_provisioned(device_id, product, &subject);

    Ok(AttestationBundle {
        device_id: device_id.to_owned(),
        subject,
        certificate_pem: certificate.pem(),
        private_key_pem: device_key.serialize_pem(),
        ca_certificate_pem: ca.certificate_pem,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minted certificate must carry exactly the subject the edge parses back
    /// into a device id, and chain to the configured CA.
    #[test]
    fn a_minted_credential_binds_the_requested_device() {
        // A throwaway CA, written where the env points.
        let ca_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();

        let dir = std::env::temp_dir().join(format!("carry-attest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert_path = dir.join("ca.crt");
        let key_path = dir.join("ca.key");
        std::fs::write(&cert_path, ca_cert.pem()).unwrap();
        std::fs::write(&key_path, ca_key.serialize_pem()).unwrap();

        // Serialised: these tests share process env.
        let bundle = {
            unsafe {
                std::env::set_var(ATTEST_CA_CERT_ENV, &cert_path);
                std::env::set_var(ATTEST_CA_KEY_ENV, &key_path);
            }
            let bundle = mint("00aa11bb", "00000001");
            unsafe {
                std::env::remove_var(ATTEST_CA_CERT_ENV);
                std::env::remove_var(ATTEST_CA_KEY_ENV);
            }
            bundle
        }
        .expect("minting succeeds with a configured CA");

        assert_eq!(bundle.subject, "V:01:D:00aa11bb:P:00000001");
        let der = rustls_pemfile::certs(&mut bundle.certificate_pem.as_bytes())
            .next()
            .unwrap()
            .unwrap();
        let (_, parsed) = x509_parser::parse_x509_certificate(&der).unwrap();
        let cn = parsed
            .subject()
            .iter_common_name()
            .next()
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(
            crate::enrollment::device_id_from_subject(cn),
            Some("00aa11bb"),
            "the edge must parse the minted subject back to the requested device id"
        );

        let ca_der = rustls_pemfile::certs(&mut ca_cert.pem().as_bytes())
            .next()
            .unwrap()
            .unwrap();
        let (_, ca_parsed) = x509_parser::parse_x509_certificate(&ca_der).unwrap();
        parsed
            .verify_signature(Some(ca_parsed.public_key()))
            .expect("the minted certificate chains to the configured CA");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The failure this loader used to pass: a certificate and a key that are
    /// each individually valid but are not a pair.
    ///
    /// `params.self_signed(&key)` cannot notice — rcgen params carry no public
    /// key — so the loader succeeded and minted attestation certificates signed
    /// by a key unrelated to the CA the edge trusts. Nothing downstream reports
    /// it either: the leaf dies in the Envoy TLS handshake, which produces no
    /// line in this workload's log. The pair check is the only place it is
    /// visible, and `provisioning_configured` has to be the thing that runs it or
    /// the operator console keeps saying "configured" about an unusable CA.
    #[test]
    fn a_mismatched_ca_pair_is_refused_rather_than_minting_unverifiable_credentials() {
        let ca_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();
        // A second, unrelated key — the shape a rotation that replaced one file
        // of the pair, or a restore that mixed generations, leaves behind.
        let stranger = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();

        let dir =
            std::env::temp_dir().join(format!("carry-attest-mismatch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cert_path = dir.join("ca.crt");
        let key_path = dir.join("ca.key");
        std::fs::write(&cert_path, ca_cert.pem()).unwrap();
        std::fs::write(&key_path, stranger.serialize_pem()).unwrap();

        // Matched by hand rather than `expect_err`: `AttestCa` deliberately has
        // no `Debug`, because it holds the CA private key.
        let Err(error) =
            AttestCa::from_pem_files(cert_path.to_str().unwrap(), key_path.to_str().unwrap())
        else {
            panic!("a mismatched pair must not load");
        };
        assert!(
            error.contains(ATTEST_CA_KEY_ENV) && error.contains(ATTEST_CA_CERT_ENV),
            "the error must name both halves so the operator knows which to replace: {error}"
        );

        // And the matching pair still loads, so the assertion above pins the
        // pairing rather than a blanket refusal.
        std::fs::write(&key_path, ca_key.serialize_pem()).unwrap();
        AttestCa::from_pem_files(cert_path.to_str().unwrap(), key_path.to_str().unwrap())
            .expect("the real pair loads");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_non_hex_device_id_is_refused() {
        assert!(matches!(
            mint("not-hex", "pin"),
            Err(ProvisionError::BadInput(_))
        ));
    }

    #[test]
    fn a_non_hex_product_id_is_refused() {
        assert!(matches!(
            mint("00aa11bb", "pin"),
            Err(ProvisionError::BadInput(_))
        ));
    }

    #[test]
    fn a_product_with_a_colon_is_refused() {
        assert!(matches!(
            mint("00aa", "p:injected"),
            Err(ProvisionError::BadInput(_))
        ));
    }
}
