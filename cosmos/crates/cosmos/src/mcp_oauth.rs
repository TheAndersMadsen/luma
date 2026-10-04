//! OAuth sign-in for MCP servers.
//!
//! **Not a stock surface.** Part of the MCP extension (`crate::mcp`), so every
//! behaviour is INFERRED design. It follows the MCP authorization flow,
//! revision 2025-06-18: an OAuth 2.1 authorization code grant with PKCE, for a
//! public client that registers itself.
//!
//! ## Shape
//!
//! * **Cosmos runs the whole exchange and keeps every secret.** Center only
//!   moves the owner's browser: it asks Cosmos for the address to open, and
//!   hands back the `state` and `code` the provider returned.
//! * **Discovery** starts from the server itself: its `401` names an OAuth
//!   Protected Resource Metadata document (RFC 9728), or the well-known path
//!   holds one. That document names the authorization server, whose own
//!   metadata (RFC 8414, then OpenID Connect discovery) names its endpoints.
//! * **Registration** is dynamic (RFC 7591), as a public client with no secret.
//!   The client is kept and used again for the next sign-in to the same server.
//! * **Sign-in state** lives in `mcp-oauth.json` beside `mcp.json`, owner-only:
//!   the client, the token endpoint, and the tokens, bound to the server URL
//!   they were issued for. A sign-in the browser has not finished yet lives in
//!   memory for ten minutes.
//! * **A token is sent** as `Authorization: Bearer` only to the URL it was
//!   issued for, and only while the owner has not typed an `Authorization`
//!   header for that server. It is renewed with the refresh token when it has
//!   run out, or once when the server refuses it.
//!
//! ## How this can fail, and what each failure does
//!
//! Written before the code, per the repository's testing policy.
//!
//! 1. The server does not say where to sign in (no resource metadata in its
//!    `401`, none at the well-known paths): the start answers that the server
//!    offers no sign-in. Nothing is stored.
//! 2. A URL taken from a remote document is not `https`, carries credentials
//!    or a fragment, or is oversized: refused before any request goes to it.
//!    Plain `http` is accepted for a loopback host only, and only when the MCP
//!    server itself is on loopback, so a remote server's documents cannot point
//!    Cosmos at a service on its own machine.
//! 3. The resource metadata describes another resource than the server's URL,
//!    or the authorization server's metadata names another issuer than the one
//!    the resource named: refused. A token must not be minted for, or by,
//!    somebody else.
//! 4. The authorization server lists its PKCE methods without `S256`, has no
//!    registration endpoint, or refuses the registration: the start answers
//!    that this sign-in cannot be used. Nothing is stored.
//! 5. A back-channel answer is slow, oversized, a redirect, or not JSON: every
//!    request has a timeout and a size cap, redirects are not followed, and
//!    the step fails.
//! 6. The owner never finishes in the browser: the pending sign-in expires
//!    after ten minutes. Pending sign-ins are capped, one per server.
//! 7. A finish arrives with an unknown, expired or already used `state`: it
//!    fails closed, and no token request is made. The `state` is consumed
//!    before the exchange, so it cannot be used twice even when that fails.
//! 8. The server was removed, or its URL changed, between start and finish:
//!    refused. The `state` is bound to one server id and URL.
//! 9. The token endpoint refuses the code, or answers without a usable Bearer
//!    token: nothing is kept, the registered client included, so the next
//!    attempt starts clean.
//! 10. The access token has run out: it is renewed once before the request. A
//!     server that refuses a token gets one renewal and one retry.
//! 11. The renewal is refused, or there is no refresh token: the tokens are
//!     dropped and the server reads `sign_in_required`, so Center can say
//!     "sign in again". The registered client is kept.
//! 12. The authorization server cannot be reached during a renewal: the call
//!     fails as unreachable or timed out and the tokens are kept, so a later
//!     call tries again.
//! 13. Two requests renew at once, and a rotating refresh token would make
//!     the second fail: one renewal runs at a time, and the second request
//!     uses what the first obtained.
//! 14. The owner typed an `Authorization` header for the server: theirs is the
//!     credential, no stored token is sent, and a sign-in is refused until
//!     they remove it. Such a server behaves exactly as it did before.
//! 15. The owner changes the server's URL after signing in: the tokens stay
//!     bound to the old URL and are never sent to the new one.
//! 16. `mcp-oauth.json` cannot be read: Cosmos starts signed out and says so
//!     in the log. With no state directory a sign-in cannot be saved, and the
//!     start answers a persistence error instead of pretending.
//! 17. A token holds bytes that cannot travel in a header: refused when it is
//!     received.
//! 18. Anything is logged: only a stage name and a status code. Never a token,
//!     a code, a verifier, a client secret, or a URL.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::StreamExt as _;
use reqwest::Url;
use reqwest::header::{ACCEPT, HeaderMap, WWW_AUTHENTICATE};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::mcp::{McpCallError, McpServer, McpStore};

const OAUTH_FILE: &str = "mcp-oauth.json";

const MAX_URL_BYTES: usize = 2048;
const MAX_DOCUMENT_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_CLIENT_FIELD_BYTES: usize = 1024;
const MAX_SCOPE_BYTES: usize = 1024;
const MAX_STATE_BYTES: usize = 128;
const MAX_CODE_BYTES: usize = 4096;
const MAX_PENDING: usize = 8;

/// How long the owner has to finish in the browser.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Discovery and registration together, when a sign-in starts.
const START_TIMEOUT: Duration = Duration::from_secs(12);
/// The exchange of the code for tokens, when a sign-in finishes.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(10);
/// A token this close to its end is renewed before it is sent.
const EXPIRY_SKEW_MS: u64 = 30_000;
/// The longest lifetime taken from a provider, so the sum cannot overflow.
const MAX_LIFETIME_SECONDS: u64 = 10 * 365 * 24 * 60 * 60;

/// Why a sign-in step produced nothing. Carries no provider payload.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OAuthError {
    /// No such server.
    NotFound,
    /// The owner typed an `Authorization` header for this server.
    OwnHeader,
    /// The return address Center gave is not one a provider may send to.
    Redirect,
    /// The server names no place to sign in.
    NotOffered,
    /// A discovered URL or document cannot be trusted.
    Unsafe,
    /// The sign-in needs something this client does not do.
    Unsupported,
    /// The server or its authorization server did not answer.
    Unavailable,
    /// The `state` is unknown, expired, already used, or for a changed server.
    State,
    /// The provider did not turn the code into tokens.
    Exchange,
    /// The sign-in cannot be written to the state directory.
    Persistence,
}

/// What signing in to one server produced. Every field but the URLs is a
/// credential, so this type has no `Debug`.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Grant {
    /// The server URL the tokens were issued for. They go nowhere else.
    server_url: String,
    /// The RFC 8707 resource the tokens are asked for.
    resource: String,
    issuer: String,
    token_endpoint: String,
    /// The return address the client was registered with.
    redirect_uri: String,
    client_id: String,
    /// Only when the provider issued one to this public client anyway.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    /// The provider registered `client_secret_post`. Otherwise a secret is
    /// sent as HTTP Basic, the RFC 7591 default.
    secret_in_body: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    /// Unix milliseconds. Missing when the provider gave no lifetime.
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<u64>,
}

impl Grant {
    fn expired(&self) -> bool {
        self.expires_at_ms
            .is_some_and(|at| now_ms().saturating_add(EXPIRY_SKEW_MS) >= at)
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Stored {
    schema_version: u8,
    servers: BTreeMap<String, Grant>,
}

/// A sign-in the owner's browser has not finished yet.
struct Pending {
    server_id: String,
    server_url: String,
    code_verifier: String,
    expires: Instant,
}

/// The access token to send, and whether it was renewed just now.
pub(crate) struct Bearer {
    pub(crate) token: String,
    pub(crate) renewed: bool,
}

/// Why a back-channel request produced nothing.
enum Fault {
    /// The provider answered, and the answer was no.
    Refused,
    /// The answer was oversized or not what the protocol describes.
    Invalid,
    TimedOut,
    Unreachable,
}

struct Tokens {
    access: String,
    refresh: Option<String>,
    expires_at_ms: Option<u64>,
}

struct Client {
    id: String,
    secret: Option<String>,
    secret_in_body: bool,
}

/// What discovery learned about a server's sign-in.
struct Discovered {
    resource: String,
    issuer: String,
    authorization_endpoint: Url,
    token_endpoint: String,
    registration_endpoint: Option<Url>,
    scope: Option<String>,
}

pub(crate) struct OAuthStore {
    grants: Mutex<BTreeMap<String, Grant>>,
    pending: Mutex<BTreeMap<String, Pending>>,
    /// Held across a renewal, so a rotating refresh token is spent once.
    renewing: tokio::sync::Mutex<()>,
    path: Option<PathBuf>,
}

impl OAuthStore {
    /// `settings_path` is where `mcp.json` lives. This store's file is beside it.
    pub(crate) fn load(settings_path: Option<&Path>) -> Self {
        let path = settings_path.map(|path| path.with_file_name(OAUTH_FILE));
        let grants = path
            .as_ref()
            .filter(|path| path.exists())
            .map(|path| {
                fs::read(path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
                    .filter(|stored| stored.schema_version == 1)
                    .map(|stored| stored.servers)
                    .unwrap_or_else(|| {
                        tracing::warn!(
                            "stored MCP sign-ins could not be read; starting signed out"
                        );
                        BTreeMap::new()
                    })
            })
            .unwrap_or_default();
        Self {
            grants: Mutex::new(grants),
            pending: Mutex::new(BTreeMap::new()),
            renewing: tokio::sync::Mutex::new(()),
            path,
        }
    }

    /// What is stored for `server`, if it was stored for the URL it has now.
    fn grant(&self, server: &McpServer) -> Option<Grant> {
        self.grants
            .lock()
            .expect("MCP sign-in lock poisoned")
            .get(&server.id)
            .filter(|grant| grant.server_url == server.url)
            .cloned()
    }

    fn signed_in(&self, server: &McpServer) -> bool {
        self.grant(server)
            .is_some_and(|grant| grant.access_token.is_some())
    }

    /// Change what is stored and write it. With `must_save`, a change that
    /// cannot be written is not made.
    fn change(
        &self,
        must_save: bool,
        edit: impl FnOnce(&mut BTreeMap<String, Grant>),
    ) -> io::Result<()> {
        let mut grants = self.grants.lock().expect("MCP sign-in lock poisoned");
        let mut next = grants.clone();
        edit(&mut next);
        let written = self.persist(&next);
        if written.is_ok() || !must_save {
            *grants = next;
        }
        if written.is_err() {
            tracing::warn!("MCP sign-in state could not be saved");
        }
        written
    }

    fn persist(&self, grants: &BTreeMap<String, Grant>) -> io::Result<()> {
        let path = self.path.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "COSMOS_STATE_DIR is not configured",
            )
        })?;
        let bytes = serde_json::to_vec_pretty(&json!({ "schema_version": 1, "servers": grants }))
            .map_err(io::Error::other)?;
        crate::integrations::write_owner_only(path, &bytes)
    }

    /// Forget everything about a server: its tokens and its registered client.
    pub(crate) fn forget(&self, server_id: &str) -> io::Result<()> {
        self.pending
            .lock()
            .expect("MCP sign-in lock poisoned")
            .retain(|_, pending| pending.server_id != server_id);
        if !self
            .grants
            .lock()
            .expect("MCP sign-in lock poisoned")
            .contains_key(server_id)
        {
            return Ok(());
        }
        self.change(false, |grants| {
            grants.remove(server_id);
        })
    }

    /// Drop a server's tokens and keep its registered client, so the owner can
    /// sign in again.
    pub(crate) fn forget_tokens(&self, server_id: &str) {
        let _ = self.change(false, |grants| {
            if let Some(grant) = grants.get_mut(server_id) {
                grant.access_token = None;
                grant.refresh_token = None;
                grant.expires_at_ms = None;
            }
        });
    }

    /// The access token to send `server`, renewed first when it has run out.
    /// `None` when the owner has not signed in to it, or typed an
    /// `Authorization` header of their own.
    pub(crate) async fn bearer(
        &self,
        server: &McpServer,
        timeout: Duration,
    ) -> Result<Option<Bearer>, McpCallError> {
        if has_authorization(server) {
            return Ok(None);
        }
        let Some(grant) = self.grant(server) else {
            return Ok(None);
        };
        let Some(token) = grant.access_token.clone() else {
            return Ok(None);
        };
        if !grant.expired() {
            return Ok(Some(Bearer {
                token,
                renewed: false,
            }));
        }
        let token = self.renew(server, &token, timeout).await?;
        Ok(Some(Bearer {
            token,
            renewed: true,
        }))
    }

    /// A new access token for `server`, in place of `spent`.
    pub(crate) async fn renew(
        &self,
        server: &McpServer,
        spent: &str,
        timeout: Duration,
    ) -> Result<String, McpCallError> {
        let started = Instant::now();
        let Ok(_one_at_a_time) = tokio::time::timeout(timeout, self.renewing.lock()).await else {
            return Err(McpCallError::TimedOut);
        };
        let grant = self.grant(server).ok_or(McpCallError::SignInRequired)?;
        let current = grant
            .access_token
            .as_deref()
            .ok_or(McpCallError::SignInRequired)?;
        if current != spent {
            // Another request renewed it while this one waited.
            return Ok(current.to_owned());
        }
        let Some(refresh) = grant.refresh_token.clone() else {
            self.forget_tokens(&server.id);
            return Err(McpCallError::SignInRequired);
        };
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(McpCallError::TimedOut);
        }
        let form = vec![
            ("grant_type", "refresh_token".to_owned()),
            ("refresh_token", refresh),
            ("resource", grant.resource.clone()),
        ];
        match token_request(&grant, form, plain_http_allowed(server), remaining).await {
            Ok(tokens) => {
                let access = tokens.access.clone();
                // A token that cannot be written still serves until a restart.
                let _ = self.change(false, |grants| {
                    if let Some(grant) = grants.get_mut(&server.id) {
                        keep(grant, tokens);
                    }
                });
                Ok(access)
            }
            Err(Fault::Refused | Fault::Invalid) => {
                self.forget_tokens(&server.id);
                Err(McpCallError::SignInRequired)
            }
            Err(Fault::TimedOut) => Err(McpCallError::TimedOut),
            Err(Fault::Unreachable) => Err(McpCallError::Unreachable),
        }
    }

    /// Discover where `server` signs in, register there if needed, and answer
    /// the address the owner's browser opens.
    async fn start(&self, server: &McpServer, redirect_uri: &str) -> Result<String, OAuthError> {
        if has_authorization(server) {
            return Err(OAuthError::OwnHeader);
        }
        // Center's own address. A provider accepts https or a loopback one.
        checked_url(redirect_uri, true).map_err(|_| OAuthError::Redirect)?;
        let deadline = Instant::now() + START_TIMEOUT;
        let found = discover(server, deadline).await?;

        let known = self.grant(server).filter(|grant| {
            grant.issuer == found.issuer
                && grant.redirect_uri == redirect_uri
                && !grant.client_id.is_empty()
        });
        let grant = match known {
            Some(grant) => Grant {
                resource: found.resource.clone(),
                token_endpoint: found.token_endpoint.clone(),
                ..grant
            },
            None => {
                let endpoint = found
                    .registration_endpoint
                    .clone()
                    .ok_or(OAuthError::Unsupported)?;
                let client = register(endpoint, redirect_uri, left(deadline)?).await?;
                Grant {
                    server_url: server.url.clone(),
                    resource: found.resource.clone(),
                    issuer: found.issuer.clone(),
                    token_endpoint: found.token_endpoint.clone(),
                    redirect_uri: redirect_uri.to_owned(),
                    client_id: client.id,
                    client_secret: client.secret,
                    secret_in_body: client.secret_in_body,
                    ..Grant::default()
                }
            }
        };
        let client_id = grant.client_id.clone();
        self.change(true, |grants| {
            grants.insert(server.id.clone(), grant);
        })
        .map_err(|_| OAuthError::Persistence)?;

        let state = random_token();
        let code_verifier = random_token();
        let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(code_verifier.as_bytes()));
        {
            let mut pending = self.pending.lock().expect("MCP sign-in lock poisoned");
            let now = Instant::now();
            // The newest press of Sign in is the one that counts.
            pending.retain(|_, known| known.expires > now && known.server_id != server.id);
            while pending.len() >= MAX_PENDING {
                let Some(oldest) = pending
                    .iter()
                    .min_by_key(|(_, known)| known.expires)
                    .map(|(state, _)| state.clone())
                else {
                    break;
                };
                pending.remove(&oldest);
            }
            pending.insert(
                state.clone(),
                Pending {
                    server_id: server.id.clone(),
                    server_url: server.url.clone(),
                    code_verifier,
                    expires: now + PENDING_TTL,
                },
            );
        }

        let mut address = found.authorization_endpoint;
        {
            let mut query = address.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", &client_id)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("state", &state)
                .append_pair("code_challenge", &code_challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("resource", &found.resource);
            if let Some(scope) = found.scope.as_deref() {
                query.append_pair("scope", scope);
            }
        }
        Ok(address.into())
    }

    /// The pending sign-in `state` names, which is then spent.
    fn take_pending(&self, state: &str) -> Result<Pending, OAuthError> {
        if state.is_empty() || state.len() > MAX_STATE_BYTES {
            return Err(OAuthError::State);
        }
        self.pending
            .lock()
            .expect("MCP sign-in lock poisoned")
            .remove(state)
            .filter(|pending| pending.expires > Instant::now())
            .ok_or(OAuthError::State)
    }

    /// Turn the provider's `code` into tokens and keep them.
    async fn exchange(
        &self,
        server: &McpServer,
        pending: Pending,
        code: &str,
    ) -> Result<(), OAuthError> {
        let grant = self.grant(server).ok_or(OAuthError::State)?;
        // The provider sends no code when the owner declined.
        if code.is_empty() || code.len() > MAX_CODE_BYTES {
            return Err(OAuthError::Exchange);
        }
        let form = vec![
            ("grant_type", "authorization_code".to_owned()),
            ("code", code.to_owned()),
            ("redirect_uri", grant.redirect_uri.clone()),
            ("code_verifier", pending.code_verifier),
            ("resource", grant.resource.clone()),
        ];
        match token_request(&grant, form, plain_http_allowed(server), EXCHANGE_TIMEOUT).await {
            Ok(tokens) => self
                .change(true, |grants| {
                    if let Some(grant) = grants.get_mut(&server.id) {
                        grant.refresh_token = None;
                        keep(grant, tokens);
                    }
                })
                .map_err(|_| OAuthError::Persistence),
            Err(Fault::Refused | Fault::Invalid) => {
                // The registered client may be what the provider refuses.
                let _ = self.forget(&server.id);
                Err(OAuthError::Exchange)
            }
            Err(Fault::TimedOut | Fault::Unreachable) => Err(OAuthError::Unavailable),
        }
    }

    #[cfg(test)]
    fn expire_pending(&self) {
        let now = Instant::now();
        for pending in self
            .pending
            .lock()
            .expect("MCP sign-in lock poisoned")
            .values_mut()
        {
            pending.expires = now;
        }
    }
}

impl McpStore {
    /// Whether the owner is signed in to `server`: an access token is stored
    /// for the URL it has now.
    pub fn signed_in(&self, server: &McpServer) -> bool {
        self.oauth.signed_in(server)
    }

    /// Begin an OAuth sign-in to a server. `redirect_uri` is where the
    /// provider sends the owner's browser afterwards. Answers the address the
    /// browser opens.
    pub async fn start_sign_in(&self, id: &str, redirect_uri: &str) -> Result<String, OAuthError> {
        let server = self.server(id).ok_or(OAuthError::NotFound)?;
        self.oauth.start(&server, redirect_uri).await
    }

    /// Finish the sign-in `state` names with the provider's `code`. Answers the
    /// id of the server it was for.
    pub async fn finish_sign_in(&self, state: &str, code: &str) -> Result<String, OAuthError> {
        let pending = self.oauth.take_pending(state)?;
        let server = self
            .server(&pending.server_id)
            .filter(|server| server.url == pending.server_url)
            .ok_or(OAuthError::State)?;
        self.oauth.exchange(&server, pending, code).await?;
        // A session opened before this sign-in belongs to nobody now.
        self.forget_session(&server.id);
        Ok(server.id)
    }

    /// Drop a server's tokens and its registered client.
    pub fn sign_out(&self, id: &str) -> Result<(), OAuthError> {
        let server = self.server(id).ok_or(OAuthError::NotFound)?;
        self.forget_session(&server.id);
        self.oauth
            .forget(&server.id)
            .map_err(|_| OAuthError::Persistence)
    }
}

/// Whether the owner typed an `Authorization` header for `server`.
fn has_authorization(server: &McpServer) -> bool {
    server
        .headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("authorization"))
}

/// Whether a `401` from `server` asks for an OAuth sign-in: its challenge
/// names resource metadata, and the owner sent no `Authorization` of their own.
pub(crate) fn asks_for_sign_in(server: &McpServer, headers: &HeaderMap) -> bool {
    !has_authorization(server) && challenge_parameter(headers, "resource_metadata").is_some()
}

/// Plain `http` is for a server on this machine only.
fn plain_http_allowed(server: &McpServer) -> bool {
    Url::parse(&server.url).is_ok_and(|url| is_loopback(&url))
}

fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// A URL from a remote document, or from Center, that a request may go to:
/// `https`, or `http` on loopback when `plain_loopback` allows it, with no
/// credentials and no fragment.
fn checked_url(value: &str, plain_loopback: bool) -> Result<Url, OAuthError> {
    if value.len() > MAX_URL_BYTES {
        return Err(OAuthError::Unsafe);
    }
    let url = Url::parse(value).map_err(|_| OAuthError::Unsafe)?;
    let scheme =
        url.scheme() == "https" || (plain_loopback && url.scheme() == "http" && is_loopback(&url));
    if !scheme
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(OAuthError::Unsafe);
    }
    Ok(url)
}

fn left(deadline: Instant) -> Result<Duration, OAuthError> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(OAuthError::Unavailable);
    }
    Ok(left)
}

/// 32 random bytes as 43 URL-safe characters: a `state`, or a PKCE verifier.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The value of parameter `name` in the response's `WWW-Authenticate`.
fn challenge_parameter(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(WWW_AUTHENTICATE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| auth_parameter(value, name))
}

/// The value of auth-param `name` (lowercase) in one `WWW-Authenticate` value.
fn auth_parameter(value: &str, name: &str) -> Option<String> {
    // ASCII lowercasing keeps every byte offset.
    let lowered = value.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(found) = lowered[from..].find(name) {
        let start = from + found;
        let end = start + name.len();
        from = end;
        // A parameter of this name, not the tail of a longer one.
        let begins = start == 0 || matches!(lowered.as_bytes()[start - 1], b' ' | b',' | b'\t');
        let Some(rest) = value[end..].trim_start().strip_prefix('=') else {
            continue;
        };
        if !begins {
            continue;
        }
        let rest = rest.trim_start();
        let parsed = match rest.strip_prefix('"') {
            Some(quoted) => quoted.split('"').next(),
            None => rest.split([',', ' ']).next(),
        };
        return parsed
            .filter(|parsed| !parsed.is_empty())
            .map(str::to_owned);
    }
    None
}

/// Send one back-channel request and read its JSON answer, bounded in size.
/// The caller set the timeout. A body that is not JSON reads as `null`.
async fn answer(request: reqwest::RequestBuilder) -> Result<(u16, Value), Fault> {
    let transport = |error: reqwest::Error| {
        if error.is_timeout() {
            Fault::TimedOut
        } else {
            Fault::Unreachable
        }
    };
    let response = request.send().await.map_err(transport)?;
    let status = response.status().as_u16();
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(transport)?;
        if buffer.len() + chunk.len() > MAX_DOCUMENT_BYTES {
            return Err(Fault::Invalid);
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok((
        status,
        serde_json::from_slice(&buffer).unwrap_or(Value::Null),
    ))
}

/// One metadata document. `None` when it is not there.
async fn document(url: Url, timeout: Duration) -> Result<Option<Value>, OAuthError> {
    let request = crate::mcp::http()
        .get(url)
        .timeout(timeout)
        .header(ACCEPT, "application/json");
    match answer(request).await {
        Ok((200, body)) if body.is_object() => Ok(Some(body)),
        Ok(_) | Err(Fault::Invalid | Fault::Refused) => Ok(None),
        Err(Fault::TimedOut | Fault::Unreachable) => Err(OAuthError::Unavailable),
    }
}

/// Ask the server, unauthenticated, what it wants: the resource metadata URL
/// and the scope its `401` names.
async fn probe(
    server: &McpServer,
    timeout: Duration,
) -> Result<(Option<String>, Option<String>), OAuthError> {
    let mut request = crate::mcp::http()
        .post(&server.url)
        .timeout(timeout)
        .header(ACCEPT, "application/json, text/event-stream")
        .header("MCP-Protocol-Version", crate::mcp::PROTOCOL_VERSION)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": crate::mcp::PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "luma-cosmos", "version": env!("CARGO_PKG_VERSION") },
            },
        }));
    for header in &server.headers {
        request = request.header(header.name.as_str(), header.value.as_str());
    }
    let response = request.send().await.map_err(|_| OAuthError::Unavailable)?;
    if response.status().as_u16() != 401 {
        return Ok((None, None));
    }
    Ok((
        challenge_parameter(response.headers(), "resource_metadata"),
        challenge_parameter(response.headers(), "scope"),
    ))
}

/// `<origin>/.well-known/oauth-protected-resource<path>`, then without the path.
fn resource_metadata_urls(server: &Url) -> Vec<Url> {
    let path = server.path().trim_end_matches('/');
    let mut urls: Vec<Url> = Vec::new();
    for suffix in [path, ""] {
        let mut url = server.clone();
        url.set_query(None);
        url.set_path(&format!("/.well-known/oauth-protected-resource{suffix}"));
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    urls
}

/// Where an issuer's metadata may live: RFC 8414, then OpenID Connect
/// discovery in both of its forms.
fn server_metadata_urls(issuer: &Url) -> Vec<Url> {
    let path = issuer.path().trim_end_matches('/').to_owned();
    let at = |path: String| {
        let mut url = issuer.clone();
        url.set_path(&path);
        url
    };
    let mut urls = vec![
        at(format!("/.well-known/oauth-authorization-server{path}")),
        at(format!("/.well-known/openid-configuration{path}")),
    ];
    if !path.is_empty() {
        urls.push(at(format!("{path}/.well-known/openid-configuration")));
    }
    urls
}

/// Whether a token for `resource` is a token for `server`: the same origin,
/// and a path that is the server's or above it.
fn covers(resource: &Url, server: &Url) -> bool {
    let directory = |url: &Url| format!("{}/", url.path().trim_end_matches('/'));
    resource.origin() == server.origin() && directory(server).starts_with(&directory(resource))
}

/// The server's URL as an RFC 8707 resource: no query, no fragment, and no
/// slash after a bare origin.
fn canonical_resource(server: &Url) -> String {
    let mut url = server.clone();
    url.set_query(None);
    url.set_fragment(None);
    if url.path() == "/" {
        return url.as_str().trim_end_matches('/').to_owned();
    }
    url.into()
}

/// The scope to ask for: what the `401` named, otherwise everything the
/// resource lists. A scope that is not RFC 6749 scope tokens is not sent.
fn scope_of(challenge: Option<String>, metadata: &Value) -> Option<String> {
    let scope = challenge.or_else(|| {
        let listed = metadata.get("scopes_supported")?.as_array()?;
        Some(
            listed
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        )
    })?;
    let sound = !scope.is_empty()
        && scope.len() <= MAX_SCOPE_BYTES
        && scope.split(' ').all(|token| {
            !token.is_empty()
                && token
                    .bytes()
                    .all(|byte| matches!(byte, 0x21 | 0x23..=0x5b | 0x5d..=0x7e))
        });
    sound.then_some(scope)
}

async fn discover(server: &McpServer, deadline: Instant) -> Result<Discovered, OAuthError> {
    let server_url = Url::parse(&server.url).map_err(|_| OAuthError::NotOffered)?;
    let plain = is_loopback(&server_url);
    let (named, challenge_scope) = probe(server, left(deadline)?).await?;

    // 1. The resource's own metadata: who issues its tokens.
    let candidates = match named {
        Some(named) => vec![checked_url(&named, plain)?],
        None => resource_metadata_urls(&server_url),
    };
    let mut resource_metadata = None;
    for candidate in candidates {
        if let Some(found) = document(candidate, left(deadline)?).await? {
            resource_metadata = Some(found);
            break;
        }
    }
    let resource_metadata = resource_metadata.ok_or(OAuthError::NotOffered)?;
    let resource = match resource_metadata.get("resource").and_then(Value::as_str) {
        Some(resource) => {
            if !covers(&checked_url(resource, plain)?, &server_url) {
                return Err(OAuthError::Unsafe);
            }
            resource.to_owned()
        }
        None => canonical_resource(&server_url),
    };
    let issuer = resource_metadata
        .get("authorization_servers")
        .and_then(Value::as_array)
        .and_then(|servers| servers.first())
        .and_then(Value::as_str)
        .ok_or(OAuthError::NotOffered)?;
    let issuer_url = checked_url(issuer, plain)?;
    if issuer_url.query().is_some() {
        return Err(OAuthError::Unsafe);
    }

    // 2. The authorization server's metadata: where its endpoints are.
    let mut metadata = None;
    for candidate in server_metadata_urls(&issuer_url) {
        if let Some(found) = document(candidate, left(deadline)?).await? {
            metadata = Some(found);
            break;
        }
    }
    let metadata = metadata.ok_or(OAuthError::NotOffered)?;
    let text = |name: &str| metadata.get(name).and_then(Value::as_str);
    // RFC 8414 section 3.3: a document for another issuer is not this one's.
    if text("issuer").map(|named| named.trim_end_matches('/')) != Some(issuer.trim_end_matches('/'))
    {
        return Err(OAuthError::Unsafe);
    }
    let authorization_endpoint = checked_url(
        text("authorization_endpoint").ok_or(OAuthError::Unsafe)?,
        plain,
    )?;
    let token_endpoint = text("token_endpoint").ok_or(OAuthError::Unsafe)?;
    checked_url(token_endpoint, plain)?;
    let registration_endpoint = text("registration_endpoint")
        .map(|endpoint| checked_url(endpoint, plain))
        .transpose()?;
    if let Some(methods) = metadata
        .get("code_challenge_methods_supported")
        .and_then(Value::as_array)
        && !methods.iter().any(|method| method.as_str() == Some("S256"))
    {
        return Err(OAuthError::Unsupported);
    }
    Ok(Discovered {
        scope: scope_of(challenge_scope, &resource_metadata),
        resource,
        issuer: issuer.to_owned(),
        authorization_endpoint,
        token_endpoint: token_endpoint.to_owned(),
        registration_endpoint,
    })
}

/// Register as a public client (RFC 7591).
async fn register(
    endpoint: Url,
    redirect_uri: &str,
    timeout: Duration,
) -> Result<Client, OAuthError> {
    let request = crate::mcp::http()
        .post(endpoint)
        .timeout(timeout)
        .header(ACCEPT, "application/json")
        .json(&json!({
            "client_name": "Luma",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }));
    let (status, body) = answer(request).await.map_err(|fault| match fault {
        Fault::TimedOut | Fault::Unreachable => OAuthError::Unavailable,
        Fault::Refused | Fault::Invalid => OAuthError::Unsupported,
    })?;
    if !matches!(status, 200 | 201) {
        tracing::warn!(
            stage = "registration",
            status,
            "an MCP sign-in step was refused"
        );
        return Err(OAuthError::Unsupported);
    }
    let field = |name: &str| {
        body.get(name)
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= MAX_CLIENT_FIELD_BYTES
                    && !value.chars().any(char::is_control)
            })
            .map(str::to_owned)
    };
    let method = body
        .get("token_endpoint_auth_method")
        .and_then(Value::as_str);
    Ok(Client {
        id: field("client_id").ok_or(OAuthError::Unsupported)?,
        secret: field("client_secret").filter(|_| method != Some("none")),
        secret_in_body: method == Some("client_secret_post"),
    })
}

/// One request to the token endpoint, as the registered client.
async fn token_request(
    grant: &Grant,
    mut form: Vec<(&'static str, String)>,
    plain_loopback: bool,
    timeout: Duration,
) -> Result<Tokens, Fault> {
    let endpoint =
        checked_url(&grant.token_endpoint, plain_loopback).map_err(|_| Fault::Refused)?;
    let mut request = crate::mcp::http()
        .post(endpoint)
        .timeout(timeout)
        .header(ACCEPT, "application/json");
    match grant.client_secret.as_deref() {
        // RFC 6749 section 2.3.1: both parts are form-encoded first.
        Some(secret) if !grant.secret_in_body => {
            request =
                request.basic_auth(form_encoded(&grant.client_id), Some(form_encoded(secret)));
        }
        secret => {
            form.push(("client_id", grant.client_id.clone()));
            if let Some(secret) = secret {
                form.push(("client_secret", secret.to_owned()));
            }
        }
    }
    let (status, body) = answer(request.form(&form)).await?;
    match status {
        200 => tokens(&body).ok_or(Fault::Invalid),
        // Asked to wait, not told no.
        408 | 429 => Err(Fault::Unreachable),
        400..=499 => {
            tracing::warn!(stage = "token", status, "an MCP sign-in step was refused");
            Err(Fault::Refused)
        }
        _ => {
            tracing::warn!(stage = "token", status, "an MCP sign-in step failed");
            Err(Fault::Unreachable)
        }
    }
}

/// The tokens in a token endpoint's answer, when it holds a Bearer token that
/// can travel in a header.
fn tokens(body: &Value) -> Option<Tokens> {
    let text = |name: &str| body.get(name).and_then(Value::as_str);
    let sendable = |token: &&str| {
        !token.is_empty()
            && token.len() <= MAX_TOKEN_BYTES
            && token.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
    };
    if text("token_type").is_some_and(|kind| !kind.eq_ignore_ascii_case("bearer")) {
        return None;
    }
    Some(Tokens {
        access: text("access_token").filter(sendable)?.to_owned(),
        refresh: text("refresh_token")
            .filter(|token| !token.is_empty() && token.len() <= MAX_TOKEN_BYTES)
            .map(str::to_owned),
        expires_at_ms: body
            .get("expires_in")
            .and_then(Value::as_u64)
            .map(|seconds| now_ms().saturating_add(seconds.min(MAX_LIFETIME_SECONDS) * 1000)),
    })
}

/// Store new tokens in a grant. A renewal that names no new refresh token
/// keeps the one in use.
fn keep(grant: &mut Grant, tokens: Tokens) {
    grant.access_token = Some(tokens.access);
    if tokens.refresh.is_some() {
        grant.refresh_token = tokens.refresh;
    }
    grant.expires_at_ms = tokens.expires_at_ms;
}

/// `application/x-www-form-urlencoded`, for the parts of HTTP Basic.
fn form_encoded(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'*' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;

    use axum::extract::{Form, Query, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse as _, Response};

    use crate::mcp::{McpHeaderInput, McpServerInput, McpState};

    /// Where the provider sends the owner's browser. Nothing is ever fetched
    /// from it: Center would hand its `state` and `code` to Cosmos.
    const REDIRECT: &str = "https://center.example/api/admin/mcp/oauth/callback";
    const WAIT: Duration = Duration::from_secs(5);

    /// What the authorization server's metadata endpoint answers.
    #[derive(Clone, Copy, Default, PartialEq)]
    enum Metadata {
        #[default]
        Served,
        /// A redirect to a copy that would work, if it were followed.
        Redirected,
        /// More bytes than a metadata document may have.
        Oversized,
    }

    /// One stand-in for both halves: an MCP server that demands a token, and
    /// the authorization server that issues it.
    #[derive(Default)]
    struct Provider {
        base: String,
        /// Registered clients: id and redirect URI.
        clients: Vec<(String, String)>,
        /// Issued codes, each with the authorization request it answers.
        codes: BTreeMap<String, BTreeMap<String, String>>,
        /// The one access token the MCP server accepts, and the one refresh
        /// token the token endpoint accepts.
        access: Option<String>,
        refresh: Option<String>,
        minted: u32,
        refreshes: u32,
        /// The `expires_in` of the next tokens.
        lifetime: u64,
        /// Every `Authorization` value the MCP endpoint was sent.
        presented: Vec<String>,
        metadata: Metadata,
        /// The token endpoint is down: it answers 503.
        outage: bool,
        /// Overrides for what the metadata documents name.
        token_endpoint: Option<String>,
        authorization_server: Option<String>,
    }

    type StandIn = Arc<Mutex<Provider>>;

    async fn mcp_endpoint(
        State(provider): State<StandIn>,
        headers: axum::http::HeaderMap,
        axum::Json(body): axum::Json<Value>,
    ) -> Response {
        let (base, accepted) = {
            let mut provider = provider.lock().expect("lock");
            for value in headers.get_all("authorization") {
                provider
                    .presented
                    .push(value.to_str().unwrap_or("").to_owned());
            }
            (provider.base.clone(), provider.access.clone())
        };
        let presented = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok());
        if accepted.is_none()
            || presented != accepted.map(|token| format!("Bearer {token}")).as_deref()
        {
            return (
                StatusCode::UNAUTHORIZED,
                [(
                    "www-authenticate",
                    format!(
                        "Bearer error=\"invalid_token\", resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\""
                    ),
                )],
            )
                .into_response();
        }
        let result = match body["method"].as_str() {
            Some("initialize") => json!({
                "protocolVersion": crate::mcp::PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "stand-in", "version": "1" }
            }),
            Some("notifications/initialized") => return StatusCode::ACCEPTED.into_response(),
            Some("tools/list") => json!({ "tools": [
                { "name": "whoami", "description": "Who is signed in.",
                  "annotations": { "readOnlyHint": true } }
            ]}),
            Some("tools/call") => json!({ "content": [
                { "type": "text", "text": "the owner" }
            ]}),
            _ => return StatusCode::BAD_REQUEST.into_response(),
        };
        axum::Json(json!({ "jsonrpc": "2.0", "id": body["id"], "result": result })).into_response()
    }

    async fn resource_metadata(State(provider): State<StandIn>) -> axum::Json<Value> {
        let provider = provider.lock().expect("lock");
        let base = &provider.base;
        axum::Json(json!({
            "resource": format!("{base}/mcp"),
            "authorization_servers": [provider.authorization_server.clone().unwrap_or_else(|| base.clone())],
            "scopes_supported": ["tools.read", "profile"],
        }))
    }

    fn server_metadata_document(provider: &Provider) -> Value {
        let base = &provider.base;
        json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": provider.token_endpoint.clone().unwrap_or_else(|| format!("{base}/token")),
            "registration_endpoint": format!("{base}/register"),
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
        })
    }

    async fn server_metadata(State(provider): State<StandIn>) -> Response {
        let provider = provider.lock().expect("lock");
        match provider.metadata {
            Metadata::Served => axum::Json(server_metadata_document(&provider)).into_response(),
            Metadata::Redirected => (
                StatusCode::TEMPORARY_REDIRECT,
                [("location", format!("{}/moved-metadata", provider.base))],
            )
                .into_response(),
            Metadata::Oversized => {
                let mut document = server_metadata_document(&provider);
                document["padding"] = json!("x".repeat(MAX_DOCUMENT_BYTES));
                axum::Json(document).into_response()
            }
        }
    }

    async fn moved_metadata(State(provider): State<StandIn>) -> axum::Json<Value> {
        axum::Json(server_metadata_document(&provider.lock().expect("lock")))
    }

    async fn registration(
        State(provider): State<StandIn>,
        axum::Json(body): axum::Json<Value>,
    ) -> Response {
        let redirect = body["redirect_uris"][0].as_str().unwrap_or("");
        let public_client = body["token_endpoint_auth_method"] == "none"
            && body["grant_types"] == json!(["authorization_code", "refresh_token"])
            && body["redirect_uris"].as_array().map(Vec::len) == Some(1)
            && !redirect.is_empty();
        if !public_client {
            return StatusCode::BAD_REQUEST.into_response();
        }
        let mut provider = provider.lock().expect("lock");
        let id = format!("client-{}", provider.clients.len() + 1);
        provider.clients.push((id.clone(), redirect.to_owned()));
        (
            StatusCode::CREATED,
            axum::Json(json!({ "client_id": id, "token_endpoint_auth_method": "none" })),
        )
            .into_response()
    }

    /// The page the owner's browser opens. It approves at once and redirects
    /// back with a code.
    async fn authorization(
        State(provider): State<StandIn>,
        Query(query): Query<BTreeMap<String, String>>,
    ) -> Response {
        let field = |name: &str| query.get(name).map(String::as_str).unwrap_or("");
        let mut provider = provider.lock().expect("lock");
        let sound =
            provider.clients.iter().any(|(id, redirect)| {
                id == field("client_id") && redirect == field("redirect_uri")
            }) && field("response_type") == "code"
                && field("code_challenge_method") == "S256"
                && !field("code_challenge").is_empty()
                && !field("state").is_empty()
                && field("resource") == format!("{}/mcp", provider.base);
        if !sound {
            return StatusCode::BAD_REQUEST.into_response();
        }
        provider.minted += 1;
        let code = format!("code-{}", provider.minted);
        provider.codes.insert(code.clone(), query.clone());
        let mut back = Url::parse(field("redirect_uri")).expect("a redirect URI");
        back.query_pairs_mut()
            .append_pair("code", &code)
            .append_pair("state", field("state"));
        (StatusCode::FOUND, [("location", String::from(back))]).into_response()
    }

    async fn token_endpoint(
        State(provider): State<StandIn>,
        Form(form): Form<BTreeMap<String, String>>,
    ) -> Response {
        let refused = || {
            (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({ "error": "invalid_grant" })),
            )
                .into_response()
        };
        let field = |name: &str| form.get(name).map(String::as_str).unwrap_or("");
        let mut provider = provider.lock().expect("lock");
        if provider.outage {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        match field("grant_type") {
            "authorization_code" => {
                // A code is spent by its first use, whatever the outcome.
                let Some(asked) = provider.codes.remove(field("code")) else {
                    return refused();
                };
                let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(Sha256::digest(field("code_verifier").as_bytes()));
                let matches = asked["client_id"] == field("client_id")
                    && asked["redirect_uri"] == field("redirect_uri")
                    && asked["resource"] == field("resource")
                    && asked["code_challenge"] == challenge;
                if !matches {
                    return refused();
                }
            }
            "refresh_token" => {
                let known_client = provider
                    .clients
                    .iter()
                    .any(|(id, _)| id == field("client_id"));
                if !known_client
                    || provider.refresh.as_deref() != Some(field("refresh_token"))
                    || field("resource") != format!("{}/mcp", provider.base)
                {
                    return refused();
                }
                provider.refreshes += 1;
            }
            _ => return refused(),
        }
        provider.minted += 1;
        provider.access = Some(format!("access-{}", provider.minted));
        provider.refresh = Some(format!("refresh-{}", provider.minted));
        axum::Json(json!({
            "access_token": provider.access,
            "token_type": "Bearer",
            "expires_in": provider.lifetime,
            "refresh_token": provider.refresh,
        }))
        .into_response()
    }

    async fn serve() -> (String, StandIn) {
        let provider = StandIn::default();
        let router = axum::Router::new()
            .route("/mcp", axum::routing::post(mcp_endpoint))
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                axum::routing::get(resource_metadata),
            )
            .route(
                "/.well-known/oauth-authorization-server",
                axum::routing::get(server_metadata),
            )
            .route("/moved-metadata", axum::routing::get(moved_metadata))
            .route("/register", axum::routing::post(registration))
            .route("/authorize", axum::routing::get(authorization))
            .route("/token", axum::routing::post(token_endpoint))
            .with_state(provider.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let base = format!("http://{}", listener.local_addr().expect("an address"));
        {
            let mut provider = provider.lock().expect("lock");
            provider.base = base.clone();
            provider.lifetime = 3600;
        }
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (base, provider)
    }

    fn state_dir(label: &str) -> String {
        let directory = std::env::temp_dir().join(format!(
            "luma-mcp-oauth-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&directory).expect("a state directory");
        directory.to_string_lossy().into_owned()
    }

    fn hosted(store: &McpStore, base: &str) -> McpServer {
        store
            .upsert(McpServerInput {
                name: Some("Hosted".to_owned()),
                url: Some(format!("{base}/mcp")),
                ..McpServerInput::default()
            })
            .expect("the server is saved")
    }

    /// What the owner's browser does with the address Cosmos answered: open
    /// it, approve, and arrive back at Center with a `state` and a `code`.
    async fn browser(address: &str) -> (String, String) {
        let response = crate::mcp::http()
            .get(address)
            .send()
            .await
            .expect("the provider answers");
        assert_eq!(response.status().as_u16(), 302, "the provider approves");
        let back = response.headers()["location"]
            .to_str()
            .expect("a location")
            .to_owned();
        assert!(back.starts_with(REDIRECT), "back to Center, nowhere else");
        let query: BTreeMap<String, String> = Url::parse(&back)
            .expect("a URL")
            .query_pairs()
            .into_owned()
            .collect();
        (query["state"].clone(), query["code"].clone())
    }

    async fn sign_in(store: &McpStore, server: &McpServer) {
        let address = store
            .start_sign_in(&server.id, REDIRECT)
            .await
            .expect("the sign-in starts");
        let (state, code) = browser(&address).await;
        store
            .finish_sign_in(&state, &code)
            .await
            .expect("the sign-in finishes");
    }

    fn stored(directory: &str, file: &str) -> String {
        fs::read_to_string(Path::new(directory).join(file)).unwrap_or_default()
    }

    #[tokio::test]
    async fn a_server_is_discovered_signed_in_to_and_its_tool_called() {
        let (base, provider) = serve().await;
        let directory = state_dir("sign-in");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &base);

        // Unauthenticated, the server names where to sign in.
        let status = store.refresh(&server.id, WAIT).await.expect("known");
        assert_eq!(status.state, McpState::SignInRequired);
        assert!(!store.signed_in(&server));

        // Start: discovery, registration, and the address for the browser.
        let address = store
            .start_sign_in(&server.id, REDIRECT)
            .await
            .expect("the sign-in starts");
        let asked: BTreeMap<String, String> = Url::parse(&address)
            .expect("a URL")
            .query_pairs()
            .into_owned()
            .collect();
        assert!(address.starts_with(&format!("{base}/authorize?")));
        assert_eq!(asked["response_type"], "code");
        assert_eq!(asked["client_id"], "client-1");
        assert_eq!(asked["redirect_uri"], REDIRECT);
        assert_eq!(asked["code_challenge_method"], "S256");
        assert_eq!(asked["code_challenge"].len(), 43);
        assert_eq!(asked["resource"], format!("{base}/mcp"));
        assert_eq!(asked["scope"], "tools.read profile");
        assert_eq!(asked["state"].len(), 43);
        assert!(!store.signed_in(&server), "not before the browser returns");

        // The browser returns, and the code becomes tokens. The stand-in
        // checks the PKCE verifier, the redirect URI and the resource.
        let (state, code) = browser(&address).await;
        assert_eq!(state, asked["state"]);
        let finished = store.finish_sign_in(&state, &code).await;
        assert_eq!(finished, Ok(server.id.clone()));
        assert!(store.signed_in(&server));

        // The tools are listed and called with the access token.
        let status = store.refresh(&server.id, WAIT).await.expect("known");
        assert_eq!(status.state, McpState::Connected);
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(
            (run.outcome, run.observation.as_str()),
            ("completed", "the owner")
        );
        let accepted = provider
            .lock()
            .expect("lock")
            .access
            .clone()
            .expect("a token");
        assert_eq!(
            provider.lock().expect("lock").presented.last(),
            Some(&format!("Bearer {accepted}"))
        );

        // The tokens are in one owner-only file and nowhere else.
        use std::os::unix::fs::PermissionsExt as _;
        let file = Path::new(&directory).join(OAUTH_FILE);
        let mode = fs::metadata(&file).expect("the file").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(stored(&directory, OAUTH_FILE).contains(&accepted));
        assert!(!stored(&directory, "mcp.json").contains("access-"));
        assert!(!stored(&directory, "mcp-tools.json").contains("access-"));

        // A restart keeps the sign-in.
        let restarted = McpStore::load(Some(&directory));
        assert!(restarted.signed_in(&server));
        let run = restarted.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "completed");

        // A changed URL is another server: the token does not go there.
        let moved = McpServer {
            url: format!("{base}/mcp?elsewhere=1"),
            ..server.clone()
        };
        assert!(!restarted.signed_in(&moved));
        assert!(
            restarted
                .oauth
                .bearer(&moved, WAIT)
                .await
                .expect("no renewal")
                .is_none()
        );

        // Sign out: the tokens are gone, on disk too.
        restarted.sign_out(&server.id).expect("signed out");
        assert!(!restarted.signed_in(&server));
        assert!(!stored(&directory, OAUTH_FILE).contains("access-"));
        assert!(!stored(&directory, OAUTH_FILE).contains("refresh-"));
        let status = restarted.refresh(&server.id, WAIT).await.expect("known");
        assert_eq!(status.state, McpState::SignInRequired);

        // A removed server leaves nothing behind.
        sign_in(&restarted, &server).await;
        restarted.remove(&server.id).expect("removed");
        assert!(!stored(&directory, OAUTH_FILE).contains("client-"));
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_token_that_ran_out_or_is_refused_is_renewed_once() {
        let (base, provider) = serve().await;
        let directory = state_dir("renew");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &base);

        // The first token lives one second: already inside the renewal margin.
        provider.lock().expect("lock").lifetime = 1;
        sign_in(&store, &server).await;
        let first = provider.lock().expect("lock").access.clone();
        provider.lock().expect("lock").lifetime = 3600;

        // Run out: renewed before the request, which then succeeds.
        let status = store.refresh(&server.id, WAIT).await.expect("known");
        assert_eq!(status.state, McpState::Connected);
        assert_eq!(provider.lock().expect("lock").refreshes, 1);
        assert_ne!(provider.lock().expect("lock").access, first);

        // Still valid: sent as it is.
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "completed");
        assert_eq!(provider.lock().expect("lock").refreshes, 1);

        // Refused by the server while Cosmos believes it valid: one renewal,
        // one retry, and the call succeeds.
        provider.lock().expect("lock").access = Some("revoked-elsewhere".to_owned());
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(
            (run.outcome, run.observation.as_str()),
            ("completed", "the owner")
        );
        assert_eq!(provider.lock().expect("lock").refreshes, 2);

        // Two requests find the token refused at once. The refresh token is
        // spent by its first use, so only one renewal may be made.
        provider.lock().expect("lock").access = Some("revoked-again".to_owned());
        let nothing = json!({});
        let (one, other) = tokio::join!(
            store.call("mcp_hosted_whoami", &nothing, None),
            store.call("mcp_hosted_whoami", &nothing, None),
        );
        assert_eq!((one.outcome, other.outcome), ("completed", "completed"));
        assert_eq!(provider.lock().expect("lock").refreshes, 3);

        // The authorization server is down during a renewal: the call fails,
        // the sign-in is kept, and the next call renews.
        {
            let mut provider = provider.lock().expect("lock");
            provider.access = Some("revoked-once-more".to_owned());
            provider.outage = true;
        }
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "unavailable");
        assert!(store.signed_in(&server));
        provider.lock().expect("lock").outage = false;
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "completed");
        assert_eq!(provider.lock().expect("lock").refreshes, 4);

        // The renewed tokens are what a restart finds.
        let restarted = McpStore::load(Some(&directory));
        let run = restarted.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "completed");
        assert_eq!(provider.lock().expect("lock").refreshes, 4);
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_renewal_the_provider_refuses_asks_the_owner_to_sign_in_again() {
        let (base, provider) = serve().await;
        let directory = state_dir("refused");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &base);
        sign_in(&store, &server).await;
        let status = store.refresh(&server.id, WAIT).await.expect("known");
        assert_eq!(status.state, McpState::Connected);

        // The provider revokes both tokens.
        {
            let mut provider = provider.lock().expect("lock");
            provider.access = Some("revoked-elsewhere".to_owned());
            provider.refresh = None;
        }
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "not_configured");
        assert!(run.observation.contains("sign in"), "{}", run.observation);
        let status = store.status().remove(&server.id).expect("recorded");
        assert_eq!(status.state, McpState::SignInRequired);
        assert_eq!(status.tools.len(), 1, "the listed tools stay");
        assert!(!store.signed_in(&server));
        assert!(!stored(&directory, OAUTH_FILE).contains("refresh-"));

        // Signed out, no stored token is sent and no renewal is tried.
        let refreshes = provider.lock().expect("lock").refreshes;
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "not_configured");
        assert_eq!(provider.lock().expect("lock").refreshes, refreshes);

        // Signing in again uses the client registered the first time.
        sign_in(&store, &server).await;
        assert_eq!(provider.lock().expect("lock").clients.len(), 1);
        let run = store.call("mcp_hosted_whoami", &json!({}), None).await;
        assert_eq!(run.outcome, "completed");
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_wrong_expired_or_reused_state_is_refused() {
        let (base, provider) = serve().await;
        let directory = state_dir("state");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &base);

        let address = store
            .start_sign_in(&server.id, REDIRECT)
            .await
            .expect("started");
        let (state, code) = browser(&address).await;

        // A state Cosmos never issued: refused before the provider is asked,
        // so the code is still unspent there.
        let wrong = store.finish_sign_in("not-the-state", &code).await;
        assert_eq!(wrong, Err(OAuthError::State));
        assert!(provider.lock().expect("lock").codes.contains_key(&code));
        assert!(!store.signed_in(&server));

        // The right one works once.
        assert!(store.finish_sign_in(&state, &code).await.is_ok());
        let reused = store.finish_sign_in(&state, &code).await;
        assert_eq!(reused, Err(OAuthError::State));

        // One that expired before the browser came back.
        let address = store
            .start_sign_in(&server.id, REDIRECT)
            .await
            .expect("started");
        let (state, code) = browser(&address).await;
        store.oauth.expire_pending();
        let expired = store.finish_sign_in(&state, &code).await;
        assert_eq!(expired, Err(OAuthError::State));

        // A second press of Sign in retires the first one's state.
        let first = store
            .start_sign_in(&server.id, REDIRECT)
            .await
            .expect("started");
        let second = store
            .start_sign_in(&server.id, REDIRECT)
            .await
            .expect("started");
        let (state, code) = browser(&first).await;
        let retired = store.finish_sign_in(&state, &code).await;
        assert_eq!(retired, Err(OAuthError::State));

        // The provider reports a refusal with no code: the state is spent.
        let (state, code) = browser(&second).await;
        let declined = store.finish_sign_in(&state, "").await;
        assert_eq!(declined, Err(OAuthError::Exchange));
        let late = store.finish_sign_in(&state, &code).await;
        assert_eq!(late, Err(OAuthError::State));

        // The server's URL changed while the owner was at the provider.
        let address = store
            .start_sign_in(&server.id, REDIRECT)
            .await
            .expect("started");
        let (state, code) = browser(&address).await;
        store
            .upsert(McpServerInput {
                id: Some(server.id.clone()),
                url: Some(format!("{base}/mcp?moved=1")),
                ..McpServerInput::default()
            })
            .expect("saved");
        let moved = store.finish_sign_in(&state, &code).await;
        assert_eq!(moved, Err(OAuthError::State));
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn sign_in_details_that_are_not_https_are_refused() {
        let (base, provider) = serve().await;
        let directory = state_dir("unsafe");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &base);

        // A token endpoint over plain http on another host.
        provider.lock().expect("lock").token_endpoint =
            Some("http://token.example/token".to_owned());
        let plain = store.start_sign_in(&server.id, REDIRECT).await;
        assert_eq!(plain, Err(OAuthError::Unsafe));

        // One that carries credentials.
        provider.lock().expect("lock").token_endpoint =
            Some("https://user:secret@token.example/token".to_owned());
        let credentials = store.start_sign_in(&server.id, REDIRECT).await;
        assert_eq!(credentials, Err(OAuthError::Unsafe));

        // An authorization server over plain http on another host.
        {
            let mut provider = provider.lock().expect("lock");
            provider.token_endpoint = None;
            provider.authorization_server = Some("http://login.example".to_owned());
        }
        let issuer = store.start_sign_in(&server.id, REDIRECT).await;
        assert_eq!(issuer, Err(OAuthError::Unsafe));

        // Nothing was registered and nothing stored along the way.
        assert!(provider.lock().expect("lock").clients.is_empty());
        assert!(stored(&directory, OAUTH_FILE).is_empty());

        // A return address a provider must not send a code to.
        provider.lock().expect("lock").authorization_server = None;
        let redirect = store
            .start_sign_in(&server.id, "http://center.example/callback")
            .await;
        assert_eq!(redirect, Err(OAuthError::Redirect));

        // Loopback http is for a server on this machine. A remote server's
        // documents cannot name it.
        assert!(checked_url("http://127.0.0.1:9/token", true).is_ok());
        assert!(checked_url("http://127.0.0.1:9/token", false).is_err());
        assert!(checked_url("http://[::1]:9/token", false).is_err());
        assert!(checked_url("https://login.example/token", false).is_ok());
        assert!(checked_url("https://login.example/token#fragment", false).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_redirected_or_oversized_metadata_document_is_not_used() {
        let (base, provider) = serve().await;
        let directory = state_dir("bounds");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &base);

        // The copy behind the redirect would work. It is not followed.
        provider.lock().expect("lock").metadata = Metadata::Redirected;
        let redirected = store.start_sign_in(&server.id, REDIRECT).await;
        assert_eq!(redirected, Err(OAuthError::NotOffered));

        provider.lock().expect("lock").metadata = Metadata::Oversized;
        let oversized = store.start_sign_in(&server.id, REDIRECT).await;
        assert_eq!(oversized, Err(OAuthError::NotOffered));
        assert!(provider.lock().expect("lock").clients.is_empty());

        provider.lock().expect("lock").metadata = Metadata::Served;
        assert!(store.start_sign_in(&server.id, REDIRECT).await.is_ok());
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_hand_typed_authorization_header_keeps_the_sign_in_out() {
        let (base, provider) = serve().await;
        let directory = state_dir("own-header");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &base);
        sign_in(&store, &server).await;

        // The owner types a header of their own: only that one is sent, and
        // the server's refusal reads as it always did.
        let typed = store
            .upsert(McpServerInput {
                id: Some(server.id.clone()),
                headers: Some(vec![McpHeaderInput {
                    name: "authorization".to_owned(),
                    value: Some("Bearer typed-by-hand".to_owned()),
                }]),
                ..McpServerInput::default()
            })
            .expect("saved");
        provider.lock().expect("lock").presented.clear();
        let status = store.refresh(&typed.id, WAIT).await.expect("known");
        assert_eq!(status.state, McpState::Unauthorized);
        assert_eq!(
            provider.lock().expect("lock").presented,
            ["Bearer typed-by-hand"]
        );
        assert_eq!(provider.lock().expect("lock").refreshes, 0);

        // And a sign-in is refused until the header is removed.
        let refused = store.start_sign_in(&typed.id, REDIRECT).await;
        assert_eq!(refused, Err(OAuthError::OwnHeader));
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn a_server_with_no_sign_in_says_so_and_a_sign_in_needs_a_state_directory() {
        // A port nothing listens on: the server cannot be asked.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        let gone = format!("http://{}", listener.local_addr().expect("an address"));
        drop(listener);
        let directory = state_dir("none");
        let store = McpStore::load(Some(&directory));
        let server = hosted(&store, &gone);
        let unreachable = store.start_sign_in(&server.id, REDIRECT).await;
        assert_eq!(unreachable, Err(OAuthError::Unavailable));
        let unknown = store.start_sign_in("nobody", REDIRECT).await;
        assert_eq!(unknown, Err(OAuthError::NotFound));
        let _ = fs::remove_dir_all(directory);

        let (base, _provider) = serve().await;
        let memory = McpStore::memory(crate::mcp::McpSettings {
            schema_version: 1,
            servers: vec![McpServer {
                id: "hosted".to_owned(),
                name: "Hosted".to_owned(),
                url: format!("{base}/mcp"),
                enabled: true,
                ..McpServer::default()
            }],
        });
        // Discovery and registration work, but with no state directory the
        // client cannot be kept, and the start says so.
        let unsaved = memory.start_sign_in("hosted", REDIRECT).await;
        assert_eq!(unsaved, Err(OAuthError::Persistence));
        let other = McpStore::memory(crate::mcp::McpSettings {
            schema_version: 1,
            servers: vec![McpServer {
                id: "plain".to_owned(),
                name: "Plain".to_owned(),
                url: format!("{base}/moved-metadata"),
                enabled: true,
                ..McpServer::default()
            }],
        });
        // A URL that answers no 401 and has no well-known document.
        let none = other.start_sign_in("plain", REDIRECT).await;
        assert_eq!(none, Err(OAuthError::NotOffered));
    }

    #[test]
    fn a_challenge_names_its_resource_metadata() {
        let header = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(WWW_AUTHENTICATE, value.parse().expect("a header"));
            headers
        };
        let quoted = header(
            "Bearer realm=\"mcp\", error=\"invalid_token\", resource_metadata=\"https://mcp.example/.well-known/oauth-protected-resource\", scope=\"a b\"",
        );
        assert_eq!(
            challenge_parameter(&quoted, "resource_metadata").as_deref(),
            Some("https://mcp.example/.well-known/oauth-protected-resource")
        );
        assert_eq!(
            challenge_parameter(&quoted, "scope").as_deref(),
            Some("a b")
        );
        let bare = header("Bearer Resource_Metadata=https://mcp.example/meta, realm=x");
        assert_eq!(
            challenge_parameter(&bare, "resource_metadata").as_deref(),
            Some("https://mcp.example/meta")
        );
        // The tail of a longer parameter name is not this parameter.
        let other = header("Bearer x_resource_metadata=\"https://elsewhere.example\"");
        assert!(challenge_parameter(&other, "resource_metadata").is_none());
        assert!(
            challenge_parameter(&header("Bearer realm=\"mcp\""), "resource_metadata").is_none()
        );
    }
}
