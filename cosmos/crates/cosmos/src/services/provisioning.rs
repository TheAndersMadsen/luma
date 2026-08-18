//! `humane.provisioning.DeviceOnboardingDACService` — the device onboarding
//! ceremony.
//!
//! Subscription status returns a configured clone-local state. HMC *association*
//! stays denied (there is no HMC directory to consult), but HMC *bypass* opens
//! enrollment by default — this is a self-hosted clone, and the whole point is to
//! let a Pin bind. The OPAQUE login pair and the DeviceUser-binding RPC delegate to
//! [`crate::enrollment::Enrollment`]: a real opaque-ke 2.0.0 server over NIST P-256
//! with Argon2, the H4 seal, and a **configured** CA that issues DeviceUser
//! certificates.
//!
//! Enrollment is faithful to the decompiled `UserBindingManager` flow: OPAQUE
//! login keyed by the mTLS principal (the device sends `device_id` empty — see
//! `UserBindingManager.loginStart`, which sets only the signature and the login
//! request), and the DeviceUser certificate sealed back to the caller under the
//! OPAQUE session key (`EncryptedPayload`) — the shape `UserBindingManager`
//! decrypts and imports.
//!
//! ## Errors are chosen for what the device can act on
//!
//! The decompiled client collapses almost every failure into silence. Following
//! `UserBindingManager` → `ProvisioningService.ProvisioningErrorHandler` →
//! `ProvisioningAccessManager`, the only outcomes that reach the wearer are:
//!
//! | wire outcome | client path | wearer sees |
//! |---|---|---|
//! | `OK`, non-empty `user_id` | `LoginFinishResult` | onboarding continues |
//! | `UNAVAILABLE` | `isNetworkError` → code `2` | `onNetworkError()` — retry |
//! | `OK` + empty `user_id` | `BindingException` → code `0` | **nothing** |
//! | any other status | code `0` | **nothing** |
//!
//! Returning `OK` with `MISSING_REGISTRATION` and an empty `user_id` is therefore
//! a dead end: `UserBindingManager$3.onNext` converts it to a `BindingException`
//! before any status code is ever read, `sendErrorFromThrowable` maps that to
//! provisioning error code `0`, and
//! `ProvisioningAccessManager$3.lambda$finishProvisioningWithError$1` handles only
//! codes `1` and `2` — code `0` falls through to a rate-limit probe that invokes
//! no handler at all. So a failed `CreateLoginFinish` is returned as a gRPC
//! **error**, and a transient one as `UNAVAILABLE`, which is the single code the
//! onboarding UI renders as a retryable state.
//!
//! ## The `device_id_verification_signature`, decided rather than ignored
//!
//! Every provisioning request carries an ECDSA-P256-SHA256 signature over the
//! device id, made with the DeviceAttestation private key
//! (`UserBindingManager.buildDacVerifierSignature` →
//! `DeviceAttestationManager.generateVerifierSignature`). Verifying it needs the
//! **DeviceAttestation certificate's public key**, which this workload only sees
//! if the mesh edge is configured to forward the client certificate: `auth.rs`
//! consumes the XFCC `Subject=` element and nothing more, so by default the
//! attestation public key is genuinely unobtainable here.
//!
//! The decision is therefore explicit, not silent:
//!
//! * If the edge forwards the certificate (XFCC `Cert=`), the signature **is**
//!   verified and a bad one is rejected `UNAUTHENTICATED`.
//! * If it does not, the field is **deliberately accepted unverified** — the same
//!   DeviceAttestation key already authenticated the mTLS connection the edge
//!   terminated, so the signature adds no evidence we do not already have. Set
//!   `COSMOS_REQUIRE_DEVICE_ATTESTATION` to refuse instead of accepting.

use std::sync::Arc;

use cosmos_protocol::provisioning as pb;
use pb::device_onboarding_dac_service_server::DeviceOnboardingDacService;
use prost::Message as _;
use tonic::{Request, Response, Status};

use crate::enrollment::{Enrollment, EnrollmentError, device_id_from_subject};

/// Fallback principal when a request reaches a handler without the `AuthLayer`
/// having resolved one. Behind the layer this never happens; in a direct
/// unit-test call the caller injects a principal explicitly.
const FALLBACK_PRINCIPAL: &str = "development-insecure-principal";

/// Envoy/Istio's forwarded client-certificate header. `auth.rs` reads its
/// `Subject=` element for the principal; the `Cert=` element (present only when
/// the edge is configured to forward it) is what makes attestation verification
/// possible at all.
const XFCC_HEADER: &str = "x-forwarded-client-cert";

/// Refuse a request whose attestation signature cannot be verified, instead of
/// deliberately accepting it.
const REQUIRE_ATTESTATION_ENV: &str = "COSMOS_REQUIRE_DEVICE_ATTESTATION";

#[derive(Clone)]
pub struct Provisioning {
    /// The server half of the enrollment ceremony (OPAQUE + H4 + DUC issuance).
    ///
    /// `None` when the deployment has not configured a DeviceUser CA. Enrollment
    /// is then honestly `UNIMPLEMENTED` rather than served by a per-process CA
    /// whose certificates stop being trusted at the next restart.
    enrollment: Option<Arc<Enrollment>>,
    /// Durable device-to-account directory shared with the enrollment ceremony.
    enrollment_store: crate::enrollment::SharedEnrollmentStore,
    /// Durable wearer state shared with the account-plane admin surface. The
    /// provisioning workload reads subscription changes written by AI-bus
    /// through the same PostgreSQL store.
    account_store: crate::store::SharedStore,
    /// Whether an always-signed RPC must contain a verifiable attestation
    /// signature. Resolved ONCE at construction rather than read per call:
    /// reading a process-global env var inside a handler makes concurrent tests
    /// race on it, and a security decision should not depend on when it is
    /// sampled.
    require_attestation: bool,
}

impl Provisioning {
    pub fn new(enrollment: Option<Arc<Enrollment>>) -> Self {
        Self::from_parts(
            enrollment,
            crate::enrollment::configured_store(),
            crate::store::MemoryStore::shared(),
            attestation_required(),
        )
    }

    pub fn with_account_store(
        enrollment: Option<Arc<Enrollment>>,
        account_store: crate::store::SharedStore,
    ) -> Self {
        Self::from_parts(
            enrollment,
            crate::enrollment::configured_store(),
            account_store,
            attestation_required(),
        )
    }

    fn from_parts(
        enrollment: Option<Arc<Enrollment>>,
        enrollment_store: crate::enrollment::SharedEnrollmentStore,
        account_store: crate::store::SharedStore,
        require_attestation: bool,
    ) -> Self {
        Self {
            enrollment,
            enrollment_store,
            account_store,
            require_attestation,
        }
    }

    /// Construct over an explicit enrollment store. Tests use this seam so they
    /// exercise the same replica-safe directory calls as production without
    /// resolving process-global deployment configuration.
    #[cfg(test)]
    pub(crate) fn with_store(
        enrollment: Option<Arc<Enrollment>>,
        enrollment_store: crate::enrollment::SharedEnrollmentStore,
    ) -> Self {
        Self::with_stores(
            enrollment,
            enrollment_store,
            crate::store::MemoryStore::shared(),
        )
    }

    #[cfg(test)]
    fn with_stores(
        enrollment: Option<Arc<Enrollment>>,
        enrollment_store: crate::enrollment::SharedEnrollmentStore,
        account_store: crate::store::SharedStore,
    ) -> Self {
        Self::from_parts(enrollment, enrollment_store, account_store, false)
    }

    /// Construct with an explicit attestation requirement (tests inject rather
    /// than mutating process-global state).
    #[cfg(test)]
    fn with_attestation_requirement(
        enrollment: Option<Arc<Enrollment>>,
        require_attestation: bool,
    ) -> Self {
        Self::from_parts(
            enrollment,
            crate::enrollment::MemoryEnrollmentStore::shared(),
            crate::store::MemoryStore::shared(),
            require_attestation,
        )
    }

    /// The enrollment ceremony, or the honest refusal.
    #[allow(clippy::result_large_err)]
    fn enrollment(&self) -> Result<&Enrollment, Status> {
        self.enrollment.as_deref().ok_or_else(|| {
            Status::unimplemented(
                "device enrollment is not configured: this deployment has no DeviceUser CA",
            )
        })
    }
}

impl Default for Provisioning {
    fn default() -> Self {
        Self::new(Enrollment::from_env())
    }
}

/// Resolve the caller principal the `AuthLayer` injected, falling back to a fixed
/// development principal if absent (a wiring bug behind the edge, but not a reason
/// to key OPAQUE state on an empty string).
fn caller_principal<T>(request: &Request<T>) -> String {
    crate::auth::principal(request)
        .map(|principal| principal.expose_for_authorization().to_owned())
        .unwrap_or_else(|| FALLBACK_PRINCIPAL.to_owned())
}

/// Whether enrollment is open. `COSMOS_ENROLLMENT_OPEN` defaults to open — this is
/// the self-hosted clone deliberately admitting devices; set it to a falsey value
/// (`0`/`false`/`no`/`off`) to close the HMC bypass gate.
fn enrollment_open() -> bool {
    match std::env::var("COSMOS_ENROLLMENT_OPEN") {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// Whether an unverifiable attestation signature must be refused.
fn attestation_required() -> bool {
    matches!(
        std::env::var(REQUIRE_ATTESTATION_ENV)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Persist the stock subscription verdict for one wearer account. This is the
/// clone account-plane mutation paired with the device-facing read RPC.
pub async fn put_subscription_state(
    store: &crate::store::SharedStore,
    principal: &str,
    status: pb::SubscriptionStatus,
) -> Result<(), Status> {
    let code = pb::SubscriptionStatusCode::try_from(status.status_code)
        .map_err(|_| Status::invalid_argument("subscription status_code is invalid"))?;
    if code == pb::SubscriptionStatusCode::Unspecified {
        return Err(Status::invalid_argument(
            "subscription status_code must be explicit",
        ));
    }
    store
        .put_account_blob(
            principal,
            crate::store::AccountBlobKind::SubscriptionState,
            &status.encode_to_vec(),
        )
        .await?;
    Ok(())
}

/// Percent-decode an XFCC element value. Envoy URL-encodes the PEM it forwards.
fn percent_decode(encoded: &str) -> Vec<u8> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    out
}

/// The DeviceAttestation certificate the edge forwarded, DER-encoded.
///
/// `None` whenever the edge does not forward `Cert=` — the default Istio
/// configuration this clone documents. See the module docs for what that means.
fn forwarded_attestation_certificate<T>(request: &Request<T>) -> Option<Vec<u8>> {
    let header = request.metadata().get(XFCC_HEADER)?.to_str().ok()?;
    // `Cert="<url-encoded PEM>"`, one element of a `;`-separated list. Matched on
    // an element boundary rather than by substring, so a `Cert=` appearing inside
    // some other element's value cannot be mistaken for the certificate. The
    // forwarded PEM is URL-encoded, so it contains no literal `;` to split on.
    let value = header
        .split(';')
        .filter_map(|element| element.trim().strip_prefix("Cert="))
        .next()?;
    let value = match value.strip_prefix('"') {
        Some(quoted) => quoted.strip_suffix('"').unwrap_or(quoted),
        None => value,
    };
    let pem = percent_decode(value);
    let mut reader = std::io::BufReader::new(pem.as_slice());
    rustls_pemfile::certs(&mut reader)
        .next()?
        .ok()
        .map(|der| der.to_vec())
}

/// The forwarded attestation certificate, checked to be the SAME device the edge
/// authenticated this connection as.
///
/// `auth.rs` derives the principal from the XFCC `Subject=` CN while the
/// signature is verified against the `Cert=` element's own CN. Both are produced
/// by the edge from one peer certificate, so a mismatch should be impossible —
/// but nothing enforced it, and the whole justification for accepting an
/// unverifiable signature is that the attesting key is the key that authenticated
/// the connection. A `Cert=` naming a different device is refused rather than
/// silently used to mint a certificate for the `Subject=` device.
#[allow(clippy::result_large_err)]
fn bound_attestation_certificate<T>(request: &Request<T>) -> Result<Option<Vec<u8>>, Status> {
    let Some(certificate) = forwarded_attestation_certificate(request) else {
        return Ok(None);
    };
    let authenticated = authenticated_device_id(request)?;
    match crate::enrollment::attestation_certificate_device_id(&certificate) {
        Some(claimed) if claimed == authenticated => Ok(Some(certificate)),
        _ => Err(Status::unauthenticated(
            "the forwarded device-attestation certificate does not name the device              this connection is authenticated as",
        )),
    }
}

/// Whether the stock device always signs this particular RPC.
///
/// This distinction is what makes [`REQUIRE_ATTESTATION_ENV`] mean anything. The
/// check used to return `Ok(())` for an absent signature *before* consulting
/// `attestation_required()`, so an operator who turned the switch on and wired
/// the edge to forward `Cert=` could still be walked straight past it by a caller
/// that simply omitted the field — a hard refusal bypassed by omission.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Attestation {
    /// `UserBindingManager.loginStart` / `loginFinish` both call
    /// `buildDacVerifierSignature()` unconditionally, so a real Pin ALWAYS sends
    /// one here. In required mode its absence is a refusal.
    AlwaysSigned,
    /// `checkHMCBypass` / `checkSubscription` build their requests empty, so an
    /// absent signature is normal and carries no information either way.
    MaySkip,
}

/// Decide what to do with a device-attestation signature.
///
/// `message` is what the device signed: `None` for the per-call
/// `device_id_verification_signature` (the device id itself), or the exact bytes
/// for the binding signature over the CSR.
#[allow(clippy::result_large_err)]
fn check_attestation<T>(
    require_attestation: bool,
    request: &Request<T>,
    message: Option<&[u8]>,
    signature: Option<&[u8]>,
    presence: Attestation,
) -> Result<(), Status> {
    let Some(signature) = signature.filter(|bytes| !bytes.is_empty()) else {
        if presence == Attestation::AlwaysSigned && require_attestation {
            return Err(Status::unauthenticated(
                "this RPC is always signed by a real device and \
                 COSMOS_REQUIRE_DEVICE_ATTESTATION is set, but no \
                 device_id_verification_signature was supplied",
            ));
        }
        // Nothing to verify is not a failure on the RPCs the device leaves empty.
        return Ok(());
    };
    match bound_attestation_certificate(request)? {
        Some(certificate) => {
            crate::enrollment::verify_attestation_signature(&certificate, message, signature)?;
            Ok(())
        }
        // `require_attestation`, not `attestation_required()`. This arm used to
        // re-read the process env var, which contradicted the invariant the
        // struct field documents — resolved ONCE at construction — and made the
        // refusal unreachable from `with_attestation_requirement`, the seam that
        // exists precisely so a test does not have to mutate process-global
        // state. A service built as "required" was not enforcing here, and no
        // test could go red about it: the branch could have been deleted or
        // inverted and the suite would have stayed green. Production reads the
        // same unchanging variable either way, so nothing about the deployment
        // changes; what changes is that the security decision is now testable
        // and cannot drift from the flag the constructor resolved.
        None if require_attestation => Err(Status::unauthenticated(
            "the edge did not forward a device-attestation certificate to verify against",
        )),
        None => {
            // Deliberate: the attestation key already authenticated the mTLS
            // connection the edge terminated, and the workload is not given the
            // certificate. Recorded rather than silently dropped.
            tracing::debug!(
                "accepting a device-attestation signature unverified: no {XFCC_HEADER} Cert= \
                 element (set {REQUIRE_ATTESTATION_ENV} to refuse instead)"
            );
            Ok(())
        }
    }
}

/// The device id this caller is authenticated as.
///
/// Parsed from the edge-injected mTLS subject, never from the request body or the
/// CSR: `CreateLoginInitRequest.device_id` is left empty by the device anyway, and
/// a client-supplied device id would let any caller name itself as any Pin.
///
/// Lower-cased so it is the SAME key the pairing endpoint stores under
/// (`admin_provision`/`admin_pair` both normalise hex to lowercase). Without
/// this, a device whose attestation CN carries uppercase hex would miss its
/// pairing and silently enrol into the fallback user instead of its account.
#[allow(clippy::result_large_err)]
fn authenticated_device_id<T>(request: &Request<T>) -> Result<String, Status> {
    let principal = caller_principal(request);
    device_id_from_subject(&principal)
        .map(|device_id| device_id.to_ascii_lowercase())
        .ok_or_else(|| Status::from(EnrollmentError::Principal))
}

#[allow(clippy::result_large_err)]
fn authenticated_device_id_from_principal_or_body(
    principal: &str,
    body_device_id: &str,
) -> Result<String, Status> {
    if let Some(device_id) = device_id_from_subject(principal) {
        return Ok(device_id.to_ascii_lowercase());
    }
    // Development-insecure calls have no edge-injected subject. The request
    // field is accepted only in that explicit mode; production identities can
    // never be overridden by it.
    if principal == FALLBACK_PRINCIPAL {
        let device_id = body_device_id.trim();
        if !device_id.is_empty()
            && device_id.len() <= 128
            && device_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Ok(device_id.to_ascii_lowercase());
        }
    }
    Err(Status::from(EnrollmentError::Principal))
}

#[tonic::async_trait]
impl DeviceOnboardingDacService for Provisioning {
    async fn get_subscription_status(
        &self,
        request: Request<pb::GetSubscriptionStatusRequest>,
    ) -> Result<Response<pb::GetSubscriptionStatusResponse>, Status> {
        let principal = caller_principal(&request);
        let (paired, account_principal) = if principal.starts_with("U:") {
            (true, Some(principal.clone()))
        } else if let Some(device_id) = device_id_from_subject(&principal) {
            let account = self
                .enrollment_store
                .device_account(&device_id.to_ascii_lowercase())
                .await?;
            let account_principal = account.as_deref().and_then(|account| {
                cosmos_core::AuthenticatedPrincipal::for_user(account)
                    .ok()
                    .map(|principal| principal.expose_for_authorization().to_owned())
            });
            (account.is_some(), account_principal)
        } else {
            // Development-insecure tests have no mTLS subject. Preserve their
            // usable onboarding state without making a production device claim.
            (true, Some(principal.clone()))
        };
        if let Some(account_principal) = account_principal
            && let Some(bytes) = self
                .account_store
                .get_account_blob(
                    &account_principal,
                    crate::store::AccountBlobKind::SubscriptionState,
                )
                .await?
        {
            let status = pb::SubscriptionStatus::decode(bytes.as_slice())
                .map_err(|_| Status::internal("stored subscription state could not be read"))?;
            return Ok(Response::new(pb::GetSubscriptionStatusResponse {
                status: Some(status),
            }));
        }
        Ok(Response::new(pb::GetSubscriptionStatusResponse {
            status: Some(pb::SubscriptionStatus {
                status_code: if paired {
                    pb::SubscriptionStatusCode::Active
                } else {
                    pb::SubscriptionStatusCode::Available
                } as i32,
                message: String::new(),
            }),
        }))
    }

    /// The HMC bypass gate: `Allowed` by default so a self-hosted clone admits a
    /// device, `Disallowed` when `COSMOS_ENROLLMENT_OPEN` is set falsey — or when
    /// this deployment has no DeviceUser CA, because inviting a Pin into a
    /// ceremony we cannot finish just strands it mid-onboarding.
    async fn verify_hmc_by_pass(
        &self,
        request: Request<pb::VerifyHmcByPassRequest>,
    ) -> Result<Response<pb::VerifyHmcByPassResponse>, Status> {
        check_attestation(
            self.require_attestation,
            &request,
            None,
            request
                .get_ref()
                .device_id_verification_signature
                .as_ref()
                .map(|signature| signature.signature.as_slice()),
            Attestation::MaySkip,
        )?;

        let status = if enrollment_open() && self.enrollment.is_some() {
            pb::VerifyHmcByPassResponseCode::Allowed
        } else {
            pb::VerifyHmcByPassResponseCode::Disallowed
        };
        Ok(Response::new(pb::VerifyHmcByPassResponse {
            status: status as i32,
        }))
    }

    async fn verify_hmc_association(
        &self,
        request: Request<pb::VerifyHmcAssociationRequest>,
    ) -> Result<Response<pb::VerifyHmcAssociationResponse>, Status> {
        let caller_principal_value = caller_principal(&request);
        check_attestation(
            self.require_attestation,
            &request,
            None,
            request
                .get_ref()
                .device_id_verification_signature
                .as_ref()
                .map(|signature| signature.signature.as_slice()),
            Attestation::MaySkip,
        )?;

        let body = request.into_inner();
        if body.hmc_id.trim().is_empty() {
            return Ok(Response::new(pb::VerifyHmcAssociationResponse {
                status: pb::HmcAssociationResponseCode::InvalidHmcId as i32,
                name_to_display: String::new(),
            }));
        }
        let device_id = authenticated_device_id_from_principal_or_body(
            &caller_principal_value,
            &body.device_id,
        )?;
        let account = self.enrollment_store.device_account(&device_id).await?;
        let (status, name_to_display) = match account {
            Some(account) if account == body.hmc_id => (
                pb::HmcAssociationResponseCode::Success,
                std::env::var("COSMOS_ENROLLMENT_DISPLAY_NAME")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "Cosmos User".to_owned()),
            ),
            Some(_) => (pb::HmcAssociationResponseCode::Failure, String::new()),
            None => (
                pb::HmcAssociationResponseCode::MissingDeviceUserAssociation,
                String::new(),
            ),
        };
        Ok(Response::new(pb::VerifyHmcAssociationResponse {
            status: status as i32,
            name_to_display,
        }))
    }

    async fn get_assigned_user_dac(
        &self,
        request: Request<pb::GetAssignedUserDacRequest>,
    ) -> Result<Response<pb::GetAssignedUserResponse>, Status> {
        let principal = caller_principal(&request);
        let userid = match device_id_from_subject(&principal) {
            Some(device_id) => self
                .enrollment_store
                .device_account(&device_id.to_ascii_lowercase())
                .await?
                .map(|account| {
                    uuid::Uuid::parse_str(&account)
                        .map(|uuid| uuid.as_bytes().to_vec())
                        .unwrap_or_else(|_| account.into_bytes())
                })
                .unwrap_or_default(),
            None => Vec::new(),
        };
        Ok(Response::new(pb::GetAssignedUserResponse { userid }))
    }

    /// OPAQUE login, step 1: the device's KE1 in, KE2 out.
    ///
    /// `MISSING_REGISTRATION` is never emitted. It is the one status the device
    /// distinguishes here (`UserBindingManager.loginStart` → `onPincodeNotSet()`),
    /// which is exactly why emitting it would be a user-enumeration oracle: a
    /// deployment holding no credential answers with a well-formed dummy KE2
    /// instead, and the device's own `clientLoginFinish` then shows the same
    /// `onWrongPincode()` a wrong pincode produces.
    ///
    /// A failure is returned as a gRPC error rather than `OK` with an empty
    /// `login_response`, which the client turns into a `BindingException` and the
    /// UI drops on the floor.
    async fn create_login_init(
        &self,
        request: Request<pb::CreateLoginInitRequest>,
    ) -> Result<Response<pb::CreateLoginInitResponse>, Status> {
        let enrollment = self.enrollment()?;
        check_attestation(
            self.require_attestation,
            &request,
            None,
            request
                .get_ref()
                .device_id_verification_signature
                .as_ref()
                .map(|signature| signature.signature.as_slice()),
            Attestation::AlwaysSigned,
        )?;

        let principal = caller_principal(&request);
        // The device id routes the login to the paired account's credential. `.ok()`:
        // a caller without a device subject (dev-insecure, a test harness) resolves
        // to the fallback account, never an error — the strict extraction stays at
        // binding, where a certificate is actually minted.
        let device_id = authenticated_device_id(&request).ok();
        let request = request.into_inner();

        let login_response = enrollment
            .login_init(&principal, device_id.as_deref(), &request.login_request)
            .await?;
        Ok(Response::new(pb::CreateLoginInitResponse {
            login_response,
            response_code: Some(pb::OpaqueLoginStatus {
                status_code: pb::OpaqueLoginStatusCode::OpaqueLoginStatusSuccessfulRequest as i32,
                message: String::new(),
            }),
        }))
    }

    /// OPAQUE login, step 2: the device's KE3 in, the enrolled user id out.
    ///
    /// On success the session key is recorded, durably, for whichever replica
    /// handles `CreateDeviceUserBinding`. On failure the error is propagated as a
    /// gRPC status — see the module docs for why `OK` + empty `user_id` is a dead
    /// end and `UNAVAILABLE` is the one retryable signal the wearer ever sees.
    async fn create_login_finish(
        &self,
        request: Request<pb::CreateLoginFinishRequest>,
    ) -> Result<Response<pb::CreateLoginFinishResponse>, Status> {
        let enrollment = self.enrollment()?;
        check_attestation(
            self.require_attestation,
            &request,
            None,
            request
                .get_ref()
                .device_id_verification_signature
                .as_ref()
                .map(|signature| signature.signature.as_slice()),
            Attestation::AlwaysSigned,
        )?;

        let principal = caller_principal(&request);
        let device_id = authenticated_device_id(&request).ok();
        let request = request.into_inner();

        enrollment
            .login_finish(&principal, &request.login_finish_request)
            .await?;
        // The user id the device now imports is the account it enrolled INTO —
        // its pairing, or the fallback — resolved from the same edge-authenticated
        // device id, never anything the request carries.
        let user_id = enrollment.account_for_device(device_id.as_deref()).await?;
        Ok(Response::new(pb::CreateLoginFinishResponse {
            user_id,
            response_code: Some(pb::OpaqueLoginStatus {
                status_code: pb::OpaqueLoginStatusCode::OpaqueLoginStatusSuccessfulRequest as i32,
                message: String::new(),
            }),
            display_name: enrollment.display_name().to_owned(),
        }))
    }

    /// DeviceUser binding: open the device's session-key-sealed attestation, issue
    /// a DeviceUser certificate for its CSR's public key, and seal that
    /// certificate back under the same session key.
    ///
    /// The certificate's subject is built from the device id the **edge**
    /// authenticated, never from the CSR — see [`Enrollment::issue_duc`].
    async fn create_device_user_binding(
        &self,
        request: Request<pb::EncryptedCreateDeviceUserBindingRequest>,
    ) -> Result<Response<pb::EncryptedCreateDeviceUserBindingResponse>, Status> {
        let enrollment = self.enrollment()?;
        let principal = caller_principal(&request);
        let device_id = authenticated_device_id(&request)?;
        let attestation_certificate = bound_attestation_certificate(&request)?;
        let request = request.into_inner();

        // The session key from the just-finished login is required. Its absence is
        // transient (the ceremony restarts), so it is reported the one way the
        // onboarding UI renders as retryable.
        let session_key = enrollment
            .session_key(&principal)
            .await?
            .ok_or_else(|| Status::unavailable("no completed OPAQUE login for this principal"))?;

        // Opening the attestation proves the caller holds the session key.
        let attestation = request
            .device_attestation_credential_verification_signature
            .ok_or_else(|| Status::invalid_argument("missing device attestation payload"))?;
        let opened = Enrollment::open_h4(&session_key, &attestation.iv, &attestation.payload)?;

        // Issue the DeviceUser certificate from the device's CSR.
        let csr = request
            .device_user_credential_csr
            .ok_or_else(|| Status::invalid_argument("missing device-user CSR"))?;

        // The sealed payload is a `VerificationSignature` over the encoded CSR
        // (`UserBindingManager.createBindingRequest`). Verified when — and only
        // when — the edge gave us the attestation certificate to check it against;
        // otherwise the same deliberate decision as every other RPC applies.
        match attestation_certificate {
            Some(certificate) => {
                let signature =
                    pb::VerificationSignature::decode(opened.as_slice()).map_err(|_| {
                        Status::invalid_argument("malformed device attestation payload")
                    })?;
                // `UserBindingManager.createBindingRequest` tags this
                // `SignatureStandard.ECDSA_SHA256`, and ECDSA-P256-SHA256 is what
                // we verify below. Accepting an unrecognised tag would mean
                // verifying under an algorithm the device did not claim to use.
                if signature.signature_standard != pb::SignatureStandard::EcdsaSha256 as i32 {
                    return Err(Status::invalid_argument(
                        "device attestation signature is not tagged ECDSA_SHA256",
                    ));
                }
                crate::enrollment::verify_attestation_signature(
                    &certificate,
                    Some(&csr.csr),
                    &signature.signature,
                )?;
            }
            // `self.require_attestation`, for the reason spelled out in
            // `check_attestation`: this handler read the env var directly and
            // never touched the resolved field at all, so the one RPC that mints
            // a DeviceUser certificate decided its attestation requirement by a
            // different rule than every other RPC in this service.
            None if self.require_attestation => {
                return Err(Status::unauthenticated(
                    "the edge did not forward a device-attestation certificate to verify against",
                ));
            }
            None => tracing::debug!(
                "accepting a binding attestation unverified: no {XFCC_HEADER} Cert= element"
            ),
        }

        // The account is resolved from the edge-authenticated device id — the same
        // id the login routed to — so the DUC's `U:<account>` is the account whose
        // credential the ceremony authenticated, never a value the binding request
        // could redirect.
        let account = enrollment.account_for_device(Some(&device_id)).await?;
        let (leaf_der, ca_der) = enrollment.issue_duc(&device_id, &account, &csr.csr)?;

        // Note the successful binding for the operator console. Purely
        // observational — never gates issuance — so a lock mishap must not fail a
        // ceremony that has already produced a certificate.
        crate::enrollment::record_binding(&device_id, &account);

        // Seal the leaf back to the device under the session key.
        let (iv, payload) = Enrollment::seal_h4(&session_key, &leaf_der);

        Ok(Response::new(
            pb::EncryptedCreateDeviceUserBindingResponse {
                device_user_certificate: Some(pb::EncryptedPayload {
                    payload,
                    iv: iv.to_vec(),
                }),
                ca_chain: Some(pb::Chain {
                    cert: vec![pb::Certificate {
                        format: pb::CertificateFormat::X509 as i32,
                        encoding: pb::CertificateEncoding::Der as i32,
                        certificate: ca_der,
                    }],
                }),
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    /// REGRESSION (falsifiability): the attestation wiring was previously
    /// exercised only by unit-testing its helpers in isolation, so the whole
    /// `check_attestation` branch could be reverted to `Ok(())` without a single
    /// red test. This drives it through a REAL RPC instead.
    ///
    /// `COSMOS_REQUIRE_DEVICE_ATTESTATION` must refuse an always-signed RPC that
    /// arrives with no signature — the bypass-by-omission case, which is what an
    /// attacker would actually send.
    #[tokio::test]
    async fn required_attestation_refuses_an_always_signed_rpc_with_no_signature() {
        // A CONFIGURED deployment: an unconfigured one answers UNIMPLEMENTED
        // before any attestation decision is made, so it would not exercise the
        // branch under test.
        let service = Provisioning::with_attestation_requirement(
            Some(Arc::new(crate::enrollment::tests::configured_enrollment())),
            true,
        );
        let denied = service
            .create_login_init(Request::new(pb::CreateLoginInitRequest {
                // The field a real device always populates, deliberately omitted.
                device_id_verification_signature: None,
                ..Default::default()
            }))
            .await;

        let status = match denied {
            Err(status) => status,
            Ok(_) => panic!(
                "an always-signed RPC with no signature must be refused when \
                 attestation is required — otherwise the requirement is bypassed \
                 by simply omitting the field"
            ),
        };
        assert_eq!(status.code(), tonic::Code::Unauthenticated);

        // ...and with the requirement OFF the same call is not refused, so the
        // assertion above pins the switch rather than an unrelated failure.
        //
        // The requirement is injected, not read from process-global env, so this
        // cannot race a concurrent test.
        let permissive = Provisioning::with_attestation_requirement(
            Some(Arc::new(crate::enrollment::tests::configured_enrollment())),
            false,
        );
        let permitted = permissive
            .create_login_init(Request::new(pb::CreateLoginInitRequest {
                device_id_verification_signature: None,
                ..Default::default()
            }))
            .await;
        if let Err(status) = permitted {
            assert_ne!(
                status.code(),
                tonic::Code::Unauthenticated,
                "attestation must not refuse when it is not required"
            );
        }
    }

    /// REGRESSION (falsifiability, the other half): the "signature present, but
    /// the edge forwarded no `Cert=` element to check it against" refusal read
    /// `COSMOS_REQUIRE_DEVICE_ATTESTATION` out of the process environment instead
    /// of the flag the constructor resolved. A service built as REQUIRED did not
    /// enforce it, and — worse — the branch was unreachable from the injection
    /// seam, so deleting or inverting it broke no test. This drives it through a
    /// real RPC with the requirement injected, exactly as the sibling test above
    /// does for the omitted-signature case.
    #[tokio::test]
    async fn required_attestation_refuses_a_signature_the_edge_gave_us_nothing_to_verify() {
        let signed = || pb::CreateLoginInitRequest {
            // Present, non-empty — so the omitted-signature arm above is NOT what
            // decides this call. No `x-forwarded-client-cert` metadata is set, so
            // there is no certificate to verify it against.
            device_id_verification_signature: Some(pb::VerificationSignature {
                signature: vec![0x30, 0x44, 0x02, 0x20],
                ..Default::default()
            }),
            ..Default::default()
        };

        let service = Provisioning::with_attestation_requirement(
            Some(Arc::new(crate::enrollment::tests::configured_enrollment())),
            true,
        );
        let status = service
            .create_login_init(Request::new(signed()))
            .await
            .expect_err(
                "a required attestation with nothing to verify it against must be \
                 refused; accepting it means the requirement is satisfied by the \
                 edge simply not forwarding the certificate",
            );
        assert_eq!(status.code(), tonic::Code::Unauthenticated);

        // With the requirement OFF the same call is not refused there, so the
        // assertion above pins the switch and not some unrelated failure.
        let permissive = Provisioning::with_attestation_requirement(
            Some(Arc::new(crate::enrollment::tests::configured_enrollment())),
            false,
        );
        if let Err(status) = permissive.create_login_init(Request::new(signed())).await {
            assert_ne!(
                status.code(),
                tonic::Code::Unauthenticated,
                "attestation must not refuse when it is not required"
            );
        }
    }

    use super::*;

    #[tokio::test]
    async fn subscription_status_returns_configured_active_state() {
        let svc =
            Provisioning::with_store(None, crate::enrollment::MemoryEnrollmentStore::shared());
        let sub = svc
            .get_subscription_status(Request::new(pb::GetSubscriptionStatusRequest {}))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            sub.status.unwrap().status_code,
            pb::SubscriptionStatusCode::Active as i32
        );
    }

    #[tokio::test]
    async fn subscription_status_reads_the_paired_accounts_durable_state() {
        let enrollment_store = crate::enrollment::MemoryEnrollmentStore::shared();
        enrollment_store
            .put_device_account("abcd1234", "wearer-a")
            .await
            .expect("device pairing stores");
        let account_store: crate::store::SharedStore =
            Arc::new(crate::store::MemoryStore::default());
        put_subscription_state(
            &account_store,
            "U:wearer-a",
            pb::SubscriptionStatus {
                status_code: pb::SubscriptionStatusCode::Paused as i32,
                message: "Payment update required".to_owned(),
            },
        )
        .await
        .expect("subscription stores");
        let service = Provisioning::with_stores(None, enrollment_store, account_store);
        let mut request = Request::new(pb::GetSubscriptionStatusRequest {});
        request.extensions_mut().insert(
            cosmos_core::AuthenticatedPrincipal::from_edge("V:01:D:abcd1234:P:0001")
                .expect("device principal"),
        );
        let status = service
            .get_subscription_status(request)
            .await
            .expect("subscription reads")
            .into_inner()
            .status
            .expect("subscription status");
        assert_eq!(
            status.status_code,
            pb::SubscriptionStatusCode::Paused as i32
        );
        assert_eq!(status.message, "Payment update required");
    }

    /// Without a configured DeviceUser CA the ceremony is honestly refused, and
    /// the bypass gate says so up front instead of stranding the Pin.
    #[tokio::test]
    async fn an_unconfigured_deployment_refuses_enrollment_instead_of_minting_a_ca() {
        let svc =
            Provisioning::with_store(None, crate::enrollment::MemoryEnrollmentStore::shared());

        let bypass = svc
            .verify_hmc_by_pass(Request::new(pb::VerifyHmcByPassRequest {
                device_id_verification_signature: None,
                device_id: String::new(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            bypass.status,
            pb::VerifyHmcByPassResponseCode::Disallowed as i32,
            "a deployment that cannot issue a certificate must not invite a device in"
        );

        let init = svc
            .create_login_init(Request::new(pb::CreateLoginInitRequest {
                login_request: Vec::new(),
                device_id_verification_signature: None,
                device_id: String::new(),
            }))
            .await
            .expect_err("enrollment must be refused");
        assert_eq!(init.code(), tonic::Code::Unimplemented);

        let binding = svc
            .create_device_user_binding(Request::new(pb::EncryptedCreateDeviceUserBindingRequest {
                device_user_credential_csr: None,
                device_attestation_credential_verification_signature: None,
            }))
            .await
            .expect_err("binding must be refused");
        assert_eq!(binding.code(), tonic::Code::Unimplemented);
    }

    #[tokio::test]
    async fn hmc_bypass_opens_enrollment_and_association_uses_the_pairing_directory() {
        let store = crate::enrollment::MemoryEnrollmentStore::shared();
        let svc = Provisioning::with_store(
            Some(Arc::new(crate::enrollment::tests::configured_enrollment())),
            store.clone(),
        );

        // Bypass is Allowed once a CA is configured: the clone admits the device.
        let bypass = svc
            .verify_hmc_by_pass(Request::new(pb::VerifyHmcByPassRequest {
                device_id_verification_signature: None,
                device_id: String::new(),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            bypass.status,
            pb::VerifyHmcByPassResponseCode::Allowed as i32
        );

        let request = |hmc_id: &str| pb::VerifyHmcAssociationRequest {
            hmc_id: hmc_id.to_owned(),
            device_id_verification_signature: None,
            device_id: "device-001".to_owned(),
        };

        let missing = svc
            .verify_hmc_association(Request::new(pb::VerifyHmcAssociationRequest {
                ..request("hmc-account")
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            missing.status,
            pb::HmcAssociationResponseCode::MissingDeviceUserAssociation as i32
        );
        assert!(missing.name_to_display.is_empty());

        store
            .put_device_account("device-001", "hmc-account")
            .await
            .expect("pairing is stored");

        let mismatch = svc
            .verify_hmc_association(Request::new(request("another-account")))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            mismatch.status,
            pb::HmcAssociationResponseCode::Failure as i32
        );

        let associated = svc
            .verify_hmc_association(Request::new(request("hmc-account")))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            associated.status,
            pb::HmcAssociationResponseCode::Success as i32
        );
        assert!(!associated.name_to_display.is_empty());
    }

    /// A caller the edge did not name as a device gets no certificate: there is no
    /// honest device id to write into one.
    #[tokio::test]
    async fn a_caller_that_is_not_a_device_subject_gets_no_certificate() {
        let svc = Provisioning::with_store(
            Some(Arc::new(crate::enrollment::tests::configured_enrollment())),
            crate::enrollment::MemoryEnrollmentStore::shared(),
        );
        let error = svc
            .create_device_user_binding(Request::new(pb::EncryptedCreateDeviceUserBindingRequest {
                device_user_credential_csr: None,
                device_attestation_credential_verification_signature: None,
            }))
            .await
            .expect_err("an unnamed caller must be refused");
        assert_eq!(error.code(), tonic::Code::PermissionDenied);
    }

    /// A `CreateLoginFinish` with no in-flight login must be a gRPC `UNAVAILABLE`,
    /// not `OK` with an empty `user_id` — the latter is the silent dead end the
    /// decompiled client cannot act on.
    #[tokio::test]
    async fn a_lost_login_is_reported_as_the_one_error_the_device_can_act_on() {
        use cosmos_core::AuthenticatedPrincipal;

        let svc = Provisioning::with_store(
            Some(Arc::new(crate::enrollment::tests::configured_enrollment())),
            crate::enrollment::MemoryEnrollmentStore::shared(),
        );
        let mut request = Request::new(pb::CreateLoginFinishRequest {
            login_finish_request: vec![0u8; 64],
            device_id_verification_signature: None,
            device_id: String::new(),
        });
        request.extensions_mut().insert(
            AuthenticatedPrincipal::from_edge(crate::enrollment::tests::TEST_PRINCIPAL)
                .expect("valid principal"),
        );

        let error = svc
            .create_login_finish(request)
            .await
            .expect_err("a finish with no in-flight login must be an error");
        assert_eq!(
            error.code(),
            tonic::Code::Unavailable,
            "only UNAVAILABLE reaches ProvisioningAccessManager.onNetworkError()"
        );
    }

    /// The XFCC `Cert=` element is what makes attestation verification possible at
    /// all; parsing it is the difference between verifying and deliberately
    /// accepting.
    #[test]
    fn a_forwarded_certificate_is_recovered_from_the_xfcc_header() {
        let key = rcgen::KeyPair::generate().expect("key");
        let params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        let certificate = params.self_signed(&key).expect("self-signed");
        let pem = certificate.pem();
        let encoded: String = pem
            .bytes()
            .map(|byte| match byte {
                b'\n' => "%0A".to_owned(),
                b' ' => "%20".to_owned(),
                other => (other as char).to_string(),
            })
            .collect();

        let mut request = Request::new(());
        request.metadata_mut().insert(
            XFCC_HEADER,
            format!("By=spiffe://x;Hash=abc;Cert=\"{encoded}\";Subject=\"CN=y\"")
                .parse()
                .expect("header value"),
        );
        assert_eq!(
            forwarded_attestation_certificate(&request).as_deref(),
            Some(certificate.der().as_ref()),
            "the forwarded certificate must round-trip out of XFCC"
        );

        // Without the element there is nothing to verify against.
        let mut bare = Request::new(());
        bare.metadata_mut().insert(
            XFCC_HEADER,
            "Hash=abc;Subject=\"CN=y\"".parse().expect("header value"),
        );
        assert!(forwarded_attestation_certificate(&bare).is_none());
    }
}
