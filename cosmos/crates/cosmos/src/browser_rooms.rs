//! Room membership carries an already verified browser capability. Transport
//! identity selects that proof; it never supplies principal or surface authority.
use crate::{
    ambiance::{
        BrowserControl, BrowserProof, InputStamp, RuntimeOperation, RuntimeResult, TurnFence,
        runtime::AmbianceRuntime,
    },
    surface_registry::{Mutation, hash},
};
use cosmos_rtc::{Error, Invocation, Session};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

const ADMISSION_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_ROOMS: usize = 64;
const MAX_PARTICIPANTS: usize = 16;

/// Management credentials remain in Cosmos, never in cognition or browser state.
pub(crate) struct Config {
    pub(crate) url: String,
    pub(crate) public_url: String,
    pub(crate) key: String,
    pub(crate) secret: String,
}

impl Config {
    pub(crate) fn configured() -> Option<Self> {
        Self::new(
            std::env::var("COSMOS_RTC_URL").ok()?,
            std::env::var("COSMOS_RTC_PUBLIC_URL").ok()?,
            std::env::var("COSMOS_RTC_API_KEY").ok()?,
            std::env::var("COSMOS_RTC_API_SECRET").ok()?,
        )
        .ok()
    }

    pub(crate) fn new(
        url: String,
        public_url: String,
        key: String,
        secret: String,
    ) -> Result<Self, Error> {
        for address in [&url, &public_url] {
            let parsed = reqwest::Url::parse(address).map_err(|_| Error::Invalid)?;
            if !matches!(parsed.scheme(), "ws" | "wss")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || (parsed.scheme() == "ws"
                    && parsed.host_str() != Some("127.0.0.1")
                    && parsed.host_str() != Some("livekit"))
            {
                return Err(Error::Invalid);
            }
        }
        if key.is_empty() || key.len() > 128 || secret.len() < 32 || secret.len() > 512 {
            return Err(Error::Invalid);
        }
        Ok(Self {
            url,
            public_url,
            key,
            secret,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection {
    version: u8,
    url: String,
    token: String,
    participant: String,
    runtime_participant: &'static str,
    runtime_epoch: Uuid,
    epoch: Uuid,
}

pub(crate) struct BrowserRooms {
    runtime: Arc<AmbianceRuntime>,
    config: Option<Config>,
    rooms: Mutex<BTreeMap<String, Room>>,
}

struct Room {
    session: Arc<Session>,
    participants: Arc<Mutex<BTreeMap<String, Participant>>>,
    task: tokio::task::JoinHandle<()>,
    name: String,
    epoch: Uuid,
    wake: Arc<tokio::sync::Notify>,
}

struct Coordinator {
    runtime: Arc<AmbianceRuntime>,
    principal: String,
    session: Arc<Session>,
    participants: Arc<Mutex<BTreeMap<String, Participant>>>,
    epoch: Uuid,
    wake: Arc<tokio::sync::Notify>,
}

impl Drop for Room {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
struct Participant {
    proof: BrowserProof,
    epoch: Uuid,
    sid: Option<String>,
    join_deadline: tokio::time::Instant,
    connection_expires_at_ms: i64,
}

impl BrowserRooms {
    pub(crate) fn new(runtime: Arc<AmbianceRuntime>, config: Option<Config>) -> Self {
        Self {
            runtime,
            config,
            rooms: Mutex::new(BTreeMap::new()),
        }
    }

    pub(crate) async fn open(
        &self,
        principal: &str,
        proof: BrowserProof,
        epoch: Uuid,
    ) -> Result<Connection, Error> {
        let config = self.config.as_ref().ok_or(Error::Unavailable)?;
        if epoch.is_nil() {
            return Err(Error::Invalid);
        }
        // OpenBrowser verifies owner capability, revocation and the fixed epoch
        // under the same durable principal lock used by every input admission.
        self.runtime
            .store
            .runtime(
                principal,
                RuntimeOperation::OpenBrowser {
                    connection: proof.clone(),
                    epoch,
                },
            )
            .await
            .map_err(runtime_error)?;
        let mut rooms = self.rooms.lock().await;
        rooms.retain(|_, room| !room.task.is_finished());
        if !rooms.contains_key(principal) {
            if rooms.len() >= MAX_ROOMS {
                return Err(Error::Busy);
            }
            // No account identifiers are published to the substrate. A stable
            // room and runtime identity allow only one connected coordinator;
            // replacement disconnects the previous one and fences its work.
            let name = format!(
                "cosmos-{}",
                hash(format!("room-v1\0{}\0{principal}", config.secret).as_bytes())
            );
            let token =
                cosmos_rtc::coordination_token(&config.key, &config.secret, &name, "runtime")?;
            let changes = self
                .runtime
                .store
                .runtime_changes(principal)
                .await
                .map_err(runtime_error)?;
            let (session, inbox) = Session::connect(&config.url, &token).await?;
            let session = Arc::new(session);
            let participants = Arc::new(Mutex::new(BTreeMap::new()));
            let epoch = Uuid::new_v4();
            let wake = Arc::new(tokio::sync::Notify::new());
            let coordinator = Coordinator {
                runtime: self.runtime.clone(),
                principal: principal.to_owned(),
                session: session.clone(),
                participants: participants.clone(),
                epoch,
                wake: wake.clone(),
            };
            let task = tokio::spawn(coordinator.run(inbox, changes));
            rooms.insert(
                principal.to_owned(),
                Room {
                    session,
                    participants,
                    task,
                    name,
                    epoch,
                    wake,
                },
            );
        }
        let room = &rooms[principal];
        if !*room.session.connected().borrow() {
            return Err(Error::Unavailable);
        }
        // A token issued before a slow room connection must not outlive a revoke.
        self.runtime
            .store
            .runtime(
                principal,
                RuntimeOperation::OpenBrowser {
                    connection: proof.clone(),
                    epoch,
                },
            )
            .await
            .map_err(runtime_error)?;
        let expires = self
            .runtime
            .store
            .surface(principal, proof.surface_id)
            .await
            .map_err(|_| Error::Unavailable)?
            .ok_or(Error::Denied)?
            .connection_expires_at;
        let mut participants = room.participants.lock().await;
        let identity = if let Some((identity, current)) = participants
            .iter()
            .find(|(_, p)| p.proof.surface_id == proof.surface_id)
        {
            if current.proof.incarnation != proof.incarnation || current.epoch != epoch {
                let identity = identity.clone();
                participants.remove(&identity);
                Uuid::new_v4().to_string()
            } else {
                identity.clone()
            }
        } else {
            if participants.len() >= MAX_PARTICIPANTS {
                return Err(Error::Busy);
            }
            Uuid::new_v4().to_string()
        };
        participants.entry(identity.clone()).or_insert(Participant {
            proof,
            epoch,
            sid: None,
            join_deadline: tokio::time::Instant::now() + Duration::from_secs(20),
            connection_expires_at_ms: expires,
        });
        room.wake.notify_one();
        Ok(Connection {
            version: 1,
            url: config.public_url.clone(),
            token: cosmos_rtc::coordination_token(
                &config.key,
                &config.secret,
                &room.name,
                &identity,
            )?,
            participant: identity,
            runtime_participant: "runtime",
            runtime_epoch: room.epoch,
            epoch,
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Input {
        stamp: InputStamp,
        text: String,
    },
    Control {
        stamp: InputStamp,
        control: BrowserControl,
    },
}

impl Coordinator {
    async fn run(
        self,
        mut inbox: tokio::sync::mpsc::Receiver<Invocation>,
        changes: crate::ambiance::changes::Changes,
    ) {
        let Self {
            runtime,
            principal,
            session,
            participants,
            epoch,
            wake,
        } = self;
        let mut connected = session.connected();
        let mut peers = session.peers();
        let mut jobs = tokio::task::JoinSet::new();
        let mut hygiene = tokio::time::interval(Duration::from_secs(1));
        let mut last_member = tokio::time::Instant::now();
        hygiene.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let dispatch = deliver(
            &runtime,
            &principal,
            &session,
            &participants,
            changes,
            epoch,
            &wake,
        );
        tokio::pin!(dispatch);
        loop {
            tokio::select! {
                biased;
                _ = &mut dispatch => break,
                changed = connected.changed() => {
                    if changed.is_err() || !*connected.borrow_and_update() { break; }
                }
                changed = peers.changed() => {
                    if changed.is_err() { break; }
                    let current = peers.borrow_and_update().clone();
                    let mut members = participants.lock().await;
                    let mut lost = Vec::new();
                    for (identity, member) in members.iter_mut() {
                        match (&member.sid, current.get(identity)) {
                            (None, Some(sid)) => member.sid = Some(sid.clone()),
                            (Some(sid), next) if next != Some(sid) => lost.push(identity.clone()),
                            _ => {}
                        }
                    }
                    for identity in lost {
                        if let Some(member) = members.remove(&identity) {
                            leave(&runtime, &principal, &member.proof).await;
                        }
                    }
                    wake.notify_one();
                }
                _ = hygiene.tick() => {
                    let mut members = participants.lock().await;
                    let now = crate::surface_registry::now_ms();
                    let expired: Vec<_> = members.iter().filter(|(_, m)| now >= m.connection_expires_at_ms || (m.sid.is_none() && tokio::time::Instant::now() >= m.join_deadline)).map(|(id, _)| id.clone()).collect();
                    for identity in expired {
                        if let Some(member) = members.remove(&identity) { leave(&runtime, &principal, &member.proof).await; }
                    }
                    if !members.is_empty() { last_member = tokio::time::Instant::now(); }
                    else if last_member.elapsed() >= Duration::from_secs(60) { break; }
                }
                _ = jobs.join_next(), if !jobs.is_empty() => {}
                call = inbox.recv() => {
                    let Some(call) = call else { break; };
                    if jobs.len() >= 32 { let _ = call.reply.send(Err(Error::Busy)); continue; }
                    let member = participants.lock().await.get(&call.caller).cloned();
                    let Some(member) = member else { let _ = call.reply.send(Err(Error::Denied)); continue; };
                    // LiveKit batches non-media presence updates. Do not start work
                    // until the actual peer session is observed: a join and leave
                    // could otherwise coalesce before the SDK creates the peer.
                    if member.sid.is_none() { let _ = call.reply.send(Err(Error::Busy)); continue; }
                    let runtime = runtime.clone();
                    let principal = principal.clone();
                    jobs.spawn(async move { coordinate(runtime, principal, member, call).await; });
                }
            }
        }
        jobs.abort_all();
        let _ = session.shutdown().await;
        for member in participants.lock().await.values() {
            leave(&runtime, &principal, &member.proof).await;
        }
    }
}

struct Sent {
    stamp: InputStamp,
    attempts: u8,
}

async fn deliver(
    runtime: &AmbianceRuntime,
    principal: &str,
    session: &Session,
    participants: &Mutex<BTreeMap<String, Participant>>,
    mut changes: crate::ambiance::changes::Changes,
    epoch: Uuid,
    wake: &tokio::sync::Notify,
) -> Result<(), Error> {
    use crate::ambiance::{ActionStatus, Channel};
    let mut sequence = 0u64;
    let mut sent: BTreeMap<(String, Uuid), Sent> = BTreeMap::new();
    loop {
        let members = participants.lock().await.clone();
        sent.retain(|(identity, _), _| members.contains_key(identity));
        'member: for (identity, member) in members.iter().filter(|(_, m)| m.sid.is_some()) {
            let result = tokio::time::timeout(
                ADMISSION_TIMEOUT,
                runtime.store.runtime(
                    principal,
                    RuntimeOperation::Poll {
                        connection: member.proof.clone(),
                    },
                ),
            )
            .await
            .map_err(|_| Error::Unavailable)?;
            let actions = match result {
                Ok(RuntimeResult::Pending(actions)) => actions,
                Err(crate::ambiance::RuntimeError::InvalidOrigin) => {
                    participants.lock().await.remove(identity);
                    continue;
                }
                _ => return Err(Error::Unavailable),
            };
            let active: BTreeMap<_, _> = actions
                .iter()
                .filter(|a| {
                    a.channel == Channel::VisualCard
                        && matches!(
                            a.status,
                            ActionStatus::Dispatched | ActionStatus::Acknowledged
                        )
                })
                .map(|a| (a.id, a))
                .collect();
            let clear: Vec<_> = sent
                .keys()
                .filter(|(peer, id)| peer == identity && !active.contains_key(id))
                .cloned()
                .collect();
            for key in clear {
                sequence = sequence
                    .checked_add(1)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(Error::Unavailable)?;
                let stamp = InputStamp {
                    epoch,
                    sequence,
                    instance_id: Uuid::new_v4(),
                };
                let payload =
                    serde_json::json!({"version":1,"kind":"clear","stamp":stamp,"actionId":key.1});
                if !received(session.invoke(identity, payload.to_string()).await, &stamp) {
                    leave(runtime, principal, &member.proof).await;
                    participants.lock().await.remove(identity);
                    continue 'member;
                }
                sent.remove(&key);
            }
            for (id, action) in active {
                let key = (identity.clone(), id);
                if sent
                    .get(&key)
                    .is_some_and(|last| last.attempts == action.attempts)
                {
                    continue;
                }
                let current = tokio::time::timeout(
                    ADMISSION_TIMEOUT,
                    runtime.store.runtime(
                        principal,
                        RuntimeOperation::CheckDelivery {
                            connection: member.proof.clone(),
                            action_id: id,
                            generation: action.generation,
                        },
                    ),
                )
                .await
                .map_err(|_| Error::Unavailable)?;
                let action = match current {
                    Ok(RuntimeResult::Dispatch(action)) => action,
                    Err(
                        crate::ambiance::RuntimeError::Stale
                        | crate::ambiance::RuntimeError::NotFound
                        | crate::ambiance::RuntimeError::InvalidOrigin,
                    ) => continue,
                    _ => return Err(Error::Unavailable),
                };
                if action.intent.text().is_empty() || action.intent.text().len() > 4000 {
                    return Err(Error::Invalid);
                }
                let stamp = if let Some(last) = sent.get(&key) {
                    last.stamp.clone()
                } else {
                    sequence = sequence
                        .checked_add(1)
                        .filter(|n| *n <= 9_007_199_254_740_991)
                        .ok_or(Error::Unavailable)?;
                    InputStamp {
                        epoch,
                        sequence,
                        instance_id: id,
                    }
                };
                // Poll committed the exact claim before this invocation. The
                // receiver returns transport receipt, then separately submits
                // its sequenced DOM acknowledgment after render commit.
                let payload = serde_json::json!({"version":1,"kind":"render","stamp":stamp,"command":crate::browser_runtime_api::command(&action)});
                let delivered =
                    received(session.invoke(identity, payload.to_string()).await, &stamp);
                sent.insert(
                    key,
                    Sent {
                        stamp,
                        attempts: action.attempts,
                    },
                );
                if !delivered {
                    let _ = tokio::time::timeout(
                        ADMISSION_TIMEOUT,
                        runtime.store.runtime(
                            principal,
                            RuntimeOperation::DeliveryFailed {
                                connection: member.proof.clone(),
                                action_id: id,
                                generation: action.generation,
                            },
                        ),
                    )
                    .await;
                }
            }
        }
        tokio::select! {
            changed = changes.changed() => changed.map_err(runtime_error)?,
            _ = wake.notified() => {}
        }
    }
}

fn received(result: Result<String, Error>, stamp: &InputStamp) -> bool {
    result
        .ok()
        .and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
        .is_some_and(|value| {
            value == serde_json::json!({"version":1,"kind":"received","stamp":stamp})
        })
}

async fn leave(runtime: &AmbianceRuntime, principal: &str, proof: &BrowserProof) {
    let _ = tokio::time::timeout(
        ADMISSION_TIMEOUT,
        runtime.store.mutate_surface(
            principal,
            proof.surface_id,
            Mutation::Leave {
                token_hash: proof.token_hash.clone(),
                incarnation: proof.incarnation,
            },
        ),
    )
    .await;
}

async fn coordinate(
    runtime: Arc<AmbianceRuntime>,
    principal: String,
    member: Participant,
    call: Invocation,
) {
    let message = serde_json::from_str::<Message>(&call.payload);
    let message = match message {
        Ok(message) => message,
        Err(_) => {
            let _ = call.reply.send(Err(Error::Invalid));
            return;
        }
    };
    let (stamp, text) = match message {
        Message::Input { stamp, text } => (stamp, text),
        Message::Control { stamp, control } => {
            if stamp.epoch != member.epoch {
                let _ = call.reply.send(Err(Error::Denied));
                return;
            }
            let result = tokio::time::timeout(
                ADMISSION_TIMEOUT,
                runtime.store.runtime(
                    &principal,
                    RuntimeOperation::BrowserControl {
                        connection: member.proof,
                        stamp,
                        control,
                    },
                ),
            )
            .await;
            let result = match result {
                Ok(Ok(RuntimeResult::ControlAccepted { duplicate })) => Ok(
                    serde_json::json!({"version":1,"kind":"accepted","duplicate":duplicate})
                        .to_string(),
                ),
                Ok(Err(error)) => Err(runtime_error(error)),
                _ => Err(Error::Unavailable),
            };
            let _ = call.reply.send(result);
            return;
        }
    };
    if stamp.epoch != member.epoch {
        let _ = call.reply.send(Err(Error::Denied));
        return;
    }
    let (started, mut admission) = oneshot::channel();
    let work = runtime.sequenced_browser_text_started(
        &principal,
        member.proof,
        stamp,
        text,
        Some(started),
    );
    tokio::pin!(work);
    let admitted = tokio::time::timeout(ADMISSION_TIMEOUT, async {
        tokio::select! {
            biased;
            result = &mut work => match result {
                Ok(RuntimeResult::Duplicate(fence)) => Ok((fence, true, true)),
                // A fast model can finish before the admission receiver is polled.
                Ok(RuntimeResult::Proposed(_)) | Ok(RuntimeResult::Blocked) => admission.await.map(|fence| (fence, false, true)).map_err(|_| Error::Unavailable),
                Err(error) => Err(status_error(error)),
                _ => Err(Error::Unavailable),
            },
            fence = &mut admission => fence.map(|fence| (fence, false, false)).map_err(|_| Error::Unavailable),
        }
    }).await;
    match admitted {
        Ok(Ok((fence, duplicate, complete))) => {
            let _ = call.reply.send(Ok(admission_reply(&fence, duplicate)));
            if !complete {
                let _ = work.await;
            }
        }
        Ok(Err(error)) => {
            let _ = call.reply.send(Err(error));
        }
        Err(_) => {
            let _ = call.reply.send(Err(Error::Unavailable));
        }
    }
}

fn admission_reply(fence: &TurnFence, duplicate: bool) -> String {
    serde_json::json!({"version":1,"kind":"admitted","turnId":fence.turn_id,"generation":fence.generation,"duplicate":duplicate}).to_string()
}

fn status_error(error: tonic::Status) -> Error {
    match error.code() {
        tonic::Code::InvalidArgument => Error::Invalid,
        tonic::Code::PermissionDenied
        | tonic::Code::Unauthenticated
        | tonic::Code::FailedPrecondition => Error::Denied,
        tonic::Code::ResourceExhausted => Error::Busy,
        _ => Error::Unavailable,
    }
}

fn runtime_error(error: crate::ambiance::RuntimeError) -> Error {
    use crate::ambiance::RuntimeError;
    match error {
        RuntimeError::InvalidRequest => Error::Invalid,
        RuntimeError::InvalidOrigin
        | RuntimeError::Stale
        | RuntimeError::PolicyBlocked
        | RuntimeError::NotFound => Error::Denied,
        RuntimeError::Busy => Error::Busy,
        RuntimeError::Unavailable => Error::Unavailable,
    }
}

#[cfg(test)]
#[path = "browser_rooms_tests.rs"]
mod tests;
