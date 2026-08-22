//! Independently authored shared types for the Cosmos-compatible workloads.
//!
//! These types describe this project's implementation choices. They are not
//! copied from, or claims about, Humane's private server implementation.

pub mod registry;

use std::{fmt, str::FromStr};

/// A separately deployable workload exposed through the compatibility edge.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Workload {
    Connectivity,
    AiBus,
    Account,
    Contacts,
    FeatureFlags,
    NotableEvents,
    Provisioning,
}

impl Workload {
    pub const ALL: [Self; 7] = [
        Self::Connectivity,
        Self::AiBus,
        Self::Account,
        Self::Contacts,
        Self::FeatureFlags,
        Self::NotableEvents,
        Self::Provisioning,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Connectivity => "connectivity",
            Self::AiBus => "ai-bus",
            Self::Account => "account",
            Self::Contacts => "contacts",
            Self::FeatureFlags => "feature-flags",
            Self::NotableEvents => "notable-events",
            Self::Provisioning => "provisioning",
        }
    }
}

impl fmt::Display for Workload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Workload {
    type Err = IdentityError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|workload| workload.as_str() == value)
            .ok_or_else(|| IdentityError::UnknownWorkload(value.to_owned()))
    }
}

/// Deployment boundary used by this clone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeploymentEnvironment {
    Development,
    Test,
    Parity,
    Production,
}

impl DeploymentEnvironment {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Test => "test",
            Self::Parity => "parity",
            Self::Production => "production",
        }
    }
}

impl fmt::Display for DeploymentEnvironment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for DeploymentEnvironment {
    type Err = IdentityError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "development" => Ok(Self::Development),
            "test" => Ok(Self::Test),
            "parity" => Ok(Self::Parity),
            "production" => Ok(Self::Production),
            _ => Err(IdentityError::UnknownEnvironment(value.to_owned())),
        }
    }
}

/// Content-free server topology metadata for the compatibility edge.
///
/// Its shape follows the observed `environment:region:workload-revision-pod`
/// response metadata, while every value is independently configured by this
/// implementation. It must never contain a caller identity or request content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServicePath(String);

impl ServicePath {
    pub fn new(
        environment: DeploymentEnvironment,
        region: impl AsRef<str>,
        workload: Workload,
        revision: impl AsRef<str>,
        pod: impl AsRef<str>,
    ) -> Result<Self, ServicePathError> {
        let region = validated_topology_token("region", region.as_ref(), 32)?;
        let revision = validated_topology_token("revision", revision.as_ref(), 63)?;
        let pod = validated_topology_token("pod", pod.as_ref(), 63)?;
        Ok(Self(format!(
            "{environment}:{region}:{workload}-{revision}-{pod}"
        )))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Builds the observed route shape from a Kubernetes pod name. A normal
    /// Deployment pod already has `<workload>-<replicaset>-<suffix>` form, so
    /// adding the workload or revision again would produce a wire-visible
    /// duplicate.
    pub fn from_pod_name(
        environment: DeploymentEnvironment,
        region: impl AsRef<str>,
        workload: Workload,
        pod_name: impl AsRef<str>,
    ) -> Result<Self, ServicePathError> {
        let region = validated_topology_token("region", region.as_ref(), 32)?;
        let pod_name = validated_topology_token("pod name", pod_name.as_ref(), 253)?;
        let prefix = format!("{workload}-");
        let remainder = pod_name
            .strip_prefix(&prefix)
            .ok_or(ServicePathError::UnexpectedPodName { workload })?;
        if !remainder.contains('-') {
            return Err(ServicePathError::UnexpectedPodName { workload });
        }
        Ok(Self(format!("{environment}:{region}:{pod_name}")))
    }
}

fn validated_topology_token<'a>(
    field: &'static str,
    value: &'a str,
    maximum: usize,
) -> Result<&'a str, ServicePathError> {
    if value.is_empty() || value.len() > maximum {
        return Err(ServicePathError::InvalidLength {
            field,
            maximum,
            actual: value.len(),
        });
    }
    let is_valid = value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-');
    if !is_valid {
        return Err(ServicePathError::InvalidCharacters { field });
    }
    Ok(value)
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum ServicePathError {
    #[error("{field} must contain between 1 and {maximum} bytes; got {actual}")]
    InvalidLength {
        field: &'static str,
        maximum: usize,
        actual: usize,
    },
    #[error("{field} contains unsupported characters")]
    InvalidCharacters { field: &'static str },
    #[error("pod name does not match the {workload} Deployment shape")]
    UnexpectedPodName { workload: Workload },
}

/// A bounded, non-secret identity for a server workload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkloadIdentity {
    workload: Workload,
    environment: DeploymentEnvironment,
    instance: Identifier,
    trust_domain: TrustDomain,
}

impl WorkloadIdentity {
    pub fn new(
        workload: Workload,
        environment: DeploymentEnvironment,
        instance: impl Into<String>,
        trust_domain: impl Into<String>,
    ) -> Result<Self, IdentityError> {
        Ok(Self {
            workload,
            environment,
            instance: Identifier::new("instance", instance.into(), 63)?,
            trust_domain: TrustDomain::new(trust_domain.into())?,
        })
    }

    pub const fn workload(&self) -> Workload {
        self.workload
    }

    pub const fn environment(&self) -> DeploymentEnvironment {
        self.environment
    }

    pub fn instance(&self) -> &str {
        self.instance.as_str()
    }

    pub fn trust_domain(&self) -> &str {
        self.trust_domain.as_str()
    }

    /// Returns this clone's workload identity URI. This is an implementation
    /// convention, not an observed Humane URI shape.
    pub fn uri(&self) -> String {
        format!(
            "spiffe://{}/env/{}/workload/{}/instance/{}",
            self.trust_domain, self.environment, self.workload, self.instance
        )
    }
}

/// An opaque caller principal established by the authenticated edge.
///
/// The value is intentionally omitted from `Debug` output and has no `Display`
/// implementation so routine structured logs cannot expose it accidentally.
#[derive(Clone, Eq, Hash, PartialEq)]
pub struct AuthenticatedPrincipal(Identifier);

impl AuthenticatedPrincipal {
    /// Accept the principal the trusted edge established from the client
    /// certificate's Subject CN.
    ///
    /// cosmos's DeviceUser CNs are structured and **colon-delimited** —
    /// `V:01:D:<device>:U:<user>` — so a principal charset without `:` rejects
    /// every real Pin, on every RPC, with UNAUTHENTICATED. `:` is therefore
    /// permitted here and *only* here; the workload `instance` identifier stays
    /// strict because `ServicePath` uses `:` as its own separator.
    ///
    /// This stays a fail-closed gate: the value is still length-bounded and still
    /// rejects control characters, whitespace, quotes, and separators that could
    /// confuse metadata or log parsing downstream.
    pub fn from_edge(value: impl Into<String>) -> Result<Self, IdentityError> {
        Identifier::with_charset(
            "authenticated principal",
            value.into(),
            128,
            is_principal_byte,
        )
        .map(Self)
    }

    /// The principal for an authenticated ACCOUNT user, from either front door.
    ///
    /// This is the identity bridge. A web login (Keycloak `sub`) and a device's
    /// enrolled DeviceUser certificate (`…:U:<user>`) must resolve to the SAME
    /// principal for a person to see the same data from their browser and their
    /// Pin — so both derive it here, from the user id alone, never from the
    /// device or the session. Keyed by user, not by device: one person's data is
    /// one partition, shared across their devices and their web session.
    ///
    /// Namespaced `U:<user>` so it can never collide with a raw device CN
    /// (`V:01:D:…`), and still passes the same fail-closed charset gate.
    pub fn for_user(user_id: &str) -> Result<Self, IdentityError> {
        Self::from_edge(format!("U:{user_id}"))
    }

    /// Resolve the principal for a device from the DeviceUser certificate CN the
    /// edge authenticated (`V:01:D:<device>:U:<user>`).
    ///
    /// This is the device half of the identity bridge. The account is the
    /// **user**, not the device: a person's Pin resolves to the SAME `U:<user>`
    /// principal their web login does (see [`for_user`]), so both front doors
    /// read one partition. The `<user>` segment is minted server-side at binding
    /// (`Enrollment::issue_duc`) and never taken from the client, so trusting it
    /// here is trusting the edge that already verified the certificate.
    ///
    /// A subject that is not the structured DeviceUser form — a service identity,
    /// a synthetic dev principal — names no user, and falls through to the raw
    /// edge principal unchanged. Extraction is therefore additive: it collapses a
    /// real Pin onto its user and leaves everything else exactly as before.
    ///
    /// [`for_user`]: AuthenticatedPrincipal::for_user
    pub fn from_device_cn(cn: &str) -> Result<Self, IdentityError> {
        match device_user_segment(cn) {
            Some(user) => Self::for_user(user),
            None => Self::from_edge(cn),
        }
    }

    pub fn expose_for_authorization(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for AuthenticatedPrincipal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuthenticatedPrincipal([REDACTED])")
    }
}

/// Wrapper for data which must never be emitted by routine `Debug` logging.
#[derive(Clone, Eq, PartialEq)]
pub struct Sensitive<T>(T);

impl<T> Sensitive<T> {
    pub const fn new(value: T) -> Self {
        Self(value)
    }

    pub const fn expose_for_processing(&self) -> &T {
        &self.0
    }
}

impl<T> fmt::Debug for Sensitive<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct Identifier(String);

impl Identifier {
    fn new(field: &'static str, value: String, maximum: usize) -> Result<Self, IdentityError> {
        Self::with_charset(field, value, maximum, is_identity_byte)
    }

    fn with_charset(
        field: &'static str,
        value: String,
        maximum: usize,
        permitted: fn(u8) -> bool,
    ) -> Result<Self, IdentityError> {
        if value.is_empty() || value.len() > maximum {
            return Err(IdentityError::InvalidLength {
                field,
                maximum,
                actual: value.len(),
            });
        }
        if !value.bytes().all(permitted) {
            return Err(IdentityError::InvalidCharacters { field });
        }
        Ok(Self(value))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Identifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Display for Identifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TrustDomain(String);

impl TrustDomain {
    fn new(value: String) -> Result<Self, IdentityError> {
        if value.is_empty() || value.len() > 253 {
            return Err(IdentityError::InvalidLength {
                field: "trust domain",
                maximum: 253,
                actual: value.len(),
            });
        }

        let labels_are_valid = value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
        if !labels_are_valid {
            return Err(IdentityError::InvalidCharacters {
                field: "trust domain",
            });
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TrustDomain {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

const fn is_identity_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
}

/// Charset for an edge-established principal: the strict identity set plus `:`,
/// the delimiter in cosmos's structured DeviceUser CN (`V:01:D:<dev>:U:<user>`).
const fn is_principal_byte(byte: u8) -> bool {
    is_identity_byte(byte) || byte == b':'
}

/// Extract the user id from a DeviceUser CN (`V:01:D:<device>:U:<user>`).
///
/// The user is the single flat field after the `:U:` tag. A real CN carries the
/// tag exactly once — the device id is hex-only
/// (`enrollment::device_id_from_subject`) and the user id is a UUID, so neither
/// contains it. Requiring exactly one occurrence, and a user field with no
/// residual `:`, means any subject with extra structure resolves to `None`
/// rather than to a forged segment. A CN with no `:U:` (a service or dev
/// subject) is `None`.
fn device_user_segment(cn: &str) -> Option<&str> {
    let mut tags = cn.match_indices(":U:");
    let (index, tag) = tags.next()?;
    if tags.next().is_some() {
        return None;
    }
    let user = &cn[index + tag.len()..];
    (!user.is_empty() && !user.contains(':')).then_some(user)
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum IdentityError {
    #[error("unknown workload `{0}`")]
    UnknownWorkload(String),
    #[error("unknown deployment environment `{0}`")]
    UnknownEnvironment(String),
    #[error("{field} must contain between 1 and {maximum} bytes; got {actual}")]
    InvalidLength {
        field: &'static str,
        maximum: usize,
        actual: usize,
    },
    #[error("{field} contains unsupported characters")]
    InvalidCharacters { field: &'static str },
}

#[cfg(test)]
mod tests {
    /// REGRESSION: cosmos's DeviceUser CN is colon-delimited. A principal charset
    /// without `:` rejects every real Pin on every RPC with UNAUTHENTICATED.
    #[test]
    fn a_real_device_user_cn_is_accepted() {
        let cn = "V:01:D:0123456789abcdef:U:fedcba9876543210";
        let principal = AuthenticatedPrincipal::from_edge(cn).expect("real CN must authenticate");
        assert_eq!(principal.expose_for_authorization(), cn);
    }

    /// The identity bridge: a device's CN and that user's web login must resolve
    /// to the SAME principal, or a person cannot see their Pin from the browser.
    #[test]
    fn a_device_cn_and_a_web_login_for_one_user_share_a_principal() {
        use super::AuthenticatedPrincipal;
        let user = "fedcba9876543210";
        let from_pin =
            AuthenticatedPrincipal::from_device_cn(&format!("V:01:D:0123456789abcdef:U:{user}"))
                .expect("a real DeviceUser CN resolves");
        let from_web = AuthenticatedPrincipal::for_user(user).expect("a web sub resolves");
        assert_eq!(
            from_pin.expose_for_authorization(),
            from_web.expose_for_authorization(),
            "Pin and web must key the same partition"
        );
        assert_eq!(from_pin.expose_for_authorization(), "U:fedcba9876543210");
    }

    /// Two devices of the SAME user collapse onto one partition; two users never
    /// collide.
    #[test]
    fn device_principals_key_by_user_not_by_device() {
        use super::AuthenticatedPrincipal;
        let expose = |cn: &str| {
            AuthenticatedPrincipal::from_device_cn(cn)
                .expect("valid CN")
                .expose_for_authorization()
                .to_owned()
        };
        assert_eq!(
            expose("V:01:D:aaaa:U:alice"),
            expose("V:01:D:bbbb:U:alice"),
            "one user's two Pins share a partition"
        );
        assert_ne!(
            expose("V:01:D:aaaa:U:alice"),
            expose("V:01:D:aaaa:U:bob"),
            "two users never share a partition"
        );
    }

    /// A subject that is not a DeviceUser CN names no user and passes through
    /// unchanged — the change is additive, never a silent reinterpretation.
    #[test]
    fn a_non_device_subject_passes_through_unchanged() {
        use super::AuthenticatedPrincipal;
        for subject in ["development-insecure-principal", "some-service-identity"] {
            assert_eq!(
                AuthenticatedPrincipal::from_device_cn(subject)
                    .expect("passes through")
                    .expose_for_authorization(),
                subject,
            );
        }
    }

    /// A malformed `U:` field (empty, or containing extra structure) must not
    /// resolve to a forged user — it falls back to the whole subject, still
    /// fail-closed on the charset gate.
    #[test]
    fn a_malformed_user_segment_does_not_forge_a_principal() {
        use super::device_user_segment;
        assert_eq!(device_user_segment("V:01:D:dev:U:alice"), Some("alice"));
        assert_eq!(device_user_segment("V:01:D:dev:U:"), None);
        assert_eq!(device_user_segment("V:01:D:dev:U:a:U:b"), None);
        assert_eq!(device_user_segment("no-tag-here"), None);
    }

    /// The gate must not have loosened beyond that one delimiter.
    #[test]
    fn the_principal_gate_still_fails_closed_on_hostile_values() {
        for hostile in [
            "",                      // empty
            "principal with spaces", // whitespace
            "line\ninjection",       // log/metadata injection
            "quote\"injection",      // quoting
            "semi;colon",            // separator confusion
            "tab\there",
            "unicode\u{202e}override",
        ] {
            assert!(
                AuthenticatedPrincipal::from_edge(hostile).is_err(),
                "must reject {hostile:?}"
            );
        }
        // Still length-bounded.
        assert!(AuthenticatedPrincipal::from_edge("a".repeat(129)).is_err());
        assert!(AuthenticatedPrincipal::from_edge("a".repeat(128)).is_ok());
    }

    /// Colons are permitted for the principal ONLY. The workload instance feeds
    /// `ServicePath`, which uses `:` as its own separator, so allowing them there
    /// would let an instance value forge extra path segments.
    #[test]
    fn colons_remain_rejected_in_the_workload_instance() {
        assert!(
            WorkloadIdentity::new(
                Workload::AiBus,
                DeploymentEnvironment::Development,
                "pod:evil",
                "carry.local",
            )
            .is_err(),
            "instance must stay strict"
        );
    }

    use super::*;

    #[test]
    fn parses_only_declared_workloads() {
        assert_eq!("ai-bus".parse(), Ok(Workload::AiBus));
        assert_eq!("connectivity".parse(), Ok(Workload::Connectivity));
        assert!(matches!(
            "unknown".parse::<Workload>(),
            Err(IdentityError::UnknownWorkload(_))
        ));
    }

    #[test]
    fn workload_identity_is_bounded_and_canonical() {
        let identity = WorkloadIdentity::new(
            Workload::FeatureFlags,
            DeploymentEnvironment::Parity,
            "flags-01",
            "Cosmos.Local",
        )
        .expect("valid identity");

        assert_eq!(identity.trust_domain(), "carry.local");
        assert_eq!(
            identity.uri(),
            "spiffe://carry.local/env/parity/workload/feature-flags/instance/flags-01"
        );
        assert!(
            WorkloadIdentity::new(
                Workload::AiBus,
                DeploymentEnvironment::Development,
                "contains/a/slash",
                "carry.local"
            )
            .is_err()
        );
    }

    #[test]
    fn service_path_contains_only_bounded_topology_tokens() {
        let path = ServicePath::new(
            DeploymentEnvironment::Parity,
            "eastus",
            Workload::AiBus,
            "r42",
            "7c9d8f",
        )
        .expect("valid service path");
        assert_eq!(path.as_str(), "parity:eastus:ai-bus-r42-7c9d8f");

        assert!(matches!(
            ServicePath::new(
                DeploymentEnvironment::Parity,
                "eastus:wearer",
                Workload::AiBus,
                "r42",
                "7c9d8f"
            ),
            Err(ServicePathError::InvalidCharacters { field: "region" })
        ));

        let kubernetes_path = ServicePath::from_pod_name(
            DeploymentEnvironment::Parity,
            "eastus",
            Workload::AiBus,
            "ai-bus-66c5495f44-abcde",
        )
        .expect("valid deployment pod name");
        assert_eq!(
            kubernetes_path.as_str(),
            "parity:eastus:ai-bus-66c5495f44-abcde"
        );
        assert!(matches!(
            ServicePath::from_pod_name(
                DeploymentEnvironment::Parity,
                "eastus",
                Workload::Account,
                "ai-bus-66c5495f44-abcde"
            ),
            Err(ServicePathError::UnexpectedPodName {
                workload: Workload::Account
            })
        ));
    }

    #[test]
    fn sensitive_values_are_redacted_from_debug_output() {
        let secret = Sensitive::new("wearer transcript");
        let principal = AuthenticatedPrincipal::from_edge("synthetic-principal-01")
            .expect("valid synthetic edge principal");

        assert_eq!(format!("{secret:?}"), "[REDACTED]");
        assert_eq!(
            format!("{principal:?}"),
            "AuthenticatedPrincipal([REDACTED])"
        );
    }
}
