//! Lost-device block mode: the stock `unauthorized-device` trailer.
//!
//! Stock ironman's `AccountAuthorizationInterceptor` sits on every account
//! channel. When an RPC closes `PERMISSION_DENIED` with an `unauthorized-device`
//! trailer (a comma-separated set of `UnauthorizedStatusCode`s) it records the
//! set, locks the keyguard and broadcasts `LOCKED_UNAUTHORIZED_DEVICE`. Any OK
//! close clears the set again (`AccountAuthorizationInterceptor.java` 57-99,
//! `AccountAuthorizationManager.handleDeviceAuthorizationUpdate`). While the set
//! is non-empty every action becomes `UnauthorizedDevice`, which speaks "This Ai
//! Pin is in block mode. Visit humane.center/devices to disable this mode"
//! (`humane_answers` `blocked_device`). The block was set on that web page.
//!
//! Luma keeps the wearer's blocked Pins in [`DeviceBlocks`], under the wearer's
//! account principal (`AccountBlobKind::DeviceBlocks`). Center's devices page
//! writes it through `account_api` (`POST/DELETE
//! /device-assignments/devices/{id}/block`), and [`DeviceBlockLayer`] answers
//! every RPC from a blocked Pin with [`gates::unauthorized_device_status`]
//! before any handler runs.
//!
//! Three properties are load-bearing:
//!
//! 1. **Every RPC, or none.** The device clears block mode on *any* OK close, so
//!    a single call served normally would unlock it. A block list that cannot
//!    be read is therefore answered UNAVAILABLE, which neither locks nor
//!    unlocks, never with a normal answer.
//! 2. **Healthy calls carry no account trailer.** An unblocked Pin reaches its
//!    handler untouched. This layer adds nothing to its response.
//! 3. **Onboarding is exempt.** `DeviceOnboardingDACService` is the attestation
//!    plane, not an account channel: a blocked Pin must still be able to
//!    re-onboard.
//!
//! The layer sits inside `auth::AuthLayer` (see `lib.rs`), so it reads the
//! account that layer resolved and the DeviceUser CN it resolved it from. The
//! block list is read from the deployment's configured store on first use. With
//! PostgreSQL that is the one database every workload shares, so a block written
//! from the web reaches every workload the Pin talks to.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::http;
use cosmos_core::AuthenticatedPrincipal;
use cosmos_protocol::account::UnauthorizedStatusCode;
use serde::{Deserialize, Serialize};
use tonic::Status;

use crate::services::gates;
use crate::store::{AccountBlobKind, SharedStore, StoreError, Written};

/// The Pins one wearer has put in block mode, keyed by device id.
///
/// Luma-owned JSON under `AccountBlobKind::DeviceBlocks`: the stock web
/// backend's own record of a block was not recovered, only its trailer.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceBlocks {
    #[serde(default)]
    devices: BTreeMap<String, DeviceBlock>,
}

/// One blocked Pin.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceBlock {
    /// `UnauthorizedStatusCode` numbers, exactly as the trailer carries them.
    pub(crate) reasons: Vec<i32>,
    /// Epoch seconds the wearer turned block mode on.
    pub(crate) blocked_at_epoch: i64,
}

impl DeviceBlocks {
    /// The block on one Pin, if it has one.
    pub(crate) fn get(&self, device_id: &str) -> Option<&DeviceBlock> {
        self.devices.get(device_id)
    }

    /// Every blocked Pin, by device id.
    pub(crate) fn iter(&self) -> impl Iterator<Item = (&String, &DeviceBlock)> {
        self.devices.iter()
    }

    /// Whether no Pin of this wearer is in block mode.
    pub(crate) fn is_empty(&self) -> bool {
        self.devices.is_empty()
    }

    /// The reason set this Pin is refused with. Empty when it is not blocked.
    fn reasons(&self, device_id: &str) -> Vec<UnauthorizedStatusCode> {
        self.devices
            .get(device_id)
            .map(|block| {
                block
                    .reasons
                    .iter()
                    .filter_map(|code| UnauthorizedStatusCode::try_from(*code).ok())
                    .filter(|code| *code != UnauthorizedStatusCode::Unspecified)
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// How often a block write re-reads after losing a race to another writer.
const WRITE_ATTEMPTS: usize = 8;

/// The wearer's block list and the exact bytes it was read from.
async fn load(store: &SharedStore, account: &str) -> Written<(DeviceBlocks, Option<Vec<u8>>)> {
    let raw = store
        .get_account_blob(account, AccountBlobKind::DeviceBlocks)
        .await?;
    let blocks = match raw.as_deref() {
        None => DeviceBlocks::default(),
        Some(bytes) => serde_json::from_slice(bytes).map_err(|_| {
            // A list we wrote and cannot read is an outage, never "no blocks":
            // reading it as empty would unlock a lost Pin.
            tracing::error!("a stored device block list will not parse");
            StoreError::Unavailable
        })?,
    };
    Ok((blocks, raw))
}

/// The wearer's blocked Pins.
pub(crate) async fn device_blocks(store: &SharedStore, account: &str) -> Written<DeviceBlocks> {
    load(store, account).await.map(|(blocks, _)| blocks)
}

/// Turn block mode on for one of the wearer's Pins (`Some(reasons)`) or off
/// (`None`), and return the list as stored.
///
/// Blocking a Pin that is already blocked keeps its original reasons and time;
/// unblocking one that is not blocked changes nothing. Both are successes.
pub(crate) async fn set_block(
    store: &SharedStore,
    account: &str,
    device_id: &str,
    block: Option<&[UnauthorizedStatusCode]>,
) -> Written<DeviceBlocks> {
    for _ in 0..WRITE_ATTEMPTS {
        let (mut blocks, raw) = load(store, account).await?;
        let changed = match block {
            Some(_) if blocks.devices.contains_key(device_id) => false,
            Some(reasons) => {
                blocks.devices.insert(
                    device_id.to_owned(),
                    DeviceBlock {
                        reasons: reasons.iter().map(|reason| *reason as i32).collect(),
                        blocked_at_epoch: now_epoch_seconds(),
                    },
                );
                true
            }
            None => blocks.devices.remove(device_id).is_some(),
        };
        if !changed {
            return Ok(blocks);
        }
        let bytes = serde_json::to_vec(&blocks).map_err(|_| StoreError::Unavailable)?;
        if store
            .compare_and_swap_account_blob(
                account,
                AccountBlobKind::DeviceBlocks,
                raw.as_deref(),
                &bytes,
            )
            .await?
        {
            return Ok(blocks);
        }
    }
    Err(StoreError::Unavailable)
}

fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// gRPC path prefix of the onboarding (attestation) plane, which block mode
/// never refuses.
const ONBOARDING_SERVICE_PREFIX: &str = "/humane.provisioning.DeviceOnboardingDACService/";

/// The account and device id of the Pin making this call, or `None` when the
/// caller is not a Pin this layer can refuse.
///
/// Both come from the DeviceUser CN the edge verified (`V:xx:D:<device>:U:<user>`),
/// and only when `AuthLayer` resolved the account from that very CN. A web
/// caller's account comes from its Bearer, so a device header beside one names
/// no device here. Health probes carry no principal at all.
fn calling_device<B>(request: &http::Request<B>) -> Option<(String, String)> {
    if request.uri().path().starts_with(ONBOARDING_SERVICE_PREFIX) {
        return None;
    }
    let principal = request.extensions().get::<AuthenticatedPrincipal>()?;
    let header = request
        .headers()
        .get(crate::config::EDGE_PRINCIPAL_HEADER)?
        .to_str()
        .ok()?;
    let subject = crate::config::edge_subject(header);
    if AuthenticatedPrincipal::from_device_cn(subject).ok()? != *principal {
        return None;
    }
    let device_id = crate::enrollment::device_id_from_subject(subject)?.to_ascii_lowercase();
    Some((principal.expose_for_authorization().to_owned(), device_id))
}

/// The deployment's configured store, opened on first use and shared by every
/// call after it. `None` while it cannot be opened. The next call tries again.
async fn configured_store() -> Option<SharedStore> {
    static CONFIGURED: tokio::sync::OnceCell<SharedStore> = tokio::sync::OnceCell::const_new();
    CONFIGURED
        .get_or_try_init(|| async {
            match std::env::var(crate::store_postgres::DATABASE_URL_ENV) {
                Ok(url) if !url.trim().is_empty() => {
                    crate::store_postgres::PostgresStore::connect(url.trim())
                        .await
                        .map(|store| Arc::new(store) as SharedStore)
                        .map_err(|error| {
                            tracing::error!(%error, "the device block list is unreachable");
                        })
                }
                _ => Ok(crate::store::MemoryStore::shared()),
            }
        })
        .await
        .ok()
        .cloned()
}

/// How this call must be refused, or `None` to serve it.
async fn refusal(store: Option<SharedStore>, account: &str, device_id: &str) -> Option<Status> {
    let store = match store {
        Some(store) => store,
        None => match configured_store().await {
            Some(store) => store,
            None => return Some(block_list_unreadable()),
        },
    };
    match device_blocks(&store, account).await {
        Ok(blocks) => gates::Entitlement::unauthorized(blocks.reasons(device_id)).denial(),
        Err(_) => Some(block_list_unreadable()),
    }
}

/// Neither a lock nor an unlock: UNAVAILABLE carries no account trailer, so the
/// device keeps whatever block state it holds and retries.
fn block_list_unreadable() -> Status {
    Status::unavailable("the device block list could not be read; retry")
}

/// The block-mode layer `lib.rs` installs inside the front door.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeviceBlockLayer;

impl<S> tower::Layer<S> for DeviceBlockLayer {
    type Service = DeviceBlockService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        DeviceBlockService { inner, store: None }
    }
}

#[derive(Clone)]
pub struct DeviceBlockService<S> {
    inner: S,
    /// Where block lists are read. `None` is the deployment's configured
    /// store. Tests hand in their own.
    store: Option<SharedStore>,
}

impl<S, B> tower::Service<http::Request<B>> for DeviceBlockService<S>
where
    S: tower::Service<http::Request<B>, Response = http::Response<tonic::body::BoxBody>>
        + Clone
        + Send
        + 'static,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: http::Request<B>) -> Self::Future {
        let Some((account, device_id)) = calling_device(&request) else {
            return Box::pin(self.inner.call(request));
        };
        // The instance `poll_ready` readied serves this call. A fresh clone
        // takes its place for the next one.
        let fresh = self.inner.clone();
        let mut ready = std::mem::replace(&mut self.inner, fresh);
        let store = self.store.clone();
        Box::pin(async move {
            match refusal(store, &account, &device_id).await {
                None => ready.call(request).await,
                Some(status) => Ok(status.into_http()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tonic::codegen::Body as _;
    use tower::ServiceExt as _;

    const ALICE: &str = "alice";
    const LOST_PIN: &str = "a1b2c3d4";
    const OTHER_PIN: &str = "0badcafe";

    fn fresh() -> SharedStore {
        Arc::new(MemoryStore::default())
    }

    fn account() -> String {
        format!("U:{ALICE}")
    }

    /// A call the way `AuthLayer` hands it on: the edge's XFCC header, and the
    /// account it resolved from that header.
    fn from_pin<T>(path: &str, device_id: &str, body: T) -> http::Request<T> {
        let mut request = http::Request::builder()
            .uri(path)
            .header("content-type", "application/grpc")
            .header(
                crate::config::EDGE_PRINCIPAL_HEADER,
                format!(
                    "By=spiffe://cosmos.local/edge;Subject=\"CN=V:01:D:{device_id}:U:{ALICE}\""
                ),
            )
            .body(body)
            .unwrap();
        request
            .extensions_mut()
            .insert(AuthenticatedPrincipal::for_user(ALICE).unwrap());
        request
    }

    /// A stand-in handler that answers OK and counts what reached it.
    fn counting_handler(
        served: Arc<AtomicUsize>,
    ) -> impl tower::Service<
        http::Request<()>,
        Response = http::Response<tonic::body::BoxBody>,
        Error = std::convert::Infallible,
        Future = impl Send,
    > + Clone
    + Send
    + 'static {
        tower::service_fn(move |_request: http::Request<()>| {
            let served = served.clone();
            async move {
                served.fetch_add(1, Ordering::SeqCst);
                Ok::<_, std::convert::Infallible>(Status::ok("").into_http())
            }
        })
    }

    fn header<'a>(
        response: &'a http::Response<tonic::body::BoxBody>,
        name: &str,
    ) -> Option<&'a str> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    async fn trailers_of(body: tonic::body::BoxBody) -> http::HeaderMap {
        let mut body = std::pin::pin!(body);
        let mut trailers = http::HeaderMap::new();
        while let Some(frame) =
            std::future::poll_fn(|context| body.as_mut().poll_frame(context)).await
        {
            if let Ok(frame) = frame {
                if let Ok(frame_trailers) = frame.into_trailers() {
                    trailers.extend(frame_trailers);
                }
            }
        }
        trailers
    }

    /// Marking a Pin lost is the stock lock signal: `PERMISSION_DENIED` with the
    /// reason set in `unauthorized-device`, answered before any handler runs.
    #[tokio::test]
    async fn blocked_device_gets_permission_denied_with_unauthorized_device_trailer() {
        let store = fresh();
        set_block(
            &store,
            &account(),
            LOST_PIN,
            Some(&[UnauthorizedStatusCode::DeviceLostOrStolen]),
        )
        .await
        .unwrap();
        let served = Arc::new(AtomicUsize::new(0));
        let service = DeviceBlockService {
            inner: counting_handler(served.clone()),
            store: Some(store),
        };

        for path in [
            "/humane.aibus.AIBusService/EncryptedUnderstand",
            "/humane.contacts.ContactsRPCService/GetContactsPaginatedStreaming",
            "/humane.featureflags.FeatureFlagsService/GetFlags",
        ] {
            let response = service
                .clone()
                .oneshot(from_pin(path, LOST_PIN, ()))
                .await
                .unwrap();
            assert_eq!(header(&response, "grpc-status"), Some("7"), "{path}");
            assert_eq!(
                header(&response, gates::UNAUTHORIZED_DEVICE_METADATA),
                Some("1"),
                "{path}: DEVICE_LOST_OR_STOLEN rides in the trailer"
            );
            assert!(header(&response, gates::SUBSCRIPTION_STATUS_METADATA).is_none());
        }
        assert_eq!(served.load(Ordering::SeqCst), 0, "no handler ran");

        // The wearer's other Pin, and anyone else's, is untouched.
        let other = service
            .clone()
            .oneshot(from_pin(
                "/humane.aibus.AIBusService/Understand",
                OTHER_PIN,
                (),
            ))
            .await
            .unwrap();
        assert!(header(&other, gates::UNAUTHORIZED_DEVICE_METADATA).is_none());
        assert_eq!(served.load(Ordering::SeqCst), 1);
    }

    /// Turning block mode off is serving normally again: the next OK close is
    /// what clears the stock device's lock state.
    #[tokio::test]
    async fn unblock_restores_ok() {
        let store = fresh();
        let lost = [UnauthorizedStatusCode::DeviceLostOrStolen];
        set_block(&store, &account(), LOST_PIN, Some(&lost))
            .await
            .unwrap();
        let served = Arc::new(AtomicUsize::new(0));
        let service = DeviceBlockService {
            inner: counting_handler(served.clone()),
            store: Some(store.clone()),
        };
        let path = "/humane.capture.CaptureService/CreateMemory";
        let refused = service
            .clone()
            .oneshot(from_pin(path, LOST_PIN, ()))
            .await
            .unwrap();
        assert_eq!(header(&refused, "grpc-status"), Some("7"));

        let after = set_block(&store, &account(), LOST_PIN, None).await.unwrap();
        assert!(after.get(LOST_PIN).is_none());
        let served_again = service
            .clone()
            .oneshot(from_pin(path, LOST_PIN, ()))
            .await
            .unwrap();
        assert_eq!(header(&served_again, "grpc-status"), Some("0"));
        assert!(header(&served_again, gates::UNAUTHORIZED_DEVICE_METADATA).is_none());
        assert_eq!(served.load(Ordering::SeqCst), 1);

        // Both writes are idempotent.
        assert!(
            set_block(&store, &account(), LOST_PIN, None)
                .await
                .unwrap()
                .get(LOST_PIN)
                .is_none()
        );
        let first = set_block(&store, &account(), LOST_PIN, Some(&lost))
            .await
            .unwrap()
            .get(LOST_PIN)
            .cloned()
            .unwrap();
        let second = set_block(
            &store,
            &account(),
            LOST_PIN,
            Some(&[UnauthorizedStatusCode::Blocked]),
        )
        .await
        .unwrap()
        .get(LOST_PIN)
        .cloned()
        .unwrap();
        assert_eq!(first, second, "a second block keeps the first one's record");
    }

    /// A healthy Pin's answers carry no account signal: no `unauthorized-device`,
    /// and no `subscription-status`, which Luma never degrades. Checked on a
    /// real stock service's headers AND trailers, because the device reads the
    /// trailers.
    #[tokio::test]
    async fn healthy_responses_never_carry_an_account_trailer() {
        use cosmos_protocol::account::user_information_service_server::UserInformationServiceServer;

        let store = fresh();
        // Another of the wearer's Pins is lost. This one is not.
        set_block(
            &store,
            &account(),
            LOST_PIN,
            Some(&[UnauthorizedStatusCode::DeviceLostOrStolen]),
        )
        .await
        .unwrap();
        let authenticator = crate::auth::RequestAuthenticator::new(
            crate::config::Config::from_map(&std::collections::HashMap::from([(
                "COSMOS_AUTH_MODE".to_owned(),
                "edge-authenticated".to_owned(),
            )]))
            .unwrap()
            .auth,
        );
        let handler = UserInformationServiceServer::new(
            crate::services::account::UserInformation::new(authenticator, store.clone()),
        );
        let service = DeviceBlockService {
            inner: handler,
            store: Some(store),
        };
        // One empty `google.protobuf.Empty` frame.
        let request = from_pin(
            "/humane.account.UserInformationService/GetUserPersonalDetails",
            OTHER_PIN,
            axum::body::Body::from(vec![0u8; 5]),
        );
        let response = service.oneshot(request).await.unwrap();
        assert_eq!(response.status(), http::StatusCode::OK);
        for name in [
            gates::UNAUTHORIZED_DEVICE_METADATA,
            gates::SUBSCRIPTION_STATUS_METADATA,
        ] {
            assert!(response.headers().get(name).is_none(), "{name} in headers");
        }
        let trailers = trailers_of(response.into_body()).await;
        assert_eq!(
            trailers
                .get("grpc-status")
                .and_then(|value| value.to_str().ok()),
            Some("0"),
            "the handler answered OK"
        );
        for name in [
            gates::UNAUTHORIZED_DEVICE_METADATA,
            gates::SUBSCRIPTION_STATUS_METADATA,
        ] {
            assert!(trailers.get(name).is_none(), "{name} in trailers");
        }
    }

    /// A block list that cannot be read must not serve the call, or the lost
    /// Pin would unlock on the first OK. UNAVAILABLE carries no account trailer,
    /// so a healthy Pin is not locked by an outage either.
    #[tokio::test]
    async fn an_unreadable_block_list_answers_unavailable_not_ok() {
        let served = Arc::new(AtomicUsize::new(0));
        let service = DeviceBlockService {
            inner: counting_handler(served.clone()),
            store: Some(
                Arc::new(crate::store_postgres::PostgresStore::unreachable()) as SharedStore,
            ),
        };
        let response = service
            .oneshot(from_pin(
                "/humane.aibus.AIBusService/Understand",
                LOST_PIN,
                (),
            ))
            .await
            .unwrap();
        assert_eq!(header(&response, "grpc-status"), Some("14"));
        assert!(header(&response, gates::UNAUTHORIZED_DEVICE_METADATA).is_none());
        assert_eq!(served.load(Ordering::SeqCst), 0);
    }

    /// Onboarding, health probes and web callers are never refused: a blocked
    /// Pin can re-onboard, and only a DeviceUser call is a Pin.
    #[tokio::test]
    async fn only_account_channel_calls_from_the_pin_itself_are_refused() {
        let store = fresh();
        set_block(
            &store,
            &account(),
            LOST_PIN,
            Some(&[UnauthorizedStatusCode::DeviceLostOrStolen]),
        )
        .await
        .unwrap();
        let served = Arc::new(AtomicUsize::new(0));
        let service = DeviceBlockService {
            inner: counting_handler(served.clone()),
            store: Some(store),
        };

        let onboarding = from_pin(
            "/humane.provisioning.DeviceOnboardingDACService/GetSubscriptionStatus",
            LOST_PIN,
            (),
        );
        let health = {
            let mut request = from_pin("/grpc.health.v1.Health/Check", LOST_PIN, ());
            request.extensions_mut().clear();
            request
        };
        let web = {
            // The wearer's own browser, whose account came from a Bearer.
            let mut request = from_pin(
                "/humane.contacts.ContactsRPCService/GetContacts",
                LOST_PIN,
                (),
            );
            request
                .headers_mut()
                .remove(crate::config::EDGE_PRINCIPAL_HEADER);
            request
        };
        let someone_elses_cn = {
            let mut request = from_pin("/humane.aibus.AIBusService/Understand", LOST_PIN, ());
            request
                .extensions_mut()
                .insert(AuthenticatedPrincipal::for_user("mallory").unwrap());
            request
        };
        for request in [onboarding, health, web, someone_elses_cn] {
            let response = service.clone().oneshot(request).await.unwrap();
            assert_eq!(header(&response, "grpc-status"), Some("0"));
        }
        assert_eq!(served.load(Ordering::SeqCst), 4);
    }

    /// The list is ours to read back: a corrupt one is an outage, never an
    /// empty list that would unlock every Pin on the account.
    #[tokio::test]
    async fn a_corrupt_block_list_is_an_outage() {
        let store = fresh();
        store
            .put_account_blob(&account(), AccountBlobKind::DeviceBlocks, b"not json")
            .await
            .unwrap();
        assert!(device_blocks(&store, &account()).await.is_err());
        assert!(refusal(Some(store), &account(), LOST_PIN).await.is_some());
    }

    /// The whole wired path: a real call through the server `lib.rs` builds.
    ///
    /// The layer can only refuse a Pin inside `AuthLayer`, whose principal it
    /// reads. Mounted outside it, or not at all, every call would pass and
    /// block mode would silently do nothing. The tests above drive the layer
    /// directly and would stay green through that mistake.
    #[tokio::test]
    async fn the_running_workload_refuses_a_blocked_pin_and_serves_the_others() {
        use cosmos_protocol::account::user_information_service_client::UserInformationServiceClient;
        use std::collections::HashMap;
        use std::time::Duration;

        async fn loopback() -> std::net::SocketAddr {
            tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .unwrap()
                .local_addr()
                .unwrap()
        }

        // A wearer of its own: the configured store is shared by the process.
        let user = format!("wiring-{}", uuid::Uuid::new_v4().simple());
        let store = configured_store()
            .await
            .expect("the configured store opens");
        set_block(
            &store,
            &format!("U:{user}"),
            LOST_PIN,
            Some(&[UnauthorizedStatusCode::DeviceLostOrStolen]),
        )
        .await
        .unwrap();

        let (grpc_address, http_address) = (loopback().await, loopback().await);
        let config = crate::config::Config::from_map(&HashMap::from([
            (
                "COSMOS_AUTH_MODE".to_owned(),
                "edge-authenticated".to_owned(),
            ),
            ("COSMOS_WORKLOAD".to_owned(), "account".to_owned()),
            ("COSMOS_GRPC_BIND".to_owned(), grpc_address.to_string()),
            ("COSMOS_HTTP_BIND".to_owned(), http_address.to_string()),
            ("COSMOS_SHUTDOWN_GRACE_MS".to_owned(), "2000".to_owned()),
        ]))
        .unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(crate::serve_until(config, async move {
            let _ = shutdown_rx.await;
        }));
        let endpoint =
            tonic::transport::Endpoint::from_shared(format!("http://{grpc_address}")).unwrap();
        let mut channel = None;
        for _ in 0..40 {
            match endpoint.clone().connect().await {
                Ok(connected) => {
                    channel = Some(connected);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        let mut client = UserInformationServiceClient::new(channel.expect("the workload listens"));
        let from = |device_id: &str| {
            let mut request = tonic::Request::new(());
            request.metadata_mut().insert(
                crate::config::EDGE_PRINCIPAL_HEADER,
                format!("By=spiffe://cosmos.local/edge;Subject=\"CN=V:01:D:{device_id}:U:{user}\"")
                    .parse()
                    .unwrap(),
            );
            request
        };

        let refused = client
            .get_user_personal_details(from(LOST_PIN))
            .await
            .expect_err("a Pin in block mode is refused");
        assert_eq!(refused.code(), tonic::Code::PermissionDenied);
        assert_eq!(
            refused
                .metadata()
                .get(gates::UNAUTHORIZED_DEVICE_METADATA)
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        assert!(
            refused
                .metadata()
                .get(gates::SUBSCRIPTION_STATUS_METADATA)
                .is_none()
        );

        let served = client
            .get_user_personal_details(from(OTHER_PIN))
            .await
            .expect("the wearer's other Pin is served");
        assert!(
            served
                .metadata()
                .get(gates::UNAUTHORIZED_DEVICE_METADATA)
                .is_none()
        );

        shutdown_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .expect("the workload stops")
            .unwrap()
            .unwrap();
    }
}
