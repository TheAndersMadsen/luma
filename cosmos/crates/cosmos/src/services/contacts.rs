//! `humane.contacts.ContactsRPCService`, the device's contact-book sync surface.
//!
//! This is the first *stateful* handler in the deployment. A contacts service
//! that acknowledges a write and then reads back nothing is a data loss a real
//! Pin notices immediately, so every RPC here is backed by the principal-keyed
//! [`Store`](crate::store::Store): writes persist under the caller's
//! authenticated principal and reads return exactly, and only, what that
//! principal wrote. A principal that has never synced still gets the honest
//! empty result a compatible Cosmos service represents when it holds nothing:
//!   * read / list / delta RPCs return an empty-but-typed response,
//!   * the two server-streaming reads return an immediately-closed (grpc-status
//!     OK) stream with zero messages,
//!   * the write / delete RPCs acknowledge with their success shape
//!     (`google.protobuf.Empty` maps to `()` under prost).
//!
//! No contacts or versions are ever fabricated. Server-assigned ids are fresh
//! UUIDv4s for plaintext contacts and key-derived UUIDs for contacts the Pin
//! sealed (see below); `version` and the sync cursors are server-owned.
//!
//! Every RPC resolves the caller through [`RequestAuthenticator`] and fails
//! closed, because the principal is now the storage key: without it there is no
//! book to read and no book to write. That is deliberately redundant with the
//! router's front-door `AuthLayer`, a handler that only reads an
//! already-resolved principal is correct exactly as long as the wiring is, and
//! this one decides which principal's contacts it hands back.
//!
//! # Sync semantics and what they are derived from
//!
//! The contacts family was observed to complete `OK`, but its semantics remain
//! unknown, "cursor/time semantics,
//! full-vs-delta transition, ordering, tombstones, pagination boundaries, stream
//! termination, retry/resume rules, and consistency guarantees". What follows is
//! therefore the simplest reading the `humane/contacts.proto` wire contract
//! admits, not recovered behaviour. The reading, with the ambiguity called out:
//!
//! * **Full vs delta.** `GetContactsStreamingRequest.syncoption` is a oneof of
//!   `last_synced_time` and `full_sync`. A `last_synced_time` is a delta read;
//!   `full_sync`, and an *unset* oneof, which a client with no cursor produces,
//!   is a full read. `full_sync = false` is ambiguous (it asserts "not full"
//!   while supplying no cursor). It is treated as a full read, because the only
//!   alternative is to invent a cursor.
//! * **Cursor comparison is strict.** A client that echoes the
//!   `latest_sync_time` it was handed receives nothing twice.
//! * **Tombstones ride the delta path only.** A full read has no prior client
//!   state to reconcile, so it carries no `deleted_contact_id`s.
//! * **`latest_sync_time` is the store's high-water mark**, not "now". A
//!   principal holding nothing gets no sync point rather than a fabricated one.
//! * **Ordering is unknown.** Items are emitted grouped, contacts, then
//!   encrypted contacts, then deletions, each in stable write order.
//! * **Pagination boundaries are unknown.** `page_num` is 0-based, `total_pages`
//!   counts the chunks actually emitted, and a non-positive `page_size` means
//!   one page. Zero items means zero messages, so an empty book stays an
//!   immediately-closed OK stream.
//!
//! # Contacts the Pin creates arrive sealed, and leave with an identity
//!
//! The stock Pin creates contacts in two places and seals both:
//! `CreateContactActionHandler` ("add Ada, 555…", `trusted = true`) and
//! `ContactsManager.updateLastContactedAt`, which seals
//! `Contact.temporaryContact(number)` for every outgoing call or SMS to an
//! unknown number, the leased contact that lets that number call back for a
//! day. `ContactsProtectionManager.encryptNewContact` protects the
//! `humane.contacts.Contact` with the Krypto data protector of the Contacts
//! domain: an `HMSA` secure asset bound to domain 10 / object 1
//! ([`CONTACT_DATA`]). `CoreDataProtector.protect` mints a **fresh C1 key per
//! call** and `KryptoDataProtector.generateKey` refuses to use it until it is
//! escrowed (`ImportKeys`), so every sealed contact names its own key and this
//! deployment holds it through [`crate::keydirectory`].
//!
//! The device never sets the contact's `id` (`ContactAdapters.
//! convertToContactProtobuf`), reads *only* `getEncryptedContactsList()` off the
//! `CreateContacts` reply, decrypts each item and keys its Room row on the id
//! it finds inside (`ContactsManager$3.onNext` → `parseEncryptedContacts` →
//! `protobufToEntities`, `contact … PRIMARY KEY(id)`, `INSERT OR REPLACE`).
//! Echoing the blob therefore collapsed every Pin-created contact into one row
//! with id `""`. So `CreateContacts` opens each sealed item, persists it as an
//! ordinary plaintext record, and answers with the canonical record **re-sealed
//! under the same key** ([`seal_secure_asset`]), id and version set. The device
//! reveals by the kid in the envelope header
//! (`ContactsProtectionManager.decryptContact` hands `reveal()` only the data
//! bytes), and the open above has already proven that header kid equals the
//! outer `EncryptionInformation.kid`, so the re-seal names exactly the key the
//! Pin minted. A sealed item this deployment cannot open fails the call with
//! `FAILED_PRECONDITION`: the Pin reports "error creating the contact" and stores
//! nothing, instead of saving an id-less row.
//!
//! The server id of a sealed contact is derived from its key id. The key is
//! per contact, so the kid names the contact: a retried `CreateContacts`
//! resends the same blob and lands on the same record instead of a duplicate.
//! Stock `encryptExistingContact(contact, keyId)`, the sealed `UpdateContacts`
//! arm, which no stock code calls, seals under a fresh key but labels the
//! envelope with the original `keyId`. Its header therefore names a different
//! key than `EncryptionInformation.kid`, [`open_secure_asset`] refuses that
//! mismatch, and the update fails with `FAILED_PRECONDITION` without writing.
//!
//! # `server_should_decrypt` and sealed rows from before this
//!
//! The device's only sync call is `GetContactsPaginatedStreaming` with
//! `server_should_decrypt = true`, and `handleDeltaSyncResponse` *skips* any
//! item still `hasEncryptedContact()` while still advancing its cursor past
//! it. Every read here first canonicalizes the principal's legacy sealed rows
//! (stored opaquely by earlier builds) exactly as `CreateContacts` would, so
//! they come back as plaintext contacts with their key-derived id, and the
//! sealed copy is then removed. A row whose
//! key this deployment never received is relayed sealed, the device skips it
//! and moves on, rather than failing the page, which used to block every
//! later sync. A key-directory outage still fails the read as `UNAVAILABLE` so
//! the device retries from its unchanged cursor.
//!
//! # Web edits nudge the Pin
//!
//! A write from the web plane (Center) queues the stock contacts push:
//! `PushMessage{app_name: "humane.contacts", data_payload: {"sync":true}}`,
//! which `CentralPushReceiver` routes to `ContactsPushManager.handlePush` to
//! schedule an immediate delta sync. The Pin's own writes queue nothing. The
//! nudge is best effort: the Pin also syncs on wake, so a queue failure is
//! logged and the saved write still succeeds.
//!
//! Transport auth (the mTLS DeviceUser principal) is still enforced at the edge,
//! the same seam every other handler relies on.

use std::{
    collections::HashMap,
    pin::Pin,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use cosmos_crypto::secure_asset::{CONTACT_DATA, open_secure_asset, seal_secure_asset};
use cosmos_protocol::common::encryption::{EncryptedData, EncryptionInformation};
use cosmos_protocol::common::push::PushMessage;
use cosmos_protocol::contacts as pb;
use pb::contacts_rpc_service_server::ContactsRpcService;
use pb::get_contacts_streaming_request::Syncoption;
use pb::get_contacts_streaming_response::Response as StreamingItem;
use prost::Message as _;
use sha2::{Digest as _, Sha256};
use tokio_stream::Stream;
use tonic::{Request, Response, Status};

use crate::{
    auth::{AuthenticationPlane, RequestAuthenticator},
    keydirectory::{KeyDirectoryError, SharedKeyDirectory},
    store::{ContactSnapshot, SharedStore, SyncTime},
};

/// The push domain stock `CentralPushReceiver` routes to `ContactsPushManager`.
pub(crate) const CONTACTS_PUSH_DOMAIN: &str = "humane.contacts";

/// The payload `ContactsPushManager.handlePush` acts on: `sync == true`
/// schedules `ContactsManager.scheduleContactsDeltaSync`.
const CONTACTS_PUSH_PAYLOAD: &[u8] = br#"{"sync":true}"#;

/// How long a sync nudge stays deliverable. It only shortens the wait for the
/// Pin's own wake sync, so a day covers a Pin that is off overnight.
const CONTACTS_PUSH_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub struct Contacts {
    authenticator: RequestAuthenticator,
    store: SharedStore,
    /// Keys the device escrowed via `ImportKeys`, published by whichever
    /// workload served it. `None` means no sealed contact can be opened: Pin
    /// creates fail and legacy sealed rows are relayed.
    keys: Option<SharedKeyDirectory>,
}

/// A sealed contact opened with the key its envelope names.
struct Unsealed {
    contact: pb::Contact,
    kid: String,
    key: [u8; cosmos_crypto::AES_KEY_LEN],
}

/// Why a sealed contact stayed sealed. Logged by class only: the kid
/// identifies the wearer.
#[derive(Clone, Copy, Debug)]
enum Unreadable {
    NoDirectory,
    NoKey,
    Envelope,
    NotAContact,
}

impl Unreadable {
    fn describe(self) -> &'static str {
        match self {
            Self::NoDirectory => "no key directory is configured",
            Self::NoKey => "no escrowed key for this contact",
            Self::Envelope => "the envelope did not open as a contacts secure asset",
            Self::NotAContact => "the opened payload is not a humane.contacts.Contact",
        }
    }
}

enum Opened {
    Contact(Box<Unsealed>),
    Sealed(Unreadable),
}

impl Contacts {
    pub fn new(authenticator: RequestAuthenticator, store: SharedStore) -> Self {
        Self {
            authenticator,
            store,
            keys: None,
        }
    }

    /// Let this workload open the contacts the device seals, with the keys the
    /// device escrowed.
    pub fn with_key_directory(mut self, keys: SharedKeyDirectory) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Open one sealed contact. `Err` is a key-directory fault (retryable);
    /// `Ok(Opened::Sealed)` is a contact this deployment cannot read.
    async fn unseal(&self, sealed: &EncryptedData) -> Result<Opened, Status> {
        let Some(directory) = &self.keys else {
            return Ok(Opened::Sealed(Unreadable::NoDirectory));
        };
        let kid = kid_of(sealed);
        let key = match directory.get(kid).await {
            Ok(Some(key)) => key,
            Ok(None) | Err(KeyDirectoryError::InvalidKid) => {
                return Ok(Opened::Sealed(Unreadable::NoKey));
            }
            Err(error) => return Err(crate::keydirectory::grpc_status(&error)),
        };
        let Ok(plaintext) = open_secure_asset(&key, kid, &sealed.data, CONTACT_DATA) else {
            return Ok(Opened::Sealed(Unreadable::Envelope));
        };
        match pb::Contact::decode(plaintext.as_slice()) {
            Ok(contact) => Ok(Opened::Contact(Box::new(Unsealed {
                contact,
                kid: kid.to_owned(),
                key,
            }))),
            Err(_) => Ok(Opened::Sealed(Unreadable::NotAContact)),
        }
    }

    /// Open every sealed item of a write, all or nothing: a Pin must never be
    /// told a contact was saved that this deployment could not read.
    async fn unseal_all(&self, sealed: &[EncryptedData]) -> Result<Vec<Unsealed>, Status> {
        let mut opened = Vec::with_capacity(sealed.len());
        for envelope in sealed {
            match self.unseal(envelope).await? {
                Opened::Contact(unsealed) => opened.push(*unsealed),
                Opened::Sealed(reason) => {
                    tracing::warn!(
                        reason = reason.describe(),
                        "contacts: refusing a sealed contact this deployment cannot open"
                    );
                    return Err(Status::failed_precondition(
                        "a sealed contact could not be opened with an escrowed contacts key",
                    ));
                }
            }
        }
        Ok(opened)
    }

    /// The principal's book with every legacy sealed row it can open turned
    /// into its canonical plaintext record. Rows it cannot open stay in
    /// `encrypted` and are relayed sealed.
    async fn snapshot(&self, principal: &str) -> Result<ContactSnapshot, Status> {
        let mut snapshot = self.store.contacts(principal).await?;
        if snapshot.encrypted.is_empty() {
            return Ok(snapshot);
        }

        let mut opened = Vec::new();
        let mut unreadable = 0_usize;
        for record in &snapshot.encrypted {
            let id = sealed_contact_id(kid_of(&record.data));
            if has_record(&snapshot, &id) {
                continue;
            }
            match self.unseal(&record.data).await? {
                Opened::Contact(unsealed) => opened.push(pb::Contact {
                    id,
                    ..unsealed.contact
                }),
                Opened::Sealed(_) => unreadable += 1,
            }
        }
        if !opened.is_empty() {
            self.store
                .put_contacts(
                    principal,
                    &pb::ContactList {
                        contacts: opened,
                        ..pb::ContactList::default()
                    },
                )
                .await?;
            snapshot = self.store.contacts(principal).await?;
        }
        if unreadable > 0 {
            tracing::warn!(
                unreadable,
                "contacts: relaying sealed contacts whose key this deployment never received"
            );
        }

        // A row whose contact now lives as a record, or was deleted as one,
        // is not relayed again: the record, or its tombstone, speaks for it.
        // Nor is it kept: it is a second copy of that contact, and a contact the
        // wearer deleted must not stay stored sealed after the delete.
        let encrypted = std::mem::take(&mut snapshot.encrypted);
        let (retired, relayed): (Vec<_>, Vec<_>) = encrypted
            .into_iter()
            .partition(|record| has_record(&snapshot, &sealed_contact_id(kid_of(&record.data))));
        if !retired.is_empty() {
            let sealed: Vec<EncryptedData> =
                retired.into_iter().map(|record| record.data).collect();
            self.store
                .delete_encrypted_contacts(principal, &sealed)
                .await?;
        }
        snapshot.encrypted = relayed;
        Ok(snapshot)
    }

    /// Persist a `ContactList`: the plaintext arm as written, the sealed arm
    /// opened and keyed by its key id. Returns the canonical plaintext records
    /// and the canonical sealed ones re-sealed for the device, both in request
    /// order.
    async fn put(
        &self,
        principal: &str,
        list: pb::ContactList,
    ) -> Result<(Vec<pb::Contact>, Vec<(pb::Contact, Unsealed)>), Status> {
        let sealed = self.unseal_all(&list.encrypted_contacts).await?;
        let plain = list.contacts.len();
        let mut contacts = list.contacts;
        contacts.extend(sealed.iter().map(|unsealed| pb::Contact {
            id: sealed_contact_id(&unsealed.kid),
            ..unsealed.contact.clone()
        }));
        let mut written: Vec<pb::Contact> = self
            .store
            .put_contacts(
                principal,
                &pb::ContactList {
                    contacts,
                    ..pb::ContactList::default()
                },
            )
            .await?
            .into_iter()
            .map(|record| record.contact)
            .collect();
        let sealed_written = written.split_off(plain);
        Ok((written, sealed_written.into_iter().zip(sealed).collect()))
    }

    /// Queue the stock `humane.contacts` sync push after a web-plane change.
    async fn nudge_pin(&self, plane: AuthenticationPlane, principal: &str) {
        if plane != AuthenticationPlane::Web {
            return;
        }
        let expiry = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .saturating_add(CONTACTS_PUSH_LIFETIME);
        let message = PushMessage {
            app_name: CONTACTS_PUSH_DOMAIN.to_owned(),
            // Fresh per push: the Pin drops a message id it has already seen
            // (`PushMessageDispatcher.dispatchMessage`).
            message_id: uuid::Uuid::new_v4().to_string(),
            expiration_timestamp: Some(prost_types::Timestamp {
                seconds: i64::try_from(expiry.as_secs()).unwrap_or(i64::MAX),
                nanos: i32::try_from(expiry.subsec_nanos()).unwrap_or_default(),
            }),
            data_payload: CONTACTS_PUSH_PAYLOAD.to_vec(),
            notification_payload: None,
        };
        if let Err(status) =
            crate::services::pushrelay::enqueue(&self.store, principal, message).await
        {
            tracing::warn!(
                code = ?status.code(),
                "contacts: change saved, but the Pin sync push could not be queued; \
                 the Pin picks it up on its next wake sync"
            );
        }
    }
}

fn kid_of(sealed: &EncryptedData) -> &str {
    sealed
        .encryption_information
        .as_ref()
        .map(|information| information.kid.as_str())
        .unwrap_or_default()
}

/// The server id of a contact the Pin sealed, derived from the key id its
/// envelope names. Stock mints one key per sealed contact, so the kid names
/// the contact. See the module docs.
fn sealed_contact_id(kid: &str) -> String {
    let digest = Sha256::new()
        .chain_update(b"humane.contacts.Contact\0")
        .chain_update(kid.as_bytes())
        .finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_custom_bytes(bytes)
        .into_uuid()
        .to_string()
}

/// Whether `id` is a live record or a tombstone in `snapshot`.
fn has_record(snapshot: &ContactSnapshot, id: &str) -> bool {
    snapshot.find(id).is_some() || snapshot.deletions.iter().any(|deletion| deletion.id == id)
}

/// Seal a canonical record for the device under the key it arrived under.
fn reseal(contact: &pb::Contact, unsealed: &Unsealed) -> Result<EncryptedData, Status> {
    let data = seal_secure_asset(
        &unsealed.key,
        &unsealed.kid,
        &contact.encode_to_vec(),
        CONTACT_DATA,
    )
    .map_err(|_| Status::internal("the saved contact could not be re-sealed for the device"))?;
    Ok(EncryptedData {
        data,
        encryption_information: Some(EncryptionInformation {
            kid: unsealed.kid.clone(),
        }),
    })
}

#[tonic::async_trait]
impl ContactsRpcService for Contacts {
    type GetContactsPaginatedStreamingStream =
        Pin<Box<dyn Stream<Item = Result<pb::GetContactsStreamingPageResponse, Status>> + Send>>;
    type GetContactsStreamingStream =
        Pin<Box<dyn Stream<Item = Result<pb::GetContactsStreamingResponse, Status>> + Send>>;

    async fn create_contacts(
        &self,
        request: Request<pb::ContactList>,
    ) -> Result<Response<pb::ContactList>, Status> {
        let caller = self.authenticator.authenticate_with_plane(&request)?;
        let principal = caller.principal.expose_for_authorization();
        let (contacts, sealed) = self.put(principal, request.into_inner()).await?;

        // The canonical persisted form. The device reads only the sealed half,
        // decrypts each item and keys its local row on the id inside, so each
        // one goes back re-sealed with its id and version set.
        let encrypted_contacts = sealed
            .iter()
            .map(|(contact, unsealed)| reseal(contact, unsealed))
            .collect::<Result<Vec<_>, _>>()?;
        let encrypted_contacts_versions =
            sealed.iter().map(|(contact, _)| contact.version).collect();
        self.nudge_pin(caller.plane, principal).await;
        Ok(Response::new(pb::ContactList {
            contacts,
            encrypted_contacts,
            encrypted_contacts_versions,
        }))
    }

    async fn delete_contacts(
        &self,
        request: Request<pb::DeleteContactRequest>,
    ) -> Result<Response<()>, Status> {
        let caller = self.authenticator.authenticate_with_plane(&request)?;
        let principal = caller.principal.expose_for_authorization();
        let ids = request.into_inner().ids;
        self.store.delete_contacts(principal, &ids).await?;
        self.nudge_pin(caller.plane, principal).await;
        Ok(Response::new(()))
    }

    async fn get_contact_deltas(
        &self,
        request: Request<pb::GetContactDeltasRequest>,
    ) -> Result<Response<pb::GetContactDeltasResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let snapshot = self.snapshot(principal.expose_for_authorization()).await?;
        let request = request.into_inner();
        let since = request.last_synced_time.as_ref().map(SyncTime::from_proto);

        // `contact_requests` is the client stating what it already holds, so a
        // version mismatch means its copy is stale even if the contact predates
        // the cursor. The two conditions are a union, not an override.
        let held_by_client: HashMap<&str, i32> = request
            .contact_requests
            .iter()
            .map(|held| (held.id.as_str(), held.version))
            .collect();
        let contacts = snapshot
            .contacts
            .iter()
            .filter(|record| {
                since.is_none_or(|cursor| record.modified > cursor)
                    || held_by_client
                        .get(record.contact.id.as_str())
                        .is_some_and(|version| *version != record.contact.version)
            })
            .map(|record| record.contact.clone())
            .collect();

        let mut deleted_contact_ids: Vec<String> = match since {
            Some(cursor) => snapshot
                .deletions_since(cursor)
                .map(|deletion| deletion.id.clone())
                .collect(),
            // A full sync reconciles nothing, so it carries no tombstones.
            None => Vec::new(),
        };
        // Any id the client says it holds that the store no longer has is gone,
        // whether or not a tombstone survives for it.
        for held in &request.contact_requests {
            if !held.id.is_empty()
                && snapshot.find(&held.id).is_none()
                && !deleted_contact_ids.contains(&held.id)
            {
                deleted_contact_ids.push(held.id.clone());
            }
        }

        let encrypted: Vec<_> = snapshot.encrypted_since(since).collect();
        Ok(Response::new(pb::GetContactDeltasResponse {
            contacts,
            deleted_contact_ids,
            encrypted_contacts: encrypted.iter().map(|record| record.data.clone()).collect(),
            encrypted_contacts_versions: encrypted.iter().map(|record| record.version).collect(),
            latest_sync_time: snapshot.latest.map(SyncTime::to_proto),
        }))
    }

    async fn get_contacts(
        &self,
        request: Request<pb::GetContactsRequest>,
    ) -> Result<Response<pb::ContactList>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let snapshot = self.snapshot(principal.expose_for_authorization()).await?;
        let search_term = request.into_inner().search_term;

        let mut contacts: Vec<pb::Contact> = snapshot
            .matching(&search_term)
            .map(|record| record.contact.clone())
            .collect();
        contacts.sort_by_cached_key(|contact| {
            (display_label(contact).to_lowercase(), contact.id.clone())
        });
        // A sealed contact cannot be matched against a plaintext term here, so a
        // search returns plaintext results only rather than guessing.
        let (encrypted_contacts, encrypted_contacts_versions) = if search_term.trim().is_empty() {
            (
                snapshot
                    .encrypted
                    .iter()
                    .map(|record| record.data.clone())
                    .collect(),
                snapshot
                    .encrypted
                    .iter()
                    .map(|record| record.version)
                    .collect(),
            )
        } else {
            (Vec::new(), Vec::new())
        };

        Ok(Response::new(pb::ContactList {
            contacts,
            encrypted_contacts,
            encrypted_contacts_versions,
        }))
    }

    async fn get_contacts_paginated_streaming(
        &self,
        request: Request<pb::GetContactsStreamingPageRequest>,
    ) -> Result<Response<Self::GetContactsPaginatedStreamingStream>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        // Every contact this deployment can open is already plaintext here, so
        // `server_should_decrypt` needs no further pass: what remains sealed is
        // unreadable and is relayed for the device to skip.
        let snapshot = self.snapshot(principal.expose_for_authorization()).await?;
        let request = request.into_inner();
        let items = streaming_items(&snapshot, cursor_of(request.streaming_request.as_ref()));

        // `chunks` rejects a zero width, and a non-positive `page_size` has no
        // meaningful reading other than "do not paginate".
        let page_size = if request.page_size > 0 {
            request.page_size as usize
        } else {
            items.len().max(1)
        };
        let total_pages = items.len().div_ceil(page_size) as i32;
        let pages: Vec<_> = items
            .chunks(page_size)
            .enumerate()
            .map(|(index, page)| {
                Ok(pb::GetContactsStreamingPageResponse {
                    page_content: page.to_vec(),
                    page_num: index as i32,
                    total_pages,
                })
            })
            .collect();

        // An empty book yields no chunks, hence zero messages and a clean close.
        Ok(Response::new(Box::pin(tokio_stream::iter(pages))))
    }

    async fn get_contacts_streaming(
        &self,
        request: Request<pb::GetContactsStreamingRequest>,
    ) -> Result<Response<Self::GetContactsStreamingStream>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let snapshot = self.snapshot(principal.expose_for_authorization()).await?;
        let request = request.into_inner();
        let items: Vec<_> = streaming_items(&snapshot, cursor_of(Some(&request)))
            .into_iter()
            .map(Ok)
            .collect();

        Ok(Response::new(Box::pin(tokio_stream::iter(items))))
    }

    async fn update_contacts(
        &self,
        request: Request<pb::ContactList>,
    ) -> Result<Response<()>, Status> {
        let caller = self.authenticator.authenticate_with_plane(&request)?;
        let principal = caller.principal.expose_for_authorization();
        // `UpdateContacts` shares `CreateContacts`' upsert: both contain a whole
        // `ContactList` and the store is what decides new-versus-existing by id.
        // A sealed item that opens resolves to its record through its key id;
        // stock's re-seal under a fresh key does not open (module docs). The `Empty`
        // response leaves no shape in which to report a per-contact outcome, so
        // the ack covers the batch.
        self.put(principal, request.into_inner()).await?;
        self.nudge_pin(caller.plane, principal).await;
        Ok(Response::new(()))
    }
}

/// The name a contact is listed by, and `GetContacts`' order (INFERRED: the
/// stock request leaves the order unspecified. This is the label Center shows,
/// `toContactRecord`): the display name, else the full name
/// ([`crate::store::full_name`]), else the nickname, else the first number or
/// e-mail address. Ties go by id, so the answer is the same on every read.
fn display_label(contact: &pb::Contact) -> String {
    let name = contact.name.as_ref();
    [
        name.map(|name| name.display_name.trim().to_owned()),
        name.map(crate::store::full_name),
        name.map(|name| name.nickname.trim().to_owned()),
        contact
            .phone_numbers
            .first()
            .map(|phone| phone.value.trim().to_owned()),
        contact
            .telephone_numbers
            .first()
            .map(|number| number.trim().to_owned()),
        contact
            .emails
            .first()
            .map(|email| email.value.trim().to_owned()),
    ]
    .into_iter()
    .flatten()
    .find(|label| !label.is_empty())
    .unwrap_or_default()
}

/// Resolve `GetContactsStreamingRequest.syncoption` to a cursor: `Some` for a
/// delta read, `None` for a full read. See the module docs for why `full_sync`
/// and an unset oneof both mean "full".
fn cursor_of(request: Option<&pb::GetContactsStreamingRequest>) -> Option<SyncTime> {
    match request.and_then(|request| request.syncoption.as_ref()) {
        Some(Syncoption::LastSyncedTime(timestamp)) => Some(SyncTime::from_proto(timestamp)),
        Some(Syncoption::FullSync(_)) | None => None,
    }
}

/// Flatten a snapshot into the streaming item sequence for `since`, shared by
/// both server-streaming reads so paging cannot drift from the unpaged read.
fn streaming_items(
    snapshot: &ContactSnapshot,
    since: Option<SyncTime>,
) -> Vec<pb::GetContactsStreamingResponse> {
    let contacts = snapshot.contacts_since(since).map(|record| {
        (
            record.modified,
            StreamingItem::Contact(record.contact.clone()),
        )
    });
    let encrypted = snapshot.encrypted_since(since).map(|record| {
        (
            record.modified,
            StreamingItem::EncryptedContact(record.data.clone()),
        )
    });

    let mut items: Vec<_> = contacts
        .chain(encrypted)
        .map(|(modified, item)| pb::GetContactsStreamingResponse {
            modified_time: Some(modified.to_proto()),
            response: Some(item),
        })
        .collect();

    // Tombstones only make sense against a client that already holds state.
    if let Some(cursor) = since {
        items.extend(snapshot.deletions_since(cursor).map(|deletion| {
            pb::GetContactsStreamingResponse {
                modified_time: Some(deletion.deleted.to_proto()),
                response: Some(StreamingItem::DeletedContactId(deletion.id.clone())),
            }
        }));
    }
    items
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap as EnvMap;

    use tokio_stream::StreamExt;

    use super::*;
    use crate::{
        config::{Authentication, Config},
        keydirectory::KeyDirectory,
        store::MemoryStore,
    };

    /// An edge-authenticated service: the principal comes from request metadata,
    /// so two different callers really are two different principals. The
    /// development-insecure mode uses one synthetic principal for everyone and
    /// therefore could not prove isolation.
    fn service() -> (Contacts, String) {
        let values = EnvMap::from([(
            "COSMOS_AUTH_MODE".to_owned(),
            "edge-authenticated".to_owned(),
        )]);
        let config = Config::from_map(&values).expect("edge-authenticated test config");
        let metadata_key = match &config.auth {
            Authentication::EdgeAuthenticated(edge) => edge.principal_metadata_key().to_owned(),
            Authentication::DevelopmentInsecure => unreachable!("configured edge-authenticated"),
        };
        let authenticator = RequestAuthenticator::new(config.auth);
        (
            // A FRESH store per service, never the process singleton.
            // `MemoryStore::shared()` is a real `OnceLock` singleton (correct in
            // production, the device establishes a channel key exactly once), so
            // handing it to a test bleeds state into every other test running in
            // parallel: rows one test writes are counted by another's assertion.
            Contacts::new(authenticator, std::sync::Arc::new(MemoryStore::default())),
            metadata_key,
        )
    }

    /// The same edge-authenticated service, but over a store whose every
    /// statement fails. Any handler that reaches storage reports the STORE's
    /// error, so an assertion on the edge error proves storage was not reached.
    fn service_over_a_dead_store() -> Contacts {
        let values = EnvMap::from([(
            "COSMOS_AUTH_MODE".to_owned(),
            "edge-authenticated".to_owned(),
        )]);
        let config = Config::from_map(&values).expect("edge-authenticated test config");
        Contacts::new(
            RequestAuthenticator::new(config.auth),
            std::sync::Arc::new(crate::store_postgres::PostgresStore::unreachable()),
        )
    }

    /// Build a request attributed to `principal` via the edge metadata header.
    fn as_principal<T>(key: &str, principal: &str, message: T) -> Request<T> {
        let mut request = Request::new(message);
        request.metadata_mut().insert(
            tonic::metadata::MetadataKey::from_bytes(key.as_bytes()).expect("valid metadata key"),
            principal.parse().expect("ASCII principal"),
        );
        request
    }

    fn named(display_name: &str) -> pb::Contact {
        pb::Contact {
            name: Some(pb::Name {
                display_name: display_name.to_owned(),
                ..pb::Name::default()
            }),
            ..pb::Contact::default()
        }
    }

    fn list(contacts: Vec<pb::Contact>) -> pb::ContactList {
        pb::ContactList {
            contacts,
            ..pb::ContactList::default()
        }
    }

    /// Fail closed, and fail closed FIRST.
    ///
    /// The store here fails on every statement, so if `get_contacts` read
    /// storage before authenticating, the refusal we observe would contain the
    /// store's message. Asserting the edge's own message is what makes the
    /// "before any storage access" half of this test's name true rather than
    /// merely asserted in the title.
    ///
    /// The code is UNAVAILABLE, not UNAUTHENTICATED: an edge-auth failure is a
    /// transport/topology failure and must not borrow an account verdict code
    /// the stock client narrates as "invalid subscription"
    /// (`RemoteInterpreter.java:91-96`). See the `From<EdgeAuthenticationError>`
    /// impl in `config.rs` and its test.
    #[tokio::test]
    async fn unauthenticated_callers_are_refused_before_any_storage_access() {
        let svc = service_over_a_dead_store();
        let status = svc
            .get_contacts(Request::new(pb::GetContactsRequest::default()))
            .await
            .expect_err("a request with no edge principal must fail closed");
        assert_eq!(status.code(), tonic::Code::Unavailable);
        assert_eq!(
            status.message(),
            crate::config::EdgeAuthenticationError::Missing.to_string(),
            "the refusal must come from the edge check, not from the store — \
             a store message here means storage was touched before authenticating"
        );
    }

    /// The edge-authenticated service over a store and key directory the test
    /// keeps, so it can seed legacy rows and escrowed keys and read the push
    /// queue.
    fn service_with(store: SharedStore, keys: SharedKeyDirectory) -> (Contacts, String) {
        let (svc, key) = service();
        (Contacts { store, ..svc }.with_key_directory(keys), key)
    }

    fn fresh_keys() -> SharedKeyDirectory {
        std::sync::Arc::new(KeyDirectory::in_memory())
    }

    /// Seal `contact` exactly as ironman's `ContactsProtectionManager.
    /// encryptNewContact` does: `KrAsset.of(10, 1, empty, contact bytes)` under
    /// the per-contact C1 key, with `EncryptionInformation.kid` naming it.
    fn sealed_by_pin(kid: &str, kek: &[u8; 16], contact: &pb::Contact) -> EncryptedData {
        EncryptedData {
            data: seal_secure_asset(kek, kid, &contact.encode_to_vec(), CONTACT_DATA)
                .expect("seal fixture"),
            encryption_information: Some(EncryptionInformation {
                kid: kid.to_owned(),
            }),
        }
    }

    /// What the Pin does with a `CreateContacts` reply item: reveal it by the
    /// key its envelope header names (`decryptContact` passes only the data
    /// bytes). Opening under `kid` proves the header names exactly that key.
    fn reveal(kid: &str, kek: &[u8; 16], sealed: &EncryptedData) -> pb::Contact {
        assert_eq!(
            kid_of(sealed),
            kid,
            "the reply names the key it was sent under"
        );
        let plaintext = open_secure_asset(kek, kid, &sealed.data, CONTACT_DATA)
            .expect("the Pin reveals the reply with the key it minted");
        pb::Contact::decode(plaintext.as_slice()).expect("the reply is a Contact")
    }

    /// `CreateContactActionHandler`: first and last name, one number, trusted,
    /// and no id, the device never sets one.
    fn voice_contact(first: &str, last: &str, number: &str) -> pb::Contact {
        pb::Contact {
            name: Some(pb::Name {
                first_name: first.to_owned(),
                last_name: last.to_owned(),
                ..pb::Name::default()
            }),
            phone_numbers: vec![pb::PhoneNumber {
                value: number.to_owned(),
                r#type: String::new(),
            }],
            trusted: true,
            ..pb::Contact::default()
        }
    }

    async fn read_all(svc: &Contacts, key: &str, principal: &str) -> pb::ContactList {
        svc.get_contacts(as_principal(
            key,
            principal,
            pb::GetContactsRequest::default(),
        ))
        .await
        .expect("get_contacts succeeds")
        .into_inner()
    }

    async fn paginated(
        svc: &Contacts,
        key: &str,
        principal: &str,
        syncoption: Option<Syncoption>,
    ) -> Result<Vec<pb::GetContactsStreamingResponse>, Status> {
        let pages = svc
            .get_contacts_paginated_streaming(as_principal(
                key,
                principal,
                pb::GetContactsStreamingPageRequest {
                    // Exactly the stock request: ContactsService.java:63-71.
                    streaming_request: Some(pb::GetContactsStreamingRequest {
                        server_should_decrypt: true,
                        syncoption,
                    }),
                    page_size: 100,
                },
            ))
            .await?
            .into_inner()
            .collect::<Result<Vec<_>, Status>>()
            .await?;
        Ok(pages
            .into_iter()
            .flat_map(|page| page.page_content)
            .collect())
    }

    #[tokio::test]
    async fn create_contacts_assigns_ids_to_hmsa_sealed_contacts_and_reseals_them() {
        let keys = fresh_keys();
        let (ada_kek, grace_kek) = ([0x11_u8; 16], [0x22_u8; 16]);
        // One key per contact: `CoreDataProtector.protect` mints each.
        keys.put("kid-ada", ada_kek).await.expect("escrow");
        keys.put("kid-grace", grace_kek).await.expect("escrow");
        let (svc, key) = service_with(std::sync::Arc::new(MemoryStore::default()), keys);

        let reply = svc
            .create_contacts(as_principal(
                &key,
                "device-a",
                pb::ContactList {
                    encrypted_contacts: vec![
                        sealed_by_pin(
                            "kid-ada",
                            &ada_kek,
                            &voice_contact("Ada", "Lovelace", "+4511"),
                        ),
                        sealed_by_pin(
                            "kid-grace",
                            &grace_kek,
                            &voice_contact("Grace", "Hopper", "+4522"),
                        ),
                    ],
                    ..pb::ContactList::default()
                },
            ))
            .await
            .expect("an escrowed Pin contact is created")
            .into_inner();

        assert!(
            reply.contacts.is_empty(),
            "the device reads only the sealed half"
        );
        assert_eq!(reply.encrypted_contacts.len(), 2);
        assert_eq!(reply.encrypted_contacts_versions, vec![1, 1]);
        let ada = reveal("kid-ada", &ada_kek, &reply.encrypted_contacts[0]);
        let grace = reveal("kid-grace", &grace_kek, &reply.encrypted_contacts[1]);
        for contact in [&ada, &grace] {
            assert!(
                uuid::Uuid::parse_str(&contact.id).is_ok(),
                "the reply carries a server id; an empty one collapses the Pin's rows into \"\""
            );
            assert_eq!(contact.version, 1);
            assert!(contact.trusted);
        }
        assert_ne!(ada.id, grace.id, "two Pin contacts stay two contacts");
        assert_eq!(
            ada.name.as_ref().map(|n| n.first_name.as_str()),
            Some("Ada")
        );
        assert_eq!(
            grace.name.as_ref().map(|n| n.last_name.as_str()),
            Some("Hopper")
        );

        // Center sees them as ordinary contacts, under the ids the Pin saved.
        let book = read_all(&svc, &key, "device-a").await;
        assert!(book.encrypted_contacts.is_empty(), "nothing is left sealed");
        let mut ids: Vec<_> = book.contacts.iter().map(|c| c.id.clone()).collect();
        ids.sort();
        let mut expected = vec![ada.id.clone(), grace.id.clone()];
        expected.sort();
        assert_eq!(ids, expected);
    }

    /// Without the key, the Pin is told the create failed ("There was an error
    /// creating the contact") and nothing is stored, never an echo it would
    /// save under an empty id.
    #[tokio::test]
    async fn create_contacts_without_key_fails_instead_of_echoing() {
        let kek = [0x44_u8; 16];
        let request = || pb::ContactList {
            encrypted_contacts: vec![sealed_by_pin(
                "kid-never-escrowed",
                &kek,
                &voice_contact("Ada", "", "+4511"),
            )],
            ..pb::ContactList::default()
        };

        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        let (svc, key) = service_with(store.clone(), fresh_keys());
        let refused = svc
            .create_contacts(as_principal(&key, "device-a", request()))
            .await
            .expect_err("an unopenable Pin contact is not acknowledged");
        assert_eq!(refused.code(), tonic::Code::FailedPrecondition);
        let book = read_all(&svc, &key, "device-a").await;
        assert!(book.contacts.is_empty() && book.encrypted_contacts.is_empty());

        // A workload with no key directory at all refuses the same way.
        let (bare, key) = service();
        let refused = bare
            .create_contacts(as_principal(&key, "device-a", request()))
            .await
            .expect_err("no directory, no sealed create");
        assert_eq!(refused.code(), tonic::Code::FailedPrecondition);
    }

    /// A sealed row stored by an earlier build becomes an ordinary contact
    /// with its key-derived id the first time it is read, exactly once.
    #[tokio::test]
    async fn legacy_sealed_row_is_canonicalized_with_an_id_on_read() {
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        let keys = fresh_keys();
        let kek = [0x66_u8; 16];
        keys.put("kid-legacy", kek).await.expect("escrow");
        // Stored opaquely, the way the previous CreateContacts kept it.
        store
            .put_contacts(
                "device-a",
                &pb::ContactList {
                    encrypted_contacts: vec![sealed_by_pin(
                        "kid-legacy",
                        &kek,
                        &voice_contact("Ada", "Lovelace", "+4511"),
                    )],
                    encrypted_contacts_versions: vec![0],
                    ..pb::ContactList::default()
                },
            )
            .await
            .expect("legacy row");
        let (svc, key) = service_with(store.clone(), keys);

        let restored = paginated(&svc, &key, "device-a", None)
            .await
            .expect("a full sync succeeds");
        assert_eq!(
            restored.len(),
            1,
            "the legacy row is one contact, not a contact and a blob"
        );
        assert!(
            store
                .contacts("device-a")
                .await
                .expect("store read")
                .encrypted
                .is_empty(),
            "once the record speaks for the contact, its sealed copy is gone"
        );
        let Some(StreamingItem::Contact(contact)) = &restored[0].response else {
            panic!("an openable legacy row reaches the Pin as plaintext");
        };
        assert_eq!(contact.id, sealed_contact_id("kid-legacy"));
        assert_eq!(
            contact.name.as_ref().map(|n| n.first_name.as_str()),
            Some("Ada")
        );

        // Canonicalized once: the next read neither re-writes nor duplicates it.
        let book = read_all(&svc, &key, "device-a").await;
        assert_eq!(book.contacts.len(), 1);
        assert_eq!(book.contacts[0].version, 1);
        assert!(book.encrypted_contacts.is_empty());

        // Deleting it is final: the legacy blob is not canonicalized again.
        let cursor = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest::default(),
            ))
            .await
            .expect("cursor")
            .into_inner()
            .latest_sync_time;
        svc.delete_contacts(as_principal(
            &key,
            "device-a",
            pb::DeleteContactRequest {
                ids: vec![contact.id.clone()],
            },
        ))
        .await
        .expect("delete");
        let book = read_all(&svc, &key, "device-a").await;
        assert!(book.contacts.is_empty() && book.encrypted_contacts.is_empty());
        let delta = paginated(
            &svc,
            &key,
            "device-a",
            cursor.map(Syncoption::LastSyncedTime),
        )
        .await
        .expect("delta");
        assert!(matches!(
            delta.as_slice(),
            [pb::GetContactsStreamingResponse { response: Some(StreamingItem::DeletedContactId(id)), .. }] if *id == contact.id
        ));
    }

    /// `DeleteContactRequest` names ids, and a relayed sealed contact has none
    /// the server can read, so deleting a plaintext contact leaves it alone.
    #[tokio::test]
    async fn deleting_a_plaintext_contact_leaves_unreadable_sealed_contacts_untouched() {
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        let orphan = sealed_by_pin(
            "kid-enrolled-elsewhere",
            &[0x77; 16],
            &voice_contact("Grace", "", "+4522"),
        );
        store
            .put_contacts(
                "device-a",
                &pb::ContactList {
                    encrypted_contacts: vec![orphan.clone()],
                    encrypted_contacts_versions: vec![0],
                    ..pb::ContactList::default()
                },
            )
            .await
            .expect("seed");
        let (svc, key) = service_with(store, fresh_keys());
        let created = svc
            .create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("create")
            .into_inner();

        svc.delete_contacts(as_principal(
            &key,
            "device-a",
            pb::DeleteContactRequest {
                ids: vec![created.contacts[0].id.clone()],
            },
        ))
        .await
        .expect("delete");

        let book = read_all(&svc, &key, "device-a").await;
        assert!(
            book.contacts.is_empty(),
            "the named plaintext contact is gone"
        );
        assert_eq!(book.encrypted_contacts, vec![orphan]);
    }

    /// Stock `encryptExistingContact(contact, keyId)` protects under a FRESH
    /// key (`CoreDataProtector.protect(identity, userId, …)` → `generateKey`)
    /// yet labels the envelope with the original `keyId`. The header then names
    /// a different key than `EncryptionInformation.kid`. This deployment
    /// refuses that shape and leaves the stored contact untouched.
    #[tokio::test]
    async fn a_stock_reseal_under_a_fresh_key_is_refused_and_writes_nothing() {
        let keys = fresh_keys();
        let (original, fresh) = ([0x99_u8; 16], [0xaa_u8; 16]);
        keys.put("kid-ada", original).await.expect("escrow");
        keys.put("kid-fresh", fresh).await.expect("escrow");
        let (svc, key) = service_with(std::sync::Arc::new(MemoryStore::default()), keys);
        svc.create_contacts(as_principal(
            &key,
            "device-a",
            pb::ContactList {
                encrypted_contacts: vec![sealed_by_pin(
                    "kid-ada",
                    &original,
                    &voice_contact("Ada", "", "+4511"),
                )],
                ..pb::ContactList::default()
            },
        ))
        .await
        .expect("create");

        let mut edited = voice_contact("Ada", "", "+4511");
        edited.name.as_mut().expect("name").nickname = "Addie".to_owned();
        let mut stock_update = sealed_by_pin("kid-fresh", &fresh, &edited);
        stock_update.encryption_information = Some(EncryptionInformation {
            kid: "kid-ada".to_owned(),
        });
        let refused = svc
            .update_contacts(as_principal(
                &key,
                "device-a",
                pb::ContactList {
                    encrypted_contacts: vec![stock_update],
                    ..pb::ContactList::default()
                },
            ))
            .await
            .expect_err("a header naming another key is not opened");
        assert_eq!(refused.code(), tonic::Code::FailedPrecondition);

        let book = read_all(&svc, &key, "device-a").await;
        assert_eq!(book.contacts.len(), 1);
        assert_eq!(book.contacts[0].version, 1, "nothing was written");
        assert!(book.encrypted_contacts.is_empty(), "no opaque blob is kept");
    }

    #[tokio::test]
    async fn one_principal_never_reads_anothers_contacts() {
        let (svc, key) = service();
        svc.create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("device-a writes");
        let b = svc
            .create_contacts(as_principal(&key, "device-b", list(vec![named("Grace")])))
            .await
            .expect("device-b writes")
            .into_inner();

        let a_view = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("device-a reads")
            .into_inner();
        assert_eq!(a_view.contacts.len(), 1);
        assert_eq!(
            a_view.contacts[0].name.as_ref().expect("name").display_name,
            "Ada",
            "device-a must not see device-b's contact"
        );

        // Nor can one principal delete another's row by naming its id.
        let b_id = b.contacts[0].id.clone();
        svc.delete_contacts(as_principal(
            &key,
            "device-a",
            pb::DeleteContactRequest {
                ids: vec![b_id.clone()],
            },
        ))
        .await
        .expect("delete succeeds vacuously");
        let b_view = svc
            .get_contacts(as_principal(
                &key,
                "device-b",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("device-b reads")
            .into_inner();
        assert_eq!(b_view.contacts.len(), 1, "device-b's contact is untouched");
        assert_eq!(b_view.contacts[0].id, b_id);
    }
}
