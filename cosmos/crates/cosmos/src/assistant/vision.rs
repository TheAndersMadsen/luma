//! One multimodal call through the assistant provider selected in Center.

use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};

const VISION_TIMEOUT: Duration = Duration::from_secs(20);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, thiserror::Error)]
pub enum VisionError {
    #[error("the configured assistant does not support image input")]
    Unsupported,
    #[error("the vision provider did not answer")]
    Transport,
    #[error("the vision provider returned no text")]
    Malformed,
}

pub fn configured() -> bool {
    let assistant = crate::integrations::active().snapshot().assistant;
    assistant.configured()
        && matches!(
            assistant.provider,
            crate::integrations::AssistantProvider::OpenAiCompatible
                | crate::integrations::AssistantProvider::CodexSubscription
        )
}

pub async fn complete(prompt: &str, image_urls: &[String]) -> Result<String, VisionError> {
    if image_urls.is_empty() {
        return Err(VisionError::Malformed);
    }
    let config = crate::integrations::active().snapshot().assistant;
    match config.provider {
        crate::integrations::AssistantProvider::OpenAiCompatible if config.configured() => {
            let api_key = config.api_key.ok_or(VisionError::Unsupported)?;
            let mut content = vec![json!({ "type": "text", "text": prompt })];
            content.extend(image_urls.iter().map(
                |url| json!({ "type": "image_url", "image_url": { "url": url, "detail": "low" } }),
            ));
            let body = json!({
                "model": config.model,
                "messages": [
                    {
                        "role": "system",
                        "content": "Describe only what the supplied images support. Do not identify people or infer sensitive traits."
                    },
                    { "role": "user", "content": content }
                ],
                "max_tokens": 1024
            });
            let request = client()
                .post(format!(
                    "{}/chat/completions",
                    config.base_url.trim_end_matches('/')
                ))
                .bearer_auth(api_key)
                .json(&body)
                .send();
            let response = tokio::time::timeout(VISION_TIMEOUT, request)
                .await
                .map_err(|_| VisionError::Transport)?
                .map_err(|_| VisionError::Transport)?
                .error_for_status()
                .map_err(|_| VisionError::Transport)?;
            let value: Value = response.json().await.map_err(|_| VisionError::Malformed)?;
            response_text(&value).ok_or(VisionError::Malformed)
        }
        crate::integrations::AssistantProvider::CodexSubscription if config.configured() => {
            let output = crate::assistant::codex_app_server::complete_with_images(
                &config.model,
                config.reasoning_effort.as_deref(),
                prompt.to_owned(),
                image_urls,
            )
            .await
            .map_err(|_| VisionError::Transport)?;
            output
                .content
                .map(|text| text.trim().to_owned())
                .filter(|text| !text.is_empty())
                .ok_or(VisionError::Malformed)
        }
        _ => Err(VisionError::Unsupported),
    }
}

fn response_text(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_owned());
    }
    let text = content
        .as_array()?
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_string_and_part_array_responses() {
        assert_eq!(
            response_text(&json!({ "choices": [{ "message": { "content": " cat " } }] })),
            Some("cat".to_owned())
        );
        assert_eq!(
            response_text(&json!({
                "choices": [{ "message": { "content": [{ "text": "black " }, { "text": "cat" }] } }]
            })),
            Some("black cat".to_owned())
        );
    }
}
