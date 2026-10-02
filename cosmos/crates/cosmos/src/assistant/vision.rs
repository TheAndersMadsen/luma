//! One multimodal call through the assistant provider selected in Center.

use base64::Engine as _;
use image::ImageDecoder as _;
use serde_json::{Value, json};
use std::{future::Future, sync::OnceLock, time::Duration};

/// A vision call the Pin waits on. The Pin gives `AnalyzeImage` 15 s (ironman
/// `AIBusService.analyzeImage`, `withDeadlineAfter(15L, SECONDS)`), so Cosmos
/// answers inside it, with time for the reply to travel back, and the wearer
/// hears Luma's own "unavailable" line instead of the Pin's timeout.
pub(crate) const DEVICE_LIMIT: Duration = Duration::from_secs(13);

/// A vision call no one is waiting on: Best Shot, private visual indexing and
/// Center's provider test. It still ends, so a stalled provider cannot hold a
/// ranking permit or the indexing run forever.
pub(crate) const BACKGROUND_LIMIT: Duration = Duration::from_secs(20);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, thiserror::Error)]
pub enum VisionError {
    #[error("image input is malformed, unsupported, or exceeds the supported bounds")]
    InvalidImage,
    #[error("the configured assistant does not support image input")]
    Unsupported,
    #[error("the vision provider did not answer")]
    Transport,
    #[error("the vision provider returned no text")]
    Malformed,
}

/// INFERRED outbound privacy policy shared by stock AnalyzeImage, capture
/// ranking and the connection test: image metadata is not needed by a model.
/// Stock AiBusBridge.analyzeImage sends JPEG bytes. Preserve its compressed
/// pixels. Static PNG/WebP are losslessly rewritten. Animated formats are
/// refused instead of silently discarding frames. Bound decode allocations.
fn sanitize_image_urls(image_urls: &[String]) -> Result<Vec<String>, VisionError> {
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    if image_urls.is_empty() || image_urls.len() > 8 {
        return Err(VisionError::InvalidImage);
    }
    image_urls
        .iter()
        .map(|url| {
            if url.len() > MAX_BYTES.div_ceil(3) * 4 + 128 {
                return Err(VisionError::InvalidImage);
            }
            let (prefix, encoded) = url.split_once(",").ok_or(VisionError::InvalidImage)?;
            if !prefix.starts_with("data:image/") || !prefix.ends_with(";base64") {
                return Err(VisionError::InvalidImage);
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| VisionError::InvalidImage)?;
            if bytes.is_empty() || bytes.len() > MAX_BYTES {
                return Err(VisionError::InvalidImage);
            }
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(4096);
            limits.max_image_height = Some(4096);
            limits.max_alloc = Some(64 * 1024 * 1024);
            let cursor = std::io::Cursor::new(&bytes);
            let (mime, sanitized) = if bytes.starts_with(&[0xff, 0xd8]) {
                let sanitized = crate::services::capture::strip_jpeg_metadata(&bytes)
                    .map_err(|_| VisionError::InvalidImage)?;
                let mut reader = image::ImageReader::with_format(cursor, image::ImageFormat::Jpeg);
                reader.limits(limits);
                reader.decode().map_err(|_| VisionError::InvalidImage)?;
                ("image/jpeg", sanitized)
            } else {
                let decoded = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                    let decoder = image::codecs::png::PngDecoder::with_limits(cursor, limits)
                        .map_err(|_| VisionError::InvalidImage)?;
                    if decoder.is_apng().map_err(|_| VisionError::InvalidImage)? {
                        return Err(VisionError::InvalidImage);
                    }
                    image::DynamicImage::from_decoder(decoder)
                } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                    let mut decoder = image::codecs::webp::WebPDecoder::new(cursor)
                        .map_err(|_| VisionError::InvalidImage)?;
                    if decoder.has_animation() {
                        return Err(VisionError::InvalidImage);
                    }
                    decoder
                        .set_limits(limits)
                        .map_err(|_| VisionError::InvalidImage)?;
                    image::DynamicImage::from_decoder(decoder)
                } else {
                    return Err(VisionError::InvalidImage);
                }
                .map_err(|_| VisionError::InvalidImage)?;
                let mut out = std::io::Cursor::new(Vec::new());
                decoded
                    .write_to(&mut out, image::ImageFormat::Png)
                    .map_err(|_| VisionError::InvalidImage)?;
                ("image/png", out.into_inner())
            };
            Ok(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(sanitized)
            ))
        })
        .collect()
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

/// Describe `image_urls` with the assistant provider selected in Center. The
/// whole call, the provider's reply body included, ends within `limit`
/// ([`DEVICE_LIMIT`] or [`BACKGROUND_LIMIT`]).
pub async fn complete(
    prompt: &str,
    image_urls: &[String],
    limit: Duration,
) -> Result<String, VisionError> {
    if image_urls.is_empty() {
        return Err(VisionError::Malformed);
    }
    let config = crate::integrations::active().snapshot().assistant;
    within(limit, async {
        match config.provider {
            crate::integrations::AssistantProvider::OpenAiCompatible if config.configured() => {
                let api_key = config.api_key.as_deref().ok_or(VisionError::Unsupported)?;
                openai_complete(
                    client(),
                    &config.base_url,
                    api_key,
                    &config.model,
                    prompt,
                    image_urls,
                )
                .await
            }
            crate::integrations::AssistantProvider::CodexSubscription if config.configured() => {
                let image_urls = sanitize_image_urls(image_urls)?;
                let output = crate::assistant::codex_app_server::complete_with_images(
                    &config.model,
                    config.reasoning_effort.as_deref(),
                    config.fast_mode,
                    prompt.to_owned(),
                    &image_urls,
                    false,
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
    })
    .await
}

/// `call`, or [`VisionError::Transport`] once `limit` passes.
async fn within(
    limit: Duration,
    call: impl Future<Output = Result<String, VisionError>>,
) -> Result<String, VisionError> {
    tokio::time::timeout(limit, call)
        .await
        .map_err(|_| VisionError::Transport)?
}

/// One OpenAI-compatible multimodal chat completion.
pub(crate) async fn openai_complete(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    image_urls: &[String],
) -> Result<String, VisionError> {
    let image_urls = sanitize_image_urls(image_urls)?;
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    content.extend(
        image_urls.iter().map(
            |url| json!({ "type": "image_url", "image_url": { "url": url, "detail": "low" } }),
        ),
    );
    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "Describe only what the supplied images support. Do not identify people or infer sensitive traits."
            },
            { "role": "user", "content": content }
        ],
        "max_tokens": 1024
    });
    let response = client
        .post(format!(
            "{}/chat/completions",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|_| VisionError::Transport)?
        .error_for_status()
        .map_err(|_| VisionError::Transport)?;
    let value: Value = response.json().await.map_err(|_| VisionError::Malformed)?;
    response_text(&value).ok_or(VisionError::Malformed)
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
