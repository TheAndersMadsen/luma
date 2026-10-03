//! Operator MCP servers: the tool servers Center lists, adds, switches and
//! tests. A Luma extension with no stock counterpart (see `crate::mcp`).

use super::*;

use crate::mcp::{McpError, McpServerInput, McpState};
use crate::mcp_oauth::OAuthError;

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
    /// `sign_in_required`, `unreachable`, `timed_out` or `invalid_response`.
    status: McpState,
    /// Whether the owner is signed in to this server through OAuth. The
    /// tokens are credentials and are never sent back.
    signed_in: bool,
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
                    signed_in: store.signed_in(&server),
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

/// Where the provider sends the owner's browser after a sign-in. Center
/// computes it from its own origin.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartSignIn {
    redirect_uri: String,
}

#[derive(Serialize)]
pub(super) struct SignInStarted {
    /// The provider's page for the owner's browser to open.
    authorization_url: String,
}

/// What the provider handed the browser. The code is a credential, so this
/// type has no `Debug`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FinishSignIn {
    state: String,
    /// Empty when the provider reported a refusal instead of a code.
    #[serde(default)]
    code: String,
}

fn oauth_error(error: OAuthError) -> DemoError {
    match error {
        OAuthError::NotFound => demo_error(StatusCode::NOT_FOUND, "That MCP server was not found."),
        OAuthError::OwnHeader => demo_error(
            StatusCode::BAD_REQUEST,
            "This server has an Authorization header. Remove it to sign in instead.",
        ),
        OAuthError::Redirect => demo_error(
            StatusCode::BAD_REQUEST,
            "Sign-in needs Center on an https address.",
        ),
        OAuthError::NotOffered => demo_error(
            StatusCode::BAD_GATEWAY,
            "This server does not offer a sign-in.",
        ),
        OAuthError::Unsafe => demo_error(
            StatusCode::BAD_GATEWAY,
            "This server's sign-in details could not be trusted, so nothing was sent.",
        ),
        OAuthError::Unsupported => demo_error(
            StatusCode::BAD_GATEWAY,
            "This server's sign-in cannot be used: it must allow client registration and PKCE.",
        ),
        OAuthError::Unavailable => demo_error(
            StatusCode::BAD_GATEWAY,
            "The server or its sign-in service did not answer. Try again.",
        ),
        OAuthError::State => demo_error(
            StatusCode::BAD_REQUEST,
            "That sign-in has expired or was already used. Start it again.",
        ),
        OAuthError::Exchange => demo_error(
            StatusCode::BAD_GATEWAY,
            "The sign-in was not accepted. Start it again.",
        ),
        OAuthError::Persistence => demo_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The sign-in could not be saved.",
        ),
    }
}

/// Begin an OAuth sign-in to a server: discover where it signs in, register
/// there, and answer the page the owner's browser opens.
pub(super) async fn start_mcp_sign_in(
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<StartSignIn>,
) -> Result<Json<SignInStarted>, DemoError> {
    require_admin(&headers)?;
    let authorization_url = crate::mcp::active()
        .start_sign_in(&id, &input.redirect_uri)
        .await
        .map_err(oauth_error)?;
    Ok(Json(SignInStarted { authorization_url }))
}

/// Finish a sign-in with the `state` and `code` the provider handed the
/// browser. The server is then asked for its tools, so the view answers with
/// what it offers.
pub(super) async fn finish_mcp_sign_in(
    headers: HeaderMap,
    Json(input): Json<FinishSignIn>,
) -> Result<Json<McpView>, DemoError> {
    require_admin(&headers)?;
    let store = crate::mcp::active();
    let id = store
        .finish_sign_in(&input.state, &input.code)
        .await
        .map_err(oauth_error)?;
    let _ = store.refresh(&id, TEST_TIMEOUT).await;
    Ok(Json(mcp_view(&store)))
}

/// Sign out of a server: drop its tokens and its registered client.
pub(super) async fn sign_out_mcp_server(
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<McpView>, DemoError> {
    require_admin(&headers)?;
    let store = crate::mcp::active();
    store.sign_out(&id).map_err(oauth_error)?;
    // What the server says without the tokens is in the view.
    let _ = store.refresh(&id, TEST_TIMEOUT).await;
    Ok(Json(mcp_view(&store)))
}
