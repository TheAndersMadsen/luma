//! The OPAQUE enrollment ceremony, driven over the wire against a running
//! deployment.
//!
//! The in-crate tests prove the ceremony logic. They cannot prove the thing that
//! actually breaks a deployment: that the CA is mounted where the loader looks,
//! that OPAQUE state survives the hop between three separate RPCs, that the edge
//! injects a principal the enrollment store agrees with, and that the certificate
//! we hand back chains to the CA the gateway is verifying against. Every one of
//! those is configuration, and every one of them fails silently, the server
//! starts, serves, and answers `UNIMPLEMENTED` or `UNAVAILABLE` to a device that
//! has no way to say why.
//!
//! This test therefore speaks the wire protocol as a device would.
//!
//! It **skips** unless `COSMOS_LIVE_ENROLLMENT_ENDPOINT` is set, and says so, a
//! bare `return` is indistinguishable from a pass. Required environment:
//!
//! * `COSMOS_LIVE_ENROLLMENT_ENDPOINT`, e.g. `https://127.0.0.1:32452`
//! * `COSMOS_LIVE_ENROLLMENT_AUTHORITY`, SNI/authority, e.g. `onboarding.clone.invalid`
//! * `COSMOS_LIVE_CA_CERT` / `COSMOS_LIVE_CA_KEY`, the clone CA (PEM. Key PKCS#8),
//!   used to mint a device-attestation client certificate for the mTLS handshake
//! * `COSMOS_LIVE_ENROLLMENT_PASSCODE`, the Pin passcode the account this device
//!   is paired to (or the deployment's fallback account) set in Center
//!
//! # Why this re-derives the cipher suite instead of importing it
//!
//! The suite is the interop contract. If this test imported the server's
//! `CipherSuite` implementation, the two halves could drift together, a change
//! from P-256 to ristretto255 would keep passing while every real device broke.
//! The suite below is written out independently, from the recovered evidence
//! (opaque-ke 2.0.0 over NIST P-256, TripleDh, Argon2), so a divergence fails.
//! The same reasoning applies to the H4 seal, implemented here rather than
//! calling the server's helper.

use std::time::Duration;

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::Engine as _;
use opaque_ke::{
    ClientLogin, ClientLoginFinishParameters, CredentialResponse, ciphersuite::CipherSuite,
};
use prost::Message;
use rand::rngs::OsRng;

use cosmos_protocol::provisioning as pb;

/// Independently declared, see the module note.
struct DeviceSuite;

impl CipherSuite for DeviceSuite {
    type OprfCs = p256::NistP256;
    type KeGroup = p256::NistP256;
    type KeyExchange = opaque_ke::key_exchange::tripledh::TripleDh;
    type Ksf = argon2::Argon2<'static>;
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Mint the device-attestation client certificate the onboarding gateway
/// requires, signed by the clone CA.
///
/// The subject follows the recovered DeviceAttestation form
/// `V:01:D:<deviceHex>:P:<product>`; `device_id_from_subject` on the server
/// parses the device id back out of exactly this shape.
fn device_attestation_certificate(
    ca_cert_pem: &str,
    ca_key_pem: &str,
    device_id: &str,
) -> (String, String) {
    let ca_key = rcgen::KeyPair::from_pem(ca_key_pem).expect("CA key is PKCS#8 PEM");
    let ca_params =
        rcgen::CertificateParams::from_ca_cert_pem(ca_cert_pem).expect("CA certificate is usable");
    let ca_certificate = ca_params
        .self_signed(&ca_key)
        .expect("CA certificate re-expresses");

    let mut params = rcgen::CertificateParams::new(vec![]).expect("params");
    params.distinguished_name = {
        let mut dn = rcgen::DistinguishedName::new();
        dn.push(
            rcgen::DnType::CommonName,
            format!("V:01:D:{device_id}:P:testproduct"),
        );
        dn.push(rcgen::DnType::OrganizationName, "Humane");
        dn.push(rcgen::DnType::OrganizationalUnitName, "DeviceAttestation");
        dn
    };
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("device key");
    let certificate = params
        .signed_by(&key, &ca_certificate, &ca_key)
        .expect("device certificate signs");
    (certificate.pem(), key.serialize_pem())
}

/// The H4 seal: AES-256-GCM under the raw 32-byte OPAQUE session key, 12-byte
/// IV, no AAD, tag appended. Written out rather than imported, see module note.
fn seal_h4(session_key: &[u8; 32], plaintext: &[u8]) -> ([u8; 12], Vec<u8>) {
    use rand::RngCore;
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(session_key.into());
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad: &[],
            },
        )
        .expect("seal");
    (iv, sealed)
}

/// Pull the 32-byte private scalar out of a PKCS#8 P-256 key.
///
/// Avoids adding a `pkcs8` feature to `p256` just for a test. In a PKCS#8 EC key
/// the inner SEC1 `ECPrivateKey` begins `INTEGER 1` followed by the private key
/// as a 32-byte OCTET STRING, i.e. the byte run `02 01 01 04 20`, so that prefix
/// locates the scalar unambiguously.
fn p256_scalar_from_pkcs8_pem(pem: &str) -> p256::FieldBytes {
    let der = rustls_pemfile::pkcs8_private_keys(&mut pem.as_bytes())
        .next()
        .expect("PEM contains a PKCS#8 key")
        .expect("PKCS#8 key parses");
    let der = der.secret_pkcs8_der();
    const MARKER: &[u8] = &[0x02, 0x01, 0x01, 0x04, 0x20];
    let start = der
        .windows(MARKER.len())
        .position(|window| window == MARKER)
        .expect("PKCS#8 EC key holds a 32-byte private scalar")
        + MARKER.len();
    let scalar: [u8; 32] = der[start..start + 32]
        .try_into()
        .expect("32 bytes follow the marker");
    scalar.into()
}

fn attestation_signature(key_pem: &str, message: &[u8]) -> pb::VerificationSignature {
    use p256::ecdsa::{Signature, signature::Signer};

    let signing = p256::ecdsa::SigningKey::from_bytes(&p256_scalar_from_pkcs8_pem(key_pem))
        .expect("the attestation scalar is a valid P-256 key");
    let signature: Signature = signing.sign(message);
    pb::VerificationSignature {
        signature: signature.to_der().as_bytes().to_vec(),
        signature_standard: pb::SignatureStandard::EcdsaSha256 as i32,
    }
}

fn certificate_pem(der: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(der);
    let body = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).expect("base64 is ASCII"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n")
}

fn mtls_endpoint(
    endpoint: &str,
    authority: &str,
    server_ca_pem: &str,
    client_cert_pem: &str,
    client_key_pem: &str,
) -> tonic::transport::Endpoint {
    let tls = tonic::transport::ClientTlsConfig::new()
        .domain_name(authority)
        .ca_certificate(tonic::transport::Certificate::from_pem(server_ca_pem))
        .identity(tonic::transport::Identity::from_pem(
            client_cert_pem,
            client_key_pem,
        ));
    tonic::transport::Channel::from_shared(endpoint.to_owned())
        .expect("endpoint parses")
        .tls_config(tls)
        .expect("tls config")
        .origin(
            format!("https://{authority}")
                .parse()
                .expect("authority is a URI"),
        )
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30))
}

fn open_h4(session_key: &[u8; 32], iv: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(session_key.into());
    cipher
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: sealed,
                aad: &[],
            },
        )
        .map_err(|_| "H4 open failed".to_owned())
}

#[tokio::test]
async fn the_full_ceremony_completes_against_a_running_deployment() {
    let Some(endpoint) = var("COSMOS_LIVE_ENROLLMENT_ENDPOINT") else {
        eprintln!(
            "SKIPPED: set COSMOS_LIVE_ENROLLMENT_ENDPOINT (plus _AUTHORITY, \
             COSMOS_LIVE_ATTEST_CA_CERT, COSMOS_LIVE_ATTEST_CA_KEY and \
             COSMOS_LIVE_SERVER_CA_CERT) to run the ceremony against a \
             live deployment"
        );
        return;
    };
    let authority =
        var("COSMOS_LIVE_ENROLLMENT_AUTHORITY").expect("COSMOS_LIVE_ENROLLMENT_AUTHORITY");
    let attest_ca_path = var("COSMOS_LIVE_ATTEST_CA_CERT")
        .or_else(|| var("COSMOS_LIVE_CA_CERT"))
        .expect("COSMOS_LIVE_ATTEST_CA_CERT");
    let attest_ca_cert_pem =
        std::fs::read_to_string(attest_ca_path).expect("read attestation CA certificate");
    let server_ca_path = var("COSMOS_LIVE_SERVER_CA_CERT")
        .or_else(|| var("COSMOS_LIVE_CA_CERT"))
        .expect("COSMOS_LIVE_SERVER_CA_CERT");
    let server_ca_cert_pem =
        std::fs::read_to_string(server_ca_path).expect("read server trust anchor");
    let pincode = var("COSMOS_LIVE_ENROLLMENT_PASSCODE").expect("COSMOS_LIVE_ENROLLMENT_PASSCODE");
    let device_id = var("COSMOS_LIVE_DEVICE_ID").unwrap_or_else(|| "0011223344556677".to_owned());

    // Prefer an attestation certificate minted where the CA key already lives.
    // The CA private key is the one secret that must not be copied around just to
    // run a test, so supplying a ready-made throwaway device identity is the
    // documented path. Minting one here is the convenience fallback for a
    // deployment whose CA is local anyway.
    let (device_cert_pem, device_key_pem) = match (
        var("COSMOS_LIVE_CLIENT_CERT"),
        var("COSMOS_LIVE_CLIENT_KEY"),
    ) {
        (Some(cert), Some(key)) => (
            std::fs::read_to_string(cert).expect("read client certificate"),
            std::fs::read_to_string(key).expect("read client key"),
        ),
        _ => {
            let ca_key_pem = std::fs::read_to_string(
                var("COSMOS_LIVE_ATTEST_CA_KEY")
                    .or_else(|| var("COSMOS_LIVE_CA_KEY"))
                    .expect(
                        "COSMOS_LIVE_ATTEST_CA_KEY (or supply COSMOS_LIVE_CLIENT_CERT/_KEY instead)",
                    ),
            )
            .expect("read CA key");
            device_attestation_certificate(&attest_ca_cert_pem, &ca_key_pem, &device_id)
        }
    };

    // mTLS exactly as the onboarding gateway demands: the stable server root is
    // the trust anchor, while the independently issued attestation leaf is the
    // client identity. These are deliberately separate trust planes.
    let channel = mtls_endpoint(
        &endpoint,
        &authority,
        &server_ca_cert_pem,
        &device_cert_pem,
        &device_key_pem,
    )
    .connect()
    .await
    .expect("the deployment accepts the attestation certificate and completes mTLS");

    let mut client =
        pb::device_onboarding_dac_service_client::DeviceOnboardingDacServiceClient::new(channel);

    // --- Preflight ------------------------------------------------------------
    // A method on the SAME service that needs no enrollment. If this answers and
    // the ceremony does not, the fault is enrollment configuration. If this also
    // fails, the fault is routing or the service name, two very different bugs
    // that both surface as UNIMPLEMENTED at the client.
    let subscription = client
        .get_subscription_status(pb::GetSubscriptionStatusRequest::default())
        .await
        .expect(
            "GetSubscriptionStatus must answer: it needs no CA, so a failure here means the \
             request never reached the provisioning service (routing or wire service name)",
        )
        .into_inner();
    eprintln!("preflight ok: subscription status = {subscription:?}");

    // --- OPAQUE login, step 1 -------------------------------------------------
    let mut rng = OsRng;
    let start =
        ClientLogin::<DeviceSuite>::start(&mut rng, pincode.as_bytes()).expect("KE1 generates");

    let init = client
        .create_login_init(pb::CreateLoginInitRequest {
            login_request: start.message.serialize().to_vec(),
            device_id_verification_signature: Some(attestation_signature(
                &device_key_pem,
                device_id.as_bytes(),
            )),
            ..Default::default()
        })
        .await
        .expect("CreateLoginInit is served — UNIMPLEMENTED here means no DeviceUser CA is mounted")
        .into_inner();

    assert!(
        !init.login_response.is_empty(),
        "the server must return a KE2; an empty one is the enumeration-oracle bug"
    );
    assert_eq!(
        init.response_code.as_ref().map(|c| c.status_code),
        Some(pb::OpaqueLoginStatusCode::OpaqueLoginStatusSuccessfulRequest as i32),
        "login init reported a non-success status"
    );

    // --- OPAQUE login, step 2 -------------------------------------------------
    let ke2 = CredentialResponse::<DeviceSuite>::deserialize(&init.login_response)
        .expect("KE2 deserializes under the recovered suite (P-256/TripleDh/Argon2)");
    let finish = start
        .state
        .finish(
            pincode.as_bytes(),
            ke2,
            ClientLoginFinishParameters::default(),
        )
        .expect("KE3 completes — a failure here means the suite or the pincode disagrees");

    let session_key: [u8; 32] = finish
        .session_key
        .as_slice()
        .try_into()
        .expect("the OPAQUE session key is 32 bytes (SHA-256 family)");

    let finished = client
        .create_login_finish(pb::CreateLoginFinishRequest {
            login_finish_request: finish.message.serialize().to_vec(),
            device_id_verification_signature: Some(attestation_signature(
                &device_key_pem,
                device_id.as_bytes(),
            )),
            ..Default::default()
        })
        .await
        .expect("CreateLoginFinish is served")
        .into_inner();

    assert!(
        !finished.user_id.is_empty(),
        "a finished login must name the enrolled user; OK + empty user_id is the \
         dead end the device cannot recover from"
    );

    // --- DeviceUser binding ---------------------------------------------------
    // A P-256 CSR, plus a VerificationSignature over it sealed under the session
    // key. Holding the key is what proves this is the same caller that logged in.
    let device_user_key =
        rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("device-user key");
    let mut csr_params = rcgen::CertificateParams::new(vec![]).expect("csr params");
    csr_params.distinguished_name = {
        let mut dn = rcgen::DistinguishedName::new();
        // Deliberately a value the server must NOT honour: identity is the
        // server's to decide, and the assertion below proves it overrode this.
        dn.push(rcgen::DnType::CommonName, "V:01:D:attacker:U:attacker");
        dn
    };
    let csr_der = csr_params
        .serialize_request(&device_user_key)
        .expect("CSR serializes")
        .der()
        .to_vec();

    // Signed with the ATTESTATION key. The server verifies this against the
    // attestation certificate the edge presented, so any other key is rejected,
    // which is exactly what happened when this test first signed with a fresh
    // random key and got `device attestation signature did not verify`.
    let signature = attestation_signature(&device_key_pem, &csr_der);
    let (iv, sealed) = seal_h4(&session_key, &signature.encode_to_vec());

    let bound = client
        .create_device_user_binding(pb::EncryptedCreateDeviceUserBindingRequest {
            device_user_credential_csr: Some(pb::CertificateSigningRequest {
                csr: csr_der.clone(),
                ..Default::default()
            }),
            device_attestation_credential_verification_signature: Some(pb::EncryptedPayload {
                iv: iv.to_vec(),
                payload: sealed,
            }),
        })
        .await
        .expect("CreateDeviceUserBinding is served")
        .into_inner();

    // The certificate comes back sealed under the same session key, the device
    // must hold it to read its own credential.
    let sealed_certificate = bound
        .device_user_certificate
        .expect("the binding must return a DeviceUser certificate");
    let certificate_der = open_h4(
        &session_key,
        &sealed_certificate.iv,
        &sealed_certificate.payload,
    )
    .expect("the issued certificate opens under the OPAQUE session key");
    assert!(
        !certificate_der.is_empty(),
        "an empty certificate would pass a naive check and fail every later mTLS call"
    );

    // The certificate must chain to the CA the gateway verifies against, and must
    // contain the SERVER's chosen identity, not the one the CSR asked for.
    let (_, parsed) = x509_parser::parse_x509_certificate(&certificate_der)
        .expect("the issued DeviceUser certificate parses");
    let subject = parsed.subject().to_string();
    assert!(
        subject.contains(&format!("D:{device_id}")),
        "the issued subject must bind the ATTESTED device id, got {subject}"
    );
    assert!(
        !subject.contains("attacker"),
        "the server honoured a CSR-chosen identity: {subject}"
    );

    // The issued DeviceUser certificate is signed by the **DeviceUser CA**, which
    // in a production-shaped topology is a DIFFERENT CA from the edge/attestation
    // CA that verifies the mTLS client certificate. The single-CA deployments this
    // test was first written against happened to use one CA for both. A three-CA
    // deployment (edge CA for mTLS, a separate DUC CA for issuance) does not. So
    // the final chain check verifies against `COSMOS_LIVE_DUC_CA_CERT` when the
    // operator supplies it, falling back to the mTLS CA otherwise.
    let chain_ca_pem = match var("COSMOS_LIVE_DUC_CA_CERT") {
        Some(path) => std::fs::read_to_string(path).expect("read COSMOS_LIVE_DUC_CA_CERT"),
        None => attest_ca_cert_pem.clone(),
    };
    let ca_der = rustls_pemfile::certs(&mut chain_ca_pem.as_bytes())
        .next()
        .expect("CA PEM has a certificate")
        .expect("CA PEM parses");
    let (_, ca) = x509_parser::parse_x509_certificate(&ca_der).expect("CA certificate parses");
    parsed
        .verify_signature(Some(ca.public_key()))
        .expect("the issued certificate must chain to the DeviceUser CA the gateway issues from");

    // The two SNI planes must remain mutually exclusive. The attestation key can
    // enroll but cannot call normal APIs. The newly issued DeviceUser key can
    // call APIs but cannot return to onboarding.
    let api_authority =
        var("COSMOS_LIVE_API_AUTHORITY").unwrap_or_else(|| "api.cosmos.humane.cloud".to_owned());
    let attestation_on_api = mtls_endpoint(
        &endpoint,
        &api_authority,
        &server_ca_cert_pem,
        &device_cert_pem,
        &device_key_pem,
    )
    .connect()
    .await;
    if let Ok(channel) = attestation_on_api {
        let crossed = tonic_health::pb::health_client::HealthClient::new(channel)
            .check(tonic_health::pb::HealthCheckRequest {
                service: String::new(),
            })
            .await;
        assert!(
            crossed.is_err(),
            "an onboarding attestation credential crossed into the DeviceUser API trust plane"
        );
    }

    let device_user_chain_pem = format!("{}{}", certificate_pem(&certificate_der), chain_ca_pem);
    let api_channel = mtls_endpoint(
        &endpoint,
        &api_authority,
        &server_ca_cert_pem,
        &device_user_chain_pem,
        &device_user_key.serialize_pem(),
    )
    .connect()
    .await
    .expect("the issued DeviceUser credential enters the API trust plane");
    tonic_health::pb::health_client::HealthClient::new(api_channel)
        .check(tonic_health::pb::HealthCheckRequest {
            service: String::new(),
        })
        .await
        .expect("the DeviceUser credential reaches an authenticated API route");

    let device_user_on_onboarding = mtls_endpoint(
        &endpoint,
        &authority,
        &server_ca_cert_pem,
        &device_user_chain_pem,
        &device_user_key.serialize_pem(),
    )
    .connect()
    .await;
    if let Ok(channel) = device_user_on_onboarding {
        let crossed = tonic_health::pb::health_client::HealthClient::new(channel)
            .check(tonic_health::pb::HealthCheckRequest {
                service: String::new(),
            })
            .await;
        assert!(
            crossed.is_err(),
            "a DeviceUser credential crossed back into the onboarding trust plane"
        );
    }

    eprintln!(
        "live enrollment ceremony and SNI trust-plane isolation completed; issued subject = {subject}"
    );
}
