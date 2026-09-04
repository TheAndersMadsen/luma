use std::{collections::HashMap, net::SocketAddr, str::FromStr, time::Duration};

use cosmos_core::{
    AuthenticatedDeviceIdentity, AuthenticatedPrincipal, DeploymentEnvironment, IdentityError,
    ServicePath, ServicePathError, WorkloadIdentity,
};
use tonic::Request;

const DEFAULT_MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MIN_MESSAGE_BYTES: usize = 1024;
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MIN_REQUEST_TIMEOUT_MS: u64 = 100;
const MAX_REQUEST_TIMEOUT_MS: u64 = 120_000;
const MIN_SHUTDOWN_GRACE_MS: u64 = 100;
const MAX_SHUTDOWN_GRACE_MS: u64 = 60_000;
const DEFAULT_GRPC_MAX_CONCURRENT_STREAMS: u32 = 64;
const MAX_GRPC_MAX_CONCURRENT_STREAMS: u32 = 1_024;
const DEFAULT_HTTP2_KEEPALIVE_INTERVAL_MS: u64 = 30_000;
const MIN_HTTP2_KEEPALIVE_INTERVAL_MS: u64 = 10_000;
const MAX_HTTP2_KEEPALIVE_INTERVAL_MS: u64 = 300_000;
const DEFAULT_HTTP2_KEEPALIVE_TIMEOUT_MS: u64 = 10_000;
const MIN_HTTP2_KEEPALIVE_TIMEOUT_MS: u64 = 1_000;
const MAX_HTTP2_KEEPALIVE_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_HTTP2_MAX_HEADER_LIST_BYTES: u32 = 16 * 1024;
const MIN_HTTP2_MAX_HEADER_LIST_BYTES: u32 = 1024;
const MAX_HTTP2_MAX_HEADER_LIST_BYTES: u32 = 64 * 1024;
const DEFAULT_HTTP2_MAX_PENDING_RESET_STREAMS: usize = 20;
const MAX_HTTP2_MAX_PENDING_RESET_STREAMS: usize = 256;

#[derive(Clone)]
pub struct Config {
    pub identity: WorkloadIdentity,
    pub grpc_bind: SocketAddr,
    pub http_bind: SocketAddr,
    pub auth: Authentication,
    pub service_path: ServicePath,
    pub limits: Limits,
    pub log_level: LogLevel,
    /// Raw explicit AI-bus kid-scope mode. The serving path validates it only
    /// for the workload that owns PublicPrivacy, before binding listeners.
    pub kid_scope: Option<String>,
    /// Captured once so startup policy cannot validate one environment view and
    /// later connect using another.
    pub database_url: Option<String>,
    /// Durable wrapping-key directory, likewise captured with the config.
    pub state_dir: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let values = std::env::vars().collect::<HashMap<_, _>>();
        Self::from_map(&values)
    }

    pub fn from_map(values: &HashMap<String, String>) -> Result<Self, ConfigError> {
        let workload = parse(values, "COSMOS_WORKLOAD", "ai-bus")?;
        let environment = parse(values, "COSMOS_ENVIRONMENT", "development")?;
        let instance = values
            .get("COSMOS_INSTANCE_ID")
            .or_else(|| values.get("COSMOS_POD_NAME"))
            .cloned()
            .unwrap_or_else(|| "local-1".to_owned());
        let identity = WorkloadIdentity::new(
            workload,
            environment,
            instance,
            get(values, "COSMOS_TRUST_DOMAIN", "cosmos.local"),
        )?;

        let grpc_bind: SocketAddr = parse(values, "COSMOS_GRPC_BIND", "127.0.0.1:50051")?;
        let http_bind: SocketAddr = parse(values, "COSMOS_HTTP_BIND", "127.0.0.1:8080")?;
        let auth_mode = parse(values, "COSMOS_AUTH_MODE", "edge-authenticated")?;
        let auth = match auth_mode {
            AuthenticationMode::EdgeAuthenticated => {
                Authentication::EdgeAuthenticated(EdgeAuthentication {
                    principal_metadata_key: edge_metadata_key(values)?,
                    edge_token: configured_edge_token(),
                })
            }
            AuthenticationMode::DevelopmentInsecure => {
                if !grpc_bind.ip().is_loopback() || !http_bind.ip().is_loopback() {
                    return Err(ConfigError::InsecureNonLoopback);
                }
                if environment != DeploymentEnvironment::Development
                    && environment != DeploymentEnvironment::Test
                {
                    return Err(ConfigError::InsecureEnvironment(environment));
                }
                Authentication::DevelopmentInsecure
            }
        };
        let region = get(values, "COSMOS_REGION", "eastus");
        let revision = get(values, "COSMOS_REVISION", "local");
        let service_path = service_path(
            values.get("COSMOS_POD_NAME").map(String::as_str),
            environment,
            &region,
            workload,
            &revision,
        )?;

        let limits = Limits {
            max_decode_bytes: bounded_usize(
                values,
                "COSMOS_MAX_DECODE_BYTES",
                DEFAULT_MAX_MESSAGE_BYTES,
                MIN_MESSAGE_BYTES,
                MAX_MESSAGE_BYTES,
            )?,
            max_encode_bytes: bounded_usize(
                values,
                "COSMOS_MAX_ENCODE_BYTES",
                DEFAULT_MAX_MESSAGE_BYTES,
                MIN_MESSAGE_BYTES,
                MAX_MESSAGE_BYTES,
            )?,
            request_timeout: Duration::from_millis(bounded_u64(
                values,
                "COSMOS_REQUEST_TIMEOUT_MS",
                15_000,
                MIN_REQUEST_TIMEOUT_MS,
                MAX_REQUEST_TIMEOUT_MS,
            )?),
            shutdown_grace: Duration::from_millis(bounded_u64(
                values,
                "COSMOS_SHUTDOWN_GRACE_MS",
                5_000,
                MIN_SHUTDOWN_GRACE_MS,
                MAX_SHUTDOWN_GRACE_MS,
            )?),
            grpc_max_concurrent_streams: bounded_u32(
                values,
                "COSMOS_GRPC_MAX_CONCURRENT_STREAMS",
                DEFAULT_GRPC_MAX_CONCURRENT_STREAMS,
                1,
                MAX_GRPC_MAX_CONCURRENT_STREAMS,
            )?,
            http2_keepalive_interval: Duration::from_millis(bounded_u64(
                values,
                "COSMOS_HTTP2_KEEPALIVE_INTERVAL_MS",
                DEFAULT_HTTP2_KEEPALIVE_INTERVAL_MS,
                MIN_HTTP2_KEEPALIVE_INTERVAL_MS,
                MAX_HTTP2_KEEPALIVE_INTERVAL_MS,
            )?),
            http2_keepalive_timeout: Duration::from_millis(bounded_u64(
                values,
                "COSMOS_HTTP2_KEEPALIVE_TIMEOUT_MS",
                DEFAULT_HTTP2_KEEPALIVE_TIMEOUT_MS,
                MIN_HTTP2_KEEPALIVE_TIMEOUT_MS,
                MAX_HTTP2_KEEPALIVE_TIMEOUT_MS,
            )?),
            http2_max_header_list_bytes: bounded_u32(
                values,
                "COSMOS_HTTP2_MAX_HEADER_LIST_BYTES",
                DEFAULT_HTTP2_MAX_HEADER_LIST_BYTES,
                MIN_HTTP2_MAX_HEADER_LIST_BYTES,
                MAX_HTTP2_MAX_HEADER_LIST_BYTES,
            )?,
            http2_max_pending_reset_streams: bounded_usize(
                values,
                "COSMOS_HTTP2_MAX_PENDING_RESET_STREAMS",
                DEFAULT_HTTP2_MAX_PENDING_RESET_STREAMS,
                1,
                MAX_HTTP2_MAX_PENDING_RESET_STREAMS,
            )?,
        };
        if limits.http2_keepalive_timeout > limits.http2_keepalive_interval {
            return Err(ConfigError::KeepaliveTimeoutExceedsInterval);
        }

        Ok(Self {
            identity,
            grpc_bind,
            http_bind,
            auth,
            service_path,
            limits,
            log_level: parse(values, "COSMOS_LOG_LEVEL", "info")?,
            kid_scope: values.get("COSMOS_KID_SCOPE").cloned(),
            database_url: values.get("COSMOS_DATABASE_URL").cloned(),
            state_dir: values.get("COSMOS_STATE_DIR").cloned(),
        })
    }
}

#[derive(Clone)]
pub enum Authentication {
    /// Istio has authenticated the client certificate and replaces this
    /// metadata before forwarding the request to the workload.
    EdgeAuthenticated(EdgeAuthentication),
    DevelopmentInsecure,
}

impl Authentication {
    pub const fn label(&self) -> &'static str {
        match self {
            Self::EdgeAuthenticated(_) => "edge-authenticated",
            Self::DevelopmentInsecure => "development-insecure",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AuthenticationMode {
    EdgeAuthenticated,
    DevelopmentInsecure,
}

impl FromStr for AuthenticationMode {
    type Err = ConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "edge-authenticated" => Ok(Self::EdgeAuthenticated),
            "development-insecure" => Ok(Self::DevelopmentInsecure),
            _ => Err(ConfigError::InvalidValue {
                name: "COSMOS_AUTH_MODE",
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EdgeAuthentication {
    principal_metadata_key: String,
    /// Shared secret proving a request came through the edge, resolved ONCE at
    /// construction. Read per-request from the environment originally, which was
    /// both a syscall on the hot path and untestable: env vars are process-global
    /// and Rust runs tests in parallel, so a test that set it changed the
    /// behaviour of every other test in flight.
    edge_token: Option<String>,
}

impl EdgeAuthentication {
    pub fn principal_metadata_key(&self) -> &str {
        &self.principal_metadata_key
    }

    /// Resolves the device principal the trusted edge established via mTLS. cosmos
    /// forwards the verified client certificate as `x-forwarded-client-cert`
    /// (XFCC) and the principal is the certificate Subject CN. Missing, binary,
    /// and malformed metadata all fail closed without reflecting the supplied
    /// value into the error or logs.
    pub fn authenticate<T>(
        &self,
        request: &Request<T>,
    ) -> Result<AuthenticatedPrincipal, EdgeAuthenticationError> {
        self.authenticate_with_device(request)
            .map(|authenticated| authenticated.principal)
    }

    /// Retain device identity at the verified edge boundary, before the legacy
    /// account projection discards it. Local/synthetic principal compatibility
    /// remains available but can never establish authenticated device evidence.
    pub(crate) fn authenticate_with_device<T>(
        &self,
        request: &Request<T>,
    ) -> Result<crate::auth::AuthenticatedRequest, EdgeAuthenticationError> {
        // Prove the request came THROUGH the edge before believing the header it
        // carries. `x-forwarded-client-cert` is only meaningful because Envoy
        // sanitizes any client-supplied copy and rewrites it from the verified
        // certificate — a workload reached by any other route is just trusting a
        // string the caller chose.
        //
        // The workloads cannot tell the edge apart by peer address: each runs
        // `socat` forwarding to 127.0.0.1, so every connection looks local. So the
        // edge presents a shared secret instead, injected as a static header the
        // client never sees (Envoy strips inbound copies of it the same way it
        // strips XFCC). Set `COSMOS_EDGE_TOKEN` on both the workload and the edge
        // to require it.
        //
        // Unset means unenforced, which keeps local runs and the test harness
        // working — deliberately, and stated plainly rather than pretending the
        // control is always on. An operator can check with `printenv`.
        if let Some(expected) = self.edge_token.as_deref() {
            let presented = request
                .metadata()
                .get(EDGE_TOKEN_HEADER)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default();
            // Constant-time compare: a byte-by-byte early exit would leak the
            // token's prefix to anyone able to time this call.
            if !constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
                return Err(EdgeAuthenticationError::Missing);
            }
        }
        let raw = request
            .metadata()
            .get(self.principal_metadata_key.as_str())
            .ok_or(EdgeAuthenticationError::Missing)?;
        let value = raw.to_str().map_err(|_| EdgeAuthenticationError::Invalid)?;
        // Derive the principal from the XFCC Subject CN (cosmos's convention);
        // fall back to the raw value for non-XFCC dev / synthetic harnesses.
        let subject = principal_from_xfcc(value);
        let cn = subject.unwrap_or(value);
        // A DeviceUser CN resolves to its *user* (`U:<user>`), the same principal
        // that user's web login resolves to, so Pin and browser share one
        // partition. Non-DeviceUser subjects pass through unchanged.
        let principal = AuthenticatedPrincipal::from_device_cn(cn)
            .map_err(|_| EdgeAuthenticationError::Invalid)?;
        let device = if self
            .edge_token
            .as_deref()
            .is_some_and(|token| !token.is_empty())
            && self.principal_metadata_key == EDGE_PRINCIPAL_HEADER
        {
            subject.and_then(|cn| {
                // The enrollment parser checks every field, version, and hex
                // device shape. Only DeviceUser (U), never attestation (P), is
                // evidence on this runtime boundary. Bound the entire subject
                // too; the compatibility account parser intentionally does not.
                AuthenticatedPrincipal::from_edge(cn).ok()?;
                cn.rsplit_once(":U:")?;
                let device_id = crate::enrollment::device_id_from_subject(cn)?;
                AuthenticatedDeviceIdentity::from_edge(device_id).ok()
            })
        } else {
            None
        };
        Ok(crate::auth::AuthenticatedRequest {
            principal,
            plane: crate::auth::AuthenticationPlane::Device,
            device,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_test_token(token: &str) -> Self {
        Self {
            principal_metadata_key: EDGE_PRINCIPAL_HEADER.to_owned(),
            edge_token: Some(token.to_owned()),
        }
    }
}

/// Header the edge uses to prove a request passed through it.
pub const EDGE_TOKEN_HEADER: &str = "x-cosmos-edge-token";

/// The header the edge injects the verified client certificate in, and the
/// default this deployment reads the principal from. Named here so the HTTP
/// surfaces resolve identity from the SAME header the gRPC front door does —
/// they disagreed once, and a reader looking at the wrong header sees no
/// principal at all and silently falls back to a fixed account.
pub const EDGE_PRINCIPAL_HEADER: &str = "x-forwarded-client-cert";

/// The shared edge secret this deployment enforces, if any.
fn configured_edge_token() -> Option<String> {
    std::env::var("COSMOS_EDGE_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// Length-independent equality. Returns false for a length mismatch without
/// comparing, which leaks only the length — the value is a deployment secret,
/// not wearer data.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Extracts the certificate Subject CN from an Envoy `x-forwarded-client-cert`
/// value (e.g. `Hash=…;Subject="CN=<id>,L=localdev:us-west-2";URI=…`). The CN is
/// the first RDN of the quoted Subject DN.
pub fn principal_from_xfcc(xfcc: &str) -> Option<&str> {
    const MARK: &str = "Subject=\"";
    let after = &xfcc[xfcc.find(MARK)? + MARK.len()..];
    let dn = &after[..after.find('"')?];
    let cn = &dn[dn.find("CN=")? + 3..];
    let cn = cn.split(',').next().unwrap_or(cn).trim();
    (!cn.is_empty()).then_some(cn)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EdgeAuthenticationError {
    #[error("authenticated edge principal required")]
    Missing,
    #[error("invalid authenticated edge principal")]
    Invalid,
}

/// Edge authentication failures are **transport** failures, never account
/// verdicts, so they must not borrow an account status code.
///
/// A DeviceUser that fails mTLS is rejected by the edge and never reaches this
/// process at all. A request that arrives here *without* a principal therefore
/// means the trusted edge was bypassed or is misconfigured — the topology is
/// broken, not the wearer's subscription.
///
/// The distinction is wearer-visible because the stock client maps status codes
/// alone, ignoring message and trailers
/// (`intent/interpreters/RemoteInterpreter.java:91-96`): UNAUTHENTICATED →
/// `Errors.unsubscribed()` → the `InvalidSubscription` experience, and
/// PERMISSION_DENIED → `Errors.deviceBlocked()` → `UnauthorizedDevice`. So an
/// XFCC header dropped anywhere in the mesh would have every Pin behind it
/// narrate "invalid subscription" for a routing bug. Those two codes belong to
/// `services::gates::unsubscribed_status` /
/// `services::gates::unauthorized_device_status`, which also contain the trailer
/// `AccountAuthorizationInterceptor` requires before persisting the verdict.
///
/// UNAVAILABLE is what the client itself emits when its side of the secure
/// channel cannot be prepared (`aibus/AIBusService.java:241`), and it is one of
/// the four codes `RemoteInterpreter` actually maps — an unmapped code is
/// rethrown, swallowed by `InterpreterOrchestrator` (`catch → return null`), and
/// the turn ends in silence.
///
/// This changes only how the refusal is *reported*. The request is still refused,
/// before any storage or model access.
impl From<EdgeAuthenticationError> for tonic::Status {
    fn from(error: EdgeAuthenticationError) -> Self {
        Self::unavailable(error.to_string())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

impl LogLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }
}

impl FromStr for LogLevel {
    type Err = ConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "error" => Ok(Self::Error),
            "warn" => Ok(Self::Warn),
            "info" => Ok(Self::Info),
            "debug" => Ok(Self::Debug),
            _ => Err(ConfigError::InvalidValue {
                name: "COSMOS_LOG_LEVEL",
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub max_decode_bytes: usize,
    pub max_encode_bytes: usize,
    pub request_timeout: Duration,
    pub shutdown_grace: Duration,
    pub grpc_max_concurrent_streams: u32,
    pub http2_keepalive_interval: Duration,
    pub http2_keepalive_timeout: Duration,
    pub http2_max_header_list_bytes: u32,
    pub http2_max_pending_reset_streams: usize,
}

fn service_path(
    pod_name: Option<&str>,
    environment: DeploymentEnvironment,
    region: &str,
    workload: cosmos_core::Workload,
    revision: &str,
) -> Result<ServicePath, ServicePathError> {
    let Some(pod_name) = pod_name else {
        return ServicePath::new(environment, region, workload, revision, "local-1");
    };

    // Validate the full downward-API value before deriving a compact pod
    // component. This prevents a caller-controlled value from being normalized
    // into an apparently trusted topology path.
    ServicePath::from_pod_name(environment, region, workload, pod_name)?;
    let workload_prefix = format!("{workload}-");
    let pod_component = pod_name
        .strip_prefix(&workload_prefix)
        .expect("from_pod_name validated the workload prefix");
    let revision_prefix = format!("{revision}-");
    let pod_component = pod_component
        .strip_prefix(&revision_prefix)
        .unwrap_or(pod_component);

    ServicePath::new(environment, region, workload, revision, pod_component)
}

fn get(values: &HashMap<String, String>, name: &'static str, default: &str) -> String {
    values
        .get(name)
        .cloned()
        .unwrap_or_else(|| default.to_owned())
}

fn parse<T>(
    values: &HashMap<String, String>,
    name: &'static str,
    default: &str,
) -> Result<T, ConfigError>
where
    T: FromStr,
{
    let value = get(values, name, default);
    value
        .parse()
        .map_err(|_| ConfigError::InvalidValue { name, value })
}

fn edge_metadata_key(values: &HashMap<String, String>) -> Result<String, ConfigError> {
    const NAME: &str = "COSMOS_EDGE_PRINCIPAL_METADATA";
    let value = get(values, NAME, "x-forwarded-client-cert");
    let is_valid = (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !is_valid {
        return Err(ConfigError::InvalidValue { name: NAME, value });
    }
    Ok(value)
}

fn bounded_usize(
    values: &HashMap<String, String>,
    name: &'static str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize, ConfigError> {
    let raw = get(values, name, &default.to_string());
    let value = raw.parse().map_err(|_| ConfigError::InvalidValue {
        name,
        value: raw.clone(),
    })?;
    if !(minimum..=maximum).contains(&value) {
        return Err(ConfigError::OutOfBounds {
            name,
            minimum: minimum as u64,
            maximum: maximum as u64,
            actual: value as u64,
        });
    }
    Ok(value)
}

fn bounded_u64(
    values: &HashMap<String, String>,
    name: &'static str,
    default: u64,
    minimum: u64,
    maximum: u64,
) -> Result<u64, ConfigError> {
    let raw = get(values, name, &default.to_string());
    let value = raw.parse().map_err(|_| ConfigError::InvalidValue {
        name,
        value: raw.clone(),
    })?;
    if !(minimum..=maximum).contains(&value) {
        return Err(ConfigError::OutOfBounds {
            name,
            minimum,
            maximum,
            actual: value,
        });
    }
    Ok(value)
}

fn bounded_u32(
    values: &HashMap<String, String>,
    name: &'static str,
    default: u32,
    minimum: u32,
    maximum: u32,
) -> Result<u32, ConfigError> {
    let value = bounded_u64(
        values,
        name,
        u64::from(default),
        u64::from(minimum),
        u64::from(maximum),
    )?;
    Ok(value as u32)
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid value for {name}: {value}")]
    InvalidValue { name: &'static str, value: String },
    #[error("{name} must be between {minimum} and {maximum}; got {actual}")]
    OutOfBounds {
        name: &'static str,
        minimum: u64,
        maximum: u64,
        actual: u64,
    },
    #[error("development-insecure authentication may bind only to loopback addresses")]
    InsecureNonLoopback,
    #[error("development-insecure authentication is not allowed in {0}")]
    InsecureEnvironment(DeploymentEnvironment),
    #[error("COSMOS_HTTP2_KEEPALIVE_TIMEOUT_MS must not exceed COSMOS_HTTP2_KEEPALIVE_INTERVAL_MS")]
    KeepaliveTimeoutExceedsInterval,
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    ServicePath(#[from] ServicePathError),
}

#[cfg(test)]
mod tests {

    /// A forged principal must not be accepted when it did not come via the edge.
    ///
    /// This is the live exposure the VPS audit proved: workload gRPC ports were
    /// reachable directly, and `x-forwarded-client-cert` was believed
    /// unconditionally, so a forged header reached a handler without ever passing
    /// Envoy's mTLS. Unpublishing the port closed the host route; this closes the
    /// lateral one, where another container on the same network dials the
    /// workload directly.
    #[test]
    fn a_request_that_did_not_pass_the_edge_is_refused_when_a_token_is_set() {
        // Injected, not set in the environment: env vars are process-global and
        // Rust runs tests in parallel, so setting one here silently changed the
        // behaviour of every other test in flight (it broke
        // `edge_authentication_fails_closed_and_redacts_the_principal`).
        let auth = EdgeAuthentication {
            principal_metadata_key: "x-forwarded-client-cert".to_owned(),
            edge_token: Some("shared-edge-secret".to_owned()),
        };
        let forged = || {
            let mut r = Request::new(());
            r.metadata_mut().insert(
                "x-forwarded-client-cert",
                "Subject=\"CN=V:01:D:forged:U:attacker\"".parse().unwrap(),
            );
            r
        };

        // No token: refused, even though the XFCC header is well-formed.
        assert!(
            auth.authenticate(&forged()).is_err(),
            "a well-formed XFCC header alone must not authenticate — that is \
             exactly what a lateral caller can produce",
        );

        // Wrong token: still refused.
        let mut wrong = forged();
        wrong
            .metadata_mut()
            .insert(EDGE_TOKEN_HEADER, "not-the-secret".parse().unwrap());
        assert!(
            auth.authenticate(&wrong).is_err(),
            "a wrong token must not pass"
        );

        // The edge's own token: accepted.
        let mut ok = forged();
        ok.metadata_mut()
            .insert(EDGE_TOKEN_HEADER, "shared-edge-secret".parse().unwrap());
        assert!(
            auth.authenticate(&ok).is_ok(),
            "the edge must still be able to authenticate a device",
        );
    }
    use super::*;
    use cosmos_core::Workload;

    fn local_values() -> HashMap<String, String> {
        HashMap::from([
            ("COSMOS_AUTH_MODE".into(), "development-insecure".into()),
            ("COSMOS_ENVIRONMENT".into(), "development".into()),
        ])
    }

    #[test]
    fn explicit_local_mode_is_runnable_on_loopback() {
        let config = Config::from_map(&local_values()).expect("valid local config");

        assert_eq!(config.identity.workload(), Workload::AiBus);
        assert_eq!(config.auth.label(), "development-insecure");
        assert!(config.grpc_bind.ip().is_loopback());
    }

    #[test]
    fn revision_is_applied_to_a_pod_name_without_duplicate_topology_tokens() {
        let mut values = local_values();
        values.insert("COSMOS_POD_NAME".into(), "ai-bus-abcde-12345".into());
        values.insert("COSMOS_REVISION".into(), "r42".into());

        let config = Config::from_map(&values).expect("valid pod config");

        assert_eq!(config.identity.instance(), "ai-bus-abcde-12345");
        assert_eq!(
            config.service_path.as_str(),
            "development:eastus:ai-bus-r42-abcde-12345"
        );

        values.insert("COSMOS_POD_NAME".into(), "ai-bus-r42-abcde".into());
        let config = Config::from_map(&values).expect("valid revision-prefixed pod config");
        assert_eq!(
            config.service_path.as_str(),
            "development:eastus:ai-bus-r42-abcde"
        );
    }

    #[test]
    fn grpc_http2_limits_have_conservative_defaults() {
        let config = Config::from_map(&local_values()).expect("valid local config");

        assert_eq!(config.limits.grpc_max_concurrent_streams, 64);
        assert_eq!(
            config.limits.http2_keepalive_interval,
            Duration::from_secs(30)
        );
        assert_eq!(
            config.limits.http2_keepalive_timeout,
            Duration::from_secs(10)
        );
        assert_eq!(config.limits.http2_max_header_list_bytes, 16 * 1024);
        assert_eq!(config.limits.http2_max_pending_reset_streams, 20);
    }

    #[test]
    fn grpc_http2_limits_accept_bounded_operator_values() {
        let mut values = local_values();
        values.extend([
            ("COSMOS_GRPC_MAX_CONCURRENT_STREAMS".into(), "32".into()),
            ("COSMOS_HTTP2_KEEPALIVE_INTERVAL_MS".into(), "45000".into()),
            ("COSMOS_HTTP2_KEEPALIVE_TIMEOUT_MS".into(), "5000".into()),
            ("COSMOS_HTTP2_MAX_HEADER_LIST_BYTES".into(), "8192".into()),
            ("COSMOS_HTTP2_MAX_PENDING_RESET_STREAMS".into(), "10".into()),
        ]);

        let config = Config::from_map(&values).expect("bounded transport config");
        assert_eq!(config.limits.grpc_max_concurrent_streams, 32);
        assert_eq!(
            config.limits.http2_keepalive_interval,
            Duration::from_secs(45)
        );
        assert_eq!(
            config.limits.http2_keepalive_timeout,
            Duration::from_secs(5)
        );
        assert_eq!(config.limits.http2_max_header_list_bytes, 8192);
        assert_eq!(config.limits.http2_max_pending_reset_streams, 10);
    }

    #[test]
    fn grpc_http2_limits_reject_values_outside_their_bounds() {
        for (name, value) in [
            ("COSMOS_GRPC_MAX_CONCURRENT_STREAMS", "0"),
            ("COSMOS_GRPC_MAX_CONCURRENT_STREAMS", "1025"),
            ("COSMOS_HTTP2_KEEPALIVE_INTERVAL_MS", "9999"),
            ("COSMOS_HTTP2_KEEPALIVE_INTERVAL_MS", "300001"),
            ("COSMOS_HTTP2_KEEPALIVE_TIMEOUT_MS", "999"),
            ("COSMOS_HTTP2_KEEPALIVE_TIMEOUT_MS", "60001"),
            ("COSMOS_HTTP2_MAX_HEADER_LIST_BYTES", "1023"),
            ("COSMOS_HTTP2_MAX_HEADER_LIST_BYTES", "65537"),
            ("COSMOS_HTTP2_MAX_PENDING_RESET_STREAMS", "0"),
            ("COSMOS_HTTP2_MAX_PENDING_RESET_STREAMS", "257"),
        ] {
            let mut values = local_values();
            values.insert(name.into(), value.into());
            assert!(matches!(
                Config::from_map(&values).err(),
                Some(ConfigError::OutOfBounds {
                    name: rejected_name,
                    ..
                }) if rejected_name == name
            ));
        }
    }

    #[test]
    fn keepalive_timeout_cannot_exceed_the_ping_interval() {
        let mut values = local_values();
        values.insert("COSMOS_HTTP2_KEEPALIVE_INTERVAL_MS".into(), "10000".into());
        values.insert("COSMOS_HTTP2_KEEPALIVE_TIMEOUT_MS".into(), "10001".into());

        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::KeepaliveTimeoutExceedsInterval)
        ));
    }

    #[test]
    fn default_authentication_trusts_only_edge_identity_metadata() {
        let config = Config::from_map(&HashMap::new()).expect("valid edge-authenticated config");

        let Authentication::EdgeAuthenticated(edge) = config.auth else {
            panic!("edge authentication should be the default");
        };
        assert_eq!(edge.principal_metadata_key(), "x-forwarded-client-cert");
    }

    #[test]
    fn edge_metadata_key_is_bounded_and_lowercase() {
        let values = HashMap::from([(
            "COSMOS_EDGE_PRINCIPAL_METADATA".into(),
            "X-Unsafe-Key".into(),
        )]);

        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::InvalidValue {
                name: "COSMOS_EDGE_PRINCIPAL_METADATA",
                ..
            })
        ));
    }

    #[test]
    fn edge_authentication_fails_closed_and_redacts_the_principal() {
        let config = Config::from_map(&HashMap::new()).expect("valid edge-authenticated config");
        let Authentication::EdgeAuthenticated(edge) = config.auth else {
            panic!("edge authentication should be the default");
        };

        let missing = edge
            .authenticate(&Request::new(()))
            .expect_err("missing identity must fail closed");
        assert_eq!(missing, EdgeAuthenticationError::Missing);
        // Still refused — but reported as a transport failure. The two account
        // codes are reserved for real entitlement verdicts, because the stock
        // client narrates them as "invalid subscription" / "device blocked" off
        // the code alone (RemoteInterpreter.java:91-96).
        for error in [
            EdgeAuthenticationError::Missing,
            EdgeAuthenticationError::Invalid,
        ] {
            let status = tonic::Status::from(error);
            assert_eq!(status.code(), tonic::Code::Unavailable, "{error:?}");
            assert_ne!(status.code(), tonic::Code::Unauthenticated, "{error:?}");
            assert_ne!(status.code(), tonic::Code::PermissionDenied, "{error:?}");
        }

        // The edge forwards the verified client cert as XFCC; the principal is
        // the Subject CN.
        let mut authenticated = Request::new(());
        authenticated.metadata_mut().insert(
            "x-forwarded-client-cert",
            "Hash=abc123;Subject=\"CN=device-test-pin-01,L=localdev:us-west-2\";URI="
                .parse()
                .expect("valid xfcc metadata"),
        );
        let principal = edge
            .authenticate(&authenticated)
            .expect("edge principal is accepted");
        assert_eq!(principal.expose_for_authorization(), "device-test-pin-01");
        assert_eq!(
            format!("{principal:?}"),
            "AuthenticatedPrincipal([REDACTED])"
        );
    }

    #[test]
    fn xfcc_subject_cn_is_extracted_or_falls_back() {
        assert_eq!(
            principal_from_xfcc("By=spiffe://x;Hash=z;Subject=\"CN=abc-01,O=humane\";URI=y"),
            Some("abc-01")
        );
        // no CN / not XFCC-shaped -> None (caller falls back to the raw value)
        assert_eq!(principal_from_xfcc("plain-principal"), None);
        assert_eq!(principal_from_xfcc("Subject=\"O=humane\""), None);
    }

    fn provenance_request(cn: &str) -> Request<()> {
        let mut request = Request::new(());
        request.metadata_mut().insert(
            EDGE_PRINCIPAL_HEADER,
            format!("Hash=test;Subject=\"CN={cn},O=Humane,OU=DeviceUser\";URI=")
                .parse()
                .unwrap(),
        );
        request
            .metadata_mut()
            .insert(EDGE_TOKEN_HEADER, "provenance-test-edge".parse().unwrap());
        request
    }

    #[test]
    fn device_provenance_preserves_one_account_partition_for_two_devices() {
        let edge = EdgeAuthentication::with_test_token("provenance-test-edge");
        let first = edge
            .authenticate_with_device(&provenance_request("V:01:D:ABCD:U:alice-sub-01"))
            .unwrap();
        let second = edge
            .authenticate_with_device(&provenance_request("V:01:D:dcba:U:alice-sub-01"))
            .unwrap();
        assert_eq!(first.principal, second.principal);
        assert_eq!(
            first.principal,
            AuthenticatedPrincipal::for_user("alice-sub-01").unwrap()
        );
        assert_ne!(first.device, second.device);
        assert_eq!(first.device.unwrap().expose_for_authorization(), "abcd");
        assert_eq!(second.device.unwrap().expose_for_authorization(), "dcba");
    }

    #[test]
    fn device_provenance_requires_a_complete_runtime_device_user_subject() {
        let edge = EdgeAuthentication::with_test_token("provenance-test-edge");
        for cn in [
            "service-identity",
            "synthetic:U:alice-sub-01",
            "V:01:D:abcd:P:00000001",
            "V:1:D:abcd:U:alice-sub-01",
            "V:zz:D:abcd:U:alice-sub-01",
            "V:01:other:abcd:U:alice-sub-01",
            "V:01:D:nothex:U:alice-sub-01",
            "V:01:D::U:alice-sub-01",
            "V:01:D:abcd:U:",
            "V:01:D:abcd:U:alice-sub-01:extra",
            "V:01:D:abcd:U:alice-sub-01:U:bob",
        ] {
            let authenticated = edge
                .authenticate_with_device(&provenance_request(cn))
                .expect("legacy principal behavior remains available");
            assert!(
                authenticated.device.is_none(),
                "malformed subject has no device"
            );
            assert_eq!(
                authenticated.principal,
                AuthenticatedPrincipal::from_device_cn(cn).unwrap(),
                "new device evidence must not change legacy account partitions"
            );
        }
        let oversized = format!("V:01:D:{}:U:alice-sub-01", "a".repeat(129));
        let authenticated = edge
            .authenticate_with_device(&provenance_request(&oversized))
            .unwrap();
        assert!(authenticated.device.is_none());
        assert_eq!(
            authenticated.principal,
            AuthenticatedPrincipal::for_user("alice-sub-01").unwrap()
        );
    }

    #[test]
    fn device_provenance_does_not_upgrade_unenforced_or_synthetic_metadata() {
        let cn = "V:01:D:abcd:U:alice-sub-01";
        let mut edge = EdgeAuthentication::with_test_token("provenance-test-edge");
        let mut raw = Request::new(());
        raw.metadata_mut()
            .insert(EDGE_PRINCIPAL_HEADER, cn.parse().unwrap());
        raw.metadata_mut()
            .insert(EDGE_TOKEN_HEADER, "provenance-test-edge".parse().unwrap());
        let authenticated = edge.authenticate_with_device(&raw).unwrap();
        assert!(
            authenticated.device.is_none(),
            "raw legacy CN is not XFCC evidence"
        );

        edge.edge_token = None;
        let authenticated = edge
            .authenticate_with_device(&provenance_request(cn))
            .unwrap();
        assert!(
            authenticated.device.is_none(),
            "unenforced edge has unknown provenance"
        );
        assert_eq!(
            authenticated.principal,
            AuthenticatedPrincipal::for_user("alice-sub-01").unwrap()
        );

        edge.edge_token = Some("provenance-test-edge".to_owned());
        edge.principal_metadata_key = "x-test-principal".to_owned();
        let mut custom = provenance_request(cn);
        let value = custom
            .metadata()
            .get(EDGE_PRINCIPAL_HEADER)
            .unwrap()
            .clone();
        custom.metadata_mut().insert("x-test-principal", value);
        assert!(
            edge.authenticate_with_device(&custom)
                .unwrap()
                .device
                .is_none()
        );
    }

    #[test]
    fn insecure_mode_refuses_non_loopback_or_parity() {
        let mut values = local_values();
        values.insert("COSMOS_GRPC_BIND".into(), "0.0.0.0:50051".into());
        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::InsecureNonLoopback)
        ));

        values.insert("COSMOS_GRPC_BIND".into(), "127.0.0.1:50051".into());
        values.insert("COSMOS_ENVIRONMENT".into(), "parity".into());
        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::InsecureEnvironment(
                DeploymentEnvironment::Parity
            ))
        ));
    }

    #[test]
    fn payload_and_deadline_limits_are_bounded() {
        let mut values = local_values();
        values.insert("COSMOS_MAX_DECODE_BYTES".into(), "16777217".into());
        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::OutOfBounds {
                name: "COSMOS_MAX_DECODE_BYTES",
                ..
            })
        ));

        values.insert("COSMOS_MAX_DECODE_BYTES".into(), "4096".into());
        values.insert("COSMOS_REQUEST_TIMEOUT_MS".into(), "0".into());
        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::OutOfBounds {
                name: "COSMOS_REQUEST_TIMEOUT_MS",
                ..
            })
        ));
    }

    #[test]
    fn malformed_service_path_configuration_is_rejected() {
        let mut values = local_values();
        values.insert("COSMOS_REGION".into(), "eastus:private-content".into());
        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::ServicePath(
                ServicePathError::InvalidCharacters { field: "region" }
            ))
        ));

        values.insert("COSMOS_REGION".into(), "eastus".into());
        values.insert("COSMOS_POD_NAME".into(), "ai-bus/pod/../../secret".into());
        assert!(matches!(
            Config::from_map(&values).err(),
            Some(ConfigError::Identity(IdentityError::InvalidCharacters {
                field: "instance"
            }))
        ));
    }
}
