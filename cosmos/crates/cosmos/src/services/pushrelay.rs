//! `humane.pushrelay.PushRelayService`, the device's push-notification relay.
//!
//! The device opens this channel after enrollment: it fetches per-app push
//! tokens and holds a long-lived bidi subscription over which the cloud pushes
//! notifications and experience-subscription status. This deployment has no
//! external push provider (FCM/APNs), but it still owns the relay capabilities
//! applications use to subscribe. Those clone-owned tokens are persisted per
//! principal. They are not third-party credentials.
//!
//! Auth is the mesh edge's job (DeviceUser mTLS terminated by Istio), matching
//! the other workloads, handlers trust the edge-injected principal.

use std::{collections::BTreeSet, pin::Pin, sync::OnceLock, time::Duration};

use cosmos_protocol::common::push::PushMessage;
use cosmos_protocol::pushrelay as pb;
use pb::push_relay_service_server::PushRelayService;
use prost::Message;
use tokio::sync::broadcast;
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status};

use crate::store::{AccountBlobKind, MemoryStore, SharedStore};

const QUEUE_CAS_RETRIES: usize = 32;
const QUEUE_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Most pushes one account's queue holds. Enqueuing past it drops the oldest.
///
/// Expired pushes are retired on every enqueue as well as by a live stream,
/// because the stream is exactly what is missing while the Pin's push is off:
/// every web contact edit would otherwise add a nudge nobody collects, forever.
/// INFERRED: stock gives no bound, the relay's queue lived in Humane's cloud,
/// which the Pin's client code does not show. Each push queued here is a nudge
/// to sync, so delivering the newest ones loses nothing a sync does not
/// recover.
const MAX_QUEUED_PUSHES: usize = 256;

#[derive(Clone)]
pub struct PushRelay {
    store: SharedStore,
}

impl Default for PushRelay {
    fn default() -> Self {
        Self {
            store: MemoryStore::shared(),
        }
    }
}

impl PushRelay {
    pub fn with_store(store: SharedStore) -> Self {
        Self { store }
    }

    async fn tokens(&self, principal: &str) -> Result<pb::PushTokenResponse, Status> {
        let Some(bytes) = self
            .store
            .get_account_blob(principal, AccountBlobKind::PushTokens)
            .await?
        else {
            return Ok(pb::PushTokenResponse::default());
        };
        pb::PushTokenResponse::decode(bytes.as_slice())
            .map_err(|_| Status::internal("stored push tokens could not be read"))
    }

    async fn queued(&self, principal: &str) -> Result<Vec<PushMessage>, Status> {
        let Some(bytes) = self
            .store
            .get_account_blob(principal, AccountBlobKind::PushQueue)
            .await?
        else {
            return Ok(Vec::new());
        };
        pb::PushMessageResponse::decode(bytes.as_slice())
            .map(|response| response.push_messages)
            .map_err(|_| Status::internal("stored push queue could not be read"))
    }
}

fn wakeups() -> &'static broadcast::Sender<String> {
    static WAKEUPS: OnceLock<broadcast::Sender<String>> = OnceLock::new();
    WAKEUPS.get_or_init(|| broadcast::channel(128).0)
}

fn queue_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Queue one clone-owned push for catch-up delivery and wake active streams.
/// The message remains durable until the stock client returns its `message_id`
/// in `acks`. A disconnect before that point therefore replays it on reconnect.
pub async fn enqueue(
    store: &SharedStore,
    principal: &str,
    message: PushMessage,
) -> Result<(), Status> {
    if message.app_name.is_empty() || message.message_id.is_empty() {
        return Err(Status::invalid_argument(
            "push app_name and message_id are required",
        ));
    }
    for _ in 0..QUEUE_CAS_RETRIES {
        let previous = store
            .get_account_blob(principal, AccountBlobKind::PushQueue)
            .await?;
        let mut queue = previous
            .as_deref()
            .map(pb::PushMessageResponse::decode)
            .transpose()
            .map_err(|_| Status::internal("stored push queue could not be read"))?
            .unwrap_or_default()
            .push_messages;
        if queue
            .iter()
            .any(|queued| queued.message_id == message.message_id)
        {
            return Err(Status::already_exists("push message_id already queued"));
        }
        queue.retain(|queued| !expired(queued));
        queue.push(message.clone());
        if queue.len() > MAX_QUEUED_PUSHES {
            queue.drain(..queue.len() - MAX_QUEUED_PUSHES);
        }
        let replacement = pb::PushMessageResponse {
            push_messages: queue,
            ..Default::default()
        }
        .encode_to_vec();
        if store
            .compare_and_swap_account_blob(
                principal,
                AccountBlobKind::PushQueue,
                previous.as_deref(),
                &replacement,
            )
            .await?
        {
            let _ = wakeups().send(principal.to_owned());
            return Ok(());
        }
    }
    Err(Status::aborted("push queue changed concurrently; retry"))
}

fn expired(message: &PushMessage) -> bool {
    message.expiration_timestamp.as_ref().is_some_and(|expiry| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        expiry.seconds < now.as_secs() as i64
            || (expiry.seconds == now.as_secs() as i64 && expiry.nanos <= now.subsec_nanos() as i32)
    })
}

fn retire_acked(queue: &mut Vec<PushMessage>, acks: &BTreeSet<String>) -> bool {
    let original = queue.len();
    queue.retain(|message| !acks.contains(&message.message_id));
    queue.len() != original
}

fn deliverable(
    queue: &[PushMessage],
    apps: &BTreeSet<String>,
    delivered: &BTreeSet<String>,
) -> Vec<PushMessage> {
    queue
        .iter()
        .filter(|message| {
            apps.contains(&message.app_name) && !delivered.contains(&message.message_id)
        })
        .cloned()
        .collect()
}

/// Recover the app subscription set from both generations of the stock wire.
///
/// `observed`: PushService can send the compact `app_names` list, while the
/// pull worker sends `subscribed_experiences` with clone-issued tokens. Treating
/// only field 1 as authoritative left the real Pin's pull request with an empty
/// subscription set, so a queued `humane.feature-flags` message was never
/// returned even though Subscribe itself completed successfully.
fn announced_apps(request: &pb::PushMessageRequest) -> BTreeSet<String> {
    request
        .app_names
        .iter()
        .chain(
            request
                .subscribed_experiences
                .iter()
                .map(|subscription| &subscription.experience_name),
        )
        .filter(|name| !name.is_empty())
        .cloned()
        .collect()
}

#[tonic::async_trait]
impl PushRelayService for PushRelay {
    /// Server-streaming response type for `Subscribe`. Boxed so the handler can
    /// return an adapter over the inbound stream without naming its concrete type.
    type SubscribeStream =
        Pin<Box<dyn Stream<Item = Result<pb::PushMessageResponse, Status>> + Send + 'static>>;

    async fn get_push_tokens(
        &self,
        request: Request<pb::PushTokenRequest>,
    ) -> Result<Response<pb::PushTokenResponse>, Status> {
        let principal = crate::auth::principal(&request)
            .ok_or_else(|| Status::unauthenticated("an authenticated principal is required"))?
            .expose_for_authorization()
            .to_owned();
        let requested = request.into_inner().app_names;
        let mut stored = self.tokens(&principal).await?;
        let mut by_app: std::collections::BTreeMap<String, pb::PushToken> = stored
            .tokens
            .drain(..)
            .map(|token| (token.app_name.clone(), token))
            .collect();
        for app_name in requested.iter().filter(|name| !name.is_empty()) {
            by_app
                .entry(app_name.clone())
                .or_insert_with(|| pb::PushToken {
                    app_name: app_name.clone(),
                    // Opaque clone-relay capability. UUIDv4 gives 122 random bits and
                    // is persisted, so rescans and restarts receive the same token.
                    token: uuid::Uuid::new_v4().to_string(),
                    error: None,
                });
        }
        let canonical = pb::PushTokenResponse {
            tokens: by_app.into_values().collect(),
        };
        self.store
            .put_account_blob(
                &principal,
                AccountBlobKind::PushTokens,
                &canonical.encode_to_vec(),
            )
            .await?;
        let wanted: std::collections::BTreeSet<_> = requested.into_iter().collect();
        Ok(Response::new(pb::PushTokenResponse {
            tokens: canonical
                .tokens
                .into_iter()
                .filter(|token| wanted.contains(&token.app_name))
                .collect(),
        }))
    }

    async fn subscribe(
        &self,
        request: Request<tonic::Streaming<pb::PushMessageRequest>>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let principal = crate::auth::principal(&request)
            .ok_or_else(|| Status::unauthenticated("an authenticated principal is required"))?
            .expose_for_authorization()
            .to_owned();
        let relay = self.clone();
        let mut inbound = request.into_inner();
        let mut wakes = wakeups().subscribe();
        let responses = async_stream::try_stream! {
            let mut apps = BTreeSet::new();
            let mut delivered = BTreeSet::new();
            let mut poll = tokio::time::interval(QUEUE_POLL_INTERVAL);
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                let mut should_check = false;
                let incoming = tokio::select! {
                    incoming = inbound.next() => Some(incoming),
                    _ = poll.tick() => {
                        should_check = true;
                        None
                    },
                    wake = wakes.recv() => {
                        match wake {
                            Ok(wearer) if wearer == principal => should_check = true,
                            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {},
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                        None
                    },
                };
                if let Some(incoming) = incoming {
                    match incoming {
                        Some(Ok(request)) => {
                            let announced = announced_apps(&request);
                            if !announced.is_empty() {
                                apps = announced;
                            }
                            if !request.acks.is_empty() {
                                let _guard = queue_lock().lock().await;
                                let acks: BTreeSet<_> = request.acks.into_iter().collect();
                                for ack in &acks { delivered.remove(ack); }
                                for _ in 0..QUEUE_CAS_RETRIES {
                                    let previous = relay.store
                                        .get_account_blob(&principal, AccountBlobKind::PushQueue)
                                        .await?;
                                    let mut queue = previous.as_deref()
                                        .map(pb::PushMessageResponse::decode)
                                        .transpose()
                                        .map_err(|_| Status::internal("stored push queue could not be read"))?
                                        .unwrap_or_default()
                                        .push_messages;
                                    if !retire_acked(&mut queue, &acks) { break; }
                                    let replacement = pb::PushMessageResponse {
                                        push_messages: queue,
                                        ..Default::default()
                                    }.encode_to_vec();
                                    if relay.store.compare_and_swap_account_blob(
                                        &principal,
                                        AccountBlobKind::PushQueue,
                                        previous.as_deref(),
                                        &replacement,
                                    ).await? { break; }
                                }
                            }
                            should_check = true;
                        }
                        Some(Err(status)) => Err(status)?,
                        None => break,
                    }
                }
                if !should_check || apps.is_empty() {
                    continue;
                }
                let _guard = queue_lock().lock().await;
                let mut queue = relay.queued(&principal).await?;
                let before_expiry = queue.len();
                queue.retain(|message| !expired(message));
                if queue.len() != before_expiry {
                    // Expiry cleanup is maintenance. If another replica changed
                    // the queue, leave its value alone and retry on the next
                    // poll rather than overwriting it.
                    let previous = relay.store
                        .get_account_blob(&principal, AccountBlobKind::PushQueue)
                        .await?;
                    if let Some(ref bytes) = previous {
                        let mut current = pb::PushMessageResponse::decode(bytes.as_slice())
                            .map_err(|_| Status::internal("stored push queue could not be read"))?
                            .push_messages;
                        current.retain(|message| !expired(message));
                        let replacement = pb::PushMessageResponse {
                            push_messages: current.clone(),
                            ..Default::default()
                        }.encode_to_vec();
                        if relay.store.compare_and_swap_account_blob(
                            &principal,
                            AccountBlobKind::PushQueue,
                            previous.as_deref(),
                            &replacement,
                        ).await? {
                            queue = current;
                        }
                    }
                }
                let push_messages = deliverable(&queue, &apps, &delivered);
                drop(_guard);
                if push_messages.is_empty() {
                    // Stock sends a request after every response. Silence here is
                    // the invariant that prevents an idle feedback loop.
                    continue;
                }
                delivered.extend(push_messages.iter().map(|message| message.message_id.clone()));
                yield pb::PushMessageResponse {
                    push_messages,
                    ..Default::default()
                };
            }
        };
        Ok(Response::new(Box::pin(responses)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_wearer<T>(mut request: Request<T>, wearer: &str) -> Request<T> {
        request.extensions_mut().insert(
            cosmos_core::AuthenticatedPrincipal::from_edge(format!(
                "V:01:D:test-device:U:{wearer}"
            ))
            .expect("valid principal"),
        );
        request
    }

    #[tokio::test]
    async fn get_push_tokens_are_stable_and_principal_scoped() {
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        let service = PushRelay::with_store(store.clone());
        let response = service
            .get_push_tokens(as_wearer(
                Request::new(pb::PushTokenRequest {
                    app_names: vec!["humane.feature-flags".to_owned()],
                }),
                "wearer-a",
            ))
            .await
            .expect("get_push_tokens succeeds")
            .into_inner();
        assert_eq!(response.tokens.len(), 1);
        let first = response.tokens[0].token.clone();

        let after_restart = PushRelay::with_store(store);
        let again = after_restart
            .get_push_tokens(as_wearer(
                Request::new(pb::PushTokenRequest {
                    app_names: vec!["humane.feature-flags".to_owned()],
                }),
                "wearer-a",
            ))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(again.tokens[0].token, first);

        let other = after_restart
            .get_push_tokens(as_wearer(
                Request::new(pb::PushTokenRequest {
                    app_names: vec!["humane.feature-flags".to_owned()],
                }),
                "wearer-b",
            ))
            .await
            .unwrap()
            .into_inner();
        assert_ne!(other.tokens[0].token, first);
    }

    #[tokio::test]
    async fn queued_pushes_survive_restart_and_stay_principal_scoped() {
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        enqueue(
            &store,
            "U:wearer-a",
            PushMessage {
                app_name: "humane.feature-flags".to_owned(),
                message_id: "message-1".to_owned(),
                data_payload: b"refresh".to_vec(),
                ..Default::default()
            },
        )
        .await
        .expect("queue push");

        let after_restart = PushRelay::with_store(store);
        let queued = after_restart.queued("U:wearer-a").await.unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].message_id, "message-1");
        assert!(after_restart.queued("U:wearer-b").await.unwrap().is_empty());
    }

    /// While the Pin is not subscribed nothing collects the queue, so an
    /// enqueue retires what has expired and keeps only the newest
    /// `MAX_QUEUED_PUSHES`.
    #[tokio::test]
    async fn the_queue_stays_bounded_while_nothing_collects_it() {
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        let push = |id: String, expiration_timestamp| PushMessage {
            app_name: "humane.contacts".to_owned(),
            message_id: id,
            expiration_timestamp,
            ..Default::default()
        };
        enqueue(
            &store,
            "U:wearer",
            push(
                "expired".to_owned(),
                Some(prost_types::Timestamp {
                    seconds: 1,
                    nanos: 0,
                }),
            ),
        )
        .await
        .unwrap();
        for index in 0..MAX_QUEUED_PUSHES + 10 {
            enqueue(&store, "U:wearer", push(format!("nudge-{index}"), None))
                .await
                .unwrap();
        }

        let queued = PushRelay::with_store(store)
            .queued("U:wearer")
            .await
            .unwrap();
        assert_eq!(queued.len(), MAX_QUEUED_PUSHES);
        assert!(queued.iter().all(|message| message.message_id != "expired"));
        assert_eq!(
            queued[0].message_id, "nudge-10",
            "the oldest are the ones dropped"
        );
        assert_eq!(
            queued.last().unwrap().message_id,
            format!("nudge-{}", MAX_QUEUED_PUSHES + 9)
        );
    }

    #[test]
    fn stock_pull_subscriptions_are_app_subscriptions_too() {
        let request = pb::PushMessageRequest {
            subscribed_experiences: vec![pb::SubscribedPushExperience {
                experience_name: "humane.feature-flags".to_owned(),
                token: "clone-owned-token".to_owned(),
            }],
            ..Default::default()
        };
        assert_eq!(
            announced_apps(&request),
            BTreeSet::from(["humane.feature-flags".to_owned()]),
        );
    }
}
