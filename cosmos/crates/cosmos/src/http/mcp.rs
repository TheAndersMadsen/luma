//! Operator MCP servers: the tool servers Center lists, adds, switches and
//! tests. A Luma extension with no stock counterpart (see `crate::mcp`).

use super::*;

use crate::mcp::{McpError, McpServerInput, McpState};

/// How long a save or test waits for the server to list its tools.
const TEST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Serialize)]
pub(super) struct McpView {
    servers: Vec<McpServerView>,
}

#[derive(Serialize)]
struct McpServerView {
    id: String,
    name: String,
    url: String,
    /// The names of the request headers saved for this server. Their values
    /// are credentials and are never sent back.
    headers: Vec<String>,
    enabled: bool,
    allow_actions: bool,
    allow_when_locked: bool,
    /// What the last contact showed: `untested`, `connected`, `unauthorized`,
    /// `unreachable`, `timed_out` or `invalid_response`.
    status: McpState,
    /// Unix milliseconds of the last contact.
    checked_at_ms: Option<u64>,
    tools: Vec<McpToolView>,
}

#[derive(Serialize)]
struct McpToolView {
    name: String,
    description: String,
    read_only: bool,
    /// Whether the assistant is offered this tool right now.
    offered: bool,
}

fn mcp_view(store: &crate::mcp::McpStore) -> McpView {
    let status = store.status();
    let offered = store.offered();
    McpView {
        servers: store
            .snapshot()
            .servers
            .into_iter()
            .map(|server| {
                let known = status.get(&server.id).cloned().unwrap_or_default();
                McpServerView {
                    tools: known
                        .tools
                        .into_iter()
                        .map(|tool| McpToolView {
                            offered: offered.iter().any(|offer| {
                                offer.server_id == server.id && offer.tool_name == tool.name
                            }),
                            name: tool.name,
                            description: tool.description,
                            read_only: tool.read_only,
                        })
                        .collect(),
                    status: known.state,
                    checked_at_ms: known.checked_at_ms,
                    headers: server
                        .headers
                        .iter()
                        .map(|header| header.name.clone())
                        .collect(),
                    id: server.id,
                    name: server.name,
                    url: server.url,
                    enabled: server.enabled,
                    allow_actions: server.allow_actions,
                    allow_when_locked: server.allow_when_locked,
                }
            })
            .collect(),
    }
}

fn mcp_error(error: McpError) -> DemoError {
    match error {
        McpError::Invalid(message) => demo_error(StatusCode::BAD_REQUEST, message),
        McpError::NotFound => demo_error(StatusCode::NOT_FOUND, "That MCP server was not found."),
        McpError::Persistence(_) => demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "MCP server settings could not be saved.",
        ),
    }
}

pub(super) async fn admin_mcp(headers: HeaderMap) -> Result<Json<McpView>, DemoError> {
    require_admin(&headers)?;
    Ok(Json(mcp_view(&crate::mcp::active())))
}

/// Add a server, or change the one the body names. A saved server is asked
/// for its tools straight away, so the view answers with what it offers.
pub(super) async fn save_mcp_server(
    headers: HeaderMap,
    Json(input): Json<McpServerInput>,
) -> Result<Json<McpView>, DemoError> {
    require_admin(&headers)?;
    let store = crate::mcp::active();
    let saved = store.upsert(input).map_err(mcp_error)?;
    if saved.enabled {
        // What it found, or why not, is in the view either way.
        let _ = store.refresh(&saved.id, TEST_TIMEOUT).await;
    }
    Ok(Json(mcp_view(&store)))
}

pub(super) async fn delete_mcp_server(
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<McpView>, DemoError> {
    require_admin(&headers)?;
    let store = crate::mcp::active();
    store.remove(&id).map_err(mcp_error)?;
    Ok(Json(mcp_view(&store)))
}

/// Center's Test: contact the server now and list its tools.
pub(super) async fn test_mcp_server(
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<McpView>, DemoError> {
    require_admin(&headers)?;
    let store = crate::mcp::active();
    store.refresh(&id, TEST_TIMEOUT).await.map_err(mcp_error)?;
    Ok(Json(mcp_view(&store)))
}
