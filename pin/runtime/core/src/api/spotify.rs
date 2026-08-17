use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};

use super::{persist_config_durably, ApiState};
use crate::config::SpotifyConfig;
use crate::spotify::{diagnostic_search, UpdateSpotifySettings};

pub fn router() -> Router<ApiState> {
    Router::new()
        .route("/status", get(status))
        .route("/settings", put(update_settings))
        .route("/pairing/start", post(start_pairing))
        .route("/pairing/cancel", post(cancel_pairing))
        .route("/session", delete(disconnect))
        .route("/search", get(search))
        .route("/diagnostics/track/{id}", get(track_audio_diagnostics))
}

/// Audio-path diagnostics for one track, derived without playing it: which
/// formats Spotify offers (does an MP3 the Pin's DSP could hardware-decode
/// exist?) and the exact loudness gain this server applies. Behind the same
/// administration auth as the rest of `/api`.
async fn track_audio_diagnostics(
    State(state): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    match state.spotify.track_audio_diagnostics(&id).await {
        Ok(diagnostics) => Json(diagnostics).into_response(),
        Err(error) => (error.status_code(), error.safe_message()).into_response(),
    }
}

async fn status(State(state): State<ApiState>) -> impl IntoResponse {
    Json(state.spotify.status().await)
}

async fn update_settings(
    State(state): State<ApiState>,
    Json(body): Json<UpdateSpotifySettings>,
) -> Response {
    let candidate_settings = SpotifyConfig {
        enabled: body.enabled,
        experimental_acknowledged: body.experimental_acknowledged,
        device_name: body.device_name.trim().to_string(),
    };
    if let Err(error) = candidate_settings.validate() {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }

    // Persist/apply/publish is one detached transaction. If the browser
    // navigates away or the network drops, the durable file, shared config,
    // and Spotify runtime still converge before the config lock is released.
    // Acquire the FIFO transaction position before detaching. Spawning first
    // could let a newer request take the mutex and then be overwritten by an
    // older request whose task happened to be scheduled later.
    let update_guard = state.config_update_lock.clone().lock_owned().await;
    let (completed, completion) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let outcome = update_settings_transaction(state, candidate_settings, update_guard).await;
        let _ = completed.send(outcome);
    });
    match completion.await {
        Ok(Ok(status)) => Json(status).into_response(),
        Ok(Err((status, message))) => (status, message).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Spotify settings update did not complete",
        )
            .into_response(),
    }
}

async fn update_settings_transaction(
    state: ApiState,
    candidate_settings: SpotifyConfig,
    _update_guard: tokio::sync::OwnedMutexGuard<()>,
) -> Result<crate::spotify::SpotifyStatus, (StatusCode, &'static str)> {
    let previous = state.shared_config.read().await.clone();
    let mut candidate = previous.clone();
    candidate.spotify = candidate_settings.clone();
    if let Err(error) = persist_config_durably(
        &state.config_path,
        &candidate,
        &previous,
        &state.esim_bridge,
    )
    .await
    {
        tracing::warn!(error = %error, "failed to persist Spotify settings");
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Spotify settings could not be confirmed",
        ));
    }

    // Persistence is now authoritative. Publish it before the potentially
    // network-bound runtime restore; this task owns the transaction even when
    // the originating request has been canceled.
    *state.shared_config.write().await = candidate;
    if let Err(error) = state.spotify.apply_settings(candidate_settings).await {
        tracing::warn!("Spotify settings applied but session restore failed");
        return Err((error.status_code(), error.safe_message()));
    }
    Ok(state.spotify.status().await)
}

async fn start_pairing(State(state): State<ApiState>) -> Response {
    match state.spotify.start_pairing().await {
        Ok(()) => Json(state.spotify.status().await).into_response(),
        Err(error) => (error.status_code(), error.safe_message()).into_response(),
    }
}

async fn cancel_pairing(State(state): State<ApiState>) -> impl IntoResponse {
    state.spotify.cancel_pairing().await;
    Json(state.spotify.status().await)
}

async fn disconnect(State(state): State<ApiState>) -> Response {
    match state.spotify.disconnect().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => (error.status_code(), error.safe_message()).into_response(),
    }
}

async fn search(
    State(state): State<ApiState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    match diagnostic_search(&state.spotify, params).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => (error.status_code(), error.safe_message()).into_response(),
    }
}
