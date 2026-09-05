//! LiveKit is transport, never policy. Only this crate imports its SDKs.
//! The caller binds identities to current enrollment before admitting work.
pub mod audio;

use livekit::{
    ConnectionState, Room, RoomEvent, RoomOptions,
    rpc::{PerformRpcData, RpcError},
};
use livekit_token::{AccessToken, VideoGrants};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, watch};

pub const MAX_PAYLOAD: usize = 12 * 1024;
pub const RPC_TIMEOUT: Duration = Duration::from_secs(3);
const METHOD: &str = "cosmos.coordinate.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("realtime transport unavailable")]
    Unavailable,
    #[error("invalid coordination message")]
    Invalid,
    #[error("coordination denied")]
    Denied,
    #[error("coordination busy")]
    Busy,
}

/// No Debug: bearer tokens and payloads must not enter logs.
pub struct Invocation {
    /// Attributed by the room server. It is not a body-supplied identity.
    pub caller: String,
    pub payload: String,
    pub reply: oneshot::Sender<Result<String, Error>>,
}

/// Owns the event pump and closes the participant when dropped. Reconnection
/// is visible to the caller, which must fence in-flight work while disconnected.
pub struct Session {
    room: Arc<Room>,
    events: tokio::task::JoinHandle<()>,
    connected: watch::Sender<bool>,
    peers: watch::Receiver<BTreeMap<String, String>>,
}

impl Session {
    pub async fn connect(
        url: &str,
        token: &str,
    ) -> Result<(Self, mpsc::Receiver<Invocation>), Error> {
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        options.data_stream = options
            .data_stream
            .with_max_payload_byte_length(MAX_PAYLOAD);
        let (room, mut events) =
            tokio::time::timeout(Duration::from_secs(10), Room::connect(url, token, options))
                .await
                .map_err(|_| Error::Unavailable)?
                .map_err(|_| Error::Unavailable)?;
        let room = Arc::new(room);
        let initial_peers = room
            .remote_participants()
            .iter()
            .map(|(identity, participant)| (identity.to_string(), participant.sid().to_string()))
            .collect::<BTreeMap<_, _>>();
        let (peers, peer_state) = watch::channel(initial_peers);
        let (inbox, receiver) = mpsc::channel::<Invocation>(32);
        let (state, connected) = watch::channel(true);
        let alive = connected.clone();
        room.local_participant()
            .register_rpc_method(METHOD.to_owned(), move |call| {
                let inbox = inbox.clone();
                let alive = alive.clone();
                Box::pin(async move {
                    let result = async {
                        if !*alive.borrow() {
                            return Err(Error::Unavailable);
                        }
                        if call.payload.is_empty() || call.payload.len() > MAX_PAYLOAD {
                            return Err(Error::Invalid);
                        }
                        let (reply, response) = oneshot::channel();
                        inbox
                            .try_send(Invocation {
                                caller: call.caller_identity.to_string(),
                                payload: call.payload,
                                reply,
                            })
                            .map_err(|_| Error::Busy)?;
                        let payload = tokio::time::timeout(RPC_TIMEOUT, response)
                            .await
                            .map_err(|_| Error::Unavailable)?
                            .map_err(|_| Error::Unavailable)??;
                        if payload.len() > MAX_PAYLOAD {
                            return Err(Error::Invalid);
                        }
                        Ok(payload)
                    }
                    .await;
                    result.map_err(rpc_error)
                })
            });
        let connection_state = state.clone();
        let events = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    RoomEvent::ConnectionStateChanged(connection) => {
                        // A disconnected session is fenced permanently. An SDK
                        // reconnect must not silently revive application work.
                        if connection != ConnectionState::Connected {
                            state.send_replace(false);
                        }
                    }
                    RoomEvent::ParticipantConnected(participant) => {
                        peers.send_modify(|current| {
                            current.insert(
                                participant.identity().to_string(),
                                participant.sid().to_string(),
                            );
                        });
                    }
                    RoomEvent::ParticipantDisconnected(participant) => {
                        peers.send_modify(|current| {
                            current.remove(&participant.identity().to_string());
                        });
                    }
                    _ => {}
                }
            }
            state.send_replace(false);
        });
        Ok((
            Self {
                room,
                events,
                connected: connection_state,
                peers: peer_state,
            },
            receiver,
        ))
    }

    pub fn connected(&self) -> watch::Receiver<bool> {
        self.connected.subscribe()
    }

    /// Server-observed presence only, never enrollment or routing authority.
    /// Session IDs distinguish a replacement connection even when updates coalesce.
    pub fn peers(&self) -> watch::Receiver<BTreeMap<String, String>> {
        self.peers.clone()
    }

    /// A transport response is not a committed render outcome. The runtime
    /// separately verifies the action's exact acknowledgment under its lock.
    pub async fn invoke(&self, target: &str, payload: String) -> Result<String, Error> {
        if target.is_empty() || payload.is_empty() || payload.len() > MAX_PAYLOAD {
            return Err(Error::Invalid);
        }
        if !*self.connected.borrow() {
            return Err(Error::Unavailable);
        }
        let result = tokio::time::timeout(
            RPC_TIMEOUT,
            self.room.local_participant().perform_rpc(PerformRpcData {
                destination_identity: target.to_owned(),
                method: METHOD.to_owned(),
                payload,
                response_timeout: RPC_TIMEOUT,
                max_round_trip_latency: RPC_TIMEOUT,
            }),
        )
        .await
        .map_err(|_| Error::Unavailable)?
        .map_err(|_| Error::Unavailable)?;
        if result.len() > MAX_PAYLOAD {
            return Err(Error::Invalid);
        }
        Ok(result)
    }

    pub async fn close(self) -> Result<(), Error> {
        self.shutdown().await
    }

    pub async fn shutdown(&self) -> Result<(), Error> {
        self.connected.send_replace(false);
        self.room.close().await.map_err(|_| Error::Unavailable)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.connected.send_replace(false);
        self.events.abort();
        let room = self.room.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = room.close().await;
            });
        }
    }
}

fn rpc_error(error: Error) -> RpcError {
    let code = match error {
        Error::Invalid => 1400,
        Error::Denied => 1403,
        Error::Busy => 1429,
        Error::Unavailable => 1503,
    };
    RpcError::new(code, error.to_string(), None)
}

/// The first transport profile carries coordination only. It cannot capture,
/// publish, record, subscribe to media, administer rooms or mint other tokens.
/// Approval and revocation remain runtime checks on every message; expiration
/// controls joining a room and is not treated as live revocation.
pub fn coordination_token(
    key: &str,
    secret: &str,
    room: &str,
    participant: &str,
) -> Result<String, Error> {
    if key.is_empty() || secret.len() < 32 || room.is_empty() || participant.is_empty() {
        return Err(Error::Invalid);
    }
    AccessToken::with_api_key(key, secret)
        .with_identity(participant)
        .with_ttl(Duration::from_secs(300))
        .with_grants(VideoGrants {
            room_join: true,
            room: room.to_owned(),
            can_publish: false,
            can_subscribe: false,
            can_publish_data: true,
            can_update_own_metadata: false,
            ..Default::default()
        })
        .to_jwt()
        .map_err(|_| Error::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordination_grants_never_inherit_media_or_administrative_defaults() {
        let token = coordination_token("fixture", &"s".repeat(32), "room", "surface").unwrap();
        let claims = livekit_token::TokenVerifier::with_api_key("fixture", &"s".repeat(32))
            .verify(&token)
            .unwrap();
        assert_eq!(claims.sub, "surface");
        assert_eq!(claims.video.room, "room");
        assert!(claims.video.room_join && claims.video.can_publish_data);
        assert!(!claims.video.can_publish && !claims.video.can_subscribe);
        assert!(!claims.video.can_update_own_metadata && !claims.video.hidden);
        assert!(!claims.video.room_admin && !claims.video.room_record && !claims.video.room_create);
        assert!(!claims.video.room_list && !claims.video.ingress_admin && !claims.video.recorder);
        assert!(claims.video.can_publish_sources.is_empty());
        assert!(!claims.sip.admin && !claims.sip.call);
        assert_eq!(claims.exp - claims.nbf, 300);
    }
}
