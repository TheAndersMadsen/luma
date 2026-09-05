//! Manual PCM in a two-party transport room. Enrollment, privacy, turn grants
//! and playback evidence belong to the runtime and device, not this adapter.
pub mod pcm;

use crate::Error;
use futures_util::StreamExt;
use livekit::{
    ConnectionState, Room, RoomEvent, RoomOptions,
    options::TrackPublishOptions,
    participant::ParticipantTrackPermission,
    publication::{LocalTrackPublication, RemoteTrackPublication},
    track::{LocalAudioTrack, LocalTrack, RemoteTrack, TrackKind, TrackSource},
    webrtc::{
        audio_frame::AudioFrame,
        audio_source::{AudioSourceOptions, RtcAudioSource, native::NativeAudioSource},
        audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions},
    },
};
use livekit_token::{AccessToken, VideoGrants};
use std::{
    borrow::Cow,
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, mpsc, watch};
use uuid::Uuid;

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 480;
pub const QUEUE_FRAMES: usize = 10;
const FRAME_TIME: Duration = Duration::from_millis(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// Bounded silence advances the encoder beyond the final content frame. This is
// not a transport flush or delivery deadline; keep the publication until the
// application has observed receipt or its own bounded completion deadline.
const END_PADDING_FRAMES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Runtime,
    Surface,
}
impl Role {
    pub fn identity(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Surface => "surface",
        }
    }
    fn peer(self) -> &'static str {
        match self {
            Self::Runtime => "surface",
            Self::Surface => "runtime",
        }
    }
}

/// No Debug: these are bearer credentials. Mint once per approved incarnation;
/// never issue another client's token into this room. Join expiry is not revoke.
pub struct Tokens {
    pub runtime: String,
    pub surface: String,
}
pub fn tokens(key: &str, secret: &str) -> Result<Tokens, Error> {
    if key.is_empty() || secret.len() < 32 {
        return Err(Error::Invalid);
    }
    let room = format!("media-{}", Uuid::new_v4());
    let mint = |role: Role| {
        AccessToken::with_api_key(key, secret)
            .with_identity(role.identity())
            .with_ttl(Duration::from_secs(60))
            .with_grants(VideoGrants {
                room_join: true,
                room: room.clone(),
                // The pinned SFU checks this flag before its source allowlist.
                can_publish: true,
                can_publish_sources: vec!["microphone".into()],
                can_subscribe: true,
                can_publish_data: false,
                can_update_own_metadata: false,
                ..Default::default()
            })
            .to_jwt()
            .map_err(|_| Error::Unavailable)
    };
    Ok(Tokens {
        runtime: mint(Role::Runtime)?,
        surface: mint(Role::Surface)?,
    })
}

/// Server-attributed transport identity. This identifies a publisher, not an actor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackId {
    pub participant: String,
    pub participant_sid: String,
    pub track_sid: String,
}

/// Runtime-selected binding carried unchanged beside PCM. The caller must
/// authorize this generation before publication/subscription and on consumption.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub epoch: Uuid,
    pub generation: u64,
    pub track: TrackId,
}

struct Slot(Arc<AtomicBool>);
impl Slot {
    fn take(slot: &Arc<AtomicBool>) -> Result<Self, Error> {
        slot.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| Error::Busy)?;
        Ok(Self(slot.clone()))
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct Publication {
    id: TrackId,
    publication: RemoteTrackPublication,
}

// A cancelled publish may already have reached the SFU. Retire the room rather
// than leaving an unowned publication or reusing its connection as current.
struct PublishAttempt {
    room: Arc<Room>,
    alive: watch::Sender<bool>,
    complete: bool,
}
impl Drop for PublishAttempt {
    fn drop(&mut self) {
        if !self.complete {
            self.alive.send_replace(false);
            let room = self.room.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = room.close().await;
                });
            }
        }
    }
}

pub struct AudioSession {
    room: Arc<Room>,
    peer: &'static str,
    alive: watch::Sender<bool>,
    publications: watch::Receiver<BTreeMap<String, Publication>>,
    peer_session: watch::Receiver<Option<String>>,
    events: tokio::task::JoinHandle<()>,
    send_slot: Arc<AtomicBool>,
    receive_slot: Arc<AtomicBool>,
}

impl AudioSession {
    pub async fn connect(url: &str, token: &str, role: Role) -> Result<Self, Error> {
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        let (room, mut events) =
            tokio::time::timeout(CONNECT_TIMEOUT, Room::connect(url, token, options))
                .await
                .map_err(|_| Error::Unavailable)?
                .map_err(|_| Error::Unavailable)?;
        let room = Arc::new(room);
        if room.local_participant().identity().to_string() != role.identity() {
            let _ = room.close().await;
            return Err(Error::Denied);
        }
        // Deny before any publication. Room isolation is the confidentiality
        // boundary; this publisher policy adds defense for ordinary WSS media.
        room.local_participant()
            .set_track_subscription_permissions(false, vec![])
            .await
            .map_err(|_| Error::Unavailable)?;
        let (alive, _) = watch::channel(true);
        let (publications, publication_state) = watch::channel(BTreeMap::new());
        let (observed_peer, peer_session) = watch::channel(None);
        let peer = role.peer();
        let mut peer_sid = None;
        if !refresh(&room, peer, &mut peer_sid, &publications, &observed_peer) {
            let _ = room.close().await;
            return Err(Error::Denied);
        }
        let event_room = room.clone();
        let event_alive = alive.clone();
        let events = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    RoomEvent::ConnectionStateChanged(state)
                        if state != ConnectionState::Connected =>
                    {
                        break;
                    }
                    RoomEvent::Reconnecting
                    | RoomEvent::Disconnected { .. }
                    | RoomEvent::LocalTrackRepublished { .. }
                    | RoomEvent::ParticipantDisconnected(_) => break,
                    _ => {}
                }
                if !refresh(
                    &event_room,
                    peer,
                    &mut peer_sid,
                    &publications,
                    &observed_peer,
                ) {
                    break;
                }
            }
            event_alive.send_replace(false);
            publications.send_replace(BTreeMap::new());
            let _ = event_room.close().await;
        });
        Ok(Self {
            room,
            peer,
            alive,
            publications: publication_state,
            peer_session,
            events,
            send_slot: Arc::new(AtomicBool::new(false)),
            receive_slot: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn connected(&self) -> watch::Receiver<bool> {
        self.alive.subscribe()
    }

    /// Observed remote session, not an application admission or actor identity.
    pub fn peer_session(&self) -> watch::Receiver<Option<String>> {
        self.peer_session.clone()
    }

    /// Current server-observed publication, without subscribing or decoding.
    /// This snapshot grants no runtime permission or actor identity; callers
    /// must revalidate it before consuming media and across asynchronous work.
    pub fn publication_current(&self, track: &TrackId) -> bool {
        *self.alive.borrow()
            && track.participant == self.peer
            && self.peer_session.borrow().as_deref() == Some(track.participant_sid.as_str())
            && contains(&self.publications, track)
    }

    pub async fn publish(&self, epoch: Uuid, generation: u64) -> Result<AudioSender, Error> {
        if epoch.is_nil() || generation == 0 {
            return Err(Error::Invalid);
        }
        if !*self.alive.borrow() {
            return Err(Error::Unavailable);
        }
        let slot = Slot::take(&self.send_slot)?;
        // Non-publishing peer updates can be batched by the SFU. Do not start
        // media before observing that exact connection: a join-and-leave inside
        // one batch would otherwise be invisible to disconnect fencing.
        let mut peer = self.peer_session.clone();
        let mut alive = self.alive.subscribe();
        tokio::time::timeout(CONNECT_TIMEOUT, async {
            loop {
                if !*alive.borrow() {
                    return Err(Error::Unavailable);
                }
                if peer.borrow().is_some() {
                    return Ok(());
                }
                tokio::select! {
                    _ = alive.changed() => return Err(Error::Unavailable),
                    changed = peer.changed() => changed.map_err(|_| Error::Unavailable)?,
                }
            }
        })
        .await
        .map_err(|_| Error::Unavailable)??;
        let mut attempt = PublishAttempt {
            room: self.room.clone(),
            alive: self.alive.clone(),
            complete: false,
        };
        // Zero native buffering: each capture copies exactly one frame
        // synchronously, without retaining a native completion callback.
        let source = NativeAudioSource::new(AudioSourceOptions::default(), SAMPLE_RATE, 1, 0);
        let track =
            LocalAudioTrack::create_audio_track("speech", RtcAudioSource::Native(source.clone()));
        let publication = tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.room.local_participant().publish_track(
                LocalTrack::Audio(track.clone()),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    dtx: false,
                    ..Default::default()
                },
            ),
        )
        .await
        .map_err(|_| Error::Unavailable)?
        .map_err(|_| Error::Unavailable)?;
        let binding = Binding {
            epoch,
            generation,
            track: TrackId {
                participant: self.room.local_participant().identity().to_string(),
                participant_sid: self.room.local_participant().sid().to_string(),
                track_sid: publication.sid().to_string(),
            },
        };
        let (frames, mut incoming) = mpsc::channel::<[i16; FRAME_SAMPLES]>(QUEUE_FRAMES);
        let (stop, mut stopping) = watch::channel(false);
        let mut alive = self.alive.subscribe();
        let task_track = track.clone();
        let task_source = source.clone();
        let producer = tokio::spawn(async move {
            let source = task_source;
            let mut next = tokio::time::Instant::now();
            let mut padding = 0;
            let result = loop {
                if *stopping.borrow() || !*alive.borrow() {
                    break Err(Error::Unavailable);
                }
                let frame = tokio::select! { biased;
                    _ = stopping.changed() => break Err(Error::Unavailable),
                    _ = alive.changed() => break Err(Error::Unavailable),
                    frame = incoming.recv() => match frame {
                        Some(frame) => frame,
                        None if padding < END_PADDING_FRAMES => { padding += 1; [0; FRAME_SAMPLES] },
                        None => break Ok(()),
                    },
                };
                tokio::select! { biased;
                    _ = stopping.changed() => break Err(Error::Unavailable),
                    _ = alive.changed() => break Err(Error::Unavailable),
                    _ = tokio::time::sleep_until(next) => {}
                }
                if *stopping.borrow() || !*alive.borrow() {
                    break Err(Error::Unavailable);
                }
                if source
                    .capture_frame(&AudioFrame {
                        data: Cow::Borrowed(&frame),
                        sample_rate: SAMPLE_RATE,
                        num_channels: 1,
                        samples_per_channel: FRAME_SAMPLES as u32,
                    })
                    .await
                    .is_err()
                {
                    break Err(Error::Unavailable);
                }
                // Keep the sample clock on its 10 ms grid rather than adding
                // scheduling/capture overhead to every frame. Skip missed
                // deadlines instead of sending queued frames in a burst.
                next += FRAME_TIME;
                let now = tokio::time::Instant::now();
                if next <= now {
                    next = now + FRAME_TIME;
                }
            };
            incoming.close();
            while incoming.try_recv().is_ok() {}
            if result.is_err() {
                source.clear_buffer();
                task_track.mute();
            }
            result
        });
        let mut sender = AudioSender {
            binding,
            frames: Some(frames),
            stop,
            alive: self.alive.subscribe(),
            producer: Some(producer),
            source,
            slot: Some(slot),
            finished: false,
            room: self.room.clone(),
            publication,
            published: true,
        };
        sender
            .room
            .local_participant()
            .set_track_subscription_permissions(
                false,
                vec![ParticipantTrackPermission {
                    participant_identity: self.peer.into(),
                    allow_all: false,
                    allowed_track_sids: vec![sender.publication.sid()],
                }],
            )
            .await
            .map_err(|_| Error::Unavailable)?;
        if !*self.alive.borrow() {
            sender.stop().await?;
            return Err(Error::Unavailable);
        }
        attempt.complete = true;
        Ok(sender)
    }

    /// No automatic subscriptions. The selected publication must belong to the
    /// exact observed peer connection; a body-supplied identity cannot replace it.
    /// Decoder attachment needs initial RTP packets. An authorized publisher
    /// should prime with silence before sending content; this returns transport
    /// readiness, not device playback or runtime permission evidence.
    pub async fn subscribe(&self, binding: Binding) -> Result<AudioReceiver, Error> {
        if binding.epoch.is_nil()
            || binding.generation == 0
            || binding.track.participant != self.peer
        {
            return Err(Error::Denied);
        }
        if !*self.alive.borrow() {
            return Err(Error::Unavailable);
        }
        let slot = Slot::take(&self.receive_slot)?;
        let mut publications = self.publications.clone();
        let mut alive = self.alive.subscribe();
        let selected = tokio::time::timeout(CONNECT_TIMEOUT, async {
            loop {
                if !*alive.borrow() {
                    return Err(Error::Unavailable);
                }
                let found = publications.borrow().get(&binding.track.track_sid).cloned();
                if let Some(found) = found {
                    if found.id != binding.track {
                        return Err(Error::Denied);
                    }
                    break Ok(found.publication);
                }
                tokio::select! {
                    _ = alive.changed() => return Err(Error::Unavailable),
                    changed = publications.changed() => changed.map_err(|_| Error::Unavailable)?,
                }
            }
        })
        .await
        .map_err(|_| Error::Unavailable)??;
        let subscription = Subscription(selected);
        subscription.0.set_subscribed(true);
        let track = tokio::time::timeout(CONNECT_TIMEOUT, async {
            loop {
                if !*alive.borrow() || !contains(&publications, &binding.track) {
                    return Err(Error::Unavailable);
                }
                if let Some(RemoteTrack::Audio(track)) = subscription.0.track() {
                    break Ok(track);
                }
                tokio::select! {
                    _ = alive.changed() => return Err(Error::Unavailable),
                    changed = publications.changed() => changed.map_err(|_| Error::Unavailable)?,
                }
            }
        })
        .await
        .map_err(|_| Error::Unavailable)??;
        let mut stream = NativeAudioStream::with_options(
            track.rtc_track(),
            SAMPLE_RATE as i32,
            1,
            NativeAudioStreamOptions {
                queue_size_frames: Some(QUEUE_FRAMES),
            },
        );
        let frames = Arc::new(ReceiveQueue::default());
        let receiver = frames.clone();
        let (stop, mut stopping) = watch::channel(false);
        let track_id = binding.track.clone();
        let task = tokio::spawn(async move {
            let (_slot, _subscription) = (slot, subscription);
            loop {
                if *stopping.borrow() || !*alive.borrow() || !receiving(&publications, &track_id) {
                    break;
                }
                let frame = tokio::select! { biased;
                    _ = stopping.changed() => break,
                    _ = alive.changed() => break,
                    changed = publications.changed() => { if changed.is_err() { break; } continue; },
                    frame = stream.next() => match frame { Some(frame) => frame, None => break },
                };
                if frame.sample_rate != SAMPLE_RATE
                    || frame.num_channels != 1
                    || frame.samples_per_channel != FRAME_SAMPLES as u32
                {
                    break;
                }
                let Ok(pcm) = <[i16; FRAME_SAMPLES]>::try_from(frame.data.as_ref()) else {
                    break;
                };
                // A lagging consumer cannot accumulate stale speech indefinitely.
                // Overflow retires this receive generation instead of guessing
                // which missing audio a downstream recognizer or player heard.
                if !frames.push(pcm) {
                    break;
                }
            }
            frames.retire();
            stream.close();
        });
        Ok(AudioReceiver {
            binding,
            frames: receiver,
            stop,
            alive: self.alive.subscribe(),
            task: Some(task),
        })
    }

    pub async fn close(&self) -> Result<(), Error> {
        self.alive.send_replace(false);
        self.room.close().await.map_err(|_| Error::Unavailable)
    }
}

fn contains(publications: &watch::Receiver<BTreeMap<String, Publication>>, id: &TrackId) -> bool {
    publications
        .borrow()
        .get(&id.track_sid)
        .is_some_and(|p| p.id == *id)
}

fn receiving(publications: &watch::Receiver<BTreeMap<String, Publication>>, id: &TrackId) -> bool {
    publications.borrow().get(&id.track_sid).is_some_and(|p| {
        p.id == *id && matches!(p.publication.track(), Some(RemoteTrack::Audio(_)))
    })
}

fn refresh(
    room: &Room,
    peer: &str,
    peer_sid: &mut Option<String>,
    state: &watch::Sender<BTreeMap<String, Publication>>,
    observed_peer: &watch::Sender<Option<String>>,
) -> bool {
    let mut tracks = BTreeMap::new();
    let participants = room.remote_participants();
    if participants.is_empty() && peer_sid.is_some() {
        return false;
    }
    for (identity, participant) in participants {
        let sid = participant.sid().to_string();
        if identity.to_string() != peer
            || peer_sid.as_ref().is_some_and(|expected| *expected != sid)
        {
            return false;
        }
        *peer_sid = Some(sid.clone());
        for (track_sid, publication) in participant.track_publications() {
            if !tracks.is_empty()
                || publication.kind() != TrackKind::Audio
                || publication.source() != TrackSource::Microphone
            {
                return false;
            }
            tracks.insert(
                track_sid.to_string(),
                Publication {
                    id: TrackId {
                        participant: peer.to_owned(),
                        participant_sid: sid.clone(),
                        track_sid: track_sid.to_string(),
                    },
                    publication,
                },
            );
        }
    }
    // Also wakes a subscription waiter when the SDK attaches a decoded track.
    state.send_replace(tracks);
    observed_peer.send_replace(peer_sid.clone());
    true
}

impl Drop for AudioSession {
    fn drop(&mut self) {
        self.alive.send_replace(false);
        self.events.abort();
        let room = self.room.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = room.close().await;
            });
        }
    }
}

struct Subscription(RemoteTrackPublication);
impl Drop for Subscription {
    fn drop(&mut self) {
        self.0.set_subscribed(false);
    }
}

/// A bounded, paced sender for one immutable publication/generation. Enqueue
/// success is neither network delivery nor playback. Dropping stops publication.
pub struct AudioSender {
    binding: Binding,
    frames: Option<mpsc::Sender<[i16; FRAME_SAMPLES]>>,
    stop: watch::Sender<bool>,
    alive: watch::Receiver<bool>,
    producer: Option<tokio::task::JoinHandle<Result<(), Error>>>,
    source: NativeAudioSource,
    slot: Option<Slot>,
    finished: bool,
    room: Arc<Room>,
    publication: LocalTrackPublication,
    published: bool,
}
impl AudioSender {
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
    pub fn push(&self, pcm: &[i16]) -> Result<(), Error> {
        let pcm = <[i16; FRAME_SAMPLES]>::try_from(pcm).map_err(|_| Error::Invalid)?;
        if *self.stop.borrow() || !*self.alive.borrow() {
            return Err(Error::Unavailable);
        }
        self.frames
            .as_ref()
            .ok_or(Error::Unavailable)?
            .try_send(pcm)
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                _ => Error::Unavailable,
            })
    }

    /// End input and pace every accepted frame, followed by bounded silence.
    /// This proves source consumption only. The publication and exclusive slot
    /// remain held: the application must observe recipient completion (or reach
    /// its bounded deadline) before calling stop. Dropping/interruption aborts
    /// immediately; a cancelled wait can be resumed on this same sender.
    pub async fn finish_input(&mut self) -> Result<(), Error> {
        self.frames.take();
        if *self.stop.borrow() || !*self.alive.borrow() {
            return Err(Error::Unavailable);
        }
        if let Some(producer) = self.producer.as_mut() {
            let result = producer.await.map_err(|_| Error::Unavailable);
            self.producer.take();
            result??;
            self.finished = true;
        }
        if self.finished && !*self.stop.borrow() && *self.alive.borrow() {
            Ok(())
        } else {
            Err(Error::Unavailable)
        }
    }

    pub async fn stop(&mut self) -> Result<(), Error> {
        self.stop.send_replace(true);
        self.frames.take();
        self.publication.mute();
        if let Some(producer) = self.producer.as_mut() {
            let _ = producer.await;
            self.producer.take();
        }
        self.source.clear_buffer();
        if self.published {
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                self.room
                    .local_participant()
                    .unpublish_track(&self.publication.sid()),
            )
            .await
            .map_err(|_| Error::Unavailable)?
            .map_err(|_| Error::Unavailable)?;
            self.published = false;
            self.slot.take();
        }
        Ok(())
    }
}
impl Drop for AudioSender {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.frames.take();
        self.publication.mute();
        self.source.clear_buffer();
        if self.published {
            let producer = self.producer.take();
            let slot = self.slot.take();
            let room = self.room.clone();
            let sid = self.publication.sid();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _slot = slot;
                    if let Some(producer) = producer {
                        let _ = producer.await;
                    }
                    let _ = room.local_participant().unpublish_track(&sid).await;
                });
            }
        }
    }
}

pub struct AudioReceiver {
    binding: Binding,
    frames: Arc<ReceiveQueue>,
    stop: watch::Sender<bool>,
    alive: watch::Receiver<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl AudioReceiver {
    pub fn binding(&self) -> &Binding {
        &self.binding
    }
    pub async fn recv(&mut self) -> Result<[i16; FRAME_SAMPLES], Error> {
        if *self.stop.borrow() || !*self.alive.borrow() {
            self.frames.retire();
            return Err(Error::Unavailable);
        }
        let frame = tokio::select! { biased;
            _ = self.alive.changed() => { self.frames.retire(); return Err(Error::Unavailable); },
            frame = self.frames.recv() => frame?,
        };
        if self.frames.retired.load(Ordering::SeqCst) || !*self.alive.borrow() {
            self.frames.retire();
            return Err(Error::Unavailable);
        }
        Ok(frame)
    }
    pub async fn stop(&mut self) {
        self.stop.send_replace(true);
        self.frames.retire();
        if let Some(task) = self.task.as_mut() {
            let _ = task.await;
            self.task.take();
        }
    }
}
impl Drop for AudioReceiver {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.frames.retire();
    }
}

/// Cancellation clears pending PCM even when the application is not polling.
/// One receiver and one producer share this bounded queue; no samples are logged.
#[derive(Default)]
struct ReceiveQueue {
    frames: Mutex<VecDeque<[i16; FRAME_SAMPLES]>>,
    retired: AtomicBool,
    wake: Notify,
}
impl ReceiveQueue {
    fn push(&self, frame: [i16; FRAME_SAMPLES]) -> bool {
        let mut frames = self.frames.lock().unwrap();
        if self.retired.load(Ordering::SeqCst) || frames.len() == QUEUE_FRAMES {
            return false;
        }
        frames.push_back(frame);
        drop(frames);
        self.wake.notify_one();
        true
    }
    fn retire(&self) {
        let mut frames = self.frames.lock().unwrap();
        self.retired.store(true, Ordering::SeqCst);
        frames.clear();
        drop(frames);
        self.wake.notify_one();
    }
    async fn recv(&self) -> Result<[i16; FRAME_SAMPLES], Error> {
        loop {
            let ready = self.wake.notified();
            {
                let mut frames = self.frames.lock().unwrap();
                if self.retired.load(Ordering::SeqCst) {
                    return Err(Error::Unavailable);
                }
                if let Some(frame) = frames.pop_front() {
                    return Ok(frame);
                }
            }
            ready.await;
        }
    }
}
