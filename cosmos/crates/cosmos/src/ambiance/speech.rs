//! Provider work belongs to a durable native turn and an exact disclosure.
//! No media session or device playback authority is granted by these methods.
use super::{
    Action, RuntimeOperation, RuntimeResult, TurnFence,
    disclosure::{self, Disclosure},
    runtime::{AmbianceRuntime, runtime_error},
};
use crate::{
    auth::AuthenticatedRequest,
    backends::azure_speech::{AzureSpeechClient, SpeechAudioFormat, SpeechSynthesisBackend},
};
use futures_util::{Stream, StreamExt};
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tonic::Status;
use uuid::Uuid;

const CHECK_TIMEOUT: Duration = Duration::from_secs(1);
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(60);

struct Lease {
    authority: Arc<DisclosureAuthority>,
    cancel: CancelDisclosure,
}
struct DisclosureAuthority {
    runtime: Arc<AmbianceRuntime>,
    authenticated: AuthenticatedRequest,
    incarnation: Uuid,
    fence: TurnFence,
    disclosure: Disclosure,
}
struct CancelDisclosure {
    store: crate::store::SharedStore,
    principal: String,
    fence: TurnFence,
    id: Uuid,
    armed: bool,
}
impl Drop for CancelDisclosure {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let store = self.store.clone();
        let principal = self.principal.clone();
        let fence = self.fence.clone();
        let id = self.id;
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                CHECK_TIMEOUT,
                store.runtime(&principal, RuntimeOperation::RetireDisclosure { fence, id }),
            )
            .await;
        });
    }
}
impl Lease {
    async fn start(
        runtime: Arc<AmbianceRuntime>,
        authenticated: AuthenticatedRequest,
        incarnation: Uuid,
        fence: TurnFence,
        request: disclosure::Request,
    ) -> Result<Self, Status> {
        let proof = tokio::time::timeout(
            CHECK_TIMEOUT,
            runtime.pin_proof(&authenticated, incarnation),
        )
        .await
        .map_err(|_| unavailable())??;
        if proof.surface_id != fence.origin_surface {
            return Err(Status::permission_denied("origin mismatch"));
        }
        let principal = authenticated
            .principal
            .expose_for_authorization()
            .to_owned();
        // Arm before the commit. Interrupted or ambiguous commits must not leave
        // a live turn available for a second upload.
        let id = Uuid::new_v4();
        let cancel = CancelDisclosure {
            store: runtime.store.clone(),
            principal: principal.clone(),
            fence: fence.clone(),
            id,
            armed: true,
        };
        let result = tokio::time::timeout(
            CHECK_TIMEOUT,
            runtime.store.runtime(
                &principal,
                RuntimeOperation::StartDisclosure {
                    fence: fence.clone(),
                    request,
                    id,
                },
            ),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(runtime_error)?;
        let RuntimeResult::DisclosureStarted(disclosure) = result else {
            return Err(Status::permission_denied(
                "speech provider disclosure not approved",
            ));
        };
        Ok(Self {
            authority: Arc::new(DisclosureAuthority {
                runtime,
                authenticated,
                incarnation,
                fence,
                disclosure,
            }),
            cancel,
        })
    }
}
impl DisclosureAuthority {
    async fn check(&self) -> Result<(), Status> {
        tokio::time::timeout(CHECK_TIMEOUT, async {
            self.runtime
                .check_pin(&self.authenticated, self.incarnation)
                .await?;
            self.runtime
                .store
                .runtime(
                    self.authenticated.principal.expose_for_authorization(),
                    RuntimeOperation::CheckDisclosure {
                        fence: self.fence.clone(),
                        disclosure: self.disclosure.clone(),
                    },
                )
                .await
                .map_err(runtime_error)?;
            Ok(())
        })
        .await
        .map_err(|_| unavailable())?
    }
}
impl Lease {
    async fn run<T>(
        &mut self,
        work: impl std::future::Future<Output = Result<T, Status>>,
    ) -> Result<T, Status> {
        let result = tokio::time::timeout(PROVIDER_TIMEOUT, async {
            // Even an immediately ready future cannot run before revalidation.
            self.authority.check().await?;
            let mut changes = tokio::time::timeout(CHECK_TIMEOUT, self.authority.runtime.store.runtime_changes(self.authority.authenticated.principal.expose_for_authorization())).await.map_err(|_| unavailable())?.map_err(runtime_error)?;
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            tokio::pin!(work);
            loop {
                tokio::select! { biased;
                    changed = changes.changed() => { changed.map_err(|_| unavailable())?; self.authority.check().await?; },
                    _ = interval.tick() => self.authority.check().await?,
                    value = &mut work => { self.authority.check().await?; return value; }
                }
            }
        }).await.map_err(|_| unavailable())?;
        if result.is_ok() {
            self.cancel.armed = false;
        }
        result
    }
}

/// Owned producer with one bounded chunk. It rechecks while the consumer is
/// idle or backpressured; revocation prevents queued bytes from being returned.
/// Consumption also revalidates authority before yielding each chunk. Drop
/// aborts pending HTTP work and requests retirement of the exact durable turn.
pub struct SpeechStream {
    chunks: mpsc::Receiver<(Vec<u8>, oneshot::Sender<()>)>,
    current: Arc<AtomicBool>,
    producer: tokio::task::JoinHandle<()>,
    authority: Arc<DisclosureAuthority>,
    pending: Option<PendingChunk>,
    ended: bool,
}
struct PendingChunk {
    chunk: Vec<u8>,
    consumed: oneshot::Sender<()>,
    check: Pin<Box<dyn std::future::Future<Output = Result<(), Status>> + Send>>,
}
impl Stream for SpeechStream {
    type Item = Result<Vec<u8>, Status>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ended {
            return Poll::Ready(None);
        }
        if !self.current.load(Ordering::SeqCst) {
            self.chunks.close();
            self.pending = None;
            while self.chunks.try_recv().is_ok() {}
            self.ended = true;
            return Poll::Ready(Some(Err(unavailable())));
        }
        if let Some(pending) = self.pending.as_mut() {
            match pending.check.as_mut().poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(())) if self.current.load(Ordering::SeqCst) => {
                    let pending = self.pending.take().unwrap();
                    let _ = pending.consumed.send(());
                    return Poll::Ready(Some(Ok(pending.chunk)));
                }
                Poll::Ready(_) => {
                    self.pending = None;
                    self.current.store(false, Ordering::SeqCst);
                    self.producer.abort();
                    self.chunks.close();
                    self.ended = true;
                    return Poll::Ready(Some(Err(unavailable())));
                }
            }
        }
        match self.chunks.poll_recv(cx) {
            Poll::Ready(Some((chunk, consumed))) if self.current.load(Ordering::SeqCst) => {
                let authority = self.authority.clone();
                self.pending = Some(PendingChunk {
                    chunk,
                    consumed,
                    check: Box::pin(async move { authority.check().await }),
                });
                self.poll_next(cx)
            }
            Poll::Ready(Some(_)) => {
                self.ended = true;
                Poll::Ready(Some(Err(unavailable())))
            }
            Poll::Ready(None) => {
                self.ended = true;
                Poll::Ready(if self.current.load(Ordering::SeqCst) {
                    None
                } else {
                    Some(Err(unavailable()))
                })
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for SpeechStream {
    fn drop(&mut self) {
        self.producer.abort();
    }
}

impl AmbianceRuntime {
    /// Atomically claim and authorize the exact proposed speech action before
    /// synthesis. The native room owner
    /// must separately authorize publication/consumption and completion.
    pub async fn synthesize_pin(
        self: &Arc<Self>,
        authenticated: AuthenticatedRequest,
        incarnation: Uuid,
        fence: TurnFence,
        action: Action,
    ) -> Result<SpeechStream, Status> {
        let client = AzureSpeechClient::from_configuration()
            .map_err(|_| unavailable())?
            .ok_or_else(unavailable)?;
        self.synthesize_pin_with_client(authenticated, incarnation, fence, action, client)
            .await
    }

    pub(crate) async fn synthesize_pin_with_client(
        self: &Arc<Self>,
        authenticated: AuthenticatedRequest,
        incarnation: Uuid,
        fence: TurnFence,
        action: Action,
        client: AzureSpeechClient,
    ) -> Result<SpeechStream, Status> {
        let format = SpeechAudioFormat::Raw48Khz16BitMonoPcm;
        let request = disclosure::Request {
            provider: disclosure::Provider::AzureSpeech {
                region: client.region().to_owned(),
            },
            purpose: disclosure::Purpose::Synthesis,
            payload_digest: client.synthesis_digest(action.intent.text(), format),
            content_digest: crate::surface_registry::hash(action.intent.text().as_bytes()),
            action_id: Some(action.id),
            privacy: action.privacy,
        };
        let mut lease =
            Lease::start(self.clone(), authenticated, incarnation, fence, request).await?;
        let authority = lease.authority.clone();
        let (send, chunks) = mpsc::channel(1);
        let current = Arc::new(AtomicBool::new(true));
        let active = current.clone();
        let producer = tokio::spawn(async move {
            let work = async {
                let mut stream = client
                    .synthesize_stream(action.intent.text(), format)
                    .await
                    .map_err(|_| unavailable())?;
                while let Some(chunk) = stream.next().await {
                    let (consumed, receive) = oneshot::channel();
                    send.send((chunk.map_err(|_| unavailable())?, consumed))
                        .await
                        .map_err(|_| unavailable())?;
                    // Keep the disclosure check alive through the last queued
                    // chunk; provider EOF cannot strand unguarded pending bytes.
                    receive.await.map_err(|_| unavailable())?;
                }
                Ok(())
            };
            if lease.run(work).await.is_err() {
                active.store(false, Ordering::SeqCst);
            }
            // Closing the channel wakes a pending consumer after invalidation.
            drop(send);
        });
        Ok(SpeechStream {
            chunks,
            current,
            producer,
            authority,
            pending: None,
            ended: false,
        })
    }
}

fn unavailable() -> Status {
    Status::unavailable("speech disclosure unavailable")
}

#[cfg(test)]
#[path = "speech_tests.rs"]
mod tests;
