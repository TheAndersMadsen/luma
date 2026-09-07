//! Room transport. A coordinator replacement requires a fresh HTTP bootstrap;
//! a transport response is never evidence that an effect completed, and a
//! received frame is never evidence that it rendered.
use crate::{
    Error,
    display::{self, Display, Expected, Incoming, Invitation, TurnStatus},
    speech::{Assembler, Speech},
    wire::RoomResponse,
};
use cosmos_rtc::{Invocation, Session};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

const JOIN_WAIT: Duration = Duration::from_secs(4);

type Completion = watch::Receiver<Option<Result<(), Error>>>;
type ConnectedSession = (Arc<Session>, mpsc::Receiver<Invocation>);

/// Survives Client unwind without retaining platform callbacks. A caller may
/// time out waiting on finish, but must keep the runtime alive while pending.
#[derive(Clone, Default)]
pub(crate) struct CleanupScope {
    completions: Arc<Mutex<Vec<Completion>>>,
}

impl CleanupScope {
    fn register(&self, completion: Completion) {
        self.completions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(completion);
    }

    pub(crate) fn pending(&self) -> bool {
        self.completions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .any(|completion| completion.borrow().is_none())
    }

    pub(crate) async fn finish(&self) -> Result<(), Error> {
        loop {
            let mut completions = self
                .completions
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            if completions.is_empty() {
                return Ok(());
            }
            let mut lost_completion = false;
            for completion in &mut completions {
                loop {
                    if completion.borrow_and_update().is_some() {
                        break;
                    }
                    if completion.changed().await.is_err() {
                        lost_completion = true;
                        break;
                    }
                }
            }
            if lost_completion {
                // An absent completion is never treated as finished teardown.
                return Err(Error::Unavailable);
            }
            {
                let mut registered = self
                    .completions
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if registered.iter().all(|entry| entry.borrow().is_some()) {
                    // Prune only when returning, with no further await. If a
                    // new job extends this wait, cancellation must not erase
                    // an error already observed in an earlier pass.
                    let result = registered
                        .iter()
                        .try_for_each(|entry| (*entry.borrow()).unwrap_or(Err(Error::Unavailable)));
                    registered.clear();
                    return result;
                }
            }
        }
    }

    fn start(
        &self,
        url: String,
        token: String,
    ) -> (
        ShutdownSignal,
        oneshot::Receiver<Result<ConnectedSession, Error>>,
    ) {
        let (shutdown, mut requested) = watch::channel(false);
        let (completed, completion) = watch::channel(None);
        let (ready, connected) = oneshot::channel();
        self.register(completion);
        // This task has no Client, Signer or SecureStore and no abort handle.
        // Both SDK connect and shutdown outlive caller cancellation. Only the
        // handoff or a wait on the registered result may be canceled.
        tokio::spawn(async move {
            let (session, inbox) = match Session::connect(&url, &token).await {
                Ok((session, inbox)) => (Arc::new(session), inbox),
                Err(_) => {
                    let _ = ready.send(Err(Error::Unavailable));
                    completed.send_replace(Some(Err(Error::Unavailable)));
                    return;
                }
            };
            let abandoned = ready.send(Ok((session.clone(), inbox))).is_err();
            if !abandoned {
                loop {
                    if *requested.borrow_and_update() {
                        break;
                    }
                    if requested.changed().await.is_err() {
                        break;
                    }
                }
            }
            let result = session.shutdown().await.map_err(|_| Error::Unavailable);
            drop(session);
            completed.send_replace(Some(result));
        });
        (ShutdownSignal { shutdown }, connected)
    }
}

struct ShutdownSignal {
    shutdown: watch::Sender<bool>,
}

impl ShutdownSignal {
    fn request(&self) {
        self.shutdown.send_replace(true);
    }
}

impl Drop for ShutdownSignal {
    fn drop(&mut self) {
        self.request();
    }
}

pub(crate) struct Connection {
    session: Arc<Session>,
    fence: Arc<SidFence>,
    runtime_epoch: Uuid,
    guard: JoinHandle<()>,
    shutdown: ShutdownSignal,
}

/// Only the attributed runtime participant may deliver frames, and only for
/// the exact bound connection. Anything else receives no transport receipt.
pub(crate) struct Outputs {
    pub(crate) display: watch::Sender<Option<Display>>,
    pub(crate) speech: watch::Sender<Option<Speech>>,
    pub(crate) invitation: watch::Sender<Option<Invitation>>,
    pub(crate) status: watch::Sender<Option<TurnStatus>>,
    pub(crate) task: watch::Sender<Option<crate::action::Task>>,
    pub(crate) confirmation: watch::Sender<Option<crate::action::Confirmation>>,
    pub(crate) revoked: watch::Sender<Option<crate::action::Revoked>>,
}

impl Outputs {
    fn retire(&self) {
        self.display.send_replace(None);
        self.speech.send_replace(None);
        self.invitation.send_replace(None);
        self.status.send_replace(None);
        self.task.send_replace(None);
        self.confirmation.send_replace(None);
        self.revoked.send_replace(None);
    }
}

fn answer(
    invocation: Invocation,
    runtime: &str,
    expected: Expected,
    outputs: &Outputs,
    assembler: &mut Assembler,
) {
    let reply = if invocation.caller != runtime {
        Err(cosmos_rtc::Error::Denied)
    } else {
        match crate::now_ms()
            .and_then(|now| display::parse_frame(&invocation.payload, expected, now))
        {
            Ok((Incoming::Render(card), reply)) => {
                outputs.display.send_replace(Some(card));
                Ok(reply)
            }
            Ok((Incoming::Speak(frame), reply)) => match assembler.accept(frame) {
                Ok(Some(speech)) => {
                    outputs.speech.send_replace(Some(speech));
                    Ok(reply)
                }
                Ok(None) => Ok(reply),
                Err(_) => Err(cosmos_rtc::Error::Invalid),
            },
            Ok((Incoming::Invite(invitation), reply)) => {
                outputs.invitation.send_replace(invitation);
                Ok(reply)
            }
            Ok((Incoming::Status(status), reply)) => {
                outputs.status.send_replace(Some(status));
                Ok(reply)
            }
            // A transport receipt is not an effect. The platform now binds
            // the command, acknowledges the binding, and only afterwards
            // reports what it actually observed.
            Ok((Incoming::Act(task), reply)) => {
                outputs.revoked.send_replace(None);
                outputs.task.send_replace(Some(task));
                Ok(reply)
            }
            Ok((Incoming::Confirm(confirmation), reply)) => {
                outputs.confirmation.send_replace(confirmation);
                Ok(reply)
            }
            // A revoke supersedes remaining work. The platform stops what it
            // can and reports `cancelled` only when it can prove nothing
            // started or that it stopped it; otherwise `unknown`.
            Ok((Incoming::Revoke(action_id, reason), reply)) => {
                outputs
                    .revoked
                    .send_replace(Some(crate::action::Revoked { action_id, reason }));
                outputs.task.send_if_modified(|current| {
                    let matched = current.as_ref().is_some_and(|t| t.action_id == action_id);
                    if matched {
                        *current = None;
                    }
                    matched
                });
                outputs.confirmation.send_if_modified(|current| {
                    let matched = current.as_ref().is_some_and(|c| c.action_id == action_id);
                    if matched {
                        *current = None;
                    }
                    matched
                });
                Ok(reply)
            }
            Ok((Incoming::Clear(action_id), reply)) => {
                assembler.clear(action_id);
                outputs.display.send_if_modified(|current| {
                    let matched = current.as_ref().is_some_and(|c| c.action_id == action_id);
                    if matched {
                        *current = None;
                    }
                    matched
                });
                outputs.speech.send_if_modified(|current| {
                    let matched = current.as_ref().is_some_and(|c| c.action_id == action_id);
                    if matched {
                        *current = None;
                    }
                    matched
                });
                Ok(reply)
            }
            Err(_) => Err(cosmos_rtc::Error::Invalid),
        }
    };
    let _ = invocation.reply.send(reply);
}

struct SidFence {
    runtime: String,
    sid: String,
    current: AtomicBool,
}

impl SidFence {
    fn new(runtime: String, sid: String) -> Self {
        Self {
            runtime,
            sid,
            current: AtomicBool::new(true),
        }
    }

    fn stop(&self) {
        self.current.store(false, Ordering::Release);
    }

    fn observe(&self, connected: bool, peers: &BTreeMap<String, String>) -> bool {
        if !connected || peers.get(&self.runtime) != Some(&self.sid) {
            self.stop();
        }
        self.current.load(Ordering::Acquire)
    }
}

impl Connection {
    pub(crate) async fn connect(
        room: &RoomResponse,
        cleanup: &CleanupScope,
        expected: Expected,
        outputs: Outputs,
    ) -> Result<Self, Error> {
        // Register before the first await, including the SDK connection work.
        // The local Drop signal covers canceled handoff and coordinator waits.
        let (shutdown, connected_session) = cleanup.start(room.url.clone(), room.token.clone());
        let (session, mut inbox) = connected_session.await.map_err(|_| Error::Unavailable)??;
        let mut connected = session.connected();
        let mut peers = session.peers();
        let sid = tokio::time::timeout(
            JOIN_WAIT,
            bind_runtime(
                &room.runtime_participant,
                &mut connected,
                &mut peers,
                &mut inbox,
            ),
        )
        .await
        .map_err(|_| Error::Unavailable)??;
        let fence = Arc::new(SidFence::new(room.runtime_participant.clone(), sid));
        let guarded_fence = fence.clone();
        let guarded_shutdown = shutdown.shutdown.clone();
        let runtime = room.runtime_participant.clone();
        let guard = tokio::spawn(async move {
            let mut assembler = Assembler::default();
            loop {
                if !guarded_fence
                    .observe(*connected.borrow_and_update(), &peers.borrow_and_update())
                {
                    break;
                }
                tokio::select! {
                    changed = connected.changed() => {
                        if changed.is_err() { break; }
                    }
                    changed = peers.changed() => {
                        if changed.is_err() { break; }
                    }
                    invocation = inbox.recv() => {
                        let Some(invocation) = invocation else { break; };
                        answer(invocation, &runtime, expected, &outputs, &mut assembler);
                    }
                }
            }
            // A lost coordinator retires any card or speech it dispatched.
            outputs.retire();
            guarded_fence.stop();
            guarded_shutdown.send_replace(true);
        });
        let connection = Self {
            session,
            fence,
            runtime_epoch: room.runtime_epoch,
            guard,
            shutdown,
        };
        if !connection.alive() {
            return Err(Error::Unavailable);
        }
        Ok(connection)
    }

    pub(crate) fn alive(&self) -> bool {
        if self.guard.is_finished() {
            self.fence.stop();
        }
        let connected = self.session.connected();
        let peers = self.session.peers();
        if connected.has_changed().is_err() || peers.has_changed().is_err() {
            self.fence.stop();
        }
        let alive = self.fence.observe(*connected.borrow(), &peers.borrow());
        if !alive {
            self.shutdown.request();
        }
        alive
    }

    pub(crate) fn runtime_epoch(&self) -> Uuid {
        self.runtime_epoch
    }

    pub(crate) async fn invoke(&self, payload: String) -> Result<String, Error> {
        if !self.alive() {
            return Err(Error::Unavailable);
        }
        let result = self.session.invoke(&self.fence.runtime, payload).await;
        if !self.alive() {
            return Err(Error::Unavailable);
        }
        result.map_err(|_| Error::Unavailable)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.fence.stop();
        self.shutdown.request();
        self.guard.abort();
        // The registered task retains Session until its uncanceled shutdown
        // finishes. Aborting this lightweight presence guard cannot affect it.
    }
}

async fn bind_runtime(
    runtime: &str,
    connected: &mut watch::Receiver<bool>,
    peers: &mut watch::Receiver<BTreeMap<String, String>>,
    inbox: &mut mpsc::Receiver<Invocation>,
) -> Result<String, Error> {
    loop {
        if !*connected.borrow_and_update() {
            return Err(Error::Unavailable);
        }
        if let Some(sid) = peers
            .borrow_and_update()
            .get(runtime)
            .filter(|sid| !sid.is_empty())
            .cloned()
        {
            return Ok(sid);
        }
        tokio::select! {
            changed = connected.changed() => {
                changed.map_err(|_| Error::Unavailable)?;
            }
            changed = peers.changed() => {
                changed.map_err(|_| Error::Unavailable)?;
            }
            invocation = inbox.recv() => {
                let invocation = invocation.ok_or(Error::Unavailable)?;
                let _ = invocation.reply.send(Err(cosmos_rtc::Error::Denied));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_cleanup(
        scope: &CleanupScope,
    ) -> (oneshot::Sender<Result<(), Error>>, JoinHandle<()>) {
        let (release, released) = oneshot::channel();
        let (completed, completion) = watch::channel(None);
        scope.register(completion);
        let task = tokio::spawn(async move {
            let result = released.await.unwrap_or(Err(Error::Unavailable));
            completed.send_replace(Some(result));
        });
        (release, task)
    }

    #[tokio::test]
    async fn timing_out_the_wait_does_not_cancel_registered_cleanup() {
        let scope = CleanupScope::default();
        let (release, task) = synthetic_cleanup(&scope);
        assert!(scope.pending());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), scope.finish())
                .await
                .is_err()
        );
        assert!(!task.is_finished());
        assert!(scope.pending());
        release.send(Ok(())).unwrap();
        task.await.unwrap();
        assert!(!scope.pending());
        scope.finish().await.unwrap();
        assert!(scope.completions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn canceled_initial_connect_remains_registered_until_its_work_finishes() {
        let scope = CleanupScope::default();
        let captured = scope.clone();
        let (shutdown, requested) = watch::channel(false);
        let local = ShutdownSignal { shutdown };
        let (completed, completion) = watch::channel(None);
        scope.register(completion);
        let (release_connect, connecting) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            connecting.await.unwrap();
            assert!(*requested.borrow());
            completed.send_replace(Some(Ok(())));
        });
        assert!(captured.pending());
        // Dropping the caller requests teardown but must not cancel the
        // in-progress SDK connection work owned by the registered task.
        drop(local);
        assert!(
            tokio::time::timeout(Duration::from_millis(1), captured.finish())
                .await
                .is_err()
        );
        assert!(!task.is_finished());
        assert!(captured.pending());
        release_connect.send(()).unwrap();
        task.await.unwrap();
        captured.finish().await.unwrap();
        assert!(!captured.pending());
    }

    #[tokio::test]
    async fn a_scope_captured_before_registration_observes_the_later_cleanup() {
        let scope = CleanupScope::default();
        let captured = scope.clone();
        assert!(!captured.pending());
        let (release, task) = synthetic_cleanup(&scope);
        assert!(captured.pending());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), captured.finish())
                .await
                .is_err()
        );
        release.send(Ok(())).unwrap();
        task.await.unwrap();
        captured.finish().await.unwrap();
        assert!(!captured.pending());
        assert!(!scope.pending());
    }

    #[tokio::test]
    async fn finish_waits_for_every_cleanup_and_retains_an_error_across_wait_timeout() {
        let scope = CleanupScope::default();
        let (first, first_task) = synthetic_cleanup(&scope);
        let (second, second_task) = synthetic_cleanup(&scope);
        first.send(Err(Error::Unavailable)).unwrap();
        first_task.await.unwrap();
        assert!(scope.pending());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), scope.finish())
                .await
                .is_err()
        );
        assert!(!second_task.is_finished());
        second.send(Ok(())).unwrap();
        second_task.await.unwrap();
        assert!(!scope.pending());
        assert_eq!(scope.finish().await, Err(Error::Unavailable));
        assert!(scope.completions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_later_registration_cannot_erase_an_earlier_error_on_wait_cancellation() {
        let scope = CleanupScope::default();
        let (first, first_task) = synthetic_cleanup(&scope);
        let mut finishing = Box::pin(scope.finish());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), &mut finishing)
                .await
                .is_err()
        );
        let (second, second_task) = synthetic_cleanup(&scope);
        first.send(Err(Error::Unavailable)).unwrap();
        first_task.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(1), &mut finishing)
                .await
                .is_err()
        );
        drop(finishing);
        assert!(scope.pending());
        second.send(Ok(())).unwrap();
        second_task.await.unwrap();
        assert_eq!(scope.finish().await, Err(Error::Unavailable));
        assert!(!scope.pending());
    }

    #[tokio::test]
    async fn a_missing_completion_never_claims_finished_teardown() {
        let scope = CleanupScope::default();
        let (completed, completion) = watch::channel(None);
        scope.register(completion);
        drop(completed);
        assert_eq!(scope.finish().await, Err(Error::Unavailable));
        assert!(scope.pending());
    }

    #[test]
    fn dropping_the_local_shutdown_signal_covers_early_connect_cancellation() {
        let (shutdown, requested) = watch::channel(false);
        let local = ShutdownSignal { shutdown };
        assert!(!*requested.borrow());
        drop(local);
        assert!(*requested.borrow());
    }

    fn peers(sid: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("runtime".into(), sid.into())])
    }

    #[test]
    fn runtime_sid_is_bound_while_other_participants_can_change() {
        let fence = SidFence::new("runtime".into(), "PA_original".into());
        let mut observed = peers("PA_original");
        assert!(fence.observe(true, &observed));
        observed.insert("browser".into(), "PA_browser".into());
        assert!(fence.observe(true, &observed));
        observed.remove("browser");
        assert!(fence.observe(true, &observed));
    }

    #[test]
    fn runtime_disappearance_or_replacement_permanently_fences_the_connection() {
        for changed in [BTreeMap::new(), peers("PA_replacement")] {
            let fence = SidFence::new("runtime".into(), "PA_original".into());
            assert!(!fence.observe(true, &changed));
            assert!(!fence.observe(true, &peers("PA_original")));
        }
    }

    #[test]
    fn disconnect_or_explicit_close_cannot_be_revived_by_presence() {
        let observed = peers("PA_original");
        let disconnected = SidFence::new("runtime".into(), "PA_original".into());
        assert!(!disconnected.observe(false, &observed));
        assert!(!disconnected.observe(true, &observed));
        let closed = SidFence::new("runtime".into(), "PA_original".into());
        closed.stop();
        assert!(!closed.observe(true, &observed));
    }
}
