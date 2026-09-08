//! Room membership carries an already verified surface capability. Transport
//! identity selects that proof; it never supplies principal or surface authority.
use crate::{
    ambiance::{
        BrowserControl, InputStamp, NativeProof, RoomProof, RuntimeOperation, RuntimeResult,
        TurnFence,
        policy::RoutingTarget,
        runtime::{AmbianceRuntime, RoomInput},
        screen::ScreenContext,
        speech::SpeechTarget,
        status::TurnStatus,
    },
    surface_registry::{Mutation, hash},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use cosmos_rtc::{Error, Invocation, Session};
use futures_util::StreamExt;
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

pub(crate) struct Rooms {
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
    proof: RoomProof,
    epoch: Uuid,
    sid: Option<String>,
    join_deadline: tokio::time::Instant,
    connection_expires_at_ms: i64,
}

impl Rooms {
    pub(crate) fn new(runtime: Arc<AmbianceRuntime>, config: Option<Config>) -> Self {
        Self {
            runtime,
            config,
            rooms: Mutex::new(BTreeMap::new()),
        }
    }

    /// The one runtime this room coordinator already speaks for. Adapters that
    /// admit input on a connection reach it here rather than being handed a
    /// second, possibly different, runtime.
    pub(crate) fn runtime(&self) -> &Arc<AmbianceRuntime> {
        &self.runtime
    }

    pub(crate) async fn open(
        &self,
        principal: &str,
        proof: RoomProof,
        epoch: Uuid,
    ) -> Result<Connection, Error> {
        let config = self.config.as_ref().ok_or(Error::Unavailable)?;
        if epoch.is_nil() {
            return Err(Error::Invalid);
        }
        self.check_connection(principal, &proof, epoch).await?;
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
        let expires = self.check_connection(principal, &proof, epoch).await?;
        let mut participants = room.participants.lock().await;
        let identity = if let Some((identity, current)) = participants
            .iter()
            .find(|(_, p)| p.proof.surface_id() == proof.surface_id())
        {
            if current.proof.incarnation() != proof.incarnation() || current.epoch != epoch {
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

    /// Both checks use the same durable principal authority as input admission.
    /// A native room join verifies its existing boot epoch without renewing the
    /// connection or its liveness lease.
    async fn check_connection(
        &self,
        principal: &str,
        proof: &RoomProof,
        epoch: Uuid,
    ) -> Result<i64, Error> {
        tokio::time::timeout(ADMISSION_TIMEOUT, async {
            match proof {
                RoomProof::Browser(connection) => {
                    let result = self
                        .runtime
                        .store
                        .runtime(
                            principal,
                            RuntimeOperation::OpenBrowser {
                                connection: connection.clone(),
                                epoch,
                            },
                        )
                        .await
                        .map_err(runtime_error)?;
                    if !matches!(result, RuntimeResult::ConnectionOpened) {
                        return Err(Error::Unavailable);
                    }
                    Ok(self
                        .runtime
                        .store
                        .surface(principal, connection.surface_id)
                        .await
                        .map_err(|_| Error::Unavailable)?
                        .ok_or(Error::Denied)?
                        .connection_expires_at)
                }
                RoomProof::Native(connection) => {
                    let result = self
                        .runtime
                        .store
                        .runtime(
                            principal,
                            RuntimeOperation::CheckNative {
                                connection: connection.clone(),
                            },
                        )
                        .await
                        .map_err(runtime_error)?;
                    match result {
                        RuntimeResult::NativeCurrent(current) if current.epoch == epoch => {
                            Ok(current.expires_at_ms)
                        }
                        RuntimeResult::NativeCurrent(_) => Err(Error::Denied),
                        _ => Err(Error::Unavailable),
                    }
                }
            }
        })
        .await
        .map_err(|_| Error::Unavailable)?
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Input {
        stamp: InputStamp,
        text: String,
        /// The request's own explicit destination, weighed exactly like the
        /// model's target and outranking it.
        #[serde(default)]
        target: Option<RoutingTarget>,
        /// Bounded text from the origin's own screen; makes the turn private.
        #[serde(default)]
        context: Option<ScreenContext>,
    },
    Control {
        stamp: InputStamp,
        control: BrowserControl,
    },
    /// Liveness for a running command. It is unsequenced by design: it never
    /// consumes an ordered ingress slot and it never claims an outcome.
    Progress { progress: ProgressMessage },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProgressMessage {
    version: u8,
    action_id: Uuid,
    generation: u64,
    sequence: u64,
    elapsed_ms: i64,
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
    channel: crate::ambiance::Channel,
}

/// Raw audio per speech frame; base64 plus the bound header stays inside the
/// transport envelope. The whole reply is bounded so a runaway provider stream
/// cannot fill a client.
const SPEECH_CHUNK: usize = 7_500;
pub(crate) const MAX_SPEECH_BYTES: usize = 1_048_576;

async fn deliver(
    runtime: &Arc<AmbianceRuntime>,
    principal: &str,
    session: &Arc<Session>,
    participants: &Mutex<BTreeMap<String, Participant>>,
    mut changes: crate::ambiance::changes::Changes,
    epoch: Uuid,
    wake: &tokio::sync::Notify,
) -> Result<(), Error> {
    use crate::ambiance::{ActionStatus, Channel};
    let mut sequence = 0u64;
    let mut sent: BTreeMap<(String, Uuid), Sent> = BTreeMap::new();
    // One synthesis job per (member, action). A job owns the disclosure lease;
    // aborting it retires the exact turn instead of leaving audio unowned.
    let mut speaking: BTreeMap<(String, Uuid), tokio::task::JoinHandle<()>> = BTreeMap::new();
    // The invitation each personal member last received (None = withdrawn).
    let mut invited: BTreeMap<String, Option<Uuid>> = BTreeMap::new();
    // The ceremony each venue was last asked for (None = withdrawn).
    let mut confirmed: BTreeMap<String, Option<Uuid>> = BTreeMap::new();
    // The turn status each native origin last received; a terminal state
    // ends a turn's status frames.
    let mut statused: BTreeMap<String, TurnStatus> = BTreeMap::new();
    // The peer session and policy digest each installation last received
    // (None = it holds no copy). A client clears its copy whenever it joins,
    // so a new peer session is delivered to again rather than left holding
    // nothing.
    let mut policies: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
    loop {
        let members = participants.lock().await.clone();
        sent.retain(|(identity, _), _| members.contains_key(identity));
        invited.retain(|identity, _| members.contains_key(identity));
        confirmed.retain(|identity, _| members.contains_key(identity));
        statused.retain(|identity, _| members.contains_key(identity));
        policies.retain(|identity, _| members.contains_key(identity));
        speaking.retain(|(identity, _), job| {
            if !members.contains_key(identity) {
                job.abort();
                return false;
            }
            !job.is_finished()
        });
        'member: for (identity, member) in members.iter().filter(|(_, m)| m.sid.is_some()) {
            // A native member must still belong to the boot epoch it joined
            // with; a reopened installation joins again as a new member.
            if let RoomProof::Native(connection) = &member.proof {
                let result = tokio::time::timeout(
                    ADMISSION_TIMEOUT,
                    runtime.store.runtime(
                        principal,
                        RuntimeOperation::CheckNative {
                            connection: connection.clone(),
                        },
                    ),
                )
                .await
                .map_err(|_| Error::Unavailable)?;
                match result {
                    Ok(RuntimeResult::NativeCurrent(current)) if current.epoch == member.epoch => {}
                    Ok(RuntimeResult::NativeCurrent(_))
                    | Err(
                        crate::ambiance::RuntimeError::InvalidOrigin
                        | crate::ambiance::RuntimeError::Stale
                        | crate::ambiance::RuntimeError::NotFound,
                    ) => {
                        participants.lock().await.remove(identity);
                        leave(runtime, principal, &member.proof).await;
                        continue;
                    }
                    _ => return Err(Error::Unavailable),
                }
            }
            let connection = &member.proof;
            let result = tokio::time::timeout(
                ADMISSION_TIMEOUT,
                runtime.store.runtime(
                    principal,
                    RuntimeOperation::Poll {
                        connection: connection.clone(),
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
            if let RoomProof::Native(proof) = &member.proof {
                // The owner's own statement about this installation, sent
                // once per change over the connection it already holds. It
                // follows the connection rather than the foreground, because
                // a device has to hold the copy before it can refuse against
                // it, and it is dropped with the connection an approval
                // revision change closes.
                let policy = match tokio::time::timeout(
                    ADMISSION_TIMEOUT,
                    runtime.store.runtime(
                        principal,
                        RuntimeOperation::DevicePolicyFor {
                            connection: connection.clone(),
                        },
                    ),
                )
                .await
                .map_err(|_| Error::Unavailable)?
                {
                    Ok(RuntimeResult::DevicePolicyFor(policy)) => policy,
                    Err(
                        crate::ambiance::RuntimeError::InvalidOrigin
                        | crate::ambiance::RuntimeError::Stale
                        | crate::ambiance::RuntimeError::NotFound,
                    ) => None,
                    _ => return Err(Error::Unavailable),
                };
                let current = (
                    member.sid.clone(),
                    policy.as_ref().map(|policy| policy.content_digest()),
                );
                if policies.get(identity) != Some(&current) {
                    sequence = sequence
                        .checked_add(1)
                        .filter(|n| *n <= 9_007_199_254_740_991)
                        .ok_or(Error::Unavailable)?;
                    let stamp = InputStamp {
                        epoch,
                        sequence,
                        instance_id: Uuid::new_v4(),
                    };
                    let payload = policy_payload(policy.as_deref(), &stamp);

                    if !received(session.invoke(identity, payload).await, &stamp) {
                        leave(runtime, principal, &member.proof).await;
                        participants.lock().await.remove(identity);
                        continue 'member;
                    }
                    policies.insert(identity.clone(), current);
                }
                let invitation = match tokio::time::timeout(
                    ADMISSION_TIMEOUT,
                    runtime.store.runtime(
                        principal,
                        RuntimeOperation::Invitation {
                            connection: connection.clone(),
                        },
                    ),
                )
                .await
                .map_err(|_| Error::Unavailable)?
                {
                    Ok(RuntimeResult::Invitation(invitation)) => invitation,
                    Err(crate::ambiance::RuntimeError::InvalidOrigin) => {
                        participants.lock().await.remove(identity);
                        continue;
                    }
                    _ => return Err(Error::Unavailable),
                };
                let current = invitation.as_ref().map(|i| i.id);
                if invited.get(identity).copied().unwrap_or(None) != current {
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
                        invite_payload(runtime, principal, proof, invitation.as_ref(), &stamp)
                            .await;
                    if !received(session.invoke(identity, payload).await, &stamp) {
                        leave(runtime, principal, &member.proof).await;
                        participants.lock().await.remove(identity);
                        continue 'member;
                    }
                    invited.insert(identity.clone(), current);
                }
                // The origin hears its turn's committed outcome once per
                // state change: working, waiting, shown/spoken elsewhere,
                // nowhere or unknown. It never learns why nothing took it.
                let status = match tokio::time::timeout(
                    ADMISSION_TIMEOUT,
                    runtime.store.runtime(
                        principal,
                        RuntimeOperation::TurnStatus {
                            connection: connection.clone(),
                        },
                    ),
                )
                .await
                .map_err(|_| Error::Unavailable)?
                {
                    Ok(RuntimeResult::TurnStatus(status)) => status,
                    Err(
                        crate::ambiance::RuntimeError::InvalidOrigin
                        | crate::ambiance::RuntimeError::Stale
                        | crate::ambiance::RuntimeError::NotFound,
                    ) => None,
                    _ => return Err(Error::Unavailable),
                };
                if let Some(status) = status
                    && statused.get(identity).is_none_or(|last| {
                        !(last.turn_id == status.turn_id
                            && last.generation == status.generation
                            && (last.state.terminal() || *last == status))
                    })
                {
                    sequence = sequence
                        .checked_add(1)
                        .filter(|n| *n <= 9_007_199_254_740_991)
                        .ok_or(Error::Unavailable)?;
                    let stamp = InputStamp {
                        epoch,
                        sequence,
                        instance_id: Uuid::new_v4(),
                    };
                    let payload = status_payload(runtime, principal, &status, &stamp).await;
                    if !received(session.invoke(identity, payload).await, &stamp) {
                        leave(runtime, principal, &member.proof).await;
                        participants.lock().await.remove(identity);
                        continue 'member;
                    }
                    statused.insert(identity.clone(), status);
                }
                // The ceremony is minted here, because the thirty-second
                // clock starts at the sentence a person can read and this is
                // where the venue's own foreground is known.
                let confirmation = match tokio::time::timeout(
                    ADMISSION_TIMEOUT,
                    runtime.store.runtime(
                        principal,
                        RuntimeOperation::Confirmation {
                            connection: connection.clone(),
                        },
                    ),
                )
                .await
                .map_err(|_| Error::Unavailable)?
                {
                    Ok(RuntimeResult::Confirmation(request)) => request,
                    Err(
                        crate::ambiance::RuntimeError::InvalidOrigin
                        | crate::ambiance::RuntimeError::Stale
                        | crate::ambiance::RuntimeError::NotFound,
                    ) => None,
                    _ => return Err(Error::Unavailable),
                };
                let current = confirmation.as_ref().map(|request| request.grant_id);
                if confirmed.get(identity).copied().unwrap_or(None) != current {
                    sequence = sequence
                        .checked_add(1)
                        .filter(|n| *n <= 9_007_199_254_740_991)
                        .ok_or(Error::Unavailable)?;
                    let stamp = InputStamp {
                        epoch,
                        sequence,
                        instance_id: Uuid::new_v4(),
                    };
                    let payload = match confirmation.as_ref() {
                        Some(request) => confirm_payload(request, proof, &stamp),
                        None => serde_json::json!({"version":1,"kind":"confirm","stamp":stamp,"request":serde_json::Value::Null}).to_string(),
                    };
                    if !received(session.invoke(identity, payload).await, &stamp) {
                        leave(runtime, principal, &member.proof).await;
                        participants.lock().await.remove(identity);
                        continue 'member;
                    }
                    confirmed.insert(identity.clone(), current);
                }
                for action in actions.iter().filter(|a| {
                    a.channel == Channel::AudioTts && a.status == ActionStatus::Proposed
                }) {
                    let key = (identity.clone(), action.id);
                    if speaking.contains_key(&key) || sent.contains_key(&key) {
                        continue;
                    }
                    let stamp = InputStamp {
                        epoch,
                        sequence: 1,
                        instance_id: action.id,
                    };
                    sent.insert(
                        key.clone(),
                        Sent {
                            stamp,
                            attempts: action.attempts.saturating_add(1),
                            channel: action.channel,
                        },
                    );
                    speaking.insert(
                        key,
                        tokio::spawn(speak(
                            runtime.clone(),
                            principal.to_owned(),
                            session.clone(),
                            identity.clone(),
                            proof.clone(),
                            action.clone(),
                            epoch,
                        )),
                    );
                }
            }
            let active: BTreeMap<_, _> = actions
                .iter()
                .filter(|a| match a.channel {
                    Channel::VisualCard => matches!(
                        a.status,
                        ActionStatus::Dispatched | ActionStatus::Acknowledged
                    ),
                    Channel::AudioTts => {
                        matches!(
                            a.status,
                            ActionStatus::Dispatched | ActionStatus::Acknowledged
                        ) || (a.status == ActionStatus::Proposed
                            && speaking.contains_key(&(identity.clone(), a.id)))
                    }
                    // A device keeps its command while it works, whether or
                    // not Cosmos is still in front of it.
                    channel if channel.is_action() => matches!(
                        a.status,
                        ActionStatus::Dispatched
                            | ActionStatus::Acknowledged
                            | ActionStatus::Running
                    ),
                    // The ceremony carries its own frame, minted above.
                    Channel::ConfirmTap => false,
                    _ => false,
                })
                .map(|a| (a.id, a))
                .collect();
            // What this installation must still be told to stop, and why. The
            // row outlives the action itself, because a new turn clears the
            // action rows first.
            let revocations = match tokio::time::timeout(
                ADMISSION_TIMEOUT,
                runtime.store.runtime(
                    principal,
                    RuntimeOperation::Revocations {
                        connection: connection.clone(),
                    },
                ),
            )
            .await
            .map_err(|_| Error::Unavailable)?
            {
                Ok(RuntimeResult::Revocations(revocations)) => revocations,
                Err(
                    crate::ambiance::RuntimeError::InvalidOrigin
                    | crate::ambiance::RuntimeError::Stale
                    | crate::ambiance::RuntimeError::NotFound,
                ) => Vec::new(),
                _ => return Err(Error::Unavailable),
            };
            let clear: Vec<_> = sent
                .iter()
                .filter(|((peer, id), _)| peer == identity && !active.contains_key(id))
                .map(|((_, id), entry)| (*id, entry.channel))
                .collect();
            for (id, channel) in clear {
                sequence = sequence
                    .checked_add(1)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(Error::Unavailable)?;
                let stamp = InputStamp {
                    epoch,
                    sequence,
                    instance_id: Uuid::new_v4(),
                };
                // A display is cleared; an effect is revoked, with the reason
                // the runtime committed or, failing that, superseded.
                let payload = if channel.is_action() {
                    let reason = revocations
                        .iter()
                        .find(|revocation| revocation.action_id == id)
                        .map(|revocation| revocation.reason)
                        .unwrap_or(crate::ambiance::action::RevokeReason::Superseded);
                    revoke_payload(id, reason, &stamp)
                } else {
                    serde_json::json!({"version":1,"kind":"clear","stamp":stamp,"actionId":id})
                        .to_string()
                };
                if !received(session.invoke(identity, payload).await, &stamp) {
                    leave(runtime, principal, &member.proof).await;
                    participants.lock().await.remove(identity);
                    continue 'member;
                }
                sent.remove(&(identity.clone(), id));
            }
            for (id, action) in active {
                let key = (identity.clone(), id);
                if action.channel == Channel::AudioTts
                    || sent
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
                            connection: connection.clone(),
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
                // its sequenced acknowledgment after its own commit, and for
                // an action its own report after the platform observed it.
                let payload = if action.channel.is_action() {
                    let card = runtime.visual_card(principal, &action);
                    act_payload(&action, &stamp, card.as_deref())
                } else {
                    render_payload(runtime, principal, &action, &stamp)
                };
                let delivered = match payload {
                    Some(payload) => received(session.invoke(identity, payload).await, &stamp),
                    // A lost transient card or an oversized envelope cannot be
                    // rendered. Use the same bounded failure lifecycle as a
                    // failed invocation; never refetch or substitute text.
                    None => false,
                };
                sent.insert(
                    key,
                    Sent {
                        stamp,
                        attempts: action.attempts,
                        channel: action.channel,
                    },
                );
                if !delivered {
                    let _ = tokio::time::timeout(
                        ADMISSION_TIMEOUT,
                        runtime.store.runtime(
                            principal,
                            RuntimeOperation::DeliveryFailed {
                                connection: connection.clone(),
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

/// Disclosed synthesis for one native member. The lease claims the exact
/// proposed action, streams provider audio under continuous revalidation and
/// hands bounded frames to the member; the member acknowledges playback
/// separately through its sequenced control channel.
async fn speak(
    runtime: Arc<AmbianceRuntime>,
    principal: String,
    session: Arc<Session>,
    identity: String,
    proof: NativeProof,
    action: crate::ambiance::Action,
    epoch: Uuid,
) {
    let connection = RoomProof::Native(proof.clone());
    let target = SpeechTarget::Native {
        principal: principal.clone(),
        connection: proof,
    };
    let stream = match runtime
        .synthesize(target, action.fence(), action.clone())
        .await
    {
        Ok(stream) => stream,
        Err(status) => {
            tracing::warn!(
                turn = %action.turn_id,
                code = ?status.code(),
                "native speech synthesis was not authorized"
            );
            // Audio has no fallback surface. Ending the turn now records the
            // outcome instead of re-proposing the same denied claim on every
            // state change until the action expires.
            let _ = tokio::time::timeout(
                ADMISSION_TIMEOUT,
                runtime.store.runtime(
                    &principal,
                    RuntimeOperation::Cancel {
                        turn_id: action.turn_id,
                        generation: action.generation,
                        worker: action.worker,
                    },
                ),
            )
            .await;
            return;
        }
    };
    let delivered = speak_frames(&session, &identity, &action, epoch, stream).await;
    if !delivered {
        let _ = tokio::time::timeout(
            ADMISSION_TIMEOUT,
            runtime.store.runtime(
                &principal,
                RuntimeOperation::DeliveryFailed {
                    connection,
                    action_id: action.id,
                    generation: action.generation,
                },
            ),
        )
        .await;
    }
}

async fn speak_frames(
    session: &Session,
    identity: &str,
    action: &crate::ambiance::Action,
    epoch: Uuid,
    stream: crate::ambiance::speech::SpeechStream,
) -> bool {
    let mut sequence = 0u64;
    let mut frame = |chunk: Option<&[u8]>, last: bool| {
        sequence += 1;
        let stamp = InputStamp {
            epoch,
            sequence,
            instance_id: action.id,
        };
        let mut speech = serde_json::json!({
            "version": 1,
            "actionId": action.id,
            "turnId": action.turn_id,
            "generation": action.generation,
            "surfaceId": action.surface_id,
            "incarnation": action.incarnation,
            "channel": "audio.tts",
            "contentDigest": action.content_digest,
            "format": "audio/mpeg",
            "expiresAt": action.display_expires_at_ms,
            "sequence": sequence,
            "final": last,
        });
        match chunk {
            Some(chunk) => speech["chunk"] = serde_json::json!(STANDARD.encode(chunk)),
            None => speech["text"] = serde_json::json!(action.intent.text()),
        }
        let payload = serde_json::json!({"version":1,"kind":"speak","stamp":stamp,"speech":speech})
            .to_string();
        (payload, stamp)
    };
    let (header, stamp) = frame(None, false);
    if !received(session.invoke(identity, header).await, &stamp) {
        return false;
    }
    let mut buffer = Vec::new();
    let mut total = 0usize;
    tokio::pin!(stream);
    loop {
        match stream.next().await {
            Some(Ok(chunk)) => {
                total += chunk.len();
                if total > MAX_SPEECH_BYTES {
                    return false;
                }
                buffer.extend_from_slice(&chunk);
                while buffer.len() >= SPEECH_CHUNK {
                    let piece: Vec<u8> = buffer.drain(..SPEECH_CHUNK).collect();
                    let (payload, stamp) = frame(Some(&piece), false);
                    if !received(session.invoke(identity, payload).await, &stamp) {
                        return false;
                    }
                }
            }
            Some(Err(_)) => return false,
            None => {
                if total == 0 {
                    return false;
                }
                let (payload, stamp) = frame(Some(&buffer), true);
                return received(session.invoke(identity, payload).await, &stamp);
            }
        }
    }
}

/// The kind of surface a record is, as the wire names it. A surface that no
/// longer exists is `unknown`; nothing else about it is named.
async fn platform_label(runtime: &AmbianceRuntime, principal: &str, surface_id: Uuid) -> String {
    match runtime
        .store
        .surface(principal, surface_id)
        .await
        .ok()
        .flatten()
        .map(|surface| surface.binding)
    {
        Some(crate::surface_registry::Binding::Native { platform, .. }) => platform,
        Some(crate::surface_registry::Binding::Pin { .. }) => "pin".to_owned(),
        Some(crate::surface_registry::Binding::Browser) => "browser".to_owned(),
        None => "unknown".to_owned(),
    }
}

/// The invite frame tells a personal member that a private card is waiting for
/// its unlocked foreground: the member's own bound connection, the class, the
/// expiry and which kind of surface asked. It never carries content; `null`
/// withdraws it.
async fn invite_payload(
    runtime: &AmbianceRuntime,
    principal: &str,
    proof: &crate::ambiance::NativeProof,
    invitation: Option<&crate::ambiance::personal::Invitation>,
    stamp: &InputStamp,
) -> String {
    let invitation = match invitation {
        None => serde_json::Value::Null,
        Some(invitation) => {
            let origin = platform_label(runtime, principal, invitation.origin_surface).await;
            serde_json::json!({
                "version": 1,
                "id": invitation.id,
                "kind": invitation.kind,
                "surfaceId": proof.surface_id,
                "incarnation": proof.incarnation,
                "origin": origin,
                "privacy": invitation.privacy,
                "expiresAt": invitation.expires_at_ms,
            })
        }
    };
    serde_json::json!({"version":1,"kind":"invite","stamp":stamp,"invitation":invitation})
        .to_string()
}

/// The status frame tells the turn's origin what the ledger committed: the
/// state, the kind of surface involved and the class the status is expressed
/// at. It never carries content, a surface identity or a reason.
async fn status_payload(
    runtime: &AmbianceRuntime,
    principal: &str,
    status: &TurnStatus,
    stamp: &InputStamp,
) -> String {
    let surface = match status.surface {
        Some(surface_id) => {
            serde_json::json!({"platform": platform_label(runtime, principal, surface_id).await})
        }
        None => serde_json::Value::Null,
    };
    status_frame(status, surface, stamp)
}

fn status_frame(status: &TurnStatus, surface: serde_json::Value, stamp: &InputStamp) -> String {
    serde_json::json!({
        "version": 1,
        "kind": "status",
        "stamp": stamp,
        "status": {
            "version": 1,
            "turnId": status.turn_id,
            "generation": status.generation,
            "state": status.state,
            "surface": surface,
            "privacy": status.privacy,
        },
    })
    .to_string()
}

fn render_payload(
    runtime: &AmbianceRuntime,
    principal: &str,
    action: &crate::ambiance::Action,
    stamp: &InputStamp,
) -> Option<String> {
    // Cache availability grants no authority. The only production caller has
    // already committed Poll and successfully rechecked CheckDelivery.
    let card = runtime.visual_card(principal, action);
    let command = crate::browser_runtime_api::command(action, card.as_deref())?;
    let payload = serde_json::json!({"version":1,"kind":"render","stamp":stamp,"command":command})
        .to_string();
    (payload.len() <= cosmos_rtc::MAX_PAYLOAD).then_some(payload)
}

/// The act frame carries one bound command to the installation that will
/// carry it out. It answers with the same transport receipt a render does,
/// which is transport evidence only: the device acknowledges the binding
/// separately, and only its own report may claim an outcome.
fn act_payload(
    action: &crate::ambiance::Action,
    stamp: &InputStamp,
    card: Option<&crate::ambiance::visual::Card>,
) -> Option<String> {
    let mut command = crate::browser_runtime_api::act_command(action)?;
    if let Some(reference) = action.intent.content_reference() {
        let card @ crate::ambiance::visual::Card::Document { .. } = card? else {
            return None;
        };
        if card.digest() != reference.digest || reference.audience != Some(action.surface_id) {
            return None;
        }
        command["document"] = card.value();
    }
    let payload =
        serde_json::json!({"version":1,"kind":"act","stamp":stamp,"command":command}).to_string();
    (payload.len() <= cosmos_rtc::MAX_PAYLOAD).then_some(payload)
}

/// A revoke supersedes remaining work. It is not a clear: a display can be
/// erased, an effect can only be told to stop.
fn revoke_payload(
    action_id: Uuid,
    reason: crate::ambiance::action::RevokeReason,
    stamp: &InputStamp,
) -> String {
    serde_json::json!({
        "version": 1,
        "kind": "revoke",
        "stamp": stamp,
        "actionId": action_id,
        "reason": reason,
    })
    .to_string()
}

/// The owner's own policy for one installation, or its withdrawal. It is
/// idempotent by construction: the loop sends it only when the digest
/// changes, and re-delivering the same document changes nothing. A document
/// that does not fit the envelope is never truncated — the installation is
/// told it holds no policy instead, which leaves it doing nothing.
fn policy_payload(
    policy: Option<&crate::ambiance::action::DevicePolicy>,
    stamp: &InputStamp,
) -> String {
    let withdrawn = || {
        serde_json::json!({
            "version": 1, "kind": "policy", "stamp": stamp,
            "digest": serde_json::Value::Null, "policy": serde_json::Value::Null,
        })
        .to_string()
    };
    let Some(policy) = policy.filter(|policy| policy.fits()) else {
        return withdrawn();
    };
    let payload = serde_json::json!({
        "version": 1, "kind": "policy", "stamp": stamp,
        "digest": policy.content_digest(), "policy": policy,
    })
    .to_string();
    if payload.len() > cosmos_rtc::MAX_PAYLOAD {
        return withdrawn();
    }
    payload
}

/// The ceremony frame. Its description is composed by policy from the bound
/// command and the owner's own label, never model prose, and it carries the
/// class §4.4 requires a ceremony to render.
fn confirm_payload(
    request: &crate::ambiance::grant::Request,
    proof: &NativeProof,
    stamp: &InputStamp,
) -> String {
    serde_json::json!({
        "version": 1,
        "kind": "confirm",
        "stamp": stamp,
        "request": {
            "version": 1,
            "grantId": request.grant_id,
            "actionId": request.action_id,
            "turnId": request.turn_id,
            "generation": request.generation,
            "surfaceId": proof.surface_id,
            "incarnation": proof.incarnation,
            "channel": "confirm.tap",
            "descriptionDigest": request.description_digest,
            "description": request.description,
            "risk": request.risk,
            "attestation": request.attestation,
            "privacy": request.privacy,
            "expiresAt": request.expires_at_ms,
        },
    })
    .to_string()
}

fn received(result: Result<String, Error>, stamp: &InputStamp) -> bool {
    result
        .ok()
        .and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
        .is_some_and(|value| {
            value == serde_json::json!({"version":1,"kind":"received","stamp":stamp})
        })
}

async fn leave(runtime: &AmbianceRuntime, principal: &str, proof: &RoomProof) {
    let _ = tokio::time::timeout(ADMISSION_TIMEOUT, async {
        match proof {
            RoomProof::Browser(connection) => {
                let _ = runtime
                    .store
                    .mutate_surface(
                        principal,
                        connection.surface_id,
                        Mutation::Leave {
                            token_hash: connection.token_hash.clone(),
                            incarnation: connection.incarnation,
                        },
                    )
                    .await;
            }
            RoomProof::Native(connection) => {
                let _ = runtime
                    .store
                    .runtime(
                        principal,
                        RuntimeOperation::CloseNative {
                            connection: connection.clone(),
                        },
                    )
                    .await;
            }
        }
    })
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
    let (stamp, input) = match message {
        Message::Input {
            stamp,
            text,
            target,
            context,
        } => (
            stamp,
            RoomInput {
                text,
                target,
                context,
                spoken: None,
            },
        ),
        // Progress renews the command's deadline and the turn's worker lease.
        // It is idempotent by its own sequence and touches no ingress cursor.
        Message::Progress { progress } => {
            let result = if progress.version != 1 {
                Err(Error::Invalid)
            } else {
                match tokio::time::timeout(
                    ADMISSION_TIMEOUT,
                    runtime.store.runtime(
                        &principal,
                        RuntimeOperation::Progress {
                            connection: member.proof,
                            action_id: progress.action_id,
                            generation: progress.generation,
                            sequence: progress.sequence,
                            elapsed_ms: progress.elapsed_ms,
                        },
                    ),
                )
                .await
                {
                    Ok(Ok(RuntimeResult::ProgressAccepted { duplicate })) => Ok(
                        serde_json::json!({"version":1,"kind":"accepted","duplicate":duplicate})
                            .to_string(),
                    ),
                    Ok(Err(error)) => Err(runtime_error(error)),
                    _ => Err(Error::Unavailable),
                }
            };
            let _ = call.reply.send(result);
            return;
        }
        Message::Control { stamp, control } => {
            if stamp.epoch != member.epoch {
                let _ = call.reply.send(Err(Error::Denied));
                return;
            }
            let result = tokio::time::timeout(
                ADMISSION_TIMEOUT,
                runtime.store.runtime(
                    &principal,
                    RuntimeOperation::RoomControl {
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
    let work =
        runtime.sequenced_room_input_started(&principal, member.proof, stamp, input, Some(started));
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
