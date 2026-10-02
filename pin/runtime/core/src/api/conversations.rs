//! Bounded, authenticated Center conversation views.
//!
//! Read-only access to stored conversations for the Center conversations page.
//! The write path lives in the agentic runtime. These endpoints never mutate.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::ApiState;
use crate::db::{ConversationDetail, ConversationSummary};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

pub fn router() -> Router<ApiState> {
    Router::new()
        .route("/conversations", get(list_conversations))
        .route("/conversations/{id}", get(get_conversation))
}

/// One page of stored conversations for the Center list view.
#[derive(Serialize)]
struct PaginatedConversations {
    conversations: Vec<ConversationSummary>,
    has_more: bool,
}

/// Optional offset/limit paging for the conversations list. The handler clamps
/// both to safe bounds.
#[derive(Deserialize)]
struct ConversationsQuery {
    #[serde(default)]
    offset: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

/// List stored conversations, most recent first, for the Center view.
async fn list_conversations(
    Query(query): Query<ConversationsQuery>,
    State(state): State<ApiState>,
) -> Json<PaginatedConversations> {
    let offset = query.offset.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let conversations = match state.db.list_conversations(offset, limit).await {
        Ok(conversations) => conversations,
        Err(e) => {
            warn!(error = %e, "failed to list conversations");
            Vec::new()
        }
    };

    Json(PaginatedConversations {
        has_more: conversations.len() as i64 == limit,
        conversations,
    })
}

/// Fetch one stored conversation with its ordered message thread.
async fn get_conversation(
    Path(id): Path<i64>,
    State(state): State<ApiState>,
) -> Result<Json<ConversationDetail>, StatusCode> {
    match state.db.get_conversation(id).await {
        Ok(Some(detail)) => Ok(Json(detail)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(e) => {
            warn!(id, error = %e, "failed to get conversation");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
