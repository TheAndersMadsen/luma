//! The wearer's music provider accounts.
//!
//! Stock linked a music provider on humane.center (INFERRED: the device has no
//! linking flow; `TidalUserManager` only fetches a token, and TIDAL's
//! `DEVICE_AUTHORIZATION` method is never referenced) and the Pin received the
//! result through `PartnerTokenRPCService`. Luma plays YouTube Music and TIDAL
//! through Center's provider gateway instead of the stock TIDAL client, keeps
//! Spotify on the Pin, and can link Apple Music, so this account state is
//! Luma-owned. The paths and shapes are INFERRED:
//!
//! - `GET /account-service/music-providers`: which provider the Pin plays from
//!   and which accounts are linked. Web plane only, and never a credential.
//! - `PUT /account-service/music-providers/active {provider}`: web plane only.
//! - `GET|PUT /account-service/music-providers/credentials`: the linked
//!   accounts themselves, for Center's provider gateway. It reads the wearer's
//!   OAuth credentials for a catalog query or a playback, and writes back what
//!   a sign-in, a token refresh or a disconnect produced. Edge plane only: the
//!   gateway acts for the Pin's owner when no browser is involved, and a
//!   browser session never reads a token. Every write names the revision it
//!   read, and a stale one is refused with 409, so two writers never lose each
//!   other's change. A write whose compare-and-swap keeps losing answers 409
//!   too, contention to re-read and retry, never a pretend outage.
//! - `GET /music/artwork/{provider}/{id}`: where a played track's cover is,
//!   for My Data and the dashboard. Web plane only.
//!
//! ## At rest
//!
//! One `MusicProviderAccounts` blob per account. The active provider is plain,
//! because Cosmos's own music grounding reads it
//! (`backends::music_discovery`). The linked accounts are sealed under a
//! per-wearer AES key Cosmos mints into the key directory, with the payload
//! type as AAD, as `account_api` seals web-written food restrictions. Each mint
//! names a fresh kid, so two first links racing cannot replace the key the
//! other sealed under. A sealed record this deployment can no longer open (its
//! key is gone) reads as unlinked, and the owner links again. Only a kid minted
//! for this account is opened or reused, as `account_api` opens only its own
//! kid, so a record that names another wearer's key reads as unlinked too.
//! Once a write leaves nothing sealed under a key (every provider
//! disconnected), that key is removed, so the old credentials are gone with it.
//!
//! ## What the Pin receives
//!
//! Nothing here reaches the Pin. Stock hands a linked provider's token to the
//! device only through `PartnerTokenRPCService.GetToken`, and only encrypted
//! for it: the long-lived arm is RSA-OAEP under the device's
//! `DeviceConfigurationCertificate`, and the short-lived arm is a
//! PARTNER_SERVICES data-protection envelope holding an `AccessToken`
//! (`PartnerServicesAccessManager.java:52-92`). Cosmos holds neither key, and a
//! Luma Pin disables the stock TIDAL user manager
//! (`MusicHooks.installTidalFailClosed`). So the credentials stay server-side
//! and `GetToken` keeps answering only what an operator ingested sealed
//! (`services::partnerservices`).

use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::backends::BackendError;
use crate::backends::music::MusicProvider;
use crate::keydirectory::{KeyDirectoryError, SharedKeyDirectory};
use crate::store::{AccountBlobKind, SharedStore, StoreError};
use crate::web_api::{ApiState, RequestPlane, key_directory_miss, unavailable};

/// The payload type the linked accounts are sealed with.
const LINKS_AAD: &[u8] = b"luma.music.ProviderLinks";

/// One write carries at most a few provider tokens. Stock gives no bound.
const MAX_BODY_BYTES: usize = 128 * 1024;
/// OAuth tokens, Apple's user token and a client secret.
const MAX_SECRET_CHARS: usize = 16 * 1024;
const MAX_FIELD_CHARS: usize = 1024;
const MAX_URI_CHARS: usize = 2048;
/// A read-modify-write that keeps losing to other writers gives up here.
const UPDATE_ATTEMPTS: usize = 16;
/// A TIDAL access token this close to expiry, with no refresh token, is
/// already unusable for a playback.
const TIDAL_EXPIRY_MARGIN_MS: u64 = 60_000;

// ── At rest ─────────────────────────────────────────────────────────────────

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredAccounts {
    #[serde(default)]
    active_provider: MusicProvider,
    /// Bumped by every write of the linked accounts.
    #[serde(default)]
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sealed: Option<SealedLinks>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SealedLinks {
    kid: String,
    /// The serialized envelope, standard base64.
    envelope: String,
}

/// The linked accounts. Deliberately no `Debug`: every field is a credential
/// or sits beside one.
#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ProviderLinks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    youtube_music: Option<YoutubeLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tidal: Option<TidalLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    apple_music: Option<AppleLink>,
}

/// The YouTube OAuth grant youtubei.js signs in with.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct YoutubeLink {
    credentials: YoutubeCredentials,
    connected_at: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct YoutubeCredentials {
    access_token: String,
    refresh_token: String,
    expiry_date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client: Option<OAuthClient>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct OAuthClient {
    client_id: String,
    client_secret: String,
}

/// TIDAL's official OAuth link: the grant once linked, and the PKCE state of a
/// sign-in in progress.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct TidalLink {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credentials: Option<TidalCredentials>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    connected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<TidalPending>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct TidalCredentials {
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    /// Unix milliseconds.
    expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_type: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct TidalPending {
    state: String,
    verifier: String,
    redirect_uri: String,
    /// Unix milliseconds.
    expires_at: u64,
}

/// A MusicKit user token. Apple's playback runtime is not on the Pin, so it is
/// linked but never played from.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AppleLink {
    music_user_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    storefront: Option<String>,
    connected_at: String,
}

fn text(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max_chars
        && !value.chars().any(char::is_control)
}

fn optional_text(value: Option<&str>, max_chars: usize) -> bool {
    value.is_none_or(|value| text(value, max_chars))
}

impl ProviderLinks {
    fn is_empty(&self) -> bool {
        self.youtube_music.is_none() && self.tidal.is_none() && self.apple_music.is_none()
    }

    /// Luma's bounds. No provider publishes one for its tokens.
    fn validate(&self) -> Result<(), &'static str> {
        if let Some(youtube) = &self.youtube_music {
            let credentials = &youtube.credentials;
            let client_ok = credentials.client.as_ref().is_none_or(|client| {
                text(&client.client_id, MAX_FIELD_CHARS)
                    && text(&client.client_secret, MAX_SECRET_CHARS)
            });
            if !text(&credentials.access_token, MAX_SECRET_CHARS)
                || !text(&credentials.refresh_token, MAX_SECRET_CHARS)
                || !text(&credentials.expiry_date, 64)
                || !optional_text(credentials.scope.as_deref(), MAX_FIELD_CHARS)
                || !optional_text(credentials.token_type.as_deref(), 64)
                || !client_ok
                || !text(&youtube.connected_at, 64)
            {
                return Err("the YouTube Music credentials are invalid");
            }
        }
        if let Some(tidal) = &self.tidal {
            if tidal.credentials.is_none() && tidal.pending.is_none() {
                return Err("a TIDAL link needs credentials or a sign-in in progress");
            }
            if let Some(credentials) = &tidal.credentials
                && (!text(&credentials.access_token, MAX_SECRET_CHARS)
                    || !optional_text(credentials.refresh_token.as_deref(), MAX_SECRET_CHARS)
                    || !optional_text(credentials.user_id.as_deref(), 256)
                    || !credentials.country_code.as_deref().is_none_or(|code| {
                        code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_uppercase())
                    })
                    || !optional_text(credentials.scope.as_deref(), MAX_FIELD_CHARS)
                    || !optional_text(credentials.token_type.as_deref(), 64))
            {
                return Err("the TIDAL credentials are invalid");
            }
            if let Some(pending) = &tidal.pending
                && (!text(&pending.state, 256)
                    || !text(&pending.verifier, 256)
                    || !text(&pending.redirect_uri, MAX_URI_CHARS))
            {
                return Err("the TIDAL sign-in state is invalid");
            }
            if !optional_text(tidal.connected_at.as_deref(), 64) {
                return Err("the TIDAL link is invalid");
            }
        }
        if let Some(apple) = &self.apple_music
            && (!text(&apple.music_user_token, MAX_SECRET_CHARS)
                || !apple.storefront.as_deref().is_none_or(|storefront| {
                    storefront.len() == 2
                        && storefront.bytes().all(|byte| byte.is_ascii_lowercase())
                })
                || !text(&apple.connected_at, 64))
        {
            return Err("the Apple Music link is invalid");
        }
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// Why a request could not be answered from the store.
enum Failure {
    Store,
    Keys,
}

impl From<StoreError> for Failure {
    fn from(_: StoreError) -> Self {
        Self::Store
    }
}

impl From<KeyDirectoryError> for Failure {
    fn from(_: KeyDirectoryError) -> Self {
        Self::Keys
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Self::Store => unavailable(),
            Self::Keys => (
                StatusCode::SERVICE_UNAVAILABLE,
                "the key directory is unavailable",
            )
                .into_response(),
        }
    }
}

/// Every compare-and-swap attempt of one write lost: another writer kept
/// landing between this read and this write. Every read in between was
/// answered, so the store is fine, this is the same contention the
/// stale-revision refusal above reports, as 409 for the caller to re-read and
/// retry, never the 503 an outage answers with.
fn cas_contention() -> Response {
    (
        StatusCode::CONFLICT,
        "the music accounts kept changing while this write was retried; read them again and retry",
    )
        .into_response()
}

/// The stored blob as read, for the compare-and-swap, and what it holds.
async fn read_stored(
    store: &SharedStore,
    account: &str,
) -> Result<(Option<Vec<u8>>, StoredAccounts), Failure> {
    let raw = store
        .get_account_blob(account, AccountBlobKind::MusicProviderAccounts)
        .await?;
    let stored = match raw.as_deref() {
        None => StoredAccounts::default(),
        // Cosmos wrote it. A blob it cannot parse is not "nothing linked".
        Some(bytes) => serde_json::from_slice(bytes).map_err(|_| Failure::Store)?,
    };
    Ok((raw, stored))
}

/// The provider the account's Pin plays from. What Cosmos's music grounding
/// verifies a track against.
pub(crate) async fn active_provider(
    store: &SharedStore,
    account: &str,
) -> Result<MusicProvider, StoreError> {
    match read_stored(store, account).await {
        Ok((_, stored)) => Ok(stored.active_provider),
        Err(_) => Err(StoreError::Unavailable),
    }
}

/// Where this account's music keys sit in the key directory. Named after the
/// account, as the food restrictions key is, so the key directory (and account
/// deletion) attributes them.
fn kid_prefix(account: &str) -> String {
    format!("{account}/account-service/music-providers/")
}

/// Whether `kid` is one [`mint_key`] made for this account.
fn own_kid(account: &str, kid: &str) -> bool {
    kid.strip_prefix(&kid_prefix(account))
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
}

/// The linked accounts, opened. A record whose key is gone, or that no longer
/// opens under it, can never be read again, so it reads as nothing linked. So
/// does one sealed under a key that is not this account's: it is not this
/// wearer's to read, however it got here.
async fn open_links(
    keys: &SharedKeyDirectory,
    account: &str,
    sealed: Option<&SealedLinks>,
) -> Result<ProviderLinks, Failure> {
    let Some(sealed) = sealed else {
        return Ok(ProviderLinks::default());
    };
    let unreadable = || {
        // A content-free subject, like account_api's food-log path: the account
        // principal must not reach the logs (see `key_directory_miss`).
        key_directory_miss(
            keys,
            "music-providers",
            "the linked music accounts can no longer be opened; they read as unlinked",
        );
        Ok(ProviderLinks::default())
    };
    if !own_kid(account, &sealed.kid) {
        return unreadable();
    }
    let Ok(data) = base64::engine::general_purpose::STANDARD.decode(&sealed.envelope) else {
        return unreadable();
    };
    let envelope = cosmos_crypto::EncryptedData {
        kid: sealed.kid.clone(),
        data,
    };
    let plaintext = match keys.open(&envelope).await {
        Ok(Some(plaintext)) => plaintext,
        Ok(None) | Err(KeyDirectoryError::OpenFailed) => return unreadable(),
        Err(error) => return Err(error.into()),
    };
    if !cosmos_crypto::envelope_aad(&envelope.data).is_ok_and(|aad| aad == LINKS_AAD) {
        return unreadable();
    }
    // It opened under this account's key and says it is the linked accounts,
    // so a payload that does not parse is a Cosmos fault. Refusing keeps a
    // later write from replacing credentials this build could not read.
    serde_json::from_slice(&plaintext).map_err(|_| Failure::Store)
}

/// A fresh key for this account's linked accounts.
async fn mint_key(keys: &SharedKeyDirectory, account: &str) -> Result<String, Failure> {
    let mut suffix = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut suffix);
    let suffix: String = suffix.iter().map(|byte| format!("{byte:02x}")).collect();
    let kid = format!("{}{suffix}", kid_prefix(account));
    let mut key = [0u8; cosmos_crypto::AES_KEY_LEN];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
    keys.put(&kid, key).await?;
    Ok(kid)
}

/// Seal the linked accounts under the key the record already names, while it
/// is this account's and still held, or a freshly minted one. Returns the
/// sealed record and the kid minted for it.
async fn seal_links(
    keys: &SharedKeyDirectory,
    account: &str,
    links: &ProviderLinks,
    previous: Option<&SealedLinks>,
) -> Result<(Option<SealedLinks>, Option<String>), Failure> {
    if links.is_empty() {
        return Ok((None, None));
    }
    let plaintext = serde_json::to_vec(links).map_err(|_| Failure::Store)?;
    let sealed = |kid: String, envelope: cosmos_crypto::EncryptedData| SealedLinks {
        kid,
        envelope: base64::engine::general_purpose::STANDARD.encode(envelope.data),
    };
    // A key that is gone by now (another write unlinked everything) is simply
    // not reused. That write's revision then refuses this one.
    if let Some(previous) = previous.filter(|previous| own_kid(account, &previous.kid))
        && let Some(envelope) = keys.seal(&previous.kid, &plaintext, LINKS_AAD).await?
    {
        return Ok((Some(sealed(previous.kid.clone(), envelope)), None));
    }
    let kid = mint_key(keys, account).await?;
    let envelope = keys
        .seal(&kid, &plaintext, LINKS_AAD)
        .await?
        // The key went as soon as it was minted. Nothing was written.
        .ok_or(Failure::Keys)?;
    Ok((Some(sealed(kid.clone(), envelope)), Some(kid)))
}

async fn write_stored(
    store: &SharedStore,
    account: &str,
    expected: Option<&[u8]>,
    next: &StoredAccounts,
) -> Result<bool, Failure> {
    let bytes = serde_json::to_vec(next).map_err(|_| Failure::Store)?;
    Ok(store
        .compare_and_swap_account_blob(
            account,
            AccountBlobKind::MusicProviderAccounts,
            expected,
            &bytes,
        )
        .await?)
}

// ── The wearer's view ───────────────────────────────────────────────────────

#[derive(Serialize)]
struct LinkDto {
    linked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    connected_at: Option<String>,
}

#[derive(Serialize)]
struct TidalLinkDto {
    linked: bool,
    /// A sign-in was started and has not expired.
    connecting: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    connected_at: Option<String>,
}

#[derive(Serialize)]
struct ProvidersDto {
    active_provider: MusicProvider,
    youtube_music: LinkDto,
    tidal: TidalLinkDto,
    apple_music: LinkDto,
}

impl ProvidersDto {
    fn of(active_provider: MusicProvider, links: &ProviderLinks, now_ms: u64) -> Self {
        let tidal = links.tidal.as_ref();
        // A TIDAL grant is linked while its token is usable or can be renewed.
        let tidal_linked = tidal
            .and_then(|tidal| tidal.credentials.as_ref())
            .is_some_and(|credentials| {
                credentials.refresh_token.is_some()
                    || credentials.expires_at > now_ms.saturating_add(TIDAL_EXPIRY_MARGIN_MS)
            });
        Self {
            active_provider,
            youtube_music: LinkDto {
                linked: links.youtube_music.is_some(),
                connected_at: links
                    .youtube_music
                    .as_ref()
                    .map(|youtube| youtube.connected_at.clone()),
            },
            tidal: TidalLinkDto {
                linked: tidal_linked,
                connecting: tidal
                    .and_then(|tidal| tidal.pending.as_ref())
                    .is_some_and(|pending| pending.expires_at > now_ms),
                connected_at: tidal
                    .filter(|_| tidal_linked)
                    .and_then(|tidal| tidal.connected_at.clone()),
            },
            apple_music: LinkDto {
                linked: links.apple_music.is_some(),
                connected_at: links
                    .apple_music
                    .as_ref()
                    .map(|apple| apple.connected_at.clone()),
            },
        }
    }
}

async fn providers(state: &ApiState, account: &str) -> Result<ProvidersDto, Failure> {
    let (_, stored) = read_stored(&state.store, account).await?;
    let links = open_links(&state.keys, account, stored.sealed.as_ref()).await?;
    Ok(ProvidersDto::of(stored.active_provider, &links, now_ms()))
}

/// `GET /account-service/music-providers`.
async fn get_providers(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    match providers(&state, &account).await {
        Ok(dto) => Json(dto).into_response(),
        Err(failure) => failure.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActiveWrite {
    provider: MusicProvider,
}

/// `PUT /account-service/music-providers/active {provider}`.
///
/// Only records the choice. Whether a provider may be chosen (linked, and
/// playable on the Pin) is Center's check before it switches the Pin's music
/// bridge, which is what actually plays.
async fn put_active(
    State(state): State<ApiState>,
    headers: HeaderMap,
    body: Result<Json<ActiveWrite>, JsonRejection>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Ok(Json(write)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            "expected {\"provider\": \"spotify\" | \"youtube_music\" | \"tidal\" | \"apple_music\"}",
        )
            .into_response();
    };
    for _ in 0..UPDATE_ATTEMPTS {
        let (raw, mut stored) = match read_stored(&state.store, &account).await {
            Ok(read) => read,
            Err(failure) => return failure.into_response(),
        };
        stored.active_provider = write.provider;
        match write_stored(&state.store, &account, raw.as_deref(), &stored).await {
            Ok(true) => {
                return match providers(&state, &account).await {
                    Ok(dto) => Json(dto).into_response(),
                    Err(failure) => failure.into_response(),
                };
            }
            Ok(false) => continue,
            Err(failure) => return failure.into_response(),
        }
    }
    cas_contention()
}

// ── Center's provider gateway ───────────────────────────────────────────────

/// The account Center's gateway speaks for, only on the edge plane.
fn gateway_account(state: &ApiState, headers: &HeaderMap) -> Result<String, Response> {
    match state.account_for(headers) {
        Ok(resolved) if resolved.plane == RequestPlane::Device => Ok(resolved.account),
        Ok(_) => Err(StatusCode::FORBIDDEN.into_response()),
        Err(status) => Err(status.into_response()),
    }
}

#[derive(Serialize)]
struct CredentialsDto {
    revision: u64,
    accounts: ProviderLinks,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialsWrite {
    /// The revision the writer read.
    revision: u64,
    accounts: ProviderLinks,
}

#[derive(Serialize)]
struct RevisionDto {
    revision: u64,
}

fn private<T: IntoResponse>(response: T) -> Response {
    let mut response = response.into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    response
}

/// `GET /account-service/music-providers/credentials`.
async fn get_credentials(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let account = match gateway_account(&state, &headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let read = async {
        let (_, stored) = read_stored(&state.store, &account).await?;
        let accounts = open_links(&state.keys, &account, stored.sealed.as_ref()).await?;
        Ok::<_, Failure>(CredentialsDto {
            revision: stored.revision,
            accounts,
        })
    };
    match read.await {
        Ok(dto) => private(Json(dto)),
        Err(failure) => failure.into_response(),
    }
}

/// `PUT /account-service/music-providers/credentials {revision, accounts}`.
async fn put_credentials(
    State(state): State<ApiState>,
    headers: HeaderMap,
    body: Result<Json<CredentialsWrite>, JsonRejection>,
) -> Response {
    let account = match gateway_account(&state, &headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Ok(Json(write)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            "expected {revision, accounts} with known providers only",
        )
            .into_response();
    };
    if let Err(reason) = write.accounts.validate() {
        return (StatusCode::BAD_REQUEST, reason).into_response();
    }
    for _ in 0..UPDATE_ATTEMPTS {
        let (raw, stored) = match read_stored(&state.store, &account).await {
            Ok(read) => read,
            Err(failure) => return failure.into_response(),
        };
        if stored.revision != write.revision {
            return (
                StatusCode::CONFLICT,
                "the music accounts changed since they were read",
            )
                .into_response();
        }
        let (sealed, minted) = match seal_links(
            &state.keys,
            &account,
            &write.accounts,
            stored.sealed.as_ref(),
        )
        .await
        {
            Ok(sealed) => sealed,
            Err(failure) => return failure.into_response(),
        };
        let next = StoredAccounts {
            active_provider: stored.active_provider,
            revision: stored.revision + 1,
            sealed,
        };
        match write_stored(&state.store, &account, raw.as_deref(), &next).await {
            Ok(true) => {
                // The key the replaced record was sealed under now seals
                // nothing kept (every provider was disconnected), so it goes,
                // and the old credentials with it. A failed removal leaves
                // only a key that opens nothing.
                if let Some(previous) = stored.sealed.as_ref().filter(|previous| {
                    own_kid(&account, &previous.kid)
                        && next
                            .sealed
                            .as_ref()
                            .is_none_or(|sealed| sealed.kid != previous.kid)
                }) {
                    let _ = state.keys.remove(&previous.kid).await;
                }
                return private(Json(RevisionDto {
                    revision: next.revision,
                }));
            }
            Ok(false) => {
                // Another write landed first. A key minted for this attempt
                // seals nothing that was kept.
                if let Some(kid) = minted {
                    let _ = state.keys.remove(&kid).await;
                }
            }
            Err(failure) => return failure.into_response(),
        }
    }
    cas_contention()
}

// ── Artwork ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ArtworkDto {
    url: String,
}

/// `GET /music/artwork/{provider}/{id}`: the cover of a played track, from the
/// `provider` and `trackID` My Data and the dashboard carry.
async fn get_artwork(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((provider, id)): Path<(String, String)>,
) -> Response {
    if let Err(refused) = state.web_caller(&headers) {
        return refused;
    }
    let Some(provider) = MusicProvider::parse(&provider) else {
        return (StatusCode::NOT_FOUND, "no artwork for that track").into_response();
    };
    match crate::backends::music::artwork_url(provider, &id).await {
        Ok(url) => Json(ArtworkDto { url }).into_response(),
        Err(BackendError::NoResult | BackendError::NotConfigured) => {
            (StatusCode::NOT_FOUND, "no artwork for that track").into_response()
        }
        Err(BackendError::Unavailable) => {
            (StatusCode::BAD_GATEWAY, "the artwork lookup failed").into_response()
        }
    }
}

/// Mount the music routes over the shared web state.
pub(crate) fn router(state: ApiState) -> Router {
    Router::new()
        .route("/account-service/music-providers", get(get_providers))
        .route("/account-service/music-providers/active", put(put_active))
        .route(
            "/account-service/music-providers/credentials",
            get(get_credentials).put(put_credentials),
        )
        .route("/music/artwork/:provider/:id", get(get_artwork))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_api::DEMO_PRINCIPAL;
    use crate::web_api::test_support::*;
    use axum::http::Method;
    use serde_json::{Value, json};

    const PROVIDERS: &str = "/account-service/music-providers";
    const ACTIVE: &str = "/account-service/music-providers/active";
    const CREDENTIALS: &str = "/account-service/music-providers/credentials";

    fn app_with(store: SharedStore, keys: SharedKeyDirectory) -> Router {
        router(ApiState::for_tests(
            store,
            keys,
            DEMO_PRINCIPAL,
            internet_facing(),
            Some(test_verifier()),
            None,
        ))
    }

    /// Center's provider gateway speaking for `account` with the edge proof.
    fn gateway_for(account: &str) -> Vec<(&'static str, String)> {
        vec![
            (crate::config::EDGE_PRINCIPAL_HEADER, format!("U:{account}")),
            (crate::config::EDGE_TOKEN_HEADER, EDGE_TOKEN.to_owned()),
        ]
    }

    fn youtube_link() -> Value {
        json!({
            "credentials": {
                "access_token": "yt-access-secret",
                "refresh_token": "yt-refresh-secret",
                "expiry_date": "2026-09-24T00:00:00.000Z",
                "scope": "http://gdata.youtube.com",
                "token_type": "Bearer",
            },
            "connected_at": "2026-09-23T00:00:00.000Z",
        })
    }

    fn tidal_link() -> Value {
        json!({
            "credentials": {
                "access_token": "tidal-access-secret",
                "refresh_token": "tidal-refresh-secret",
                "expires_at": 4_102_444_800_000_u64,
                "user_id": "123",
                "country_code": "DK",
            },
            "connected_at": "2026-09-23T00:00:00.000Z",
        })
    }

    fn apple_link() -> Value {
        json!({
            "music_user_token": "apple-user-secret",
            "storefront": "dk",
            "connected_at": "2026-09-23T00:00:00.000Z",
        })
    }

    async fn stored(store: &SharedStore, account: &str) -> Option<Value> {
        store
            .get_account_blob(account, AccountBlobKind::MusicProviderAccounts)
            .await
            .unwrap()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn music_providers_round_trip_and_are_principal_scoped() {
        let app = app_with(fresh(), fresh_keys());
        let (status, body) =
            send(&app, Method::GET, CREDENTIALS, &gateway_for("alice"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"revision": 0, "accounts": {}}));

        let accounts = json!({
            "youtube_music": youtube_link(),
            "tidal": tidal_link(),
            "apple_music": apple_link(),
        });
        let (status, body) = send(
            &app,
            Method::PUT,
            CREDENTIALS,
            &gateway_for("alice"),
            Some(json!({"revision": 0, "accounts": accounts})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"revision": 1}));

        let (_, body) = send(&app, Method::GET, CREDENTIALS, &gateway_for("alice"), None).await;
        assert_eq!(body, json!({"revision": 1, "accounts": accounts}));
        let (_, body) = send(&app, Method::GET, CREDENTIALS, &gateway_for("bob"), None).await;
        assert_eq!(
            body,
            json!({"revision": 0, "accounts": {}}),
            "bob sees none of it"
        );

        let (status, body) = send(
            &app,
            Method::GET,
            PROVIDERS,
            &[bearer_header("alice")],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "active_provider": "spotify",
                "youtube_music": {"linked": true, "connected_at": "2026-09-23T00:00:00.000Z"},
                "tidal": {"linked": true, "connecting": false, "connected_at": "2026-09-23T00:00:00.000Z"},
                "apple_music": {"linked": true, "connected_at": "2026-09-23T00:00:00.000Z"},
            })
        );
        let (_, body) = send(&app, Method::GET, PROVIDERS, &[bearer_header("bob")], None).await;
        assert_eq!(
            body,
            json!({
                "active_provider": "spotify",
                "youtube_music": {"linked": false},
                "tidal": {"linked": false, "connecting": false},
                "apple_music": {"linked": false},
            })
        );
    }

    /// The production topology: PostgreSQL holds the blob and the key
    /// directory, and every Cosmos workload reads both. A link written through
    /// one workload's router is read, sealed, through another's.
    #[tokio::test]
    async fn music_providers_round_trip_on_the_shared_postgres_store() {
        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let connect = || async {
            let store: SharedStore = std::sync::Arc::new(
                crate::store_postgres::PostgresStore::connect(&url)
                    .await
                    .expect("COSMOS_TEST_DATABASE_URL is set but connect/migrate failed"),
            );
            let keys: SharedKeyDirectory = std::sync::Arc::new(
                crate::keydirectory::KeyDirectory::connect(&url)
                    .await
                    .expect("the shared key directory connects"),
            );
            (store, keys)
        };
        let (store, keys) = connect().await;
        let (other_store, other_keys) = connect().await;
        let writer = app_with(store.clone(), keys.clone());
        let reader = app_with(other_store, other_keys);
        let account = format!("pg-music-{}", uuid::Uuid::new_v4());
        let accounts = json!({"youtube_music": youtube_link(), "tidal": tidal_link()});

        let (status, _) = send(
            &writer,
            Method::PUT,
            CREDENTIALS,
            &gateway_for(&account),
            Some(json!({"revision": 0, "accounts": accounts})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, read) = send(
            &reader,
            Method::GET,
            CREDENTIALS,
            &gateway_for(&account),
            None,
        )
        .await;
        assert_eq!(read, json!({"revision": 1, "accounts": accounts}));

        let (status, view) = send(
            &reader,
            Method::PUT,
            ACTIVE,
            &[bearer_header(&account)],
            Some(json!({"provider": "tidal"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(view["tidal"]["linked"], true);
        assert_eq!(
            active_provider(&store, &format!("U:{account}"))
                .await
                .unwrap(),
            MusicProvider::Tidal
        );

        let raw = store
            .get_account_blob(
                &format!("U:{account}"),
                AccountBlobKind::MusicProviderAccounts,
            )
            .await
            .unwrap()
            .unwrap();
        let raw = String::from_utf8(raw).unwrap();
        for secret in ["yt-access-secret", "tidal-refresh-secret"] {
            assert!(
                !raw.contains(secret),
                "{secret} must not be stored in the clear"
            );
        }
        let (_, bob) = send(
            &reader,
            Method::GET,
            CREDENTIALS,
            &gateway_for(&format!("{account}-b")),
            None,
        )
        .await;
        assert_eq!(bob, json!({"revision": 0, "accounts": {}}));

        // Disconnecting everything through one workload removes the shared key
        // every workload would have opened the old record with.
        let kid = stored(&store, &format!("U:{account}")).await.unwrap()["sealed"]["kid"]
            .as_str()
            .unwrap()
            .to_owned();
        let (status, _) = send(
            &reader,
            Method::PUT,
            CREDENTIALS,
            &gateway_for(&account),
            Some(json!({"revision": 1, "accounts": {}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!keys.holds(&kid).await.unwrap());
    }

    #[tokio::test]
    async fn linked_accounts_are_sealed_at_rest_under_the_wearers_own_key() {
        let store = fresh();
        let keys = fresh_keys();
        let app = app_with(store.clone(), keys.clone());
        let (status, _) = send(
            &app,
            Method::PUT,
            CREDENTIALS,
            &gateway_for("alice"),
            Some(json!({"revision": 0, "accounts": {"youtube_music": youtube_link(), "apple_music": apple_link()}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let raw = store
            .get_account_blob("U:alice", AccountBlobKind::MusicProviderAccounts)
            .await
            .unwrap()
            .unwrap();
        let raw = String::from_utf8(raw).unwrap();
        for secret in ["yt-access-secret", "yt-refresh-secret", "apple-user-secret"] {
            assert!(
                !raw.contains(secret),
                "{secret} must not be stored in the clear"
            );
        }
        let blob = stored(&store, "U:alice").await.unwrap();
        assert_eq!(blob["active_provider"], "spotify");
        assert_eq!(blob["revision"], 1);
        let kid = blob["sealed"]["kid"].as_str().unwrap();
        assert!(kid.starts_with("U:alice/account-service/music-providers/"));
        assert!(keys.holds(kid).await.unwrap());
    }

    #[tokio::test]
    async fn the_credentials_answer_only_the_gateway_on_the_edge_plane() {
        let app = app_with(fresh(), fresh_keys());
        let body = json!({"revision": 0, "accounts": {"apple_music": apple_link()}});
        let forged = vec![(crate::config::EDGE_PRINCIPAL_HEADER, "U:alice".to_owned())];
        let wrong = vec![
            (crate::config::EDGE_PRINCIPAL_HEADER, "U:alice".to_owned()),
            (
                crate::config::EDGE_TOKEN_HEADER,
                "not-the-secret".to_owned(),
            ),
        ];
        for (who, headers, expected) in [
            (
                "a signed-in browser",
                vec![bearer_header("alice")],
                StatusCode::FORBIDDEN,
            ),
            ("nobody", Vec::new(), StatusCode::UNAUTHORIZED),
            ("a bare edge marker", forged, StatusCode::UNAUTHORIZED),
            ("a wrong edge proof", wrong, StatusCode::UNAUTHORIZED),
        ] {
            let (status, _) = send(&app, Method::GET, CREDENTIALS, &headers, None).await;
            assert_eq!(status, expected, "GET from {who}");
            let (status, _) =
                send(&app, Method::PUT, CREDENTIALS, &headers, Some(body.clone())).await;
            assert_eq!(status, expected, "PUT from {who}");
        }
        let (_, read) = send(&app, Method::GET, CREDENTIALS, &gateway_for("alice"), None).await;
        assert_eq!(
            read,
            json!({"revision": 0, "accounts": {}}),
            "nothing was written"
        );
    }

    #[tokio::test]
    async fn the_wearers_view_and_choice_answer_only_the_web_plane() {
        let app = app_with(fresh(), fresh_keys());
        for (who, headers, expected) in [
            ("the gateway", gateway_for("alice"), StatusCode::FORBIDDEN),
            ("nobody", Vec::new(), StatusCode::UNAUTHORIZED),
        ] {
            let (status, _) = send(&app, Method::GET, PROVIDERS, &headers, None).await;
            assert_eq!(status, expected, "GET from {who}");
            let (status, _) = send(
                &app,
                Method::PUT,
                ACTIVE,
                &headers,
                Some(json!({"provider": "tidal"})),
            )
            .await;
            assert_eq!(status, expected, "PUT from {who}");
        }
    }

    #[tokio::test]
    async fn each_first_link_mints_its_own_key_so_a_racing_writer_cannot_strand_a_record() {
        let keys = fresh_keys();
        let links: ProviderLinks =
            serde_json::from_value(json!({"apple_music": apple_link()})).unwrap();
        let (first, first_minted) = seal_links(&keys, "U:alice", &links, None)
            .await
            .ok()
            .unwrap();
        let (second, second_minted) = seal_links(&keys, "U:alice", &links, None)
            .await
            .ok()
            .unwrap();
        let (first, second) = (first.unwrap(), second.unwrap());
        assert_eq!(first_minted.as_deref(), Some(first.kid.as_str()));
        assert_eq!(second_minted.as_deref(), Some(second.kid.as_str()));
        assert_ne!(first.kid, second.kid);
        let opened = open_links(&keys, "U:alice", Some(&first))
            .await
            .ok()
            .unwrap();
        assert!(
            opened == links,
            "the second mint left the first record readable"
        );

        let (reused, minted) = seal_links(&keys, "U:alice", &links, Some(&first))
            .await
            .ok()
            .unwrap();
        assert_eq!(reused.unwrap().kid, first.kid, "a held key is reused");
        assert!(minted.is_none());
    }

    /// A record is opened only under a key minted for its own account, as
    /// `account_api` opens only its own kid. Alice's record copied into Bob's
    /// row names Alice's key, so Bob's gateway reads nothing linked, and Bob's
    /// next link neither reuses nor removes Alice's key.
    #[tokio::test]
    async fn a_record_naming_another_wearers_key_is_neither_opened_nor_reused() {
        let store = fresh();
        let keys = fresh_keys();
        let app = app_with(store.clone(), keys.clone());
        let alice_link = json!({"revision": 0, "accounts": {"apple_music": apple_link()}});
        let (status, _) = send(
            &app,
            Method::PUT,
            CREDENTIALS,
            &gateway_for("alice"),
            Some(alice_link),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let alice_blob = store
            .get_account_blob("U:alice", AccountBlobKind::MusicProviderAccounts)
            .await
            .unwrap()
            .unwrap();
        let alice_kid = stored(&store, "U:alice").await.unwrap()["sealed"]["kid"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .put_account_blob("U:bob", AccountBlobKind::MusicProviderAccounts, &alice_blob)
            .await
            .unwrap();

        let bob = gateway_for("bob");
        let (status, read) = send(&app, Method::GET, CREDENTIALS, &bob, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(read, json!({"revision": 1, "accounts": {}}));
        let (_, view) = send(&app, Method::GET, PROVIDERS, &[bearer_header("bob")], None).await;
        assert_eq!(view["apple_music"]["linked"], false);

        let bob_link = json!({"revision": 1, "accounts": {"youtube_music": youtube_link()}});
        let (status, _) = send(&app, Method::PUT, CREDENTIALS, &bob, Some(bob_link)).await;
        assert_eq!(status, StatusCode::OK);
        let bob_kid = stored(&store, "U:bob").await.unwrap()["sealed"]["kid"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(bob_kid.starts_with("U:bob/account-service/music-providers/"));
        assert!(keys.holds(&alice_kid).await.unwrap(), "Alice's key stays");
        let (_, read) = send(&app, Method::GET, CREDENTIALS, &gateway_for("alice"), None).await;
        assert_eq!(
            read,
            json!({"revision": 1, "accounts": {"apple_music": apple_link()}})
        );
    }

    /// Disconnecting every provider removes the key the credentials were
    /// sealed under, so nothing that key ever sealed can be opened again. A
    /// later link mints a fresh key.
    #[tokio::test]
    async fn unlinking_every_provider_removes_the_key_that_sealed_them() {
        let store = fresh();
        let keys = fresh_keys();
        let app = app_with(store.clone(), keys.clone());
        let alice = gateway_for("alice");
        let link = json!({"revision": 0, "accounts": {"tidal": tidal_link()}});
        send(&app, Method::PUT, CREDENTIALS, &alice, Some(link)).await;
        let first = stored(&store, "U:alice").await.unwrap()["sealed"]["kid"]
            .as_str()
            .unwrap()
            .to_owned();

        let one_left = json!({"revision": 1, "accounts": {"apple_music": apple_link()}});
        let (status, _) = send(&app, Method::PUT, CREDENTIALS, &alice, Some(one_left)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            keys.holds(&first).await.unwrap(),
            "a record still sealed under the key keeps it"
        );

        let (status, _) = send(
            &app,
            Method::PUT,
            CREDENTIALS,
            &alice,
            Some(json!({"revision": 2, "accounts": {}})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!keys.holds(&first).await.unwrap(), "the key went with them");
        assert_eq!(
            stored(&store, "U:alice").await.unwrap(),
            json!({"active_provider": "spotify", "revision": 3})
        );

        let relink = json!({"revision": 3, "accounts": {"tidal": tidal_link()}});
        let (status, _) = send(&app, Method::PUT, CREDENTIALS, &alice, Some(relink)).await;
        assert_eq!(status, StatusCode::OK);
        let (_, read) = send(&app, Method::GET, CREDENTIALS, &alice, None).await;
        assert_eq!(
            read,
            json!({"revision": 4, "accounts": {"tidal": tidal_link()}})
        );
    }

    /// Deleting the account takes the linked accounts with it: the blob is an
    /// account blob `Store::purge_account` removes, and the key's kid names the
    /// wearer, which is how `account_api`'s deletion finds the keys to remove.
    #[tokio::test]
    async fn account_deletion_finds_the_linked_accounts_and_their_key() {
        let store = fresh();
        let app = app_with(store.clone(), fresh_keys());
        let link = json!({"revision": 0, "accounts": {"apple_music": apple_link()}});
        let (status, _) = send(
            &app,
            Method::PUT,
            CREDENTIALS,
            &gateway_for("alice"),
            Some(link),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let kid = stored(&store, "U:alice").await.unwrap()["sealed"]["kid"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            crate::services::public_privacy::kid_user_id(&kid),
            Some("alice")
        );
        store.purge_account("U:alice").await.unwrap();
        assert!(stored(&store, "U:alice").await.is_none());
    }

    /// Stock hands the Pin a linked provider's token only through `GetToken`,
    /// and only sealed for the device (`PartnerServicesAccessManager.java:52-92`).
    /// Cosmos can seal for neither arm, so a link made here gives the Pin
    /// nothing.
    #[tokio::test]
    async fn linking_a_provider_never_hands_the_pin_a_partner_token() {
        use crate::services::partnerservices::PartnerToken;
        use cosmos_protocol::partnerservices as pb;
        use pb::partner_token_rpc_service_server::PartnerTokenRpcService as _;

        let store = fresh();
        let app = app_with(store.clone(), fresh_keys());
        let linked = json!({"revision": 0, "accounts": {"tidal": tidal_link(), "youtube_music": youtube_link()}});
        let (status, _) = send(
            &app,
            Method::PUT,
            CREDENTIALS,
            &gateway_for("alice"),
            Some(linked),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let pin = |provider: &str| {
            let mut request = tonic::Request::new(pb::DeviceUserAccessTokenRequest {
                provider_name: provider.to_owned(),
            });
            request
                .extensions_mut()
                .insert(cosmos_core::AuthenticatedPrincipal::from_edge("U:alice").unwrap());
            request
        };
        let service = PartnerToken::with_store(store);
        for provider in ["tidal", "youtube_music", ""] {
            let token = service.get_token(pin(provider)).await.unwrap().into_inner();
            assert!(token.accesstoken.is_none(), "GetToken({provider:?})");
            let tokens = service
                .get_tokens(pin(provider))
                .await
                .unwrap()
                .into_inner();
            assert!(tokens.tokens.is_empty(), "GetTokens({provider:?})");
        }
    }
}
