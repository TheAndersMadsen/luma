//! `humane.account.*`, post-enrollment per-user account services.
//!
//! Three services live in the `humane.account` package: food preferences, user
//! information, and stored Wi-Fi configs. A compatible Cosmos service with nothing
//! stored for this device answers every read with a well-formed *empty*
//! response, not an error, so that is exactly what an untouched principal gets
//! here. Nothing in this module needs an LLM, real crypto, or externally-signed
//! state, so no RPC is `UNIMPLEMENTED`.
//!
//! ## What is stored, and why it has to be
//!
//! The set RPCs used to echo the client's own blob straight back and discard it.
//! The device cannot tell the difference: an ack that returns the payload is
//! indistinguishable from a successful write, so
//! `EncryptedSetFoodRestrictions`, the wearer's food restrictions, which
//! include **allergies**, was written, acked, and lost, and the next read
//! returned empty. The assistant then planned meals with no knowledge of them.
//!
//! Both writes now land in [`crate::store::Store`] under the authenticated
//! principal, keyed by [`AccountBlobKind`]:
//!
//! | RPC | kind |
//! | --- | --- |
//! | `EncryptedSetFoodRestrictions` / `EncryptedGetFoodRestrictions` | `FoodRestrictions` |
//! | `SetUserDailyIntakeGoals` / `GetUserDailyIntakeGoals` | `DailyIntakeGoals` |
//! | `GetUserPersonalDetails` | `PersonalDetails` |
//! | `ListSecureWifiConfigs` | `WifiConfigs` |
//!
//! The stored bytes are the prost encoding of the *response* message the read
//! returns, so a read is a decode and nothing is reshaped in between. The
//! encrypted payloads (`EncryptedData`) are opaque service-scoped envelopes (see
//! `humane.common.encryption`) and stay sealed end to end, we never decrypt,
//! re-encrypt, or fabricate an envelope, and no key material is involved.
//!
//! **The last two rows have no device writer, and that is the proto's doing.**
//! `humane.account` (wire interface in
//! `contracts/humane/account.proto`) declares exactly one RPC on
//! `UserInformationService` (`GetUserPersonalDetails`) and exactly one on
//! `WifiConfigService` (`ListSecureWifiConfigs`), there is no
//! `SetUserPersonalDetails` and no Wi-Fi write to serve. The profile was
//! humane.center's to write, and in Luma it still is: the web plane
//! (`account_api`'s `/account-service/profile`) writes the same
//! `PersonalDetails` row this service reads, through [`personal_details`] and
//! [`put_account_info`].
//!
//! The same holds for food preferences: no stock device process calls
//! `FoodPreferencesService` (the food experience tells the wearer to add goals
//! "in dot center"), so `/account-service/food-preferences` is their editor and
//! the helpers below are the one read and write both planes share.
//!
//! Authentication is enforced at the mTLS edge (the DeviceUser client cert /
//! `X-Forwarded-Client-Cert` principal, per RUNTIME-CONTRACTS §2). Each handler
//! *also* resolves the principal through [`RequestAuthenticator`] and fails
//! closed, matching `services::contacts`: the principal is now the storage key,
//! and a handler that decides which wearer's allergies to hand back must not
//! depend on the router wiring alone for that.

use cosmos_protocol::account as pb;
use prost::Message as _;

use pb::food_preferences_service_server::FoodPreferencesService;
use pb::user_information_service_server::UserInformationService;
use pb::wifi_config_service_server::WifiConfigService;
use tonic::{Request, Response, Status};

use crate::{
    auth::RequestAuthenticator,
    store::{AccountBlobKind, SharedStore},
};

/// Read one stored payload back as its response message.
///
/// Absent means the device never set it: the caller's well-formed empty
/// response. A stored blob that will not decode is **not** absence, it is a
/// payload we wrote and can no longer read, so it is reported as an outage
/// rather than served as "the wearer set nothing".
async fn read_blob<M: prost::Message + Default>(
    store: &SharedStore,
    principal: &str,
    kind: AccountBlobKind,
) -> Result<Option<M>, Status> {
    let Some(bytes) = store.get_account_blob(principal, kind).await? else {
        return Ok(None);
    };
    match M::decode(bytes.as_slice()) {
        Ok(message) => Ok(Some(message)),
        Err(_) => Err(undecodable(kind)),
    }
}

fn undecodable(kind: AccountBlobKind) -> Status {
    // The kind is a payload name, not wearer content. The bytes are never
    // logged.
    tracing::error!(
        kind = kind.as_str(),
        "a stored account payload will not decode"
    );
    Status::internal("the stored account payload could not be read")
}

/// How often a read-modify-write re-reads after losing a race.
const UPDATE_ATTEMPTS: usize = 8;

/// Change one stored payload without losing a concurrent write to it.
///
/// `change` gets the stored message (the default when nothing is stored) and
/// returns its replacement. The replacement is written only if the row still
/// holds exactly what was read, and otherwise the whole step runs again.
pub(crate) async fn update_blob<M, F>(
    store: &SharedStore,
    principal: &str,
    kind: AccountBlobKind,
    mut change: F,
) -> Result<M, Status>
where
    M: prost::Message + Default,
    F: FnMut(M) -> M,
{
    for _ in 0..UPDATE_ATTEMPTS {
        let current = store.get_account_blob(principal, kind).await?;
        let stored = match current.as_deref() {
            None => M::default(),
            Some(bytes) => M::decode(bytes).map_err(|_| undecodable(kind))?,
        };
        let next = change(stored);
        if store
            .compare_and_swap_account_blob(
                principal,
                kind,
                current.as_deref(),
                &next.encode_to_vec(),
            )
            .await?
        {
            return Ok(next);
        }
    }
    Err(Status::unavailable(
        "the account payload kept changing underneath this write; retry",
    ))
}

/// The wearer's profile, as `GetUserPersonalDetails` answers it: present but
/// empty `account_info` when nothing is stored, so the device never derefs a
/// null. With nothing stored there is no sealed bio data, and none is invented.
pub(crate) async fn personal_details(
    store: &SharedStore,
    principal: &str,
) -> Result<pb::PersonalDetailsResponse, Status> {
    let mut details = read_blob::<pb::PersonalDetailsResponse>(
        store,
        principal,
        AccountBlobKind::PersonalDetails,
    )
    .await?
    .unwrap_or_default();
    details
        .account_info
        .get_or_insert_with(pb::AccountInfo::default);
    Ok(details)
}

/// Replace the wearer's preferred name and pronunciation, keeping the sealed
/// bio data stored beside them.
///
/// The Pin reads the name once per install, to call itself "<name>’s Ai Pin"
/// over Bluetooth (`AppController` behind its `preferred_name_fetched` latch),
/// so a change reaches the Bluetooth name after the next setup.
pub(crate) async fn put_account_info(
    store: &SharedStore,
    principal: &str,
    info: pb::AccountInfo,
) -> Result<pb::PersonalDetailsResponse, Status> {
    update_blob(
        store,
        principal,
        AccountBlobKind::PersonalDetails,
        |mut details: pb::PersonalDetailsResponse| {
            details.account_info = Some(info.clone());
            details
        },
    )
    .await
}

/// The wearer's sealed food restrictions, exactly as stored.
pub(crate) async fn food_restrictions(
    store: &SharedStore,
    principal: &str,
) -> Result<Vec<cosmos_protocol::common::encryption::EncryptedData>, Status> {
    Ok(read_blob::<pb::EncryptedGetFoodRestrictionsResponse>(
        store,
        principal,
        AccountBlobKind::FoodRestrictions,
    )
    .await?
    .unwrap_or_default()
    .secure_restrictions)
}

/// The wearer's daily intake goals: an empty set when none are stored.
pub(crate) async fn daily_intake_goals(
    store: &SharedStore,
    principal: &str,
) -> Result<pb::DailyIntakeGoals, Status> {
    Ok(read_blob::<pb::GetDailyIntakeGoalsResponse>(
        store,
        principal,
        AccountBlobKind::DailyIntakeGoals,
    )
    .await?
    .and_then(|response| response.goals)
    .unwrap_or_default())
}

/// Replace the wearer's daily intake goals (the stored shape is the
/// `GetDailyIntakeGoalsResponse` the read returns).
pub(crate) async fn put_daily_intake_goals(
    store: &SharedStore,
    principal: &str,
    goals: Option<pb::DailyIntakeGoals>,
) -> Result<(), Status> {
    let payload = pb::GetDailyIntakeGoalsResponse { goals };
    store
        .put_account_blob(
            principal,
            AccountBlobKind::DailyIntakeGoals,
            &payload.encode_to_vec(),
        )
        .await?;
    Ok(())
}

/// `humane.account.FoodPreferencesService`, encrypted food restrictions and
/// daily nutrient-intake goals.
#[derive(Clone)]
pub struct FoodPreferences {
    authenticator: RequestAuthenticator,
    store: SharedStore,
}

impl FoodPreferences {
    pub fn new(authenticator: RequestAuthenticator, store: SharedStore) -> Self {
        Self {
            authenticator,
            store,
        }
    }
}

#[tonic::async_trait]
impl FoodPreferencesService for FoodPreferences {
    async fn encrypted_get_food_restrictions(
        &self,
        request: Request<pb::GetFoodRestrictionsRequest>,
    ) -> Result<Response<pb::EncryptedGetFoodRestrictionsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        // Nothing stored for this device: well-formed empty list, never an error
        // and never another principal's restrictions.
        Ok(Response::new(pb::EncryptedGetFoodRestrictionsResponse {
            secure_restrictions: food_restrictions(
                &self.store,
                principal.expose_for_authorization(),
            )
            .await?,
        }))
    }

    async fn encrypted_set_food_restrictions(
        &self,
        request: Request<pb::EncryptedSetFoodRestrictionsRequest>,
    ) -> Result<Response<pb::EncryptedSetFoodRestrictionsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let stored = request.into_inner().secure_restrictions;
        // Stored as the shape the *read* returns, so the get is a plain decode.
        // A failure here surfaces as a gRPC error rather than an ack: the ack
        // echoes the wearer's own blob, so a swallowed failure would look
        // exactly like success and their allergies would be gone.
        let payload = pb::EncryptedGetFoodRestrictionsResponse {
            secure_restrictions: stored.clone(),
        };
        self.store
            .put_account_blob(
                principal.expose_for_authorization(),
                AccountBlobKind::FoodRestrictions,
                &payload.encode_to_vec(),
            )
            .await?;
        Ok(Response::new(pb::EncryptedSetFoodRestrictionsResponse {
            secure_restrictions: stored,
        }))
    }

    async fn get_user_daily_intake_goals(
        &self,
        request: Request<pb::GetDailyIntakeGoalsRequest>,
    ) -> Result<Response<pb::GetDailyIntakeGoalsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        // No goals configured: a present-but-empty goals container (empty
        // `nutrient_goals`), not an absent message, so the client never derefs
        // a null goals object. A stored payload gets the same treatment, a
        // round trip must not turn `goals` into `None`.
        let goals = daily_intake_goals(&self.store, principal.expose_for_authorization()).await?;
        Ok(Response::new(pb::GetDailyIntakeGoalsResponse {
            goals: Some(goals),
        }))
    }

    async fn set_user_daily_intake_goals(
        &self,
        request: Request<pb::SetDailyIntakeGoalsRequest>,
    ) -> Result<Response<pb::SetDailyIntakeGoalsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let goals = request.into_inner().goals;
        put_daily_intake_goals(
            &self.store,
            principal.expose_for_authorization(),
            goals.clone(),
        )
        .await?;
        // Ack the write by returning the goals the client just set.
        Ok(Response::new(pb::SetDailyIntakeGoalsResponse { goals }))
    }
}

/// `humane.account.UserInformationService`, the account profile the device
/// reads at startup.
#[derive(Clone)]
pub struct UserInformation {
    authenticator: RequestAuthenticator,
    store: SharedStore,
}

impl UserInformation {
    pub fn new(authenticator: RequestAuthenticator, store: SharedStore) -> Self {
        Self {
            authenticator,
            store,
        }
    }
}

#[tonic::async_trait]
impl UserInformationService for UserInformation {
    async fn get_user_personal_details(
        &self,
        // `google.protobuf.Empty` request, tonic maps it to `()`.
        request: Request<()>,
    ) -> Result<Response<pb::PersonalDetailsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        Ok(Response::new(
            personal_details(&self.store, principal.expose_for_authorization()).await?,
        ))
    }
}

/// `humane.account.WifiConfigService`, the user's saved encrypted Wi-Fi
/// networks. Named with a trailing `s` to avoid shadowing the `pb::WifiConfig`
/// message type.
#[derive(Clone)]
pub struct WifiConfigs {
    authenticator: RequestAuthenticator,
    store: SharedStore,
}

impl WifiConfigs {
    pub fn new(authenticator: RequestAuthenticator, store: SharedStore) -> Self {
        Self {
            authenticator,
            store,
        }
    }
}

#[tonic::async_trait]
impl WifiConfigService for WifiConfigs {
    async fn list_secure_wifi_configs(
        &self,
        request: Request<pb::ListSecureWifiConfigsRequest>,
    ) -> Result<Response<pb::ListSecureWifiConfigsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        // No stored Wi-Fi configs for this device: well-formed empty list.
        let stored = read_blob::<pb::ListSecureWifiConfigsResponse>(
            &self.store,
            principal.expose_for_authorization(),
            AccountBlobKind::WifiConfigs,
        )
        .await?;
        Ok(Response::new(stored.unwrap_or_default()))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap as EnvMap;

    use cosmos_protocol::common::encryption::{EncryptedData, EncryptionInformation};

    use super::*;
    use crate::{
        config::{Authentication, Config},
        store::MemoryStore,
    };

    /// Edge-authenticated services over one shared store, plus the metadata key
    /// a caller identifies itself with. Edge-authenticated rather than
    /// development-insecure because the latter hands every caller the same
    /// synthetic principal and so could not prove isolation.
    fn services() -> (FoodPreferences, UserInformation, WifiConfigs, String) {
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
        // Fresh per test, `shared()` is a process singleton and would bleed
        // state between tests running in parallel. See `contacts::tests::service`.
        let store: crate::store::SharedStore = std::sync::Arc::new(MemoryStore::default());
        (
            FoodPreferences::new(authenticator.clone(), store.clone()),
            UserInformation::new(authenticator.clone(), store.clone()),
            WifiConfigs::new(authenticator, store),
            metadata_key,
        )
    }

    fn as_principal<T>(key: &str, principal: &str, message: T) -> Request<T> {
        let mut request = Request::new(message);
        request.metadata_mut().insert(
            tonic::metadata::MetadataKey::from_bytes(key.as_bytes()).expect("valid metadata key"),
            principal.parse().expect("ASCII principal"),
        );
        request
    }

    /// A sealed restriction. Opaque here, the server holds no key for it, so
    /// the ciphertext bytes are the whole identity we can assert on.
    fn sealed(data: &[u8]) -> EncryptedData {
        EncryptedData {
            encryption_information: Some(EncryptionInformation {
                kid: "kid-account-1".to_owned(),
            }),
            data: data.to_vec(),
        }
    }

    /// Isolation is a security property: the store is keyed by the
    /// edge-authenticated principal, so one wearer's allergies can never be
    /// served to another device.
    #[tokio::test]
    async fn one_principal_never_reads_anothers_account_payloads() {
        let (food, .., key) = services();
        food.encrypted_set_food_restrictions(as_principal(
            &key,
            "device-a",
            pb::EncryptedSetFoodRestrictionsRequest {
                secure_restrictions: vec![sealed(b"sealed peanut allergy")],
            },
        ))
        .await
        .expect("set ok");

        let back = food
            .encrypted_get_food_restrictions(as_principal(
                &key,
                "device-b",
                pb::GetFoodRestrictionsRequest {},
            ))
            .await
            .expect("get ok")
            .into_inner();
        assert!(
            back.secure_restrictions.is_empty(),
            "a device must never be served another wearer's food restrictions"
        );
    }

    /// The principal is the storage key, so an unauthenticated caller has no
    /// book to read or write. Both must fail closed rather than fall back to a
    /// shared bucket.
    #[tokio::test]
    async fn an_unauthenticated_caller_reaches_no_account_data() {
        let (food, user, wifi, _key) = services();

        assert!(
            food.encrypted_set_food_restrictions(Request::new(
                pb::EncryptedSetFoodRestrictionsRequest {
                    secure_restrictions: vec![sealed(b"sealed peanut allergy")],
                }
            ))
            .await
            .is_err()
        );
        assert!(
            food.encrypted_get_food_restrictions(Request::new(pb::GetFoodRestrictionsRequest {}))
                .await
                .is_err()
        );
        assert!(
            food.set_user_daily_intake_goals(Request::new(pb::SetDailyIntakeGoalsRequest {
                goals: None
            }))
            .await
            .is_err()
        );
        assert!(
            food.get_user_daily_intake_goals(Request::new(pb::GetDailyIntakeGoalsRequest {}))
                .await
                .is_err()
        );
        assert!(
            user.get_user_personal_details(Request::new(()))
                .await
                .is_err()
        );
        assert!(
            wifi.list_secure_wifi_configs(Request::new(pb::ListSecureWifiConfigsRequest {}))
                .await
                .is_err()
        );
    }
}
