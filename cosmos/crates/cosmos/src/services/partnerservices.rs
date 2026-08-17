//! `humane.partnerservices.PartnerTokenRPCService` — encrypted, linked-provider
//! token delivery.
//!
//! The stock contract has no write RPC. `observed`: provider linking happens in
//! an account plane and the Pin only reads the result. This clone therefore uses
//! an admin-gated HTTP ingestion surface and stores only the proto's opaque
//! `short_lived_encrypted_access_token` arm. It never accepts a raw OAuth token,
//! decrypts the envelope, or fabricates provider credentials.

use cosmos_protocol::partnerservices as pb;
use pb::partner_token_rpc_service_server::PartnerTokenRpcService;
use prost::Message;
use tonic::{Request, Response, Status};

use crate::store::{AccountBlobKind, MemoryStore, SharedStore};

#[derive(Clone, PartialEq, Message)]
struct StoredProviderToken {
    #[prost(string, tag = "1")]
    provider_name: String,
    #[prost(message, optional, tag = "2")]
    response: Option<pb::DeviceUserAccessTokenResponse>,
}

#[derive(Clone, PartialEq, Message)]
struct StoredProviderTokens {
    #[prost(message, repeated, tag = "1")]
    entries: Vec<StoredProviderToken>,
}

const TOKEN_CAS_RETRIES: usize = 32;

#[derive(Clone)]
pub struct PartnerToken {
    store: SharedStore,
}

impl Default for PartnerToken {
    fn default() -> Self {
        Self {
            store: MemoryStore::shared(),
        }
    }
}

impl PartnerToken {
    pub fn with_store(store: SharedStore) -> Self {
        Self { store }
    }

    async fn stored(&self, principal: &str) -> Result<StoredProviderTokens, Status> {
        let Some(bytes) = self
            .store
            .get_account_blob(principal, AccountBlobKind::PartnerTokens)
            .await?
        else {
            return Ok(StoredProviderTokens::default());
        };
        StoredProviderTokens::decode(bytes.as_slice())
            .map_err(|_| Status::internal("stored partner tokens could not be read"))
    }
}

/// Store one service-scoped encrypted provider token for an account.
///
/// This is clone account-plane ingestion, not a claimed Humane RPC. The caller
/// must already have authorized and encrypted the provider credential for the
/// device-side service; the backend treats it as opaque ciphertext.
pub async fn put_encrypted_token(
    store: &SharedStore,
    principal: &str,
    provider_name: &str,
    token: cosmos_protocol::common::encryption::EncryptedData,
) -> Result<(), Status> {
    let provider_name = provider_name.trim().to_ascii_lowercase();
    if provider_name.is_empty() || provider_name.len() > 128 {
        return Err(Status::invalid_argument(
            "a bounded provider name is required",
        ));
    }
    if token.data.is_empty()
        || token
            .encryption_information
            .as_ref()
            .is_none_or(|information| information.kid.trim().is_empty())
    {
        return Err(Status::invalid_argument(
            "an encrypted token with a key id is required",
        ));
    }
    for _ in 0..TOKEN_CAS_RETRIES {
        let previous = store
            .get_account_blob(principal, AccountBlobKind::PartnerTokens)
            .await?;
        let mut stored = previous
            .as_deref()
            .and_then(|bytes| StoredProviderTokens::decode(bytes).ok())
            .unwrap_or_default();
        let response = pb::DeviceUserAccessTokenResponse {
            accesstoken: Some(
                pb::device_user_access_token_response::Accesstoken::ShortLivedEncryptedAccessToken(
                    token.clone(),
                ),
            ),
        };
        match stored
            .entries
            .iter_mut()
            .find(|entry| entry.provider_name == provider_name)
        {
            Some(entry) => entry.response = Some(response),
            None => stored.entries.push(StoredProviderToken {
                provider_name: provider_name.clone(),
                response: Some(response),
            }),
        }
        stored
            .entries
            .sort_by(|left, right| left.provider_name.cmp(&right.provider_name));
        if store
            .compare_and_swap_account_blob(
                principal,
                AccountBlobKind::PartnerTokens,
                previous.as_deref(),
                &stored.encode_to_vec(),
            )
            .await?
        {
            return Ok(());
        }
    }
    Err(Status::aborted(
        "provider tokens changed concurrently; retry",
    ))
}

/// Remove one linked provider credential from an account.
pub async fn delete_token(
    store: &SharedStore,
    principal: &str,
    provider_name: &str,
) -> Result<bool, Status> {
    let provider_name = provider_name.trim().to_ascii_lowercase();
    if provider_name.is_empty() {
        return Err(Status::invalid_argument("provider_name is required"));
    }
    for _ in 0..TOKEN_CAS_RETRIES {
        let previous = store
            .get_account_blob(principal, AccountBlobKind::PartnerTokens)
            .await?;
        let Some(bytes) = previous.as_deref() else {
            return Ok(false);
        };
        let mut stored = StoredProviderTokens::decode(bytes)
            .map_err(|_| Status::internal("stored partner tokens could not be read"))?;
        let before = stored.entries.len();
        stored
            .entries
            .retain(|entry| entry.provider_name != provider_name);
        if stored.entries.len() == before {
            return Ok(false);
        }
        if store
            .compare_and_swap_account_blob(
                principal,
                AccountBlobKind::PartnerTokens,
                previous.as_deref(),
                &stored.encode_to_vec(),
            )
            .await?
        {
            return Ok(true);
        }
    }
    Err(Status::aborted(
        "provider tokens changed concurrently; retry",
    ))
}

#[tonic::async_trait]
impl PartnerTokenRpcService for PartnerToken {
    async fn get_token(
        &self,
        request: Request<pb::DeviceUserAccessTokenRequest>,
    ) -> Result<Response<pb::DeviceUserAccessTokenResponse>, Status> {
        let principal = crate::auth::principal(&request)
            .ok_or_else(|| Status::unauthenticated("an authenticated principal is required"))?
            .expose_for_authorization();
        let provider = request.get_ref().provider_name.trim().to_ascii_lowercase();
        let stored = self.stored(principal).await?;
        let response = stored
            .entries
            .into_iter()
            .find(|entry| entry.provider_name == provider)
            .and_then(|entry| entry.response)
            .unwrap_or_default();
        Ok(Response::new(response))
    }

    async fn get_tokens(
        &self,
        request: Request<pb::DeviceUserAccessTokenRequest>,
    ) -> Result<Response<pb::MultipleDeviceUserAccessTokenResponse>, Status> {
        let principal = crate::auth::principal(&request)
            .ok_or_else(|| Status::unauthenticated("an authenticated principal is required"))?
            .expose_for_authorization();
        let provider = request.get_ref().provider_name.trim().to_ascii_lowercase();
        let stored = self.stored(principal).await?;
        let tokens = stored
            .entries
            .into_iter()
            .filter(|entry| provider.is_empty() || entry.provider_name == provider)
            .filter_map(|entry| entry.response)
            .collect();
        Ok(Response::new(pb::MultipleDeviceUserAccessTokenResponse {
            tokens,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmos_protocol::common::encryption::{EncryptedData, EncryptionInformation};

    fn as_wearer<T>(mut request: Request<T>, wearer: &str) -> Request<T> {
        request.extensions_mut().insert(
            cosmos_core::AuthenticatedPrincipal::from_edge(format!("U:{wearer}"))
                .expect("valid principal"),
        );
        request
    }

    #[tokio::test]
    async fn encrypted_partner_tokens_persist_and_stay_principal_scoped() {
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        put_encrypted_token(
            &store,
            "U:wearer-a",
            "tidal",
            EncryptedData {
                encryption_information: Some(EncryptionInformation {
                    kid: "kid-a".to_owned(),
                }),
                data: vec![1, 2, 3],
            },
        )
        .await
        .expect("store encrypted token");

        let restarted = PartnerToken::with_store(store);
        let found = restarted
            .get_token(as_wearer(
                Request::new(pb::DeviceUserAccessTokenRequest {
                    provider_name: "TIDAL".to_owned(),
                }),
                "wearer-a",
            ))
            .await
            .expect("read token")
            .into_inner();
        assert!(matches!(
            found.accesstoken,
            Some(
                pb::device_user_access_token_response::Accesstoken::ShortLivedEncryptedAccessToken(
                    _
                )
            )
        ));
        let other = restarted
            .get_token(as_wearer(
                Request::new(pb::DeviceUserAccessTokenRequest {
                    provider_name: "tidal".to_owned(),
                }),
                "wearer-b",
            ))
            .await
            .expect("other account read")
            .into_inner();
        assert!(other.accesstoken.is_none());
    }

    #[tokio::test]
    async fn multiple_provider_tokens_are_filterable_replaceable_and_unlinkable() {
        let store: SharedStore = std::sync::Arc::new(MemoryStore::default());
        let token = |kid: &str, byte: u8| EncryptedData {
            encryption_information: Some(EncryptionInformation {
                kid: kid.to_owned(),
            }),
            data: vec![byte],
        };

        put_encrypted_token(&store, "U:wearer", "tidal", token("tidal-1", 1))
            .await
            .unwrap();
        put_encrypted_token(&store, "U:wearer", "spotify", token("spotify", 2))
            .await
            .unwrap();
        put_encrypted_token(&store, "U:wearer", "TIDAL", token("tidal-2", 3))
            .await
            .unwrap();

        let service = PartnerToken::with_store(store.clone());
        let all = service
            .get_tokens(as_wearer(
                Request::new(pb::DeviceUserAccessTokenRequest::default()),
                "wearer",
            ))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(
            all.tokens.len(),
            2,
            "re-link replaces instead of duplicating"
        );

        let tidal = service
            .get_tokens(as_wearer(
                Request::new(pb::DeviceUserAccessTokenRequest {
                    provider_name: "tidal".to_owned(),
                }),
                "wearer",
            ))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(tidal.tokens.len(), 1);
        match tidal.tokens[0].accesstoken.as_ref().unwrap() {
            pb::device_user_access_token_response::Accesstoken::ShortLivedEncryptedAccessToken(
                encrypted,
            ) => {
                assert_eq!(encrypted.data, [3]);
                assert_eq!(
                    encrypted.encryption_information.as_ref().unwrap().kid,
                    "tidal-2"
                );
            }
            _ => panic!("clone ingestion stores the short-lived encrypted arm"),
        }

        assert!(delete_token(&store, "U:wearer", "TIDAL").await.unwrap());
        assert!(!delete_token(&store, "U:wearer", "tidal").await.unwrap());
        let remaining = service
            .get_tokens(as_wearer(
                Request::new(pb::DeviceUserAccessTokenRequest::default()),
                "wearer",
            ))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(remaining.tokens.len(), 1);
        assert!(
            service
                .get_token(as_wearer(
                    Request::new(pb::DeviceUserAccessTokenRequest {
                        provider_name: "tidal".to_owned(),
                    }),
                    "wearer",
                ))
                .await
                .unwrap()
                .into_inner()
                .accesstoken
                .is_none()
        );
    }
}
