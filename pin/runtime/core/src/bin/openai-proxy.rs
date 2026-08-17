use std::error::Error;
use std::net::SocketAddr;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tonic::metadata::MetadataValue;
use tonic::Request as GrpcRequest;
use tower_http::cors::CorsLayer;

#[path = "../tier_a.rs"]
mod tier_a;

#[allow(dead_code)]
mod proto {
    #[allow(dead_code, clippy::enum_variant_names)]
    pub mod aibus {
        tonic::include_proto!("humane.aibus");
    }

    #[allow(dead_code)]
    pub mod common {
        #[allow(dead_code)]
        pub mod encryption {
            tonic::include_proto!("humane.common.encryption");
        }
        #[allow(dead_code)]
        pub mod food {
            tonic::include_proto!("humane.common.food");
        }
    }
}

use proto::aibus::ai_bus_service_client::AiBusServiceClient;
use proto::aibus::{
    synapse_chat_turn, synapse_understanding_response, SynapseActionContent, SynapseDeviceContext,
    SynapseMessageContent, SynapseUnderstandingRequest, SynapseUser,
};

#[derive(Clone)]
struct AppState {
    grpc_addr: String,
    model: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletionRequest {
    model: Option<String>,
    messages: Vec<OpenAiChatMessage>,
    #[serde(default)]
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatMessage {
    role: String,
    content: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let options = Options::parse()?;
    let state = AppState {
        grpc_addr: options.grpc_addr,
        model: options.model,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(options.listen).await?;
    eprintln!(
        "openai-proxy listening on http://{} and forwarding Understand to {}",
        listener.local_addr()?,
        options.grpc_display
    );
    axum::serve(listener, app).await?;
    Ok(())
}

struct Options {
    listen: SocketAddr,
    grpc_addr: String,
    grpc_display: String,
    model: String,
}

impl Options {
    fn parse() -> Result<Self, Box<dyn Error>> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        let mut listen: SocketAddr = "127.0.0.1:8000".parse()?;
        let mut grpc_addr = "http://127.0.0.1:9090".to_string();
        let mut model = "penumbra-understand".to_string();

        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--listen" => {
                    i += 1;
                    listen = args.get(i).ok_or("--listen requires a value")?.parse()?;
                }
                "--grpc" => {
                    i += 1;
                    grpc_addr = normalize_grpc_addr(args.get(i).ok_or("--grpc requires a value")?);
                }
                "--model" => {
                    i += 1;
                    model = args.get(i).ok_or("--model requires a value")?.clone();
                }
                "--help" | "-h" => {
                    print_usage();
                    std::process::exit(0);
                }
                other => return Err(format!("unknown argument: {other}").into()),
            }
            i += 1;
        }

        Ok(Self {
            listen,
            grpc_display: grpc_addr.clone(),
            grpc_addr,
            model,
        })
    }
}

fn normalize_grpc_addr(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("http://{value}")
    }
}

fn print_usage() {
    eprintln!("Usage: cargo run --bin openai-proxy -- [--listen 127.0.0.1:8000] [--grpc http://127.0.0.1:9090] [--model penumbra-understand]");
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "grpc": state.grpc_addr,
        "model": state.model,
    }))
}

async fn models(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "object": "list",
        "data": [
            {
                "id": state.model,
                "object": "model",
                "created": 0,
                "owned_by": "penumbra"
            }
        ]
    }))
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<OpenAiChatCompletionRequest>,
) -> Result<Json<serde_json::Value>, Response> {
    if req.stream {
        return Err(openai_error(
            StatusCode::BAD_REQUEST,
            "streaming is not supported by this Understand proxy",
        ));
    }

    let response_model = req.model.clone().unwrap_or_else(|| state.model.clone());
    let (utterance, history) = openai_messages_to_understand(req.messages)?;
    let run_id = headers
        .get("x-ai-mic-run-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| format!("openai-{}", uuid::Uuid::new_v4()));

    let mut client = AiBusServiceClient::connect(state.grpc_addr.clone())
        .await
        .map_err(|error| {
            openai_error(
                StatusCode::BAD_GATEWAY,
                &format!("gRPC connect failed: {error}"),
            )
        })?;

    let mut grpc_request = GrpcRequest::new(SynapseUnderstandingRequest {
        utterance,
        device_context: if history.is_empty() {
            None
        } else {
            Some(SynapseDeviceContext {
                turns: history,
                ..Default::default()
            })
        },
        ..Default::default()
    });
    grpc_request.metadata_mut().insert(
        "x-ai-mic-run-id",
        MetadataValue::try_from(run_id.as_str()).map_err(|error| {
            openai_error(StatusCode::BAD_REQUEST, &format!("invalid run id: {error}"))
        })?,
    );

    let mut stream = client
        .understand(grpc_request)
        .await
        .map_err(|error| {
            openai_error(
                StatusCode::BAD_GATEWAY,
                &format!("Understand failed: {error}"),
            )
        })?
        .into_inner();
    let response = stream
        .message()
        .await
        .map_err(|error| {
            openai_error(
                StatusCode::BAD_GATEWAY,
                &format!("Understand stream failed: {error}"),
            )
        })?
        .ok_or_else(|| openai_error(StatusCode::BAD_GATEWAY, "Understand returned no responses"))?;

    let text = extract_respond_text(&response).ok_or_else(|| {
        openai_error(
            StatusCode::BAD_GATEWAY,
            "Understand response did not contain a Respond action",
        )
    })?;

    Ok(Json(serde_json::json!({
        "id": format!("chatcmpl-{run_id}"),
        "object": "chat.completion",
        "created": chrono::Utc::now().timestamp(),
        "model": response_model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": text
                },
                "finish_reason": "stop"
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0
        }
    })))
}

#[allow(clippy::result_large_err)]
fn openai_messages_to_understand(
    messages: Vec<OpenAiChatMessage>,
) -> Result<(String, Vec<proto::aibus::SynapseChatTurn>), Response> {
    let mut turns = Vec::new();
    let mut last_user_idx = None;

    for message in messages {
        if message.content.trim().is_empty() {
            continue;
        }

        match message.role.as_str() {
            "user" => {
                last_user_idx = Some(turns.len());
                turns.push(proto::aibus::SynapseChatTurn {
                    user: SynapseUser::User as i32,
                    content: Some(synapse_chat_turn::Content::UserRequest(
                        proto::aibus::SynapseUserRequestContent {
                            request: message.content,
                            is_verbal: true,
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                });
            }
            "assistant" => turns.push(proto::aibus::SynapseChatTurn {
                user: SynapseUser::Assistant as i32,
                content: Some(synapse_chat_turn::Content::Action(SynapseActionContent {
                    action: crate::tier_a::native_actions::RESPOND.to_string(),
                    input: serde_json::json!({ "Response": message.content }).to_string(),
                    ..Default::default()
                })),
                ..Default::default()
            }),
            "system" => turns.push(proto::aibus::SynapseChatTurn {
                user: SynapseUser::System as i32,
                content: Some(synapse_chat_turn::Content::Message(SynapseMessageContent {
                    content: message.content,
                })),
                ..Default::default()
            }),
            other => {
                return Err(openai_error(
                    StatusCode::BAD_REQUEST,
                    &format!("unsupported message role: {other}"),
                ));
            }
        }
    }

    let Some(last_user_idx) = last_user_idx else {
        return Err(openai_error(
            StatusCode::BAD_REQUEST,
            "at least one user message is required",
        ));
    };

    let current_user_turn = turns.remove(last_user_idx);
    let Some(synapse_chat_turn::Content::UserRequest(user_request)) = current_user_turn.content
    else {
        return Err(openai_error(
            StatusCode::BAD_REQUEST,
            "last user message could not be converted",
        ));
    };

    Ok((user_request.request, turns))
}

fn extract_respond_text(response: &proto::aibus::SynapseUnderstandingResponse) -> Option<String> {
    let synapse_understanding_response::Body::Turn(turn) = response.body.as_ref()? else {
        return None;
    };
    let synapse_chat_turn::Content::Action(action) = turn.content.as_ref()? else {
        return None;
    };

    if action.action != crate::tier_a::native_actions::RESPOND {
        return None;
    }

    let value = serde_json::from_str::<serde_json::Value>(&action.input).ok()?;
    value
        .get("Response")
        .and_then(|response| response.as_str())
        .map(str::to_string)
}

fn openai_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": {
                "message": message,
                "type": "invalid_request_error",
                "code": null
            }
        })),
    )
        .into_response()
}
