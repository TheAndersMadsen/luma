//! `humane.account.*` — post-enrollment per-user account services.
//!
//! Three services live in the `humane.account` package: food preferences, user
//! information, and stored Wi-Fi configs. A compatible Cosmos service with nothing
//! stored for this device answers every read with a well-formed *empty*
//! response, not an error — so that is exactly what an untouched principal gets
//! here. Nothing in this module needs an LLM, real crypto, or externally-signed
//! state, so no RPC is `UNIMPLEMENTED`.
//!
//! ## What is stored, and why it has to be
//!
//! The set RPCs used to echo the client's own blob straight back and discard it.
//! The device cannot tell the difference: an ack that returns the payload is
//! indistinguishable from a successful write, so
//! `EncryptedSetFoodRestrictions` — the wearer's food restrictions, which
//! include **allergies** — was written, acked, and lost, and the next read
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
//! `humane.common.encryption`) and stay sealed end to end — we never decrypt,
//! re-encrypt, or fabricate an envelope, and no key material is involved.
//!
//! **The last two rows are read-only, and that is the proto's doing, not an
//! omission here.** `humane.account` (reconstructed from ironman.apk, see
//! `contracts/humane/account.proto`) declares exactly one RPC on
//! `UserInformationService` (`GetUserPersonalDetails`) and exactly one on
//! `WifiConfigService` (`ListSecureWifiConfigs`) — there is no
//! `SetUserPersonalDetails` and no Wi-Fi write to serve. An earlier version of
//! this doc listed both as data we were dropping; they are payloads no RPC in
//! this package can deliver. They are read through the same store anyway, so
//! whichever surface does write them (onboarding, the companion app) is served
//! by the same rows rather than by a second store.
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
/// response. A stored blob that will not decode is **not** absence — it is a
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
        Err(_) => {
            // The kind is a payload name, not wearer content; the bytes are
            // never logged.
            tracing::error!(
                kind = kind.as_str(),
                "a stored account payload will not decode"
            );
            Err(Status::internal(
                "the stored account payload could not be read",
            ))
        }
    }
}

/// `humane.account.FoodPreferencesService` — encrypted food restrictions and
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
        let stored = read_blob::<pb::EncryptedGetFoodRestrictionsResponse>(
            &self.store,
            principal.expose_for_authorization(),
            AccountBlobKind::FoodRestrictions,
        )
        .await?;
        Ok(Response::new(stored.unwrap_or_default()))
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
        let stored = read_blob::<pb::GetDailyIntakeGoalsResponse>(
            &self.store,
            principal.expose_for_authorization(),
            AccountBlobKind::DailyIntakeGoals,
        )
        .await?;
        // No goals configured: a present-but-empty goals container (empty
        // `nutrient_goals`), not an absent message, so the client never derefs
        // a null goals object. A stored payload gets the same treatment — a
        // round trip must not turn `goals` into `None`.
        let goals = stored
            .and_then(|response| response.goals)
            .unwrap_or_default();
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
        let payload = pb::GetDailyIntakeGoalsResponse {
            goals: goals.clone(),
        };
        self.store
            .put_account_blob(
                principal.expose_for_authorization(),
                AccountBlobKind::DailyIntakeGoals,
                &payload.encode_to_vec(),
            )
            .await?;
        // Ack the write by returning the goals the client just set.
        Ok(Response::new(pb::SetDailyIntakeGoalsResponse { goals }))
    }
}

/// `humane.account.UserInformationService` — the account profile the device
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
        // `google.protobuf.Empty` request — tonic maps it to `()`.
        request: Request<()>,
    ) -> Result<Response<pb::PersonalDetailsResponse>, Status> {
        let principal = self.authenticator.authenticate(&request)?;
        let stored = read_blob::<pb::PersonalDetailsResponse>(
            &self.store,
            principal.expose_for_authorization(),
            AccountBlobKind::PersonalDetails,
        )
        .await?;
        // Present-but-empty account info (empty preferred name / pronunciation)
        // rather than an absent message, to avoid a null-deref on the device.
        // With nothing stored there is no encrypted bio data to serve, and we do
        // not fabricate an envelope.
        let mut response = stored.unwrap_or_default();
        response
            .account_info
            .get_or_insert_with(pb::AccountInfo::default);
        Ok(Response::new(response))
    }
}

/// `humane.account.WifiConfigService` — the user's saved encrypted Wi-Fi
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
        // Fresh per test — `shared()` is a process singleton and would bleed
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

    /// A sealed restriction. Opaque here — the server holds no key for it — so
    /// the ciphertext bytes are the whole identity we can assert on.
    fn sealed(data: &[u8]) -> EncryptedData {
        EncryptedData {
            encryption_information: Some(EncryptionInformation {
                kid: "kid-account-1".to_owned(),
            }),
            data: data.to_vec(),
        }
    }

    #[tokio::test]
    async fn reads_return_well_formed_empty() {
        let (food, user, wifi, key) = services();

        // Representative read from each service returns Ok with an empty /
        // default-but-present response, never an error.
        let details = user
            .get_user_personal_details(as_principal(&key, "device-a", ()))
            .await
            .expect("personal details ok")
            .into_inner();
        assert!(details.secure_bio_data.is_none());
        let info = details.account_info.expect("account_info present");
        assert!(info.preferred_name.is_empty());

        let configs = wifi
            .list_secure_wifi_configs(as_principal(
                &key,
                "device-a",
                pb::ListSecureWifiConfigsRequest {},
            ))
            .await
            .expect("wifi list ok")
            .into_inner();
        assert!(configs.secure_wifi_configs.is_empty());

        let restrictions = food
            .encrypted_get_food_restrictions(as_principal(
                &key,
                "device-a",
                pb::GetFoodRestrictionsRequest {},
            ))
            .await
            .expect("food restrictions ok")
            .into_inner();
        assert!(restrictions.secure_restrictions.is_empty());

        let goals = food
            .get_user_daily_intake_goals(as_principal(
                &key,
                "device-a",
                pb::GetDailyIntakeGoalsRequest {},
            ))
            .await
            .expect("intake goals ok")
            .into_inner();
        assert!(
            goals
                .goals
                .expect("goals present")
                .nutrient_goals
                .is_empty()
        );
    }

    /// REGRESSION: `EncryptedSetFoodRestrictions` echoed the wearer's blob back
    /// as an ack and then dropped it, so their **allergies** did not survive the
    /// call and the next read said they had none.
    ///
    /// The ack proves nothing — it is the client's own payload — so this asserts
    /// on what the READ hands back, through the real RPC entry point.
    #[tokio::test]
    async fn food_restrictions_read_back_after_they_are_set() {
        let (food, .., key) = services();
        let restriction = sealed(b"sealed peanut allergy");

        food.encrypted_set_food_restrictions(as_principal(
            &key,
            "device-a",
            pb::EncryptedSetFoodRestrictionsRequest {
                secure_restrictions: vec![restriction.clone()],
            },
        ))
        .await
        .expect("set ok");

        let back = food
            .encrypted_get_food_restrictions(as_principal(
                &key,
                "device-a",
                pb::GetFoodRestrictionsRequest {},
            ))
            .await
            .expect("get ok")
            .into_inner();
        assert_eq!(
            back.secure_restrictions,
            vec![restriction],
            "a restriction the wearer set must come back byte-for-byte, still sealed"
        );
    }

    /// A second set replaces the first: the RPC carries the wearer's whole list
    /// and its items have no id to merge on, so a removed allergy must not
    /// resurrect.
    #[tokio::test]
    async fn setting_restrictions_again_replaces_the_stored_list() {
        let (food, .., key) = services();

        for payload in [
            b"sealed peanut allergy".as_slice(),
            b"sealed shellfish".as_slice(),
        ] {
            food.encrypted_set_food_restrictions(as_principal(
                &key,
                "device-a",
                pb::EncryptedSetFoodRestrictionsRequest {
                    secure_restrictions: vec![sealed(payload)],
                },
            ))
            .await
            .expect("set ok");
        }

        let back = food
            .encrypted_get_food_restrictions(as_principal(
                &key,
                "device-a",
                pb::GetFoodRestrictionsRequest {},
            ))
            .await
            .expect("get ok")
            .into_inner();
        assert_eq!(back.secure_restrictions, vec![sealed(b"sealed shellfish")]);
    }

    /// REGRESSION: `SetUserDailyIntakeGoals` acked and discarded too.
    #[tokio::test]
    async fn daily_intake_goals_read_back_after_they_are_set() {
        let (food, .., key) = services();
        let goals = pb::DailyIntakeGoals {
            nutrient_goals: vec![pb::NutrientGoal {
                uuid: "goal-1".to_owned(),
                is_max_set: true,
                max_value: 2000.0,
                ..Default::default()
            }],
        };

        food.set_user_daily_intake_goals(as_principal(
            &key,
            "device-a",
            pb::SetDailyIntakeGoalsRequest {
                goals: Some(goals.clone()),
            },
        ))
        .await
        .expect("set ok");

        let back = food
            .get_user_daily_intake_goals(as_principal(
                &key,
                "device-a",
                pb::GetDailyIntakeGoalsRequest {},
            ))
            .await
            .expect("get ok")
            .into_inner();
        assert_eq!(back.goals, Some(goals));
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
