//! Notifications wake delivery; the subsequent Store transaction is authority.
use super::RuntimeError;
use tokio::sync::broadcast;

pub enum Changes {
    Memory {
        receiver: broadcast::Receiver<String>,
        key: String,
    },
    Postgres(Box<sqlx::postgres::PgListener>),
}
impl Changes {
    pub async fn changed(&mut self) -> Result<(), RuntimeError> {
        match self {
            Self::Memory { receiver, key } => loop {
                match receiver.recv().await {
                    Ok(changed) if changed == *key => return Ok(()),
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => return Ok(()),
                    Err(_) => return Err(RuntimeError::Unavailable),
                }
            },
            Self::Postgres(listener) => {
                // try_recv reports a lost connection. Do not keep dispatching
                // after a reconnect that may have missed revocation notifications.
                listener
                    .try_recv()
                    .await
                    .map_err(|_| RuntimeError::Unavailable)?
                    .ok_or(RuntimeError::Unavailable)
                    .map(|_| ())
            }
        }
    }
}

pub fn channel(principal: &str) -> String {
    // PostgreSQL identifiers are limited to 63 bytes. This is only a wake-up
    // hint: a collision cannot authorize data from another principal.
    format!(
        "cosmos_runtime_{}",
        &crate::surface_registry::hash(principal.as_bytes())[..48]
    )
}

pub struct Signals(broadcast::Sender<String>);
impl Default for Signals {
    fn default() -> Self {
        Self(broadcast::channel(256).0)
    }
}
impl Signals {
    pub fn subscribe(&self, principal: &str) -> Changes {
        Changes::Memory {
            receiver: self.0.subscribe(),
            key: channel(principal),
        }
    }
    pub fn notify(&self, principal: &str) {
        let _ = self.0.send(channel(principal));
    }
}
