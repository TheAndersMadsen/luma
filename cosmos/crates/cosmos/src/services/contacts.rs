//! `humane.contacts.ContactsRPCService` — the device's contact-book sync surface.
//!
//! This is the first *stateful* handler in the deployment. A contacts service
//! that acknowledges a write and then reads back nothing is a data loss a real
//! Pin notices immediately, so every RPC here is backed by the principal-keyed
//! [`Store`](crate::store::Store): writes persist under the caller's
//! authenticated principal and reads return exactly — and only — what that
//! principal wrote. A principal that has never synced still gets the honest
//! empty result a compatible Cosmos service represents when it holds nothing:
//!   * read / list / delta RPCs return an empty-but-typed response,
//!   * the two server-streaming reads return an immediately-closed (grpc-status
//!     OK) stream with zero messages,
//!   * the write / delete RPCs acknowledge with their success shape
//!     (`google.protobuf.Empty` maps to `()` under prost).
//!
//! No contacts, ids, or versions are ever fabricated. Server-assigned ids are
//! fresh UUIDv4s; `version` and the sync cursors are server-owned.
//!
//! Every RPC resolves the caller through [`RequestAuthenticator`] and fails
//! closed, because the principal is now the storage key: without it there is no
//! book to read and no book to write. That is deliberately redundant with the
//! router's front-door `AuthLayer` — a handler that only reads an
//! already-resolved principal is correct exactly as long as the wiring is, and
//! this one decides which principal's contacts it hands back.
//!
//! # Sync semantics and what they are derived from
//!
//! The contacts family was observed to complete `OK`, but its semantics remain
//! unknown — "cursor/time semantics,
//! full-vs-delta transition, ordering, tombstones, pagination boundaries, stream
//! termination, retry/resume rules, and consistency guarantees". What follows is
//! therefore the simplest reading the `humane/contacts.proto` wire contract
//! admits, not recovered behaviour. The reading, with the ambiguity called out:
//!
//! * **Full vs delta.** `GetContactsStreamingRequest.syncoption` is a oneof of
//!   `last_synced_time` and `full_sync`. A `last_synced_time` is a delta read;
//!   `full_sync` — and an *unset* oneof, which a client with no cursor produces
//!   — is a full read. `full_sync = false` is ambiguous (it asserts "not full"
//!   while supplying no cursor); it is treated as a full read, because the only
//!   alternative is to invent a cursor.
//! * **Cursor comparison is strict.** A client that echoes the
//!   `latest_sync_time` it was handed receives nothing twice.
//! * **Tombstones ride the delta path only.** A full read has no prior client
//!   state to reconcile, so it carries no `deleted_contact_id`s.
//! * **`latest_sync_time` is the store's high-water mark**, not "now". A
//!   principal holding nothing gets no sync point rather than a fabricated one.
//! * **Ordering is unknown.** Items are emitted grouped — contacts, then
//!   encrypted contacts, then deletions — each in stable write order.
//! * **Pagination boundaries are unknown.** `page_num` is 0-based, `total_pages`
//!   counts the chunks actually emitted, and a non-positive `page_size` means
//!   one page. Zero items means zero messages, so an empty book stays an
//!   immediately-closed OK stream.
//! * **`server_should_decrypt` is honoured for keys this deployment holds.** The
//!   device's only delta-sync call is `GetContactsPaginatedStreaming` with
//!   `server_should_decrypt = true`, and `handleDeltaSyncResponse` *discards* any
//!   item that still `hasEncryptedContact()` — it saves only the plaintext
//!   `getContact()` case. A sealed item is therefore not a degraded result but a
//!   lost contact: a factory-reset device that full-syncs would drop every one
//!   and finish with an empty address book.
//!
//!   Contacts are sealed under the krypton `IDataProtector` user-data key
//!   (`DataProtectionIdentity.ofUser`), which the device **escrows to the
//!   server** — `KryptoDataProtector.generateKey`
//!   (`humaneinternal/system/dataprotection/KryptoDataProtector.java:46-80`)
//!   mints the C1 key, calls `keyManager.updateKey(...)`, and then deletes the
//!   key and fails the whole operation unless `keyInfo.isUploaded()`. A device
//!   will not protect data under a key the server does not have. That escrow is
//!   `PublicPrivacyService.ImportKeys`, and it is what made
//!   `server_should_decrypt` a coherent request for real cosmos.
//!
//!   `ImportKeys` is served by the AI-bus workload, so the imported key reaches
//!   this one through [`crate::keydirectory`] rather than a process-local store.
//!   Given the key, a sealed contact is opened and returned in the plaintext form
//!   the device actually saves. Without it — a device that enrolled elsewhere,
//!   whose keys went to whoever it enrolled with — the blob is relayed
//!   byte-for-byte: unreadable, but never dropped and never invented.
//! * **A sealed contact carries its own identity, and it arrives empty — which no
//!   server can repair.** The device seals a `humane.contacts.Contact` whose `id`
//!   it never sets (`ContactAdapters.convertToContactProtobuf`,
//!   ContactAdapters.java:36-61), and on the `CreateContacts` reply it *decrypts*
//!   the echoed blob and keys its local row on the recovered payload's id —
//!   `new ContactEntity(contact.getId(), …)` in
//!   `ContactAdapters.protobufToEntities` (ContactAdapters.java:63-69), reached
//!   from `ContactsManager.parseEncryptedContacts` (ContactsManager.java:386-395).
//!   That row lands in `contact (… PRIMARY KEY(id))`
//!   (ContactsDatabase_Impl.java:46), so on a stock Pin every sealed contact
//!   persists under `""` and overwrites the last. The server has no seam to fix
//!   this from: `EncryptedData` is exactly `{encryption_information, data}` (and
//!   `encryption_information.kid` is a krypton *key* id — `ContactsProtectionManager`
//!   sets it from `protectedData.getKeyId()`, ContactsProtectionManager.java:52-64),
//!   `ContactList` is exactly `{contacts, encrypted_contacts,
//!   encrypted_contacts_versions}`, and `ContactsManager$3.onNext`
//!   (ContactsManager.java:286-296) reads *only* `getEncryptedContactsList()` — a
//!   plaintext contact minted alongside would be dropped unread. Real cosmos
//!   evidently resolved this by decrypting server-side (hence
//!   `server_should_decrypt`) and re-issuing the contact with a server id on the
//!   plaintext delta-sync path, the only case `handleDeltaSyncResponse` saves
//!   (ContactsManager.java:230-247). Holding no user-data key we can do neither,
//!   so the blob is relayed byte-for-byte and no identity is invented.
//!
//!   The two fields that look like they could contain an identity alongside the
//!   blob cannot:
//!
//!   * **`kid` is user-scoped, not per-contact.** Both seal paths derive it from
//!     `DataProtectionIdentity.ofUser(userId)` — `encryptNewContact` takes it
//!     from `protectedData.getKeyId()` and `encryptExistingContact` echoes the
//!     key id it was handed (ContactsProtectionManager.java:52-84). Every
//!     contact a wearer owns is sealed under the *same* kid, so keying storage
//!     on it would collapse the whole address book into one row. That is the
//!     failure mode `two_contacts_sealed_under_one_key_stay_two_contacts` pins.
//!   * **`encrypted_contacts_versions` is `repeated int32`, and nothing reads
//!     it.** Stock's `ContactList` message info is
//!     `…\u{1}\u{1b}\u{2}\u{1b}\u{3}'` (ContactList.java:529) — field 3 is type
//!     0x27, `INT32_LIST_PACKED`. It cannot hold a minted string id, and no
//!     stock call site reads `getEncryptedContactsVersionsList()` on any
//!     response, so a value put there would never reach the device's database.
//!
//!   What this *does* bound is the blast radius of keying sealed contacts on
//!   their ciphertext bytes. A stock Pin never re-seals and never deletes:
//!   `ContactsManager.updateContact` (ContactsManager.java:352-375) — the only
//!   caller of `encryptExistingContact` — has no caller itself, and
//!   `ContactsService.deleteContact` (ContactsService.java:40-43) is likewise
//!   unreferenced. The one repeat a Pin does produce is a retried
//!   `CreateContacts`, which resends the identical serialized blob and so
//!   dedupes correctly. Byte identity is therefore not a good identity, but it
//!   is the only one the wire offers, and it is right for every case the stock
//!   client actually exercises.
//!
//! Transport auth (the mTLS DeviceUser principal) is still enforced at the edge,
//! the same seam every other handler relies on.

use std::{collections::HashMap, pin::Pin};

use cosmos_protocol::contacts as pb;
use pb::contacts_rpc_service_server::ContactsRpcService;
use pb::get_contacts_streaming_request::Syncoption;
use pb::get_contacts_streaming_response::Response as StreamingItem;
use tokio_stream::Stream;
use tonic::{Request, Response, Status};

use crate::{
    auth::RequestAuthenticator,
    store::{ContactSnapshot, SharedStore, SyncTime},
};

#[derive(Clone)]
pub struct Contacts {
    authenticator: RequestAuthenticator,
    store: SharedStore,
    /// Keys published by whichever workload served `ImportKeys`. `None` — or a
    /// directory holding no key for a given kid — means sealed contacts are
    /// relayed as-is, which is the pre-existing behaviour.
    keys: Option<crate::keydirectory::SharedKeyDirectory>,
}

impl Contacts {
    pub fn new(authenticator: RequestAuthenticator, store: SharedStore) -> Self {
        Self {
            authenticator,
            store,
            keys: None,
        }
    }

    /// Let this workload honour `server_should_decrypt` for contacts whose key
    /// the device escrowed.
    pub fn with_key_directory(mut self, keys: crate::keydirectory::SharedKeyDirectory) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Open what we can of a page's sealed contacts, rewriting each opened item
    /// into the plaintext form.
    ///
    /// This is what `server_should_decrypt = true` asks for, and honouring it is
    /// the difference between a restored address book and an empty one: the
    /// device's `handleDeltaSyncResponse` saves only the plaintext case and
    /// DISCARDS anything still `hasEncryptedContact()`. Contacts we hold no key
    /// for stay sealed rather than being dropped — relaying is honest, deleting
    /// the wearer's data is not.
    async fn decrypt_page(&self, items: &mut [pb::GetContactsStreamingResponse]) {
        let Some(directory) = &self.keys else {
            return;
        };
        for item in items.iter_mut() {
            let Some(StreamingItem::EncryptedContact(sealed)) = &item.response else {
                continue;
            };
            let envelope = cosmos_crypto::EncryptedData {
                data: sealed.data.clone(),
                kid: sealed
                    .encryption_information
                    .as_ref()
                    .map(|info| info.kid.clone())
                    .unwrap_or_default(),
            };
            let Some(plaintext) = directory.open(&envelope).await else {
                continue;
            };
            match <pb::Contact as prost::Message>::decode(plaintext.as_slice()) {
                Ok(contact) => item.response = Some(StreamingItem::Contact(contact)),
                Err(error) => {
                    // Opened but not parseable: the key was right and the payload
                    // is not a Contact. Relay it sealed rather than dropping it.
                    tracing::warn!(%error, "contacts: opened a sealed contact that is not a Contact");
                }
            }
        }
    }
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
        let principal = self.authenticator.authenticate(&request)?;
        let list = request.into_inner();
        let written = self
            .store
            .put_contacts(principal.expose_for_authorization(), &list)
            .await?;

        // The response is the canonical persisted form: plaintext contacts as
        // the store stamped them, and the encrypted blobs echoed back exactly as
        // sent — they are stored opaquely and contain no server-owned fields.
        //
        // The verbatim echo is forced, not lazy: a sealed contact's id lives
        // inside the ciphertext the device decrypts on this very response
        // (ContactsManager.java:286-296 → ContactAdapters.java:63-69), and no
        // field beside the blob carries one. See the module docs.
        Ok(Response::new(pb::ContactList {
            contacts: written.into_iter().map(|record| record.contact).collect(),
            encrypted_contacts: list.encrypted_contacts,
            encrypted_contacts_versions: list.encrypted_contacts_versions,
        }))
    }

    async fn delete_contacts(
        &self,
        request: Request<pb::DeleteContactRequest>,
    ) -> Result<Response<()>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let ids = request.into_inner().ids;
        self.store
            .delete_contacts(principal.expose_for_authorization(), &ids)
            .await?;
        Ok(Response::new(()))
    }

    async fn get_contact_deltas(
        &self,
        request: Request<pb::GetContactDeltasRequest>,
    ) -> Result<Response<pb::GetContactDeltasResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let snapshot = self
            .store
            .contacts(principal.expose_for_authorization())
            .await?;
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
        let snapshot = self
            .store
            .contacts(principal.expose_for_authorization())
            .await?;
        let search_term = request.into_inner().search_term;

        let contacts = snapshot
            .matching(&search_term)
            .map(|record| record.contact.clone())
            .collect();
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
        let snapshot = self
            .store
            .contacts(principal.expose_for_authorization())
            .await?;
        let request = request.into_inner();
        let mut items = streaming_items(&snapshot, cursor_of(request.streaming_request.as_ref()));

        // Honour `server_should_decrypt` for whatever we hold the key to. The
        // device DISCARDS items that arrive still encrypted, so anything left
        // sealed here is a contact the wearer will not get back — but relaying it
        // is still better than dropping it, and inventing one is worse than both.
        if request
            .streaming_request
            .as_ref()
            .is_some_and(|streaming| streaming.server_should_decrypt)
        {
            self.decrypt_page(&mut items).await;
        }
        let items = items;

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
        let snapshot = self
            .store
            .contacts(principal.expose_for_authorization())
            .await?;
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
        let principal = self.authenticator.authenticate(&request)?;
        let list = request.into_inner();
        // `UpdateContacts` shares `CreateContacts`' upsert: both contain a whole
        // `ContactList` and the store is what decides new-versus-existing by id.
        // The `Empty` response leaves no shape in which to report a per-contact
        // outcome, so the ack covers the batch.
        self.store
            .put_contacts(principal.expose_for_authorization(), &list)
            .await?;
        Ok(Response::new(()))
    }
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

    use cosmos_protocol::common::encryption::{EncryptedData, EncryptionInformation};

    use super::*;
    use crate::{
        config::{Authentication, Config},
        store::MemoryStore,
    };

    /// An edge-authenticated service: the principal comes from request metadata,
    /// so two different callers really are two different principals. The
    /// development-insecure mode uses one synthetic principal for everyone and
    /// therefore could not prove isolation.
    /// The restore path, end to end: a contact the device sealed comes back as
    /// PLAINTEXT once the key it was sealed under has been escrowed.
    ///
    /// This is the property that decides whether a factory-reset Pin gets its
    /// address book back. `handleDeltaSyncResponse` saves only the plaintext case
    /// and discards anything still `hasEncryptedContact()`, so a sealed item is
    /// not a degraded result — it is a lost contact.
    #[tokio::test]
    async fn a_sealed_contact_comes_back_plaintext_once_its_key_is_escrowed() {
        use prost::Message as _;

        let (svc, key) = service();
        let directory = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let channel_key = [42u8; cosmos_crypto::AES_KEY_LEN];
        let kid = "kid-contacts-1";
        // The device escrowed this key via ImportKeys, in another workload.
        directory.put(kid, channel_key).await;
        let svc = svc.with_key_directory(directory);

        // A contact sealed exactly as the device seals one.
        let contact = pb::Contact {
            name: Some(pb::Name {
                first_name: "Ada".to_owned(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let sealed = cosmos_crypto::seal(
            kid,
            &channel_key,
            &contact.encode_to_vec(),
            b"humane.contacts.Contact",
        )
        .expect("seal");

        svc.create_contacts(as_principal(
            &key,
            "device-a",
            pb::ContactList {
                encrypted_contacts: vec![EncryptedData {
                    data: sealed.data.clone(),
                    encryption_information: Some(EncryptionInformation {
                        kid: sealed.kid.clone(),
                    }),
                }],
                encrypted_contacts_versions: vec![1],
                ..Default::default()
            },
        ))
        .await
        .expect("write");

        let page = svc
            .get_contacts_paginated_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingPageRequest {
                    streaming_request: Some(pb::GetContactsStreamingRequest {
                        server_should_decrypt: true,
                        syncoption: None,
                    }),
                    page_size: 0,
                },
            ))
            .await
            .expect("paginated read")
            .into_inner();

        let mut page = page;
        let first = tokio_stream::StreamExt::next(&mut page)
            .await
            .expect("a page")
            .expect("page is ok");
        let recovered: Vec<_> = first
            .page_content
            .into_iter()
            .filter_map(|item| match item.response {
                Some(StreamingItem::Contact(contact)) => Some(contact),
                _ => None,
            })
            .collect();

        assert_eq!(
            recovered.len(),
            1,
            "the sealed contact must be returned as plaintext; still-sealed means the \
             device discards it and the wearer loses the contact"
        );
        assert_eq!(
            recovered[0].name.as_ref().map(|n| n.first_name.as_str()),
            Some("Ada")
        );
    }

    /// Without the key, the contact is RELAYED, never dropped and never invented.
    #[tokio::test]
    async fn a_contact_we_hold_no_key_for_stays_sealed_rather_than_vanishing() {
        use prost::Message as _;

        let (svc, key) = service();
        // A directory that was never given this kid — a device enrolled elsewhere.
        let directory = std::sync::Arc::new(crate::keydirectory::KeyDirectory::in_memory());
        let svc = svc.with_key_directory(directory);

        let sealed = cosmos_crypto::seal(
            "kid-we-never-got",
            &[1u8; cosmos_crypto::AES_KEY_LEN],
            &pb::Contact::default().encode_to_vec(),
            b"humane.contacts.Contact",
        )
        .expect("seal");

        svc.create_contacts(as_principal(
            &key,
            "device-a",
            pb::ContactList {
                encrypted_contacts: vec![EncryptedData {
                    data: sealed.data.clone(),
                    encryption_information: Some(EncryptionInformation {
                        kid: sealed.kid.clone(),
                    }),
                }],
                encrypted_contacts_versions: vec![1],
                ..Default::default()
            },
        ))
        .await
        .expect("write");

        let mut page = svc
            .get_contacts_paginated_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingPageRequest {
                    streaming_request: Some(pb::GetContactsStreamingRequest {
                        server_should_decrypt: true,
                        syncoption: None,
                    }),
                    page_size: 0,
                },
            ))
            .await
            .expect("paginated read")
            .into_inner();

        let first = tokio_stream::StreamExt::next(&mut page)
            .await
            .expect("a page")
            .expect("page is ok");
        assert!(
            first
                .page_content
                .iter()
                .any(|item| matches!(item.response, Some(StreamingItem::EncryptedContact(_)))),
            "an unreadable contact must be relayed sealed, not dropped"
        );
    }

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
            // production — the device establishes a channel key exactly once), so
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

    #[tokio::test]
    async fn reads_return_well_formed_empty() {
        let (svc, key) = service();

        // Representative read: GetContacts returns an empty, well-formed list.
        let list = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest {
                    search_term: String::new(),
                },
            ))
            .await
            .expect("get_contacts succeeds")
            .into_inner();
        assert!(list.contacts.is_empty(), "no plaintext contacts");
        assert!(list.encrypted_contacts.is_empty(), "no encrypted contacts");

        // A delta sync with nothing stored is also an empty success.
        let deltas = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest::default(),
            ))
            .await
            .expect("get_contact_deltas succeeds")
            .into_inner();
        assert!(deltas.contacts.is_empty());
        assert!(deltas.deleted_contact_ids.is_empty());
        assert!(
            deltas.latest_sync_time.is_none(),
            "no sync point is invented for a principal that never wrote"
        );

        // The streaming read yields zero messages and closes cleanly.
        let mut stream = svc
            .get_contacts_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingRequest::default(),
            ))
            .await
            .expect("get_contacts_streaming succeeds")
            .into_inner();
        assert!(
            stream.next().await.is_none(),
            "empty stream closes with no items"
        );

        // So does the paginated one, rather than emitting an empty page.
        let mut pages = svc
            .get_contacts_paginated_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingPageRequest {
                    streaming_request: None,
                    page_size: 10,
                },
            ))
            .await
            .expect("get_contacts_paginated_streaming succeeds")
            .into_inner();
        assert!(pages.next().await.is_none());
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

    #[tokio::test]
    async fn created_contacts_read_back_with_server_assigned_uuids() {
        let (svc, key) = service();
        let created = svc
            .create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("create_contacts succeeds")
            .into_inner();

        assert_eq!(created.contacts.len(), 1);
        let id = created.contacts[0].id.clone();
        assert!(
            uuid::Uuid::parse_str(&id).is_ok(),
            "server-assigned ids are UUIDs"
        );
        assert_eq!(created.contacts[0].version, 1);

        let read_back = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("get_contacts succeeds")
            .into_inner();
        assert_eq!(read_back.contacts.len(), 1);
        assert_eq!(read_back.contacts[0].id, id, "the write survived the read");
    }

    /// A sealed contact is relayed, never rewritten or supplemented.
    ///
    /// The device decrypts what this RPC returns and keys its local row on the
    /// id it finds *inside* the ciphertext (ContactAdapters.java:63-69), and it
    /// reads only `getEncryptedContactsList()` off the reply
    /// (ContactsManager.java:286-296). So minting an id or a companion plaintext
    /// contact here would be invisible at best and fabricated data at worst.
    /// This pins the relay: byte-identical, same order, same count, nothing
    /// added.
    #[tokio::test]
    async fn create_contacts_relays_sealed_blobs_untouched() {
        let (svc, key) = service();
        let sealed = |data: &[u8], kid: &str| EncryptedData {
            encryption_information: Some(EncryptionInformation {
                kid: kid.to_owned(),
            }),
            data: data.to_vec(),
        };
        let request = pb::ContactList {
            contacts: Vec::new(),
            encrypted_contacts: vec![
                sealed(b"sealed-ada", "kid-1"),
                sealed(b"sealed-grace", "kid-2"),
            ],
            encrypted_contacts_versions: vec![7, 9],
        };

        let echoed = svc
            .create_contacts(as_principal(&key, "device-a", request.clone()))
            .await
            .expect("create_contacts succeeds")
            .into_inner();

        assert_eq!(
            echoed.encrypted_contacts, request.encrypted_contacts,
            "sealed contacts come back byte-for-byte and in order"
        );
        assert_eq!(
            echoed.encrypted_contacts_versions, request.encrypted_contacts_versions,
            "the parallel version list stays aligned with the blobs"
        );
        assert!(
            echoed.contacts.is_empty(),
            "no plaintext contact is invented for a blob the server cannot read"
        );

        // And the read path relays the same bytes rather than dropping the half
        // it cannot interpret.
        let read_back = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("get_contacts succeeds")
            .into_inner();
        assert_eq!(read_back.encrypted_contacts, request.encrypted_contacts);
        assert!(read_back.contacts.is_empty());
    }

    /// `kid` is NOT a contact identity, and treating it as one loses the book.
    ///
    /// Sealed contacts are keyed on their ciphertext bytes, which is a poor
    /// identity — the obvious repair is to reach for the one other field on
    /// `EncryptedData`. That field is user-scoped: both seal paths build it from
    /// `DataProtectionIdentity.ofUser(userId)`
    /// (ContactsProtectionManager.java:52-84), so every contact one wearer owns
    /// arrives under the same kid. Keying on it would merge an entire address
    /// book into a single row. This drives `CreateContacts` with two distinct
    /// blobs sharing a kid and reads them back, so the merge is observable
    /// rather than merely acknowledged.
    #[tokio::test]
    async fn two_contacts_sealed_under_one_key_stay_two_contacts() {
        let (svc, key) = service();
        // One user key, two contacts — exactly what a stock Pin produces.
        let shared_kid = "krypton-user-key-1";
        let sealed = |data: &[u8]| EncryptedData {
            encryption_information: Some(EncryptionInformation {
                kid: shared_kid.to_owned(),
            }),
            data: data.to_vec(),
        };
        let request = pb::ContactList {
            contacts: Vec::new(),
            encrypted_contacts: vec![sealed(b"sealed-ada"), sealed(b"sealed-grace")],
            encrypted_contacts_versions: vec![1, 1],
        };

        svc.create_contacts(as_principal(&key, "device-a", request.clone()))
            .await
            .expect("create_contacts succeeds");

        let read_back = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("get_contacts succeeds")
            .into_inner();
        assert_eq!(
            read_back.encrypted_contacts, request.encrypted_contacts,
            "two contacts sealed under one user key are two contacts — collapsing \
             them on the shared kid would delete the wearer's address book"
        );
    }

    /// Deleting a plaintext contact must not take sealed contacts with it.
    ///
    /// `DeleteContactRequest` carries ids only, and a sealed contact has none
    /// the server can read, so the honest outcome is that a delete leaves the
    /// sealed half alone. The tempting alternative — "we cannot tell which blob
    /// this id names, so drop them" — silently destroys wearer data, and the
    /// stock client never even issues the call (`ContactsService.deleteContact`,
    /// ContactsService.java:40-43, has no caller in ironman). Asserting the blob
    /// reads back byte-for-byte afterwards is what makes this falsifiable; an
    /// `Ok` from the delete proves nothing.
    #[tokio::test]
    async fn deleting_a_plaintext_contact_leaves_sealed_contacts_untouched() {
        let (svc, key) = service();
        let blob = EncryptedData {
            encryption_information: Some(EncryptionInformation {
                kid: "krypton-user-key-1".to_owned(),
            }),
            data: b"sealed-grace".to_vec(),
        };
        let created = svc
            .create_contacts(as_principal(
                &key,
                "device-a",
                pb::ContactList {
                    contacts: vec![named("Ada")],
                    encrypted_contacts: vec![blob.clone()],
                    encrypted_contacts_versions: vec![1],
                },
            ))
            .await
            .expect("create_contacts succeeds")
            .into_inner();

        svc.delete_contacts(as_principal(
            &key,
            "device-a",
            pb::DeleteContactRequest {
                ids: vec![created.contacts[0].id.clone()],
            },
        ))
        .await
        .expect("delete succeeds");

        let read_back = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("get_contacts succeeds")
            .into_inner();
        assert!(
            read_back.contacts.is_empty(),
            "the named plaintext contact is gone"
        );
        assert_eq!(
            read_back.encrypted_contacts,
            vec![blob],
            "a delete the server cannot resolve against a sealed blob must leave \
             that blob intact, not guess"
        );
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

    #[tokio::test]
    async fn update_contacts_bumps_the_server_version_in_place() {
        let (svc, key) = service();
        let created = svc
            .create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("create")
            .into_inner();
        let id = created.contacts[0].id.clone();

        svc.update_contacts(as_principal(
            &key,
            "device-a",
            list(vec![pb::Contact {
                id: id.clone(),
                ..named("Ada Lovelace")
            }]),
        ))
        .await
        .expect("update succeeds");

        let read_back = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("read")
            .into_inner();
        assert_eq!(read_back.contacts.len(), 1, "an update is not an append");
        assert_eq!(read_back.contacts[0].version, 2);
        assert_eq!(
            read_back.contacts[0]
                .name
                .as_ref()
                .expect("name")
                .display_name,
            "Ada Lovelace"
        );
    }

    #[tokio::test]
    async fn search_term_filters_the_principals_own_contacts() {
        let (svc, key) = service();
        svc.create_contacts(as_principal(
            &key,
            "device-a",
            list(vec![named("Ada Lovelace"), named("Grace Hopper")]),
        ))
        .await
        .expect("create");

        let hits = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest {
                    search_term: "HOPPER".to_owned(),
                },
            ))
            .await
            .expect("search")
            .into_inner();
        assert_eq!(hits.contacts.len(), 1);
        assert_eq!(
            hits.contacts[0].name.as_ref().expect("name").display_name,
            "Grace Hopper"
        );
    }

    #[tokio::test]
    async fn delta_sync_returns_only_changes_after_the_clients_cursor() {
        let (svc, key) = service();
        svc.create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("first write");

        // Full sync: no cursor supplied, so everything comes back with a cursor
        // the client can continue.
        let full = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest::default(),
            ))
            .await
            .expect("full sync")
            .into_inner();
        assert_eq!(full.contacts.len(), 1);
        let cursor = full.latest_sync_time.expect("a write establishes a cursor");

        // Replaying the same cursor yields nothing — the comparison is strict.
        let quiet = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest {
                    contact_requests: Vec::new(),
                    last_synced_time: Some(cursor),
                },
            ))
            .await
            .expect("delta sync")
            .into_inner();
        assert!(
            quiet.contacts.is_empty(),
            "nothing changed since the cursor"
        );
        assert!(quiet.deleted_contact_ids.is_empty());

        svc.create_contacts(as_principal(&key, "device-a", list(vec![named("Grace")])))
            .await
            .expect("second write");
        let delta = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest {
                    contact_requests: Vec::new(),
                    last_synced_time: Some(cursor),
                },
            ))
            .await
            .expect("delta sync")
            .into_inner();
        assert_eq!(delta.contacts.len(), 1, "only the newer write is delivered");
        assert_eq!(
            delta.contacts[0].name.as_ref().expect("name").display_name,
            "Grace"
        );
    }

    #[tokio::test]
    async fn delta_sync_reports_deletions_as_tombstones() {
        let (svc, key) = service();
        let created = svc
            .create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("create")
            .into_inner();
        let id = created.contacts[0].id.clone();
        let cursor = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest::default(),
            ))
            .await
            .expect("full sync")
            .into_inner()
            .latest_sync_time
            .expect("cursor");

        svc.delete_contacts(as_principal(
            &key,
            "device-a",
            pb::DeleteContactRequest {
                ids: vec![id.clone()],
            },
        ))
        .await
        .expect("delete");

        let delta = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest {
                    // The client also states what it still holds; a contact the
                    // server no longer has is gone either way.
                    contact_requests: vec![pb::ContactDeltasRequest {
                        id: id.clone(),
                        version: 1,
                    }],
                    last_synced_time: Some(cursor),
                },
            ))
            .await
            .expect("delta sync")
            .into_inner();
        assert_eq!(delta.deleted_contact_ids, vec![id.clone()]);
        assert!(delta.contacts.is_empty());

        // And the deleted contact is gone from a plain read.
        let read_back = svc
            .get_contacts(as_principal(
                &key,
                "device-a",
                pb::GetContactsRequest::default(),
            ))
            .await
            .expect("read")
            .into_inner();
        assert!(read_back.contacts.is_empty());
    }

    #[tokio::test]
    async fn a_stale_client_version_pulls_the_contact_even_before_the_cursor() {
        let (svc, key) = service();
        let created = svc
            .create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("create")
            .into_inner();
        let id = created.contacts[0].id.clone();
        let cursor = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest::default(),
            ))
            .await
            .expect("full sync")
            .into_inner()
            .latest_sync_time
            .expect("cursor");

        let delta = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest {
                    contact_requests: vec![pb::ContactDeltasRequest {
                        id: id.clone(),
                        version: 0,
                    }],
                    last_synced_time: Some(cursor),
                },
            ))
            .await
            .expect("delta sync")
            .into_inner();
        assert_eq!(
            delta.contacts.len(),
            1,
            "the client holds version 0 but the server has version 1"
        );
        assert_eq!(delta.contacts[0].id, id);
        assert!(delta.deleted_contact_ids.is_empty(), "it still exists");
    }

    #[tokio::test]
    async fn streaming_full_sync_emits_every_contact_and_no_tombstones() {
        let (svc, key) = service();
        let created = svc
            .create_contacts(as_principal(
                &key,
                "device-a",
                list(vec![named("Ada"), named("Grace")]),
            ))
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

        let stream = svc
            .get_contacts_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingRequest {
                    server_should_decrypt: false,
                    syncoption: Some(Syncoption::FullSync(true)),
                },
            ))
            .await
            .expect("streaming read")
            .into_inner();
        let items: Vec<_> = stream
            .collect::<Result<Vec<_>, Status>>()
            .await
            .expect("stream completes OK");

        assert_eq!(items.len(), 1, "only the surviving contact");
        assert!(matches!(items[0].response, Some(StreamingItem::Contact(_))));
        assert!(
            items[0].modified_time.is_some(),
            "each item carries its modification time"
        );
    }

    #[tokio::test]
    async fn streaming_delta_sync_emits_the_tombstone() {
        let (svc, key) = service();
        let created = svc
            .create_contacts(as_principal(&key, "device-a", list(vec![named("Ada")])))
            .await
            .expect("create")
            .into_inner();
        let cursor = svc
            .get_contact_deltas(as_principal(
                &key,
                "device-a",
                pb::GetContactDeltasRequest::default(),
            ))
            .await
            .expect("full sync")
            .into_inner()
            .latest_sync_time
            .expect("cursor");
        svc.delete_contacts(as_principal(
            &key,
            "device-a",
            pb::DeleteContactRequest {
                ids: vec![created.contacts[0].id.clone()],
            },
        ))
        .await
        .expect("delete");

        let stream = svc
            .get_contacts_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingRequest {
                    server_should_decrypt: false,
                    syncoption: Some(Syncoption::LastSyncedTime(cursor)),
                },
            ))
            .await
            .expect("streaming read")
            .into_inner();
        let items: Vec<_> = stream
            .collect::<Result<Vec<_>, Status>>()
            .await
            .expect("stream completes OK");

        assert_eq!(items.len(), 1);
        match &items[0].response {
            Some(StreamingItem::DeletedContactId(id)) => {
                assert_eq!(*id, created.contacts[0].id);
            }
            _ => panic!("a delta sync past a deletion must emit its tombstone"),
        }
    }

    #[tokio::test]
    async fn paginated_streaming_chunks_the_same_items() {
        let (svc, key) = service();
        svc.create_contacts(as_principal(
            &key,
            "device-a",
            list(vec![named("Ada"), named("Grace"), named("Katherine")]),
        ))
        .await
        .expect("create");

        let stream = svc
            .get_contacts_paginated_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingPageRequest {
                    streaming_request: None,
                    page_size: 2,
                },
            ))
            .await
            .expect("paginated read")
            .into_inner();
        let pages: Vec<_> = stream
            .collect::<Result<Vec<_>, Status>>()
            .await
            .expect("stream completes OK");

        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].page_num, 0, "page numbering is 0-based");
        assert_eq!(pages[0].total_pages, 2);
        assert_eq!(pages[0].page_content.len(), 2);
        assert_eq!(pages[1].page_num, 1);
        assert_eq!(pages[1].page_content.len(), 1);
    }

    #[tokio::test]
    async fn non_positive_page_size_yields_a_single_page() {
        let (svc, key) = service();
        svc.create_contacts(as_principal(
            &key,
            "device-a",
            list(vec![named("Ada"), named("Grace")]),
        ))
        .await
        .expect("create");

        let stream = svc
            .get_contacts_paginated_streaming(as_principal(
                &key,
                "device-a",
                pb::GetContactsStreamingPageRequest {
                    streaming_request: None,
                    page_size: 0,
                },
            ))
            .await
            .expect("paginated read")
            .into_inner();
        let pages: Vec<_> = stream
            .collect::<Result<Vec<_>, Status>>()
            .await
            .expect("stream completes OK");

        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].total_pages, 1);
        assert_eq!(pages[0].page_content.len(), 2);
    }
}
