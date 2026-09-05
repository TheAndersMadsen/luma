//! Runtime-owned lifetime for an isolated Pin audio room. This grants transport
//! membership only: no microphone subscription, provider access or playback.
use super::{PinProof, RuntimeOperation, RuntimeResult, runtime::AmbianceRuntime};
use crate::{auth::AuthenticatedRequest, browser_rooms::Config};
use cosmos_rtc::audio::{AudioSession, Role};
use serde::Serialize;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, SemaphorePermit, watch};
use tonic::Status;
use uuid::Uuid;

const CHECK_TIMEOUT: Duration = Duration::from_secs(1);
const CHECK_INTERVAL: Duration = Duration::from_millis(250);
static MEDIA_SLOTS: Semaphore = Semaphore::const_new(64);

/// Bearer credentials are never Debug or ledger data. A token's 60-second join
/// expiry is separate from the durable connection expiry and active revocation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub version: u8,
    pub url: String,
    pub token: String,
    pub epoch: Uuid,
    pub incarnation: Uuid,
    pub expires_at_ms: i64,
}

/// No access to the raw transport escapes this owner. Turn-bound capture and
/// dispatch must be implemented here before an application can consume PCM.
pub struct PinMedia {
    session: Arc<AudioSession>,
    task: tokio::task::JoinHandle<()>,
    cleanup: Cleanup,
    authenticated: AuthenticatedRequest,
    retired: Arc<AtomicBool>,
    _slot: SemaphorePermit<'static>,
}

struct Cleanup {
    runtime: Arc<AmbianceRuntime>,
    principal: String,
    proof: PinProof,
    owner: Uuid,
}
impl Cleanup {
    async fn close(&self) {
        // Retirement uses previously authenticated evidence and is restricted
        // to this exact incarnation, even after the device pairing changes.
        let _ = tokio::time::timeout(
            CHECK_TIMEOUT,
            self.runtime.store.runtime(
                &self.principal,
                RuntimeOperation::RetirePinMedia {
                    connection: self.proof.clone(),
                    owner: self.owner,
                },
            ),
        )
        .await;
    }
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let runtime = self.runtime.clone();
        let principal = self.principal.clone();
        let proof = self.proof.clone();
        let owner = self.owner;
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                CHECK_TIMEOUT,
                runtime.store.runtime(
                    &principal,
                    RuntimeOperation::RetirePinMedia {
                        connection: proof,
                        owner,
                    },
                ),
            )
            .await;
        });
    }
}

impl PinMedia {
    /// Attach at most once to an incarnation already returned by open_pin.
    /// A failed or interrupted attach requires a new connection incarnation.
    pub async fn connect(
        runtime: Arc<AmbianceRuntime>,
        authenticated: AuthenticatedRequest,
        incarnation: Uuid,
    ) -> Result<(Self, Bootstrap), Status> {
        let config =
            Config::configured().ok_or_else(|| Status::unavailable("media is not configured"))?;
        Self::with_config(runtime, authenticated, incarnation, config).await
    }

    pub(crate) async fn with_config(
        runtime: Arc<AmbianceRuntime>,
        authenticated: AuthenticatedRequest,
        incarnation: Uuid,
        config: Config,
    ) -> Result<(Self, Bootstrap), Status> {
        let slot = MEDIA_SLOTS
            .try_acquire()
            .map_err(|_| Status::resource_exhausted("media capacity reached"))?;
        let proof = tokio::time::timeout(
            CHECK_TIMEOUT,
            runtime.pin_proof(&authenticated, incarnation),
        )
        .await
        .map_err(|_| unavailable())??;
        let principal = authenticated
            .principal
            .expose_for_authorization()
            .to_owned();
        // Cleanup is armed before the claim: cancellation during a slow commit
        // cannot leave a reusable unowned grant after that commit completes.
        let cleanup = Cleanup {
            runtime: runtime.clone(),
            principal: principal.clone(),
            proof: proof.clone(),
            owner: Uuid::new_v4(),
        };
        let result = tokio::time::timeout(
            CHECK_TIMEOUT,
            runtime.store.runtime(
                &principal,
                RuntimeOperation::ClaimPinMedia {
                    connection: proof,
                    owner: cleanup.owner,
                },
            ),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(super::runtime::runtime_error)?;
        let RuntimeResult::PinMediaGranted(connection) = result else {
            return Err(unavailable());
        };
        let mut changes =
            tokio::time::timeout(CHECK_TIMEOUT, runtime.store.runtime_changes(&principal))
                .await
                .map_err(|_| unavailable())?
                .map_err(super::runtime::runtime_error)?;
        let tokens =
            cosmos_rtc::audio::tokens(&config.key, &config.secret).map_err(|_| unavailable())?;
        let session = Arc::new(
            AudioSession::connect(&config.url, &tokens.runtime, Role::Runtime)
                .await
                .map_err(|_| unavailable())?,
        );
        // Membership changes during signaling must win before releasing a token.
        tokio::time::timeout(
            CHECK_TIMEOUT,
            runtime.check_pin(&authenticated, incarnation),
        )
        .await
        .map_err(|_| unavailable())??;
        let mut connected = session.connected();
        let mut peer = session.peer_session();
        let join_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        let task_session = session.clone();
        let media_authenticated = authenticated.clone();
        let task_proof = cleanup.proof.clone();
        let owner = cleanup.owner;
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(CHECK_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                if !*connected.borrow() {
                    break;
                }
                let joined = peer.borrow().is_some();
                if !joined && tokio::time::Instant::now() >= join_deadline {
                    break;
                }
                let check = tokio::time::timeout(
                    CHECK_TIMEOUT,
                    runtime.check_pin(&authenticated, incarnation),
                )
                .await;
                if !matches!(check, Ok(Ok(()))) {
                    break;
                }
                tokio::select! {
                    biased;
                    _ = connected.changed() => break,
                    _ = tokio::time::sleep_until(join_deadline), if !joined => break,
                    changed = peer.changed() => if changed.is_err() { break; },
                    changed = changes.changed() => if changed.is_err() { break; },
                    _ = interval.tick() => {},
                }
            }
            // Closing the transport synchronously fences its queues before
            // waiting for either network cleanup or a possibly failing Store.
            let _ = tokio::time::timeout(CHECK_TIMEOUT, task_session.close()).await;
            let _ = tokio::time::timeout(
                CHECK_TIMEOUT,
                runtime.store.runtime(
                    &principal,
                    RuntimeOperation::RetirePinMedia {
                        connection: task_proof,
                        owner,
                    },
                ),
            )
            .await;
        });
        Ok((
            Self {
                session,
                task,
                cleanup,
                authenticated: media_authenticated,
                retired: Arc::new(AtomicBool::new(false)),
                _slot: slot,
            },
            Bootstrap {
                version: 1,
                url: config.public_url,
                token: tokens.surface,
                epoch: connection.epoch,
                incarnation,
                expires_at_ms: connection.expires_at_ms,
            },
        ))
    }

    pub fn connected(&self) -> watch::Receiver<bool> {
        self.session.connected()
    }

    /// Admit one local-transcription turn against an actually observed native
    /// publication. Admission does not subscribe or expose PCM. The capture
    /// adapter must still use bounded, generation-bound transport consumption.
    pub async fn begin_local_voice(
        &self,
        stamp: super::InputStamp,
        track: cosmos_rtc::audio::TrackId,
    ) -> Result<Option<super::voice::LocalVoice>, Status> {
        if !self.session.publication_current(&track) {
            return Err(Status::failed_precondition("voice source is not current"));
        }
        let session = Arc::downgrade(&self.session);
        let source_track = track.clone();
        let retired = self.retired.clone();
        let source_current = Arc::new(move || {
            !retired.load(Ordering::SeqCst)
                && session
                    .upgrade()
                    .is_some_and(|s| s.publication_current(&source_track))
        });
        let intake = self
            .cleanup
            .runtime
            .begin_local_voice(
                self.authenticated.clone(),
                self.cleanup.proof.incarnation,
                stamp,
                super::voice::Binding {
                    media_owner: self.cleanup.owner,
                    participant_sid: track.participant_sid.clone(),
                    track_sid: track.track_sid.clone(),
                },
                source_current,
            )
            .await?;
        // Source loss during the durable commit wins before any capture work.
        if !self.session.publication_current(&track) {
            return Err(Status::failed_precondition("voice source is not current"));
        }
        Ok(intake)
    }

    pub async fn close(&self) {
        self.retired.store(true, Ordering::SeqCst);
        self.task.abort();
        let _ = tokio::time::timeout(CHECK_TIMEOUT, self.session.close()).await;
        self.cleanup.close().await;
    }
}
impl Drop for PinMedia {
    fn drop(&mut self) {
        self.retired.store(true, Ordering::SeqCst);
        self.task.abort();
        // AudioSession::drop closes transport when the task's Arc is released.
        // Cleanup retires only this durable incarnation.
    }
}
fn unavailable() -> Status {
    Status::unavailable("media connection unavailable")
}

#[cfg(test)]
#[path = "pin_media_tests.rs"]
mod tests;
