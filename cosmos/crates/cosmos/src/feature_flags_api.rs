//! Settings → Features on the web plane: the wearer's own choices for the stock
//! Pin features their Pins are served.
//!
//! humane.center had this page for each account (Settings → Ai Pin →
//! Features, `/settings/account/features`) and its client held the
//! `feature-flags` scope; `flag_overrides` has the stock evidence that the
//! choices were the account's own. The page's calls were not recovered, so
//! these paths and shapes are INFERRED, under the `feature-flags` service name
//! the way the recovered routes sit under `capture` and `account-service`:
//!
//! - `GET /feature-flags/features`: every feature the wearer may choose, with
//!   this server's default and what the wearer's Pins are served, as a
//!   `Page<T>`.
//! - `PUT /feature-flags/features/{name} {value}`: choose a value. Answers the
//!   feature as it now stands. A value of the wrong type, out of range, or
//!   breaking another feature it needs is a `400` with the reason.
//! - `DELETE /feature-flags/features/{name}`: go back to this server's default.
//!   Answers `{"deleted": bool}`.
//!
//! All three are web plane only: the caller is the verified Keycloak Bearer,
//! and only that account's choices are read or written. The Pin receives them
//! through the stock `GetFlags` (`services::feature_flags`) at its next sync;
//! Center sends it a `humane.feature-flags` push after a change.

use std::collections::BTreeMap;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use cosmos_protocol::featureflags::feature_flag_assignment::Val;
use serde::{Deserialize, Serialize};

use crate::flag_overrides::{self, Feature, FlagValue, Overrides};
use crate::services::feature_flags::{default_flags, served_flags};
use crate::web_api::{ApiState, DeletedDto, delete_failed, page_of, unavailable};

/// One value and its field name. Stock gives no bound.
const MAX_BODY_BYTES: usize = 4 * 1024;
/// A string flag value's bound. INFERRED: Luma's own limit. Stock gives none.
const MAX_TEXT_BYTES: usize = 256;

/// One feature as the wearer sees it.
#[derive(Serialize)]
struct FeatureDto {
    name: &'static str,
    editable: bool,
    #[serde(rename = "type")]
    value_type: &'static str,
    /// What this server serves every Pin without a choice.
    default: serde_json::Value,
    /// What this wearer's Pins are served.
    effective: serde_json::Value,
    /// The wearer has a choice stored for it.
    overridden: bool,
    label: &'static str,
    description: &'static str,
    category: &'static str,
    evidence: &'static str,
    delivery: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<&'static str>,
}

fn json_of(val: &Val) -> serde_json::Value {
    match val {
        Val::ValBool(value) => serde_json::json!(value),
        Val::ValInt(value) => serde_json::json!(value),
        Val::ValStr(value) => serde_json::json!(value),
        Val::ValFloat(value) => serde_json::json!(value),
    }
}

fn type_of(val: &Val) -> &'static str {
    match val {
        Val::ValBool(_) => "bool",
        Val::ValInt(_) => "int",
        Val::ValStr(_) => "text",
        Val::ValFloat(_) => "float",
    }
}

fn by_name(
    flags: Vec<cosmos_protocol::featureflags::FeatureFlagAssignment>,
) -> BTreeMap<String, Val> {
    flags
        .into_iter()
        .filter_map(|flag| Some((flag.flag_name, flag.val?)))
        .collect()
}

/// Every feature the wearer may choose, as their Pins are served it.
fn features_for(overrides: &Overrides) -> Vec<FeatureDto> {
    let defaults = by_name(default_flags());
    let served = by_name(served_flags(overrides));
    flag_overrides::FEATURES
        .iter()
        .filter_map(|feature| {
            let default = defaults.get(feature.key)?;
            let effective = served.get(feature.key).unwrap_or(default);
            Some(dto(feature, default, effective, overrides))
        })
        .collect()
}

fn dto(
    feature: &'static Feature,
    default: &Val,
    effective: &Val,
    overrides: &Overrides,
) -> FeatureDto {
    FeatureDto {
        name: feature.key,
        editable: feature.editable(),
        value_type: type_of(default),
        default: json_of(default),
        effective: json_of(effective),
        overridden: overrides.contains_key(feature.key),
        label: feature.label,
        description: feature.description,
        category: feature.category,
        evidence: feature.evidence,
        delivery: feature.delivery,
        warning: feature.warning,
    }
}

/// A feature this wearer cannot choose. The same answer for a stock flag this
/// deployment decides and for a name that is no flag at all.
fn not_a_feature() -> Response {
    (
        StatusCode::NOT_FOUND,
        "That feature is not one you can change.",
    )
        .into_response()
}

/// `GET /feature-flags/features`.
async fn list_features(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    match flag_overrides::for_account(&state.store, &account).await {
        Ok(overrides) => {
            let features = features_for(&overrides);
            let total = features.len() as i64;
            Json(page_of(features, total, 0, total.max(1))).into_response()
        }
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValueWrite {
    value: serde_json::Value,
}

/// The value a write names, in the arm of this feature's default.
fn chosen_value(default: &Val, value: &serde_json::Value) -> Result<FlagValue, &'static str> {
    let chosen = match (default, value) {
        (Val::ValBool(_), serde_json::Value::Bool(value)) => FlagValue::Bool(*value),
        (Val::ValInt(_), serde_json::Value::Number(number)) => {
            // The Pin reads the arm as a Java int (`(int) getValInt()` in
            // `FeatureFlagSyncWorker.convertFeatureFlagAssignment`).
            let value = number
                .as_i64()
                .ok_or("That value must be a whole number.")?;
            if i32::try_from(value).is_err() {
                return Err("That number is too large for this feature.");
            }
            FlagValue::Int(value)
        }
        (Val::ValStr(_), serde_json::Value::String(value)) => {
            if value.len() > MAX_TEXT_BYTES {
                return Err("That text is too long for this feature.");
            }
            FlagValue::Text(value.clone())
        }
        _ => return Err("That value has the wrong type for this feature."),
    };
    if let FlagValue::Int(value) = chosen
        && value < 0
    {
        return Err("This timeout cannot be negative.");
    }
    Ok(chosen)
}

/// Features the stock consumer only reads beside another one: a choice that
/// would leave one on without the other is refused, naming what it needs.
fn needs_met(overrides: &Overrides) -> Result<(), &'static str> {
    let served = by_name(served_flags(overrides));
    let on = |key: &str| matches!(served.get(key), Some(Val::ValBool(true)));
    if on("cmu_ultra_chime_enabled") && !on("cmu_ultra_enabled") {
        return Err("Catch Me Up chime needs Catch Me Up Ultra accessory path on.");
    }
    if on("fitness_tracker_extra_data_enabled") && !on("fitness_tracker_enabled") {
        return Err("Fitness extra sensor data needs Fitness tracker on.");
    }
    Ok(())
}

/// `PUT /feature-flags/features/{name} {value}`.
async fn choose_feature(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Result<Json<ValueWrite>, JsonRejection>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Some(feature) = flag_overrides::feature(&name) else {
        return not_a_feature();
    };
    let Some(default) = crate::services::feature_flags::default_value(feature.key) else {
        return not_a_feature();
    };
    if !feature.editable() {
        return (
            StatusCode::BAD_REQUEST,
            "Touchcode remains available to unlock your Pin.",
        )
            .into_response();
    }
    let Ok(Json(write)) = body else {
        return (StatusCode::BAD_REQUEST, "expected {\"value\": ...}").into_response();
    };
    let value = match chosen_value(&default, &write.value) {
        Ok(value) => value,
        Err(reason) => return (StatusCode::BAD_REQUEST, reason).into_response(),
    };
    let outcome = flag_overrides::update(&state.store, &account, |overrides| {
        // Only this write's own effect blocks it. A dependency left unmet by an
        // earlier change, restoring or turning off a master while a dependent
        // stays on, which `restore_default` deliberately allows, must not wedge
        // every later, unrelated feature change behind a 400.
        let already_unmet = needs_met(overrides).is_err();
        overrides.insert(feature.key.to_owned(), value.clone());
        if !already_unmet {
            needs_met(overrides)?;
        }
        Ok::<_, &'static str>(overrides.clone())
    })
    .await;
    match outcome {
        Ok(Ok(overrides)) => {
            let served = by_name(served_flags(&overrides));
            let effective = served.get(feature.key).unwrap_or(&default);
            Json(dto(feature, &default, effective, &overrides)).into_response()
        }
        Ok(Err(reason)) => (StatusCode::BAD_REQUEST, reason).into_response(),
        Err(_) => unavailable(),
    }
}

/// `DELETE /feature-flags/features/{name}`: back to this server's default.
///
/// Always allowed, even when another choice needed this one: going back to
/// the default must never be a dead end.
async fn restore_default(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let account = match state.web_caller(&headers) {
        Ok(account) => account,
        Err(refused) => return refused,
    };
    let Some(feature) = flag_overrides::feature(&name) else {
        return not_a_feature();
    };
    let outcome = flag_overrides::update(&state.store, &account, |overrides| {
        Ok::<_, std::convert::Infallible>(overrides.remove(feature.key).is_some())
    })
    .await;
    match outcome {
        Ok(Ok(deleted)) => Json(DeletedDto { deleted }).into_response(),
        Ok(Err(never)) => match never {},
        Err(_) => delete_failed(),
    }
}

/// Mount the Features routes over the shared web state.
pub(crate) fn router(state: ApiState) -> Router {
    Router::new()
        .route("/feature-flags/features", get(list_features))
        .route(
            "/feature-flags/features/:name",
            put(choose_feature).delete(restore_default),
        )
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SharedStore;
    use crate::web_api::DEMO_PRINCIPAL;
    use crate::web_api::test_support::*;
    use axum::http::Method;
    use serde_json::{Value, json};

    const FEATURES: &str = "/feature-flags/features";

    fn app_with(store: SharedStore) -> Router {
        router(ApiState::for_tests(
            store,
            fresh_keys(),
            DEMO_PRINCIPAL,
            internet_facing(),
            Some(test_verifier()),
            None,
        ))
    }

    fn feature_uri(name: &str) -> String {
        format!("{FEATURES}/{name}")
    }

    fn row<'a>(page: &'a Value, name: &str) -> &'a Value {
        page["content"]
            .as_array()
            .expect("a Page<T>")
            .iter()
            .find(|feature| feature["name"] == name)
            .unwrap_or_else(|| panic!("{name} is listed"))
    }

    /// Center's gateway, a Pin behind the edge: the device plane.
    fn pin_of(account: &str) -> Vec<(&'static str, String)> {
        vec![
            (crate::config::EDGE_PRINCIPAL_HEADER, format!("U:{account}")),
            (crate::config::EDGE_TOKEN_HEADER, EDGE_TOKEN.to_owned()),
        ]
    }

    async fn served_to_pin_of(store: &SharedStore, account: &str, key: &str) -> Option<Val> {
        let overrides = flag_overrides::for_account(store, &format!("U:{account}"))
            .await
            .unwrap();
        by_name(served_flags(&overrides)).remove(key)
    }

    /// The point of the page: one wearer's choice reaches their own Pins and
    /// changes nothing for anyone else.
    #[tokio::test]
    async fn a_choice_is_the_wearers_alone() {
        let store = fresh();
        let app = app_with(store.clone());

        let (status, chosen) = send(
            &app,
            Method::PUT,
            &feature_uri("tickle"),
            &[bearer_header("alice")],
            Some(json!({"value": false})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(chosen["name"], json!("tickle"));
        assert_eq!(chosen["effective"], json!(false));
        assert_eq!(chosen["default"], json!(true));
        assert_eq!(chosen["overridden"], json!(true));

        let (_, alice) = send(&app, Method::GET, FEATURES, &[bearer_header("alice")], None).await;
        assert_eq!(row(&alice, "tickle")["effective"], json!(false));
        let (_, bob) = send(&app, Method::GET, FEATURES, &[bearer_header("bob")], None).await;
        assert_eq!(row(&bob, "tickle")["effective"], json!(true));
        assert_eq!(row(&bob, "tickle")["overridden"], json!(false));

        // What `GetFlags` serves each account's Pins.
        assert_eq!(
            served_to_pin_of(&store, "alice", "tickle").await,
            Some(Val::ValBool(false))
        );
        assert_eq!(
            served_to_pin_of(&store, "bob", "tickle").await,
            Some(Val::ValBool(true))
        );
    }

    /// Only a signed-in wearer reaches a choice: nobody is 401, and a Pin or
    /// Center's gateway on the device plane is 403, reading or writing.
    #[tokio::test]
    async fn only_a_signed_in_wearer_reaches_the_features() {
        let store = fresh();
        let app = app_with(store.clone());
        let write = Some(json!({"value": false}));
        let uri = feature_uri("tickle");

        let (status, _) = send(&app, Method::GET, FEATURES, &[], None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = send(&app, Method::PUT, &uri, &[], write.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, _) = send(&app, Method::GET, FEATURES, &pin_of("alice"), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send(&app, Method::PUT, &uri, &pin_of("alice"), write).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send(&app, Method::DELETE, &uri, &pin_of("alice"), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        assert!(
            flag_overrides::for_account(&store, "U:alice")
                .await
                .unwrap()
                .is_empty(),
            "no refused request stored anything"
        );
    }

    /// The production topology: the web plane (ai-bus) writes a choice and the
    /// feature-flags workload, on its own connection to the same PostgreSQL,
    /// serves it to that account's Pin through the stock `GetFlags`, and to no
    /// other account's.
    #[tokio::test]
    async fn a_choice_reaches_the_pin_through_the_shared_postgres_store() {
        use crate::services::feature_flags::FeatureFlags;
        use cosmos_protocol::featureflags::{
            DeviceFeatureFlagRequest, feature_flags_service_server::FeatureFlagsService,
        };

        let Ok(url) = std::env::var("COSMOS_TEST_DATABASE_URL") else {
            eprintln!("SKIPPED: set COSMOS_TEST_DATABASE_URL to exercise the Postgres path");
            return;
        };
        let connect = || async {
            let store: SharedStore = std::sync::Arc::new(
                crate::store_postgres::PostgresStore::connect(&url)
                    .await
                    .expect("COSMOS_TEST_DATABASE_URL is set but connect/migrate failed"),
            );
            store
        };
        let web = app_with(connect().await);
        let config = crate::config::Config::from_map(&std::collections::HashMap::from([(
            "COSMOS_AUTH_MODE".to_owned(),
            "edge-authenticated".to_owned(),
        )]))
        .expect("edge-authenticated test config");
        let principal_key = match &config.auth {
            crate::config::Authentication::EdgeAuthenticated(edge) => {
                edge.principal_metadata_key().to_owned()
            }
            crate::config::Authentication::DevelopmentInsecure => unreachable!(),
        };
        let flags = FeatureFlags::new(
            crate::auth::RequestAuthenticator::new(config.auth),
            connect().await,
        );
        let served = |account: String| {
            let mut request = tonic::Request::new(DeviceFeatureFlagRequest {});
            request.metadata_mut().insert(
                tonic::metadata::MetadataKey::from_bytes(principal_key.as_bytes()).unwrap(),
                format!("U:{account}").parse().unwrap(),
            );
            let flags = &flags;
            async move {
                by_name(
                    flags
                        .get_flags(request)
                        .await
                        .expect("GetFlags answers")
                        .into_inner()
                        .assignment,
                )
            }
        };
        let alice = format!("pg-features-{}", uuid::Uuid::new_v4());
        let bob = format!("pg-features-{}", uuid::Uuid::new_v4());

        // Exercise every setting offered by Center, not merely one boolean.
        // Masters precede their dependent choices. Reverse-order restoration
        // permits each master to return to false without stranding a child.
        let defaults = served(bob.clone()).await;
        let mut choices = Vec::new();
        for feature in flag_overrides::FEATURES {
            if feature.key == "touchcode_enabled" {
                let (status, _) = send(
                    &web,
                    Method::PUT,
                    &feature_uri(feature.key),
                    &[bearer_header(&alice)],
                    Some(json!({"value": false})),
                )
                .await;
                assert_eq!(
                    status,
                    StatusCode::BAD_REQUEST,
                    "Touchcode remains available"
                );
                continue;
            }
            let default = defaults.get(feature.key).expect("served default");
            let (value, expected) = match default {
                Val::ValBool(value) => (json!(!value), Val::ValBool(!value)),
                Val::ValInt(_) => (json!(12_345), Val::ValInt(12_345)),
                _ => panic!("unexpected wearer setting type"),
            };
            let (status, _) = send(
                &web,
                Method::PUT,
                &feature_uri(feature.key),
                &[bearer_header(&alice)],
                Some(json!({"value": value})),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{}", feature.key);
            choices.push((feature.key, expected));
        }
        let fetched = served(alice.clone()).await;
        for (name, expected) in &choices {
            assert_eq!(fetched.get(*name), Some(expected), "{name}");
        }
        assert_eq!(served(bob).await, defaults, "another account is unchanged");
        for (name, _) in choices.into_iter().rev() {
            let (status, body) = send(
                &web,
                Method::DELETE,
                &feature_uri(name),
                &[bearer_header(&alice)],
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{name}");
            assert_eq!(body, json!({"deleted": true}));
            assert_eq!(served(alice.clone()).await.get(name), defaults.get(name));
        }
        assert_eq!(served(alice).await, defaults, "all defaults restored");
    }

    #[tokio::test]
    async fn touchcode_is_available_and_an_ignored_old_choice_can_be_restored() {
        use cosmos_protocol::featureflags::{
            DeviceFeatureFlagRequest, feature_flags_service_server::FeatureFlagsService,
        };
        let store = fresh();
        flag_overrides::update(&store, "U:alice", |choices| {
            choices.insert("touchcode_enabled".to_owned(), FlagValue::Bool(false));
            Ok::<_, std::convert::Infallible>(())
        })
        .await
        .unwrap()
        .unwrap();
        let web = app_with(store.clone());
        let (status, page) =
            send(&web, Method::GET, FEATURES, &[bearer_header("alice")], None).await;
        assert_eq!(status, StatusCode::OK);
        let touchcode = row(&page, "touchcode_enabled");
        assert_eq!(touchcode["effective"], json!(true));
        assert_eq!(touchcode["editable"], json!(false));
        assert_eq!(touchcode["overridden"], json!(true));
        let config = crate::config::Config::from_map(&std::collections::HashMap::from([(
            "COSMOS_AUTH_MODE".to_owned(),
            "edge-authenticated".to_owned(),
        )]))
        .unwrap();
        let mut request = tonic::Request::new(DeviceFeatureFlagRequest {});
        request.metadata_mut().insert(
            crate::config::EDGE_PRINCIPAL_HEADER,
            "U:alice".parse().unwrap(),
        );
        let flags = crate::services::feature_flags::FeatureFlags::new(
            crate::auth::RequestAuthenticator::new(config.auth),
            store.clone(),
        );
        let fetched = by_name(
            flags
                .get_flags(request)
                .await
                .unwrap()
                .into_inner()
                .assignment,
        );
        assert_eq!(fetched.get("touchcode_enabled"), Some(&Val::ValBool(true)));
        let (status, _) = send(
            &web,
            Method::PUT,
            &feature_uri("touchcode_enabled"),
            &[bearer_header("alice")],
            Some(json!({"value": false})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, body) = send(
            &web,
            Method::DELETE,
            &feature_uri("touchcode_enabled"),
            &[bearer_header("alice")],
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"deleted": true}));
        let (_, page) = send(&web, Method::GET, FEATURES, &[bearer_header("alice")], None).await;
        assert_eq!(row(&page, "touchcode_enabled")["overridden"], json!(false));
        assert_eq!(row(&page, "touchcode_enabled")["effective"], json!(true));
    }
}
