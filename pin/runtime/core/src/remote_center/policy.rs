//! Pure policy primitives for a future remote Center transport.
//!
//! This module deliberately has no HTTP client and never returns a URL, host,
//! or caller-controlled path. A successful decision is a closed typed
//! operation which an integration layer must dispatch directly. With no
//! capabilities it permits only exact Center asset-catalog entries over
//! `GET`/`HEAD` and `GET /api/health`; reviewed device, feature-flag, and
//! Spotify surfaces require separate explicit capabilities.

use std::collections::VecDeque;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_TARGET_BYTES: usize = 512;
pub const MAX_PATH_SEGMENT_BYTES: usize = 128;
pub const MAX_CENTER_ASSETS: usize = 64;
pub const MAX_ASSET_PATH_BYTES: usize = 256;
pub const MAX_HEADER_COUNT: usize = 32;
pub const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_SPOTIFY_SEARCH_QUERY_BYTES: usize = 256;
pub const MAX_SPOTIFY_SETTINGS_BODY_BYTES: u64 = 512;
pub const MAX_REQUEST_AGE_MS: u64 = 2 * 60 * 1_000;
pub const MAX_REQUEST_LIFETIME_MS: u64 = 5 * 60 * 1_000;
pub const MAX_CLOCK_SKEW_MS: u64 = 30 * 1_000;
pub const MAX_LEDGER_ENTRIES: usize = 4_096;
pub const IDEMPOTENCY_RETENTION_MS: u64 = 10 * 60 * 1_000;
const MAX_LEGACY_FULL_ACCESS_BODY_BYTES: u64 = 1024 * 1024;

const MIN_REQUEST_ID_BYTES: usize = 16;
const MAX_REQUEST_ID_BYTES: usize = 64;
const MIN_IDEMPOTENCY_KEY_BYTES: usize = 16;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 96;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Head,
    Post,
    Put,
    Delete,
    Patch,
    Options,
}

impl HttpMethod {
    fn parse(value: &str) -> Result<Self, PolicyError> {
        match value {
            "GET" => Ok(Self::Get),
            "HEAD" => Ok(Self::Head),
            "POST" => Ok(Self::Post),
            "PUT" => Ok(Self::Put),
            "DELETE" => Ok(Self::Delete),
            "PATCH" => Ok(Self::Patch),
            "OPTIONS" => Ok(Self::Options),
            _ => Err(PolicyError::InvalidMethod),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessMode {
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DataSensitivity {
    NonSensitive,
    Sensitive,
}

/// The two independent authorization axes attached to every approved route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccessScope {
    pub mode: AccessMode,
    pub sensitivity: DataSensitivity,
}

impl AccessScope {
    pub const fn is_write(self) -> bool {
        matches!(self.mode, AccessMode::Write)
    }

    pub const fn is_sensitive(self) -> bool {
        matches!(self.sensitivity, DataSensitivity::Sensitive)
    }
}

const NON_SENSITIVE_READ: AccessScope = AccessScope {
    mode: AccessMode::Read,
    sensitivity: DataSensitivity::NonSensitive,
};
const SENSITIVE_READ: AccessScope = AccessScope {
    mode: AccessMode::Read,
    sensitivity: DataSensitivity::Sensitive,
};
const SENSITIVE_WRITE: AccessScope = AccessScope {
    mode: AccessMode::Write,
    sensitivity: DataSensitivity::Sensitive,
};

/// Future reviewed routes. `Capabilities::none()` grants none of these.
///
/// A transport must derive each capability from an authenticated remote
/// principal and a separate route-and-field review. Capabilities are not a
/// substitute for request-body validation in the eventual handler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Capability {
    DeviceMetadataRead = 0,
    FeatureFlagsRead = 1,
    /// Read Spotify connection state and run a bounded track-only search.
    SpotifyRead = 2,
    /// Change Spotify settings or pairing/session state.
    SpotifyManage = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities(u64);

impl Capabilities {
    pub const fn none() -> Self {
        Self(0)
    }

    /// Add one deliberately selected capability.
    pub const fn with(mut self, capability: Capability) -> Self {
        self.0 |= 1_u64 << capability as u8;
        self
    }

    pub const fn contains(self, capability: Capability) -> bool {
        self.0 & (1_u64 << capability as u8) != 0
    }
}

impl Default for Capabilities {
    fn default() -> Self {
        Self::none()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetMethod {
    Get,
    Head,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CenterOperation {
    Asset {
        method: AssetMethod,
        catalog: CatalogIdentity,
        catalog_index: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiOperation {
    Health,
    DeviceMetadata,
    FeatureFlagsRead,
    SpotifyStatus,
    SpotifySettingsUpdate,
    SpotifyPairingStart,
    SpotifyPairingCancel,
    SpotifySessionDelete,
    SpotifySearch(SpotifySearchQuery),
    /// Transitional proxy operation for the legacy full-access Center mode.
    /// It remains subject to origin-form validation, hard-denied namespaces,
    /// payload bounds, freshness, replay protection, and idempotency.
    LegacyFullAccessProxy,
    #[cfg(test)]
    TestMutation,
}

/// A decoded, bounded Spotify track-search query.
///
/// The fixed-size representation keeps the approved operation closed and
/// copyable: dispatch receives validated data, never a caller-provided URL or
/// path. Debug output is deliberately redacted because searches are personal
/// data.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct SpotifySearchQuery {
    bytes: [u8; MAX_SPOTIFY_SEARCH_QUERY_BYTES],
    len: u16,
}

impl SpotifySearchQuery {
    fn new(value: &str) -> Result<Self, PolicyError> {
        let bytes = value.as_bytes();
        if bytes.is_empty()
            || bytes.len() > MAX_SPOTIFY_SEARCH_QUERY_BYTES
            || value.chars().any(char::is_control)
        {
            return Err(PolicyError::InvalidSpotifySearchQuery);
        }
        let mut storage = [0; MAX_SPOTIFY_SEARCH_QUERY_BYTES];
        storage[..bytes.len()].copy_from_slice(bytes);
        Ok(Self {
            bytes: storage,
            len: bytes.len() as u16,
        })
    }

    pub fn as_str(&self) -> &str {
        // Construction copies an already-valid UTF-8 `str`, and callers cannot
        // mutate the private byte storage or length.
        std::str::from_utf8(&self.bytes[..usize::from(self.len)])
            .expect("Spotify search query invariant")
    }
}

impl fmt::Debug for SpotifySearchQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SpotifySearchQuery(<redacted>)")
    }
}

/// Closed dispatch result. It intentionally contains no raw path or URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovedOperation {
    CenterAsset(CenterOperation),
    Api(ApiOperation),
}

/// Exact asset membership supplied by the embedded Setup pack integration.
///
/// Entries are relative to `/setup/` (for example `index.html` or
/// `assets/app.js`). No prefix or extension wildcard is accepted.
#[derive(Debug)]
pub struct CenterAssetCatalog<'a> {
    identity: CatalogIdentity,
    entries: &'a [&'a str],
}

static NEXT_CATALOG_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CatalogIdentity(u64);

impl<'a> CenterAssetCatalog<'a> {
    pub fn new(entries: &'a [&'a str]) -> Result<Self, CatalogError> {
        if entries.is_empty() {
            return Err(CatalogError::Empty);
        }
        if entries.len() > MAX_CENTER_ASSETS {
            return Err(CatalogError::TooManyEntries);
        }

        let mut has_index = false;
        for (index, entry) in entries.iter().enumerate() {
            validate_asset_entry(entry)?;
            has_index |= *entry == "index.html";
            if entries[..index].contains(entry) {
                return Err(CatalogError::DuplicateEntry);
            }
        }
        if !has_index {
            return Err(CatalogError::MissingIndex);
        }

        let identity = NEXT_CATALOG_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map(CatalogIdentity)
            .map_err(|_| CatalogError::IdentityExhausted)?;

        Ok(Self { identity, entries })
    }

    /// Resolve only an asset handle issued from this exact catalog instance.
    /// The integration must serve the returned entry from the embedded pack,
    /// never use it as a filesystem or proxy path.
    pub fn resolve(&self, operation: CenterOperation) -> Option<&'a str> {
        match operation {
            CenterOperation::Asset {
                method: _,
                catalog,
                catalog_index,
            } if catalog == self.identity => self.entries.get(catalog_index).copied(),
            _ => None,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn find(&self, entry: &str) -> Option<usize> {
        self.entries
            .iter()
            .position(|candidate| *candidate == entry)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogError {
    Empty,
    TooManyEntries,
    InvalidEntry,
    DuplicateEntry,
    MissingIndex,
    IdentityExhausted,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Empty => "Center asset catalog is empty",
            Self::TooManyEntries => "Center asset catalog has too many entries",
            Self::InvalidEntry => "Center asset catalog contains an invalid entry",
            Self::DuplicateEntry => "Center asset catalog contains a duplicate entry",
            Self::MissingIndex => "Center asset catalog does not contain index.html",
            Self::IdentityExhausted => "Center asset catalog identity space is exhausted",
        })
    }
}

impl std::error::Error for CatalogError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CenterGeneration(u64);

impl CenterGeneration {
    pub fn new(value: u64) -> Result<Self, PolicyError> {
        if value == 0 {
            Err(PolicyError::InvalidGeneration)
        } else {
            Ok(Self(value))
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Content-free metadata signed by the remote transport.
///
/// `body_bytes` is the measured body length. A write must also provide an
/// equal declared length so an unbounded/chunked body is never admitted.
/// Arbitrary headers are intentionally not represented: the typed dispatcher
/// must synthesize its own fixed headers and must not forward `Host`, cookies,
/// credentials, forwarding headers, hop-by-hop headers, or transfer encoding.
pub struct RequestEnvelope<'a> {
    pub method: &'a str,
    pub target: &'a str,
    /// The only header value carried by the wire protocol. The connector
    /// synthesizes all dispatched headers and never forwards arbitrary ones.
    pub content_type: Option<&'a str>,
    pub header_count: usize,
    pub header_bytes: usize,
    pub body_bytes: u64,
    pub declared_body_bytes: Option<u64>,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub generation: u64,
    pub request_id: &'a str,
    pub idempotency_key: Option<&'a str>,
}

pub struct PolicyContext<'catalog, 'entries> {
    pub now_ms: u64,
    pub expected_generation: CenterGeneration,
    pub capabilities: Capabilities,
    pub center_assets: &'catalog CenterAssetCatalog<'entries>,
}

pub struct ValidatedRequest {
    operation: ApprovedOperation,
    scope: AccessScope,
    generation: CenterGeneration,
    request_id: String,
    idempotency_key: Option<String>,
    expires_at_ms: u64,
}

impl fmt::Debug for ValidatedRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ValidatedRequest")
            .field("operation", &self.operation)
            .field("scope", &self.scope)
            .field("generation", &self.generation)
            .field("request_id", &"<redacted>")
            .field(
                "idempotency_key",
                &self.idempotency_key.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl ValidatedRequest {
    pub const fn scope(&self) -> AccessScope {
        self.scope
    }

    pub const fn generation(&self) -> CenterGeneration {
        self.generation
    }

    pub const fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

#[derive(Clone, Copy)]
struct RouteRule {
    operation: ApprovedOperation,
    scope: AccessScope,
    required_capability: Option<Capability>,
    max_body_bytes: u64,
    content_type: ContentTypeRule,
}

#[derive(Clone, Copy)]
enum ContentTypeRule {
    Forbidden,
    JsonRequired,
    LegacyAny,
}

/// Validate and classify one remote request without reading or retaining its
/// body. Unknown method/path pairs are denied by default. This staged value is
/// not a dispatch permit: the typed operation becomes available to integration
/// code only through `ReservationDecision::ExecuteOnce` from `MetadataLedger`.
pub fn authorize(
    envelope: &RequestEnvelope<'_>,
    context: &PolicyContext<'_, '_>,
) -> Result<ValidatedRequest, PolicyError> {
    let method = HttpMethod::parse(envelope.method)?;
    let target = validate_origin_target(envelope.target)?;
    let rule = classify(method, target, context.center_assets)?;

    if let Some(required) = rule.required_capability {
        if !context.capabilities.contains(required) {
            return Err(PolicyError::CapabilityRequired(required));
        }
    }

    validate_rule(envelope, context, rule)
}

/// Transitional authorization for the legacy remote-Center full-access mode.
///
/// Unlike the historical bypass, this still validates the request envelope and
/// returns a ledger-compatible reservation input. Only `/setup`, its legacy
/// `/center` alias, and `/api`
/// remain dispatchable, while device-local and high-risk namespaces stay
/// permanently denied regardless of the full-access flag.
pub fn authorize_full_access(
    envelope: &RequestEnvelope<'_>,
    context: &PolicyContext<'_, '_>,
) -> Result<ValidatedRequest, PolicyError> {
    let method = HttpMethod::parse(envelope.method)?;
    let target = validate_origin_target(envelope.target)?;
    if hard_denied(target.path) {
        return Err(PolicyError::HardDeniedRoute);
    }
    if !in_namespace(target.path, "/api")
        && !in_namespace(target.path, "/setup")
        && !in_namespace(target.path, "/center")
    {
        return Err(PolicyError::RouteNotAllowed);
    }

    let scope = match method {
        HttpMethod::Get | HttpMethod::Head | HttpMethod::Options => SENSITIVE_READ,
        HttpMethod::Post | HttpMethod::Put | HttpMethod::Delete | HttpMethod::Patch => {
            SENSITIVE_WRITE
        }
    };
    let rule = RouteRule {
        operation: ApprovedOperation::Api(ApiOperation::LegacyFullAccessProxy),
        scope,
        required_capability: None,
        max_body_bytes: if scope.is_write() {
            MAX_LEGACY_FULL_ACCESS_BODY_BYTES
        } else {
            0
        },
        content_type: ContentTypeRule::LegacyAny,
    };
    validate_rule(envelope, context, rule)
}

fn validate_rule(
    envelope: &RequestEnvelope<'_>,
    context: &PolicyContext<'_, '_>,
    rule: RouteRule,
) -> Result<ValidatedRequest, PolicyError> {
    if envelope.header_count > MAX_HEADER_COUNT {
        return Err(PolicyError::TooManyHeaders);
    }
    if envelope.header_bytes > MAX_HEADER_BYTES {
        return Err(PolicyError::HeadersTooLarge);
    }
    match (rule.content_type, envelope.content_type) {
        (ContentTypeRule::Forbidden, Some(_)) => return Err(PolicyError::ContentTypeNotAllowed),
        (ContentTypeRule::JsonRequired, Some("application/json"))
        | (ContentTypeRule::LegacyAny, _) => {}
        (ContentTypeRule::JsonRequired, _) => return Err(PolicyError::InvalidContentType),
        (ContentTypeRule::Forbidden, None) => {}
    }
    match envelope.declared_body_bytes {
        Some(declared) if declared != envelope.body_bytes => {
            return Err(PolicyError::BodyLengthMismatch)
        }
        None if envelope.body_bytes != 0 || rule.scope.is_write() => {
            return Err(PolicyError::ContentLengthRequired)
        }
        _ => {}
    }
    if envelope.body_bytes > rule.max_body_bytes {
        return Err(PolicyError::BodyTooLarge);
    }

    validate_freshness(envelope, context)?;
    if !valid_token(
        envelope.request_id,
        MIN_REQUEST_ID_BYTES,
        MAX_REQUEST_ID_BYTES,
    ) {
        return Err(PolicyError::InvalidRequestId);
    }

    let idempotency_key = validate_idempotency(rule.scope, envelope.idempotency_key)?;

    Ok(ValidatedRequest {
        operation: rule.operation,
        scope: rule.scope,
        generation: context.expected_generation,
        request_id: envelope.request_id.to_owned(),
        idempotency_key,
        expires_at_ms: envelope.expires_at_ms,
    })
}

fn validate_idempotency(
    scope: AccessScope,
    supplied: Option<&str>,
) -> Result<Option<String>, PolicyError> {
    match (scope.is_write(), supplied) {
        (true, None) => Err(PolicyError::MissingIdempotencyKey),
        (false, Some(_)) => Err(PolicyError::UnexpectedIdempotencyKey),
        (_, Some(key))
            if !valid_token(key, MIN_IDEMPOTENCY_KEY_BYTES, MAX_IDEMPOTENCY_KEY_BYTES) =>
        {
            Err(PolicyError::InvalidIdempotencyKey)
        }
        (_, key) => Ok(key.map(str::to_owned)),
    }
}

fn classify(
    method: HttpMethod,
    target: OriginTarget<'_>,
    assets: &CenterAssetCatalog<'_>,
) -> Result<RouteRule, PolicyError> {
    let path = target.path;
    if hard_denied(path) {
        return Err(PolicyError::HardDeniedRoute);
    }

    if target.query.is_none() && matches!(method, HttpMethod::Get | HttpMethod::Head) {
        let asset_method = if method == HttpMethod::Get {
            AssetMethod::Get
        } else {
            AssetMethod::Head
        };
        let center_operation = match path {
            "/setup/" | "/center/" => {
                assets
                    .find("index.html")
                    .map(|catalog_index| CenterOperation::Asset {
                        method: asset_method,
                        catalog: assets.identity,
                        catalog_index,
                    })
            }
            _ => path
                .strip_prefix("/setup/")
                .or_else(|| path.strip_prefix("/center/"))
                .and_then(|entry| assets.find(entry))
                .map(|catalog_index| CenterOperation::Asset {
                    method: asset_method,
                    catalog: assets.identity,
                    catalog_index,
                }),
        };
        if let Some(operation) = center_operation {
            return Ok(RouteRule {
                operation: ApprovedOperation::CenterAsset(operation),
                scope: NON_SENSITIVE_READ,
                required_capability: None,
                max_body_bytes: 0,
                content_type: ContentTypeRule::Forbidden,
            });
        }
    }

    let rule = match (method, path, target.query) {
        (HttpMethod::Get, "/api/health", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::Health),
            scope: NON_SENSITIVE_READ,
            required_capability: None,
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        // Explicit review table. None of these are enabled by the default
        // capability set, and no namespace/prefix grants access to them.
        (HttpMethod::Get, "/api/device", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::DeviceMetadata),
            scope: SENSITIVE_READ,
            required_capability: Some(Capability::DeviceMetadataRead),
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        (HttpMethod::Get, "/api/feature-flags", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::FeatureFlagsRead),
            scope: SENSITIVE_READ,
            required_capability: Some(Capability::FeatureFlagsRead),
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        (HttpMethod::Get, "/api/spotify/status", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::SpotifyStatus),
            scope: SENSITIVE_READ,
            required_capability: Some(Capability::SpotifyRead),
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        (HttpMethod::Get, "/api/spotify/search", Some(query)) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::SpotifySearch(
                parse_spotify_search_query(query)?,
            )),
            scope: SENSITIVE_READ,
            required_capability: Some(Capability::SpotifyRead),
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        (HttpMethod::Put, "/api/spotify/settings", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::SpotifySettingsUpdate),
            scope: SENSITIVE_WRITE,
            required_capability: Some(Capability::SpotifyManage),
            max_body_bytes: MAX_SPOTIFY_SETTINGS_BODY_BYTES,
            content_type: ContentTypeRule::JsonRequired,
        },
        (HttpMethod::Post, "/api/spotify/pairing/start", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::SpotifyPairingStart),
            scope: SENSITIVE_WRITE,
            required_capability: Some(Capability::SpotifyManage),
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        (HttpMethod::Post, "/api/spotify/pairing/cancel", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::SpotifyPairingCancel),
            scope: SENSITIVE_WRITE,
            required_capability: Some(Capability::SpotifyManage),
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        (HttpMethod::Delete, "/api/spotify/session", None) => RouteRule {
            operation: ApprovedOperation::Api(ApiOperation::SpotifySessionDelete),
            scope: SENSITIVE_WRITE,
            required_capability: Some(Capability::SpotifyManage),
            max_body_bytes: 0,
            content_type: ContentTypeRule::Forbidden,
        },
        _ => return Err(PolicyError::RouteNotAllowed),
    };
    Ok(rule)
}

fn hard_denied(path: &str) -> bool {
    const HARD_DENIED_NAMESPACES: &[&str] = &[
        "/upload",
        "/aibus-upload",
        "/internal",
        "/api/dev",
        "/api/logs",
        "/api/esim",
        "/api/cellular",
        "/api/wifi",
        "/api/spotify/diagnostics",
        "/_penumbra",
        "/hooks",
        "/_hooks",
        "/api/hooks",
    ];

    HARD_DENIED_NAMESPACES
        .iter()
        .any(|prefix| in_namespace(path, prefix))
        || path == "/api/contacts/client-reset/claim"
}

fn in_namespace(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[derive(Clone, Copy)]
struct OriginTarget<'a> {
    path: &'a str,
    query: Option<&'a str>,
}

fn validate_origin_target(target: &str) -> Result<OriginTarget<'_>, PolicyError> {
    if target.len() > MAX_TARGET_BYTES {
        return Err(PolicyError::TargetTooLong);
    }
    if !target.starts_with('/') || target.starts_with("//") {
        return Err(PolicyError::InvalidOriginForm);
    }
    if target.contains('#') || target.contains('\\') {
        return Err(PolicyError::AmbiguousTarget);
    }
    if !target.is_ascii()
        || target
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b' ')
    {
        return Err(PolicyError::AmbiguousTarget);
    }
    let (path, query) = match target.split_once('?') {
        Some((path, query)) if !query.is_empty() && !query.contains('?') => (path, Some(query)),
        Some(_) => return Err(PolicyError::QueryNotAllowed),
        None => (target, None),
    };
    if path.contains('%') {
        return Err(PolicyError::AmbiguousTarget);
    }
    if path == "/" || path == "/setup/" || path == "/center/" {
        return Ok(OriginTarget { path, query });
    }

    for segment in path[1..].split('/') {
        if !valid_path_segment(segment) {
            return Err(PolicyError::InvalidPath);
        }
    }
    Ok(OriginTarget { path, query })
}

fn parse_spotify_search_query(query: &str) -> Result<SpotifySearchQuery, PolicyError> {
    let mut search = None;
    let mut kind = None;
    for pair in query.split('&') {
        let (name, raw_value) = pair
            .split_once('=')
            .ok_or(PolicyError::InvalidSpotifySearchQuery)?;
        match name {
            "q" if search.is_none() => search = Some(decode_form_value(raw_value)?),
            "kind" if kind.is_none() => kind = Some(decode_form_value(raw_value)?),
            _ => return Err(PolicyError::InvalidSpotifySearchQuery),
        }
    }
    let search = search.ok_or(PolicyError::InvalidSpotifySearchQuery)?;
    if kind.as_deref() != Some("track") || search.trim().is_empty() {
        return Err(PolicyError::InvalidSpotifySearchQuery);
    }
    SpotifySearchQuery::new(&search)
}

fn decode_form_value(value: &str) -> Result<String, PolicyError> {
    let input = value.as_bytes();
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        match input[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' => {
                if index + 2 >= input.len() {
                    return Err(PolicyError::InvalidSpotifySearchQuery);
                }
                let high =
                    hex_value(input[index + 1]).ok_or(PolicyError::InvalidSpotifySearchQuery)?;
                let low =
                    hex_value(input[index + 2]).ok_or(PolicyError::InvalidSpotifySearchQuery)?;
                output.push((high << 4) | low);
                index += 3;
            }
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') => {
                output.push(byte);
                index += 1;
            }
            _ => return Err(PolicyError::InvalidSpotifySearchQuery),
        }
        if output.len() > MAX_SPOTIFY_SEARCH_QUERY_BYTES {
            return Err(PolicyError::InvalidSpotifySearchQuery);
        }
    }
    String::from_utf8(output).map_err(|_| PolicyError::InvalidSpotifySearchQuery)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn validate_asset_entry(entry: &str) -> Result<(), CatalogError> {
    if entry.is_empty()
        || entry.len() > MAX_ASSET_PATH_BYTES
        || entry.starts_with('/')
        || entry.ends_with('/')
        || !entry.is_ascii()
        || entry.contains('%')
        || entry.contains('?')
        || entry.contains('#')
        || entry.contains('\\')
        || entry.split('/').any(|segment| !valid_path_segment(segment))
    {
        return Err(CatalogError::InvalidEntry);
    }
    Ok(())
}

fn valid_path_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= MAX_PATH_SEGMENT_BYTES
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_freshness(
    envelope: &RequestEnvelope<'_>,
    context: &PolicyContext<'_, '_>,
) -> Result<(), PolicyError> {
    if envelope.generation == 0 {
        return Err(PolicyError::InvalidGeneration);
    }
    if envelope.generation != context.expected_generation.get() {
        return Err(PolicyError::GenerationMismatch);
    }
    let lifetime = envelope
        .expires_at_ms
        .checked_sub(envelope.issued_at_ms)
        .filter(|lifetime| *lifetime > 0)
        .ok_or(PolicyError::InvalidFreshnessWindow)?;
    if lifetime > MAX_REQUEST_LIFETIME_MS {
        return Err(PolicyError::InvalidFreshnessWindow);
    }
    if envelope.issued_at_ms > context.now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(PolicyError::RequestFromFuture);
    }
    if context.now_ms >= envelope.expires_at_ms {
        return Err(PolicyError::RequestExpired);
    }
    if context.now_ms >= envelope.issued_at_ms
        && context.now_ms - envelope.issued_at_ms > MAX_REQUEST_AGE_MS
    {
        return Err(PolicyError::RequestTooOld);
    }
    Ok(())
}

fn valid_token(value: &str, minimum: usize, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    (minimum..=maximum).contains(&bytes.len())
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RequestFingerprint([u8; 32]);

impl RequestFingerprint {
    /// Construct only from a cryptographic digest computed locally by the
    /// authenticated transport. Never accept this digest from the peer.
    ///
    /// It must bind the authenticated principal/session, typed operation,
    /// canonical mutation inputs, body bytes, and resource preconditions. It
    /// must exclude retry-specific request IDs and timestamps so a legitimate
    /// retry has the same semantic fingerprint.
    pub const fn from_locally_computed_digest(digest: [u8; 32]) -> Self {
        Self(digest)
    }
}

impl fmt::Debug for RequestFingerprint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RequestFingerprint(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdempotencyState {
    InFlight,
    Completed,
    Indeterminate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionState {
    Completed,
    Indeterminate,
}

#[derive(PartialEq, Eq)]
pub struct ExecutionReservation {
    generation: CenterGeneration,
    operation: ApprovedOperation,
    request_id: String,
    idempotency_key: Option<String>,
    execute_before_ms: u64,
}

impl ExecutionReservation {
    pub const fn generation(&self) -> CenterGeneration {
        self.generation
    }

    pub const fn operation(&self) -> ApprovedOperation {
        self.operation
    }
}

impl fmt::Debug for ExecutionReservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionReservation")
            .field("generation", &self.generation)
            .field("operation", &self.operation)
            .field("request_id", &"<redacted>")
            .field(
                "idempotency_key",
                &self.idempotency_key.as_ref().map(|_| "<redacted>"),
            )
            .field("execute_before_ms", &self.execute_before_ms)
            .finish()
    }
}

/// A duplicate decision is an explicit rejection, never permission to invoke
/// the operation again. No response content is cached by this policy module.
#[derive(Debug, PartialEq, Eq)]
pub enum ReservationDecision {
    ExecuteOnce(ExecutionReservation),
    RejectDuplicateDoNotExecute(IdempotencyState),
}

struct SeenRequest {
    request_id: String,
    expires_at_ms: u64,
}

struct SeenIdempotencyKey {
    key: String,
    operation: ApprovedOperation,
    fingerprint: RequestFingerprint,
    owner_request_id: String,
    state: IdempotencyState,
    retained_until_ms: u64,
}

/// Bounded, generation-scoped replay metadata. It stores identifiers and a
/// digest only; it never stores request or response content.
pub struct MetadataLedger {
    generation: CenterGeneration,
    capacity: usize,
    requests: VecDeque<SeenRequest>,
    idempotency: VecDeque<SeenIdempotencyKey>,
}

impl MetadataLedger {
    pub fn new(generation: CenterGeneration, capacity: usize) -> Result<Self, PolicyError> {
        if capacity == 0 || capacity > MAX_LEDGER_ENTRIES {
            return Err(PolicyError::InvalidLedgerCapacity);
        }
        Ok(Self {
            generation,
            capacity,
            requests: VecDeque::with_capacity(capacity),
            idempotency: VecDeque::with_capacity(capacity),
        })
    }

    /// Advance to a fresh remote-session generation and erase only old
    /// metadata. Equal or decreasing generations fail closed.
    pub fn advance_generation(&mut self, generation: CenterGeneration) -> Result<(), PolicyError> {
        if generation.get() <= self.generation.get() {
            return Err(PolicyError::GenerationNotAdvanced);
        }
        self.generation = generation;
        self.requests.clear();
        self.idempotency.clear();
        Ok(())
    }

    pub fn admit(
        &mut self,
        request: &ValidatedRequest,
        fingerprint: RequestFingerprint,
        now_ms: u64,
    ) -> Result<ReservationDecision, PolicyError> {
        if request.generation != self.generation {
            return Err(PolicyError::GenerationMismatch);
        }
        if now_ms >= request.expires_at_ms {
            return Err(PolicyError::RequestExpired);
        }

        self.requests.retain(|entry| entry.expires_at_ms > now_ms);
        self.idempotency
            .retain(|entry| entry.retained_until_ms > now_ms);

        if self
            .requests
            .iter()
            .any(|entry| entry.request_id == request.request_id)
        {
            return Err(PolicyError::ReplayDetected);
        }

        let existing_idempotency = request
            .idempotency_key
            .as_ref()
            .and_then(|key| self.idempotency.iter().position(|entry| entry.key == *key));
        if let Some(index) = existing_idempotency {
            let entry = &self.idempotency[index];
            if entry.operation != request.operation || entry.fingerprint != fingerprint {
                return Err(PolicyError::IdempotencyConflict);
            }
            if self.requests.len() >= self.capacity {
                return Err(PolicyError::LedgerFull);
            }
            self.requests.push_back(SeenRequest {
                request_id: request.request_id.clone(),
                expires_at_ms: request.expires_at_ms,
            });
            let retained_until_ms = now_ms.saturating_add(IDEMPOTENCY_RETENTION_MS);
            self.idempotency[index].retained_until_ms = self.idempotency[index]
                .retained_until_ms
                .max(retained_until_ms);
            return Ok(ReservationDecision::RejectDuplicateDoNotExecute(
                self.idempotency[index].state,
            ));
        }

        if self.requests.len() >= self.capacity
            || (request.idempotency_key.is_some() && self.idempotency.len() >= self.capacity)
        {
            return Err(PolicyError::LedgerFull);
        }

        let reservation = ExecutionReservation {
            generation: request.generation,
            operation: request.operation,
            request_id: request.request_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            execute_before_ms: request.expires_at_ms,
        };
        self.requests.push_back(SeenRequest {
            request_id: request.request_id.clone(),
            expires_at_ms: request.expires_at_ms,
        });
        if let Some(key) = &request.idempotency_key {
            self.idempotency.push_back(SeenIdempotencyKey {
                key: key.clone(),
                operation: request.operation,
                fingerprint,
                owner_request_id: request.request_id.clone(),
                state: IdempotencyState::InFlight,
                retained_until_ms: now_ms.saturating_add(IDEMPOTENCY_RETENTION_MS),
            });
        }
        Ok(ReservationDecision::ExecuteOnce(reservation))
    }

    /// Record only the terminal metadata state of a mutation reservation. No
    /// response or request content is retained. An unrecorded outcome stays
    /// `InFlight` and duplicates continue to fail closed.
    pub fn record_completion(
        &mut self,
        reservation: &ExecutionReservation,
        completion: CompletionState,
        now_ms: u64,
    ) -> Result<(), PolicyError> {
        if reservation.generation != self.generation {
            return Err(PolicyError::GenerationMismatch);
        }
        let key = reservation
            .idempotency_key
            .as_ref()
            .ok_or(PolicyError::ReservationNotTracked)?;
        let entry = self
            .idempotency
            .iter_mut()
            .find(|entry| {
                entry.key == *key
                    && entry.operation == reservation.operation
                    && entry.owner_request_id == reservation.request_id
            })
            .ok_or(PolicyError::ReservationNotTracked)?;
        if entry.state != IdempotencyState::InFlight {
            return Err(PolicyError::InvalidReservationState);
        }
        entry.state = match completion {
            CompletionState::Completed => IdempotencyState::Completed,
            CompletionState::Indeterminate => IdempotencyState::Indeterminate,
        };
        entry.retained_until_ms = entry
            .retained_until_ms
            .max(now_ms.saturating_add(IDEMPOTENCY_RETENTION_MS));
        Ok(())
    }

    /// A reservation can start only before the signed envelope expires and
    /// while its generation and in-flight metadata remain current.
    pub fn reservation_may_start(&self, reservation: &ExecutionReservation, now_ms: u64) -> bool {
        if now_ms >= reservation.execute_before_ms
            || !self.reservation_generation_is_current(reservation)
        {
            return false;
        }
        match &reservation.idempotency_key {
            Some(key) => self.idempotency.iter().any(|entry| {
                entry.key == *key
                    && entry.operation == reservation.operation
                    && entry.owner_request_id == reservation.request_id
                    && entry.state == IdempotencyState::InFlight
            }),
            None => true,
        }
    }

    /// Generation check for the integration's commit fence after an operation
    /// has started. The caller must perform this while holding the same
    /// serialization boundary that guards publication; a check followed by an
    /// unlocked commit is not sufficient.
    pub fn reservation_generation_is_current(&self, reservation: &ExecutionReservation) -> bool {
        reservation.generation == self.generation
    }

    pub fn tracked_requests(&self) -> usize {
        self.requests.len()
    }

    pub fn tracked_idempotency_keys(&self) -> usize {
        self.idempotency.len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyError {
    InvalidMethod,
    TargetTooLong,
    InvalidOriginForm,
    AmbiguousTarget,
    QueryNotAllowed,
    InvalidPath,
    HardDeniedRoute,
    RouteNotAllowed,
    CapabilityRequired(Capability),
    TooManyHeaders,
    HeadersTooLarge,
    ContentTypeNotAllowed,
    InvalidContentType,
    ContentLengthRequired,
    BodyLengthMismatch,
    BodyTooLarge,
    InvalidSpotifySearchQuery,
    InvalidGeneration,
    GenerationMismatch,
    InvalidFreshnessWindow,
    RequestFromFuture,
    RequestExpired,
    RequestTooOld,
    InvalidRequestId,
    MissingIdempotencyKey,
    UnexpectedIdempotencyKey,
    InvalidIdempotencyKey,
    InvalidLedgerCapacity,
    GenerationNotAdvanced,
    ReplayDetected,
    IdempotencyConflict,
    LedgerFull,
    ReservationNotTracked,
    InvalidReservationState,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidMethod => "request method is invalid",
            Self::TargetTooLong => "request target is too long",
            Self::InvalidOriginForm => "request target is not origin-form",
            Self::AmbiguousTarget => "request target encoding is ambiguous",
            Self::QueryNotAllowed => "query strings are not allowed",
            Self::InvalidPath => "request path is invalid",
            Self::HardDeniedRoute => "request route is hard-denied",
            Self::RouteNotAllowed => "request route is not allowlisted",
            Self::CapabilityRequired(_) => "request route requires a missing capability",
            Self::TooManyHeaders => "request has too many headers",
            Self::HeadersTooLarge => "request headers are too large",
            Self::ContentTypeNotAllowed => "request content type is not allowed for this route",
            Self::InvalidContentType => "request content type is invalid for this route",
            Self::ContentLengthRequired => "request requires an exact content length",
            Self::BodyLengthMismatch => "request body length does not match its declaration",
            Self::BodyTooLarge => "request body is too large for the route",
            Self::InvalidSpotifySearchQuery => "Spotify search query is invalid",
            Self::InvalidGeneration => "request generation is invalid",
            Self::GenerationMismatch => "request generation is not current",
            Self::InvalidFreshnessWindow => "request freshness window is invalid",
            Self::RequestFromFuture => "request issue time is too far in the future",
            Self::RequestExpired => "request has expired",
            Self::RequestTooOld => "request is too old",
            Self::InvalidRequestId => "request identifier is invalid",
            Self::MissingIdempotencyKey => "write request is missing an idempotency key",
            Self::UnexpectedIdempotencyKey => "read request supplied an idempotency key",
            Self::InvalidIdempotencyKey => "idempotency key is invalid",
            Self::InvalidLedgerCapacity => "metadata ledger capacity is invalid",
            Self::GenerationNotAdvanced => "metadata ledger generation did not advance",
            Self::ReplayDetected => "request identifier was already seen",
            Self::IdempotencyConflict => "idempotency key was reused for a different request",
            Self::LedgerFull => "metadata ledger is full",
            Self::ReservationNotTracked => "execution reservation is not tracked",
            Self::InvalidReservationState => "execution reservation is already terminal",
        })
    }
}

impl std::error::Error for PolicyError {}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSET_ENTRIES: &[&str] = &[
        "index.html",
        "assets/app-abc123.js",
        "assets/app-abc123.css",
    ];
    const NOW_MS: u64 = 1_000_000;
    const GENERATION: u64 = 7;

    fn catalog() -> CenterAssetCatalog<'static> {
        CenterAssetCatalog::new(ASSET_ENTRIES).unwrap()
    }

    fn envelope<'a>(method: &'a str, target: &'a str) -> RequestEnvelope<'a> {
        RequestEnvelope {
            method,
            target,
            content_type: None,
            header_count: 0,
            header_bytes: 0,
            body_bytes: 0,
            declared_body_bytes: None,
            issued_at_ms: NOW_MS - 1_000,
            expires_at_ms: NOW_MS + 30_000,
            generation: GENERATION,
            request_id: "request-0000000001",
            idempotency_key: None,
        }
    }

    fn context<'catalog, 'entries>(
        assets: &'catalog CenterAssetCatalog<'entries>,
        capabilities: Capabilities,
    ) -> PolicyContext<'catalog, 'entries> {
        PolicyContext {
            now_ms: NOW_MS,
            expected_generation: CenterGeneration::new(GENERATION).unwrap(),
            capabilities,
            center_assets: assets,
        }
    }

    fn mutation_request(
        request_id: &str,
        idempotency_key: &str,
        expires_at_ms: u64,
    ) -> ValidatedRequest {
        ValidatedRequest {
            operation: ApprovedOperation::Api(ApiOperation::TestMutation),
            scope: SENSITIVE_WRITE,
            generation: CenterGeneration::new(GENERATION).unwrap(),
            request_id: request_id.to_owned(),
            idempotency_key: Some(idempotency_key.to_owned()),
            expires_at_ms,
        }
    }

    fn fingerprint(byte: u8) -> RequestFingerprint {
        RequestFingerprint::from_locally_computed_digest([byte; 32])
    }

    #[test]
    fn asset_catalog_requires_exact_safe_unique_entries_and_index() {
        assert_eq!(
            CenterAssetCatalog::new(&[]).unwrap_err(),
            CatalogError::Empty
        );
        assert_eq!(
            CenterAssetCatalog::new(&["assets/app.js"]).unwrap_err(),
            CatalogError::MissingIndex
        );
        assert_eq!(
            CenterAssetCatalog::new(&["index.html", "index.html"]).unwrap_err(),
            CatalogError::DuplicateEntry
        );
        for entry in [
            "/index.html",
            "../index.html",
            "assets//app.js",
            "assets/%2e%2e/app.js",
            "assets/app.js?x=1",
            "assets\\app.js",
        ] {
            assert_eq!(
                CenterAssetCatalog::new(&["index.html", entry]).unwrap_err(),
                CatalogError::InvalidEntry,
                "{entry}"
            );
        }
    }

    #[test]
    fn only_exact_catalog_assets_are_enabled_for_get_and_head() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());
        let cases = [
            (
                "GET",
                "/center/",
                CenterOperation::Asset {
                    method: AssetMethod::Get,
                    catalog: assets.identity,
                    catalog_index: 0,
                },
            ),
            (
                "HEAD",
                "/center/assets/app-abc123.js",
                CenterOperation::Asset {
                    method: AssetMethod::Head,
                    catalog: assets.identity,
                    catalog_index: 1,
                },
            ),
        ];
        for (method, target, expected) in cases {
            let approved = authorize(&envelope(method, target), &policy).unwrap();
            assert_eq!(approved.operation, ApprovedOperation::CenterAsset(expected));
            assert_eq!(approved.scope(), NON_SENSITIVE_READ);
        }

        let approved =
            authorize(&envelope("GET", "/center/assets/app-abc123.js"), &policy).unwrap();
        let ApprovedOperation::CenterAsset(operation) = approved.operation else {
            panic!("expected a Center asset operation");
        };
        assert_eq!(assets.resolve(operation), Some("assets/app-abc123.js"));
        let other_catalog = catalog();
        assert_eq!(other_catalog.resolve(operation), None);

        assert_eq!(
            authorize(
                &envelope("GET", "/center/assets/not-in-manifest.js"),
                &policy
            )
            .unwrap_err(),
            PolicyError::RouteNotAllowed
        );
        assert_eq!(
            authorize(&envelope("POST", "/center/"), &policy).unwrap_err(),
            PolicyError::RouteNotAllowed
        );
        for redirect in ["/", "/center"] {
            assert_eq!(
                authorize(&envelope("GET", redirect), &policy).unwrap_err(),
                PolicyError::RouteNotAllowed
            );
        }
    }

    #[test]
    fn default_api_allowlist_is_exact_get_health_only() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());
        let approved = authorize(&envelope("GET", "/api/health"), &policy).unwrap();
        assert_eq!(
            approved.operation,
            ApprovedOperation::Api(ApiOperation::Health)
        );
        assert_eq!(approved.scope(), NON_SENSITIVE_READ);

        for (method, path) in [
            ("HEAD", "/api/health"),
            ("POST", "/api/health"),
            ("GET", "/api"),
            ("GET", "/api/health/extra"),
        ] {
            assert!(authorize(&envelope(method, path), &policy).is_err());
        }
    }

    #[test]
    fn future_routes_need_distinct_capabilities_and_receive_scopes() {
        let assets = catalog();

        let device_policy = context(
            &assets,
            Capabilities::none().with(Capability::DeviceMetadataRead),
        );
        let device = authorize(&envelope("GET", "/api/device"), &device_policy).unwrap();
        assert_eq!(
            device.operation,
            ApprovedOperation::Api(ApiOperation::DeviceMetadata)
        );
        assert_eq!(device.scope().mode, AccessMode::Read);
        assert!(device.scope().is_sensitive());
        assert_eq!(
            authorize(&envelope("GET", "/api/feature-flags"), &device_policy).unwrap_err(),
            PolicyError::CapabilityRequired(Capability::FeatureFlagsRead)
        );

        let read_policy = context(
            &assets,
            Capabilities::none().with(Capability::FeatureFlagsRead),
        );
        let read = authorize(&envelope("GET", "/api/feature-flags"), &read_policy).unwrap();
        assert_eq!(read.scope(), SENSITIVE_READ);

        let all_reviewed_reads = context(
            &assets,
            Capabilities::none()
                .with(Capability::DeviceMetadataRead)
                .with(Capability::FeatureFlagsRead),
        );
        assert_eq!(
            authorize(&envelope("PUT", "/api/feature-flags"), &all_reviewed_reads).unwrap_err(),
            PolicyError::RouteNotAllowed
        );
    }

    #[test]
    fn spotify_routes_require_separate_read_and_manage_capabilities() {
        let assets = catalog();
        let read_policy = context(&assets, Capabilities::none().with(Capability::SpotifyRead));
        let status = authorize(&envelope("GET", "/api/spotify/status"), &read_policy).unwrap();
        assert_eq!(
            status.operation,
            ApprovedOperation::Api(ApiOperation::SpotifyStatus)
        );
        assert_eq!(status.scope(), SENSITIVE_READ);

        let search = authorize(
            &envelope("GET", "/api/spotify/search?q=No+Surprises&kind=track"),
            &read_policy,
        )
        .unwrap();
        let ApprovedOperation::Api(ApiOperation::SpotifySearch(query)) = search.operation else {
            panic!("expected a typed Spotify search operation");
        };
        assert_eq!(query.as_str(), "No Surprises");

        let mut settings = envelope("PUT", "/api/spotify/settings");
        settings.content_type = Some("application/json");
        settings.header_count = 1;
        settings.header_bytes = 28;
        settings.body_bytes = 64;
        settings.declared_body_bytes = Some(64);
        settings.idempotency_key = Some("spotify-settings-0001");
        assert_eq!(
            authorize(&settings, &read_policy).unwrap_err(),
            PolicyError::CapabilityRequired(Capability::SpotifyManage)
        );

        let manage_policy = context(
            &assets,
            Capabilities::none().with(Capability::SpotifyManage),
        );
        let update = authorize(&settings, &manage_policy).unwrap();
        assert_eq!(
            update.operation,
            ApprovedOperation::Api(ApiOperation::SpotifySettingsUpdate)
        );
        assert_eq!(update.scope(), SENSITIVE_WRITE);

        for (method, path, operation) in [
            (
                "POST",
                "/api/spotify/pairing/start",
                ApiOperation::SpotifyPairingStart,
            ),
            (
                "POST",
                "/api/spotify/pairing/cancel",
                ApiOperation::SpotifyPairingCancel,
            ),
            (
                "DELETE",
                "/api/spotify/session",
                ApiOperation::SpotifySessionDelete,
            ),
        ] {
            let mut request = envelope(method, path);
            request.declared_body_bytes = Some(0);
            request.idempotency_key = Some("spotify-mutation-0001");
            let approved = authorize(&request, &manage_policy).unwrap();
            assert_eq!(approved.operation, ApprovedOperation::Api(operation));
        }

        assert_eq!(
            authorize(&envelope("GET", "/api/spotify/status"), &manage_policy,).unwrap_err(),
            PolicyError::CapabilityRequired(Capability::SpotifyRead)
        );
    }

    #[test]
    fn spotify_search_and_settings_are_strictly_bounded() {
        let assets = catalog();
        let read_policy = context(&assets, Capabilities::none().with(Capability::SpotifyRead));
        for target in [
            "/api/spotify/search",
            "/api/spotify/search?q=hello",
            "/api/spotify/search?q=hello&kind=artist",
            "/api/spotify/search?q=hello&kind=track&extra=1",
            "/api/spotify/search?q=%0A&kind=track",
            "/api/spotify/search?q=%GG&kind=track",
            "/api/spotify/search?q=+&kind=track",
            "/api/spotify/search?q=one&q=two&kind=track",
        ] {
            assert!(
                authorize(&envelope("GET", target), &read_policy).is_err(),
                "{target}"
            );
        }
        let encoded = authorize(
            &envelope("GET", "/api/spotify/search?kind=track&q=Bj%C3%B6rk"),
            &read_policy,
        )
        .unwrap();
        let ApprovedOperation::Api(ApiOperation::SpotifySearch(query)) = encoded.operation else {
            panic!("expected typed search");
        };
        assert_eq!(query.as_str(), "Björk");

        let manage_policy = context(
            &assets,
            Capabilities::none().with(Capability::SpotifyManage),
        );
        let mut settings = envelope("PUT", "/api/spotify/settings");
        settings.body_bytes = 1;
        settings.declared_body_bytes = Some(1);
        settings.idempotency_key = Some("spotify-settings-0001");
        assert_eq!(
            authorize(&settings, &manage_policy).unwrap_err(),
            PolicyError::InvalidContentType
        );
        settings.content_type = Some("text/plain");
        assert_eq!(
            authorize(&settings, &manage_policy).unwrap_err(),
            PolicyError::InvalidContentType
        );
        settings.content_type = Some("application/json");
        settings.body_bytes = MAX_SPOTIFY_SETTINGS_BODY_BYTES + 1;
        settings.declared_body_bytes = Some(settings.body_bytes);
        assert_eq!(
            authorize(&settings, &manage_policy).unwrap_err(),
            PolicyError::BodyTooLarge
        );
    }

    #[test]
    fn current_admin_and_personal_surfaces_are_denied_by_default() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());
        for (method, path) in [
            ("GET", "/api/device"),
            ("GET", "/api/settings"),
            ("PUT", "/api/settings"),
            ("GET", "/api/events"),
            ("GET", "/api/activity/notes"),
            ("GET", "/api/contacts"),
            ("POST", "/api/contacts"),
            ("GET", "/api/memories"),
            ("DELETE", "/api/memories/example"),
            ("GET", "/api/fitness/sessions"),
            ("GET", "/api/spotify/status"),
            ("GET", "/api/spotify/search"),
            ("GET", "/api/codex/status"),
            ("POST", "/api/codex/login/device-code"),
            ("GET", "/api/feature-flags"),
            ("PUT", "/api/feature-flags"),
            ("PUT", "/api/wifi/set-enabled"),
            ("PUT", "/api/cellular/set-enabled"),
            ("GET", "/api/esim/state"),
            ("POST", "/api/provider/login"),
        ] {
            assert!(
                authorize(&envelope(method, path), &policy).is_err(),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn upload_internal_dev_log_and_hook_routes_are_hard_denied() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());
        for path in [
            "/upload",
            "/upload/id/file",
            "/aibus-upload/ticket",
            "/internal",
            "/internal/status",
            "/api/dev/install",
            "/api/logs/server",
            "/api/logs/logcat",
            "/api/esim/state",
            "/api/esim/delete-profile",
            "/api/cellular/set-enabled",
            "/api/wifi/set-enabled",
            "/api/spotify/diagnostics",
            "/api/spotify/diagnostics/track/example",
            "/_penumbra/hooks/v1/inbound-settings",
            "/_penumbra/hooks/v1/contact-reset-claim",
            "/hooks/example",
            "/_hooks/example",
            "/api/hooks/example",
            "/api/contacts/client-reset/claim",
        ] {
            assert_eq!(
                authorize(&envelope("GET", path), &policy).unwrap_err(),
                PolicyError::HardDeniedRoute,
                "{path}"
            );
        }
    }

    #[test]
    fn legacy_full_access_keeps_local_only_routes_denied_and_uses_write_guards() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());

        for path in [
            "/api/esim/state",
            "/api/esim/delete-profile",
            "/api/cellular/set-enabled",
            "/api/wifi/set-enabled",
            "/api/logs/server",
            "/api/spotify/diagnostics/track/example",
            "/upload/example",
        ] {
            assert_eq!(
                authorize_full_access(&envelope("GET", path), &policy).unwrap_err(),
                PolicyError::HardDeniedRoute,
                "{path}"
            );
        }

        let mut write = envelope("PUT", "/api/settings");
        write.body_bytes = 2;
        write.declared_body_bytes = Some(2);
        assert_eq!(
            authorize_full_access(&write, &policy).unwrap_err(),
            PolicyError::MissingIdempotencyKey
        );
        write.idempotency_key = Some("idempotency-key-0001");
        let validated = authorize_full_access(&write, &policy).unwrap();
        assert_eq!(validated.scope(), SENSITIVE_WRITE);
    }

    #[test]
    fn traversal_encoding_absolute_targets_and_queries_fail_closed() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());
        for target in [
            "/center/../index.html",
            "/center/./index.html",
            "/center//index.html",
            "/center/%2e%2e/index.html",
            "/center/%252e%252e/index.html",
            "/api/%68ealth",
            "/api/health?",
            "/api/health?x=1",
            "/api/health#fragment",
            "/center\\index.html",
            "http://localhost/api/health",
            "http://127.0.0.1/api/health",
            "//localhost/api/health",
            "/center/café",
        ] {
            assert!(
                authorize(&envelope("GET", target), &policy).is_err(),
                "{target}"
            );
        }
    }

    #[test]
    fn request_envelope_sizes_and_declared_length_are_bounded() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());

        let mut too_many_headers = envelope("GET", "/api/health");
        too_many_headers.header_count = MAX_HEADER_COUNT + 1;
        assert_eq!(
            authorize(&too_many_headers, &policy).unwrap_err(),
            PolicyError::TooManyHeaders
        );

        let mut headers_too_large = envelope("GET", "/api/health");
        headers_too_large.header_bytes = MAX_HEADER_BYTES + 1;
        assert_eq!(
            authorize(&headers_too_large, &policy).unwrap_err(),
            PolicyError::HeadersTooLarge
        );

        let mut mismatch = envelope("GET", "/api/health");
        mismatch.declared_body_bytes = Some(1);
        assert_eq!(
            authorize(&mismatch, &policy).unwrap_err(),
            PolicyError::BodyLengthMismatch
        );

        let mut body = envelope("GET", "/api/health");
        body.body_bytes = 1;
        body.declared_body_bytes = Some(1);
        assert_eq!(
            authorize(&body, &policy).unwrap_err(),
            PolicyError::BodyTooLarge
        );
    }

    #[test]
    fn freshness_and_generation_are_exact_and_bounded() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());

        let mut request = envelope("GET", "/api/health");
        request.generation = 0;
        assert_eq!(
            authorize(&request, &policy).unwrap_err(),
            PolicyError::InvalidGeneration
        );

        request = envelope("GET", "/api/health");
        request.generation += 1;
        assert_eq!(
            authorize(&request, &policy).unwrap_err(),
            PolicyError::GenerationMismatch
        );

        request = envelope("GET", "/api/health");
        request.expires_at_ms = NOW_MS;
        assert_eq!(
            authorize(&request, &policy).unwrap_err(),
            PolicyError::RequestExpired
        );

        request = envelope("GET", "/api/health");
        request.issued_at_ms = NOW_MS + MAX_CLOCK_SKEW_MS + 1;
        request.expires_at_ms = request.issued_at_ms + 1_000;
        assert_eq!(
            authorize(&request, &policy).unwrap_err(),
            PolicyError::RequestFromFuture
        );

        request = envelope("GET", "/api/health");
        request.issued_at_ms = NOW_MS - MAX_REQUEST_AGE_MS - 1;
        request.expires_at_ms = NOW_MS + 1;
        assert_eq!(
            authorize(&request, &policy).unwrap_err(),
            PolicyError::RequestTooOld
        );

        request = envelope("GET", "/api/health");
        request.expires_at_ms = request.issued_at_ms + MAX_REQUEST_LIFETIME_MS + 1;
        assert_eq!(
            authorize(&request, &policy).unwrap_err(),
            PolicyError::InvalidFreshnessWindow
        );
    }

    #[test]
    fn idempotency_metadata_is_required_only_for_writes() {
        let assets = catalog();
        let read_policy = context(&assets, Capabilities::none());
        let mut read = envelope("GET", "/api/health");
        read.idempotency_key = Some("idempotency-000001");
        assert_eq!(
            authorize(&read, &read_policy).unwrap_err(),
            PolicyError::UnexpectedIdempotencyKey
        );

        assert_eq!(
            validate_idempotency(SENSITIVE_WRITE, None).unwrap_err(),
            PolicyError::MissingIdempotencyKey
        );
        assert_eq!(
            validate_idempotency(SENSITIVE_WRITE, Some("short")).unwrap_err(),
            PolicyError::InvalidIdempotencyKey
        );
        assert_eq!(
            validate_idempotency(SENSITIVE_WRITE, Some("idempotency-000001")).unwrap(),
            Some("idempotency-000001".to_owned())
        );
    }

    #[test]
    fn ledger_reserves_once_and_rejects_duplicate_without_reexecution() {
        let generation = CenterGeneration::new(GENERATION).unwrap();
        let first = mutation_request("request-0000000001", "idempotency-000001", NOW_MS + 30_000);
        let request_fingerprint = fingerprint(1);
        let mut ledger = MetadataLedger::new(generation, 8).unwrap();
        let ReservationDecision::ExecuteOnce(reservation) =
            ledger.admit(&first, request_fingerprint, NOW_MS).unwrap()
        else {
            panic!("first request must receive the only execution reservation");
        };
        assert!(ledger.reservation_may_start(&reservation, NOW_MS));
        assert!(!ledger.reservation_may_start(&reservation, NOW_MS + 30_000));
        assert_eq!(
            ledger
                .admit(&first, request_fingerprint, NOW_MS)
                .unwrap_err(),
            PolicyError::ReplayDetected
        );

        let retry = mutation_request("request-0000000002", "idempotency-000001", NOW_MS + 30_000);
        assert_eq!(
            ledger.admit(&retry, request_fingerprint, NOW_MS).unwrap(),
            ReservationDecision::RejectDuplicateDoNotExecute(IdempotencyState::InFlight)
        );

        let conflict =
            mutation_request("request-0000000003", "idempotency-000001", NOW_MS + 30_000);
        assert_eq!(
            ledger.admit(&conflict, fingerprint(2), NOW_MS).unwrap_err(),
            PolicyError::IdempotencyConflict
        );

        ledger
            .record_completion(&reservation, CompletionState::Completed, NOW_MS)
            .unwrap();
        assert!(!ledger.reservation_may_start(&reservation, NOW_MS));
        assert!(ledger.reservation_generation_is_current(&reservation));
        let completed_retry =
            mutation_request("request-0000000004", "idempotency-000001", NOW_MS + 30_000);
        assert_eq!(
            ledger
                .admit(&completed_retry, request_fingerprint, NOW_MS)
                .unwrap(),
            ReservationDecision::RejectDuplicateDoNotExecute(IdempotencyState::Completed)
        );
        assert_eq!(ledger.tracked_requests(), 3);
        assert_eq!(ledger.tracked_idempotency_keys(), 1);
    }

    #[test]
    fn idempotency_reservation_outlives_request_expiry() {
        let generation = CenterGeneration::new(GENERATION).unwrap();
        let first = mutation_request("request-0000000001", "idempotency-000001", NOW_MS + 1_000);
        let request_fingerprint = fingerprint(5);
        let mut ledger = MetadataLedger::new(generation, 4).unwrap();
        let ReservationDecision::ExecuteOnce(_) =
            ledger.admit(&first, request_fingerprint, NOW_MS).unwrap()
        else {
            panic!("first request must reserve execution");
        };

        let later = NOW_MS + 2_000;
        let retry = mutation_request("request-0000000002", "idempotency-000001", later + 30_000);
        assert_eq!(
            ledger.admit(&retry, request_fingerprint, later).unwrap(),
            ReservationDecision::RejectDuplicateDoNotExecute(IdempotencyState::InFlight)
        );
    }

    #[test]
    fn ledger_capacity_fails_closed_until_expired_metadata_is_pruned() {
        let assets = catalog();
        let generation = CenterGeneration::new(GENERATION).unwrap();
        let policy = context(&assets, Capabilities::none());
        let first = authorize(&envelope("GET", "/api/health"), &policy).unwrap();
        let mut ledger = MetadataLedger::new(generation, 1).unwrap();
        let request_fingerprint = fingerprint(3);
        assert!(matches!(
            ledger.admit(&first, request_fingerprint, NOW_MS).unwrap(),
            ReservationDecision::ExecuteOnce(_)
        ));

        let mut second_envelope = envelope("GET", "/api/health");
        second_envelope.request_id = "request-0000000002";
        let second = authorize(&second_envelope, &policy).unwrap();
        assert_eq!(
            ledger
                .admit(&second, request_fingerprint, NOW_MS)
                .unwrap_err(),
            PolicyError::LedgerFull
        );

        let later = first.expires_at_ms();
        let later_policy = PolicyContext {
            now_ms: later,
            expected_generation: generation,
            capabilities: Capabilities::none(),
            center_assets: &assets,
        };
        let mut later_envelope = envelope("GET", "/api/health");
        later_envelope.request_id = "request-0000000003";
        later_envelope.issued_at_ms = later;
        later_envelope.expires_at_ms = later + 1_000;
        let later_request = authorize(&later_envelope, &later_policy).unwrap();
        assert_eq!(
            ledger
                .admit(&later_request, request_fingerprint, later)
                .unwrap(),
            ReservationDecision::ExecuteOnce(ExecutionReservation {
                generation,
                operation: ApprovedOperation::Api(ApiOperation::Health),
                request_id: "request-0000000003".to_owned(),
                idempotency_key: None,
                execute_before_ms: later + 1_000,
            })
        );
    }

    #[test]
    fn generation_advance_clears_metadata_and_rejects_rollback() {
        let assets = catalog();
        let old_generation = CenterGeneration::new(GENERATION).unwrap();
        let new_generation = CenterGeneration::new(GENERATION + 1).unwrap();
        let policy = context(&assets, Capabilities::none());
        let request = authorize(&envelope("GET", "/api/health"), &policy).unwrap();
        let request_fingerprint = fingerprint(4);
        let mut ledger = MetadataLedger::new(old_generation, 2).unwrap();
        let ReservationDecision::ExecuteOnce(reservation) =
            ledger.admit(&request, request_fingerprint, NOW_MS).unwrap()
        else {
            panic!("first request must reserve execution");
        };

        ledger.advance_generation(new_generation).unwrap();
        assert_eq!(ledger.tracked_requests(), 0);
        assert!(!ledger.reservation_generation_is_current(&reservation));
        assert_eq!(
            ledger.advance_generation(old_generation).unwrap_err(),
            PolicyError::GenerationNotAdvanced
        );
        assert_eq!(
            ledger
                .admit(&request, request_fingerprint, NOW_MS)
                .unwrap_err(),
            PolicyError::GenerationMismatch
        );
    }

    #[test]
    fn invalid_method_and_metadata_tokens_are_rejected() {
        let assets = catalog();
        let policy = context(&assets, Capabilities::none());
        assert_eq!(
            authorize(&envelope("get", "/api/health"), &policy).unwrap_err(),
            PolicyError::InvalidMethod
        );
        let mut request = envelope("GET", "/api/health");
        request.request_id = "short";
        assert_eq!(
            authorize(&request, &policy).unwrap_err(),
            PolicyError::InvalidRequestId
        );
        assert_eq!(
            MetadataLedger::new(CenterGeneration::new(1).unwrap(), 0)
                .err()
                .unwrap(),
            PolicyError::InvalidLedgerCapacity
        );
    }
}
