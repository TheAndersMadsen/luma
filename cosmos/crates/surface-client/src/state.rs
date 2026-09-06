use crate::{
    Admission, Config, Error, MAX_JOURNAL_BYTES, MAX_SEQUENCE, MAX_TEXT_BYTES, OperationKind,
    OperationResult, Pending, Platform, RECEIPT_MS, wire,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    origin: String,
    enrollment: Uuid,
    platform: Platform,
    public_key: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Journal {
    version: u8,
    binding: Binding,
    pub(crate) epoch: Uuid,
    pub(crate) sequence: u64,
    #[serde(deserialize_with = "required")]
    pub(crate) surface_id: Option<Uuid>,
    #[serde(deserialize_with = "required")]
    pub(crate) approval_revision: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub(crate) open: Option<PendingOpen>,
    #[serde(deserialize_with = "required")]
    pub(crate) pending: Option<PendingRpc>,
    #[serde(deserialize_with = "required")]
    pub(crate) last_unknown: Option<Pending>,
    #[serde(deserialize_with = "required")]
    pub(crate) last_admission: Option<Admission>,
    #[serde(deserialize_with = "required")]
    pub(crate) last_result: Option<OperationResult>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingOpen {
    pub(crate) challenge: wire::Challenge,
    pub(crate) request: wire::OpenRequest,
    pub(crate) secret: String,
    pub(crate) created_at_ms: i64,
    #[serde(deserialize_with = "required")]
    pub(crate) opened_at_ms: Option<i64>,
    #[serde(deserialize_with = "required")]
    pub(crate) connection: Option<wire::ConnectionView>,
    pub(crate) joined: bool,
    #[serde(deserialize_with = "required")]
    pub(crate) runtime_epoch: Option<Uuid>,
    pub(crate) lease_until_ms: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingRpc {
    pub(crate) message: RpcMessage,
    pub(crate) created_at_ms: i64,
    pub(crate) runtime_epoch: Uuid,
    pub(crate) approval_revision: u64,
    pub(crate) incarnation: Uuid,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum RpcMessage {
    Input { stamp: Stamp, text: String },
    Control { stamp: Stamp, control: Control },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stamp {
    pub(crate) epoch: Uuid,
    pub(crate) sequence: u64,
    pub(crate) instance_id: Uuid,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Control {
    Heartbeat,
    Cancel {
        #[serde(rename = "turnId")]
        turn_id: Uuid,
        generation: u64,
    },
    State {
        visible: bool,
    },
    Acknowledge {
        #[serde(rename = "actionId")]
        action_id: Uuid,
        #[serde(rename = "turnId")]
        turn_id: Uuid,
        generation: u64,
        channel: String,
        #[serde(rename = "contentDigest")]
        content_digest: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Reply {
    Admitted {
        version: u8,
        #[serde(rename = "turnId")]
        turn_id: Uuid,
        generation: u64,
        duplicate: bool,
    },
    Accepted {
        version: u8,
        duplicate: bool,
    },
}

fn required<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl Journal {
    pub(crate) fn fresh(config: &Config, key: &[u8; 65]) -> Self {
        Self {
            version: 1,
            binding: Binding {
                origin: config.server_origin.clone(),
                enrollment: config.enrollment_id,
                platform: config.platform,
                public_key: URL_SAFE_NO_PAD.encode(key),
            },
            epoch: config.boot_epoch,
            sequence: 0,
            surface_id: None,
            approval_revision: None,
            open: None,
            pending: None,
            last_unknown: None,
            last_admission: None,
            last_result: None,
        }
    }

    pub(crate) fn load(bytes: &[u8], config: &Config, key: &[u8; 65]) -> Result<Self, Error> {
        if bytes.is_empty() || bytes.len() > MAX_JOURNAL_BYTES {
            return Err(Error::InvalidJournal);
        }
        let mut journal: Self = serde_json::from_slice(bytes).map_err(|_| Error::InvalidJournal)?;
        // A connection signed under a superseded approval profile cannot be
        // resumed or retried: the owner must reapprove at the current profile,
        // which drops that connection anyway. Keep the enrollment identity and
        // record any unresolved request as unknown rather than blocking.
        if journal
            .open
            .as_ref()
            .is_some_and(|open| open.challenge.approval != wire::PROFILE)
        {
            journal.open = None;
            journal.abandon_pending();
        }
        journal
            .validate(config, key)
            .map_err(|_| Error::InvalidJournal)?;
        Ok(journal)
    }

    pub(crate) fn bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::InvalidJournal)?;
        if bytes.len() > MAX_JOURNAL_BYTES {
            return Err(Error::InvalidJournal);
        }
        Ok(bytes)
    }

    fn validate(&self, config: &Config, key: &[u8; 65]) -> Result<(), Error> {
        if self.version != 1
            || self.binding != Self::fresh(config, key).binding
            || self.epoch.is_nil()
            || self.sequence > MAX_SEQUENCE
            || self.surface_id.is_some_and(|id| id.is_nil())
            || self
                .approval_revision
                .is_some_and(|v| v == 0 || v > MAX_SEQUENCE)
            || self.surface_id.is_some() != self.approval_revision.is_some()
        {
            return Err(Error::InvalidJournal);
        }
        if let Some(open) = &self.open {
            open.challenge.validate(
                &config.server_origin,
                config.enrollment_id,
                key,
                open.created_at_ms,
            )?;
            if Some(open.challenge.surface_id) != self.surface_id
                || Some(open.challenge.approval_revision) != self.approval_revision
                || open.request.epoch != self.epoch
                || wire::fingerprint(&wire::decode_secret(&open.secret)?)
                    != open.request.session_token_hash
                || open.runtime_epoch.is_some_and(|id| id.is_nil())
                || open.joined && open.connection.is_none()
            {
                return Err(Error::InvalidJournal);
            }
            let message = wire::signing_message(&open.challenge, &open.request)?;
            let signature = URL_SAFE_NO_PAD
                .decode(&open.request.signature)
                .map_err(|_| Error::InvalidJournal)?;
            if URL_SAFE_NO_PAD.encode(&signature) != open.request.signature {
                return Err(Error::InvalidJournal);
            }
            wire::verify_signature(key, &message, &signature)?;
            if let Some(connection) = &open.connection {
                connection.validate(
                    &open.challenge,
                    self.epoch,
                    open.opened_at_ms.ok_or(Error::InvalidJournal)?,
                )?;
                if Some(connection.incarnation) == open.request.expected_incarnation
                    || open.lease_until_ms <= 0
                    || open.lease_until_ms > connection.expires_at_ms
                {
                    return Err(Error::InvalidJournal);
                }
            } else if open.lease_until_ms != 0
                || open.runtime_epoch.is_some()
                || open.opened_at_ms.is_some()
            {
                return Err(Error::InvalidJournal);
            }
        }
        if let Some(pending) = &self.pending {
            pending.message.validate()?;
            if pending.message.stamp().epoch != self.epoch
                || pending.message.stamp().sequence != self.sequence
                || pending.created_at_ms <= 0
                || pending.runtime_epoch.is_nil()
                || pending.incarnation.is_nil()
                || pending.approval_revision == 0
                || pending.approval_revision > MAX_SEQUENCE
                || self.surface_id.is_none()
            {
                return Err(Error::InvalidJournal);
            }
        }
        if self.last_unknown.is_some_and(|p| {
            p.instance_id.is_nil() || p.sequence == 0 || p.sequence > MAX_SEQUENCE || p.can_retry
        }) || self.last_admission.is_some_and(|a| !valid_admission(a))
            || self
                .last_result
                .is_some_and(|r| matches!(r,OperationResult::Text(a) if !valid_admission(a)))
        {
            return Err(Error::InvalidJournal);
        }
        Ok(())
    }

    pub(crate) fn abandon_pending(&mut self) {
        if let Some(pending) = self.pending.take() {
            let mut summary = pending.summary(i64::MAX);
            summary.can_retry = false;
            self.last_unknown = Some(summary);
        }
        self.last_result = None;
    }

    pub(crate) fn reconcile(&mut self, epoch: Uuid, now: i64) {
        if self.epoch != epoch {
            self.abandon_pending();
            self.epoch = epoch;
            self.sequence = 0;
            self.open = None;
            self.last_admission = None;
        } else if self
            .pending
            .as_ref()
            .is_some_and(|pending| !pending.retryable(now))
        {
            self.abandon_pending();
        }
    }

    pub(crate) fn stage(
        &mut self,
        message: RpcMessage,
        now: i64,
        runtime_epoch: Uuid,
        incarnation: Uuid,
    ) -> Result<(), Error> {
        if self.pending.is_some() {
            return Err(Error::Pending);
        }
        message.validate()?;
        if message.stamp().epoch != self.epoch
            || message.stamp().sequence
                != self.sequence.checked_add(1).ok_or(Error::InvalidInput)?
            || now <= 0
            || runtime_epoch.is_nil()
            || incarnation.is_nil()
        {
            return Err(Error::InvalidInput);
        }
        self.sequence = message.stamp().sequence;
        self.last_result = None;
        self.pending = Some(PendingRpc {
            message,
            created_at_ms: now,
            runtime_epoch,
            approval_revision: self.approval_revision.ok_or(Error::Disconnected)?,
            incarnation,
        });
        Ok(())
    }

    pub(crate) fn complete(&mut self, result: OperationResult) {
        let current_origin = self.pending.as_ref().is_some_and(|pending| {
            self.open
                .as_ref()
                .and_then(|open| open.connection.as_ref())
                .is_some_and(|connection| pending.incarnation == connection.incarnation)
        });
        self.pending = None;
        self.last_result = Some(result);
        match result {
            OperationResult::Text(admission) => {
                // A receipt survives same-boot replacement, but that old
                // connection's turn can no longer accept a fresh cancel.
                self.last_admission = current_origin.then_some(admission);
            }
            OperationResult::Cancel => self.last_admission = None,
            OperationResult::Heartbeat
            | OperationResult::State(_)
            | OperationResult::Acknowledge => {}
        }
    }
}

pub(crate) fn valid_admission(value: Admission) -> bool {
    !value.turn_id.is_nil() && value.generation > 0 && value.generation <= MAX_SEQUENCE
}

impl RpcMessage {
    pub(crate) fn stamp(&self) -> &Stamp {
        match self {
            Self::Input { stamp, .. } | Self::Control { stamp, .. } => stamp,
        }
    }

    pub(crate) fn kind(&self) -> OperationKind {
        match self {
            Self::Input { .. } => OperationKind::Text,
            Self::Control {
                control: Control::Heartbeat,
                ..
            } => OperationKind::Heartbeat,
            Self::Control {
                control: Control::Cancel { .. },
                ..
            } => OperationKind::Cancel,
            Self::Control {
                control: Control::State { .. },
                ..
            } => OperationKind::State,
            Self::Control {
                control: Control::Acknowledge { .. },
                ..
            } => OperationKind::Acknowledge,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        let stamp = self.stamp();
        if stamp.epoch.is_nil()
            || stamp.instance_id.is_nil()
            || stamp.sequence == 0
            || stamp.sequence > MAX_SEQUENCE
        {
            return Err(Error::InvalidInput);
        }
        match self {
            Self::Input { text, .. } if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES => {
                Err(Error::InvalidInput)
            }
            Self::Control {
                control:
                    Control::Cancel {
                        turn_id,
                        generation,
                    },
                ..
            } if *turn_id != stamp.instance_id
                || *generation == 0
                || *generation > MAX_SEQUENCE =>
            {
                Err(Error::InvalidInput)
            }
            Self::Control {
                control:
                    Control::Acknowledge {
                        action_id,
                        turn_id,
                        generation,
                        channel,
                        content_digest,
                    },
                ..
            } if *action_id != stamp.instance_id
                || turn_id.is_nil()
                || *generation == 0
                || *generation > MAX_SEQUENCE
                || !matches!(channel.as_str(), "visual.card" | "audio.tts")
                || content_digest.len() != 64
                || !content_digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
            {
                Err(Error::InvalidInput)
            }
            _ => Ok(()),
        }?;
        // JSON escaping can make a valid raw-text length exceed the transport
        // envelope cap. Refuse it before allocating a durable sequence.
        if serde_json::to_vec(self)
            .map_err(|_| Error::InvalidInput)?
            .len()
            > cosmos_rtc::MAX_PAYLOAD
        {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

impl PendingRpc {
    pub(crate) fn retryable(&self, now: i64) -> bool {
        now >= self.created_at_ms
            && now
                .checked_sub(self.created_at_ms)
                .is_some_and(|age| age < RECEIPT_MS)
    }

    pub(crate) fn summary(&self, now: i64) -> Pending {
        Pending {
            kind: self.message.kind(),
            instance_id: self.message.stamp().instance_id,
            sequence: self.message.stamp().sequence,
            can_retry: self.retryable(now),
        }
    }

    pub(crate) fn response(&self, payload: &str) -> Result<(OperationResult, bool), Error> {
        if payload.len() > 1024 {
            return Err(Error::InvalidResponse);
        }
        let reply = serde_json::from_str::<Reply>(payload).map_err(|_| Error::InvalidResponse)?;
        match (self.message.kind(), reply) {
            (
                OperationKind::Text,
                Reply::Admitted {
                    version: 1,
                    turn_id,
                    generation,
                    duplicate,
                },
            ) if turn_id == self.message.stamp().instance_id
                && generation > 0
                && generation <= MAX_SEQUENCE =>
            {
                Ok((
                    OperationResult::Text(Admission {
                        turn_id,
                        generation,
                        duplicate,
                    }),
                    duplicate,
                ))
            }
            (
                OperationKind::Heartbeat,
                Reply::Accepted {
                    version: 1,
                    duplicate,
                },
            ) => Ok((OperationResult::Heartbeat, duplicate)),
            (
                OperationKind::Cancel,
                Reply::Accepted {
                    version: 1,
                    duplicate,
                },
            ) => Ok((OperationResult::Cancel, duplicate)),
            (
                OperationKind::State,
                Reply::Accepted {
                    version: 1,
                    duplicate,
                },
            ) => {
                let RpcMessage::Control {
                    control: Control::State { visible },
                    ..
                } = &self.message
                else {
                    return Err(Error::InvalidResponse);
                };
                Ok((OperationResult::State(*visible), duplicate))
            }
            (
                OperationKind::Acknowledge,
                Reply::Accepted {
                    version: 1,
                    duplicate,
                },
            ) => Ok((OperationResult::Acknowledge, duplicate)),
            _ => Err(Error::InvalidResponse),
        }
    }
}
