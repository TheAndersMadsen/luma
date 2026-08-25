//! Best-frame selection for stock three-frame photo bursts.
//!
//! `observed`: the photography app asks CCAPS for `numPhotosPerBurst`, defaults
//! that value to three, uploads every resulting frame and (when
//! `humane_capture_upload_3_thumbnails` is true, as shipped) every thumbnail.
//! Recovered Center also exposes `POST /memory/{uuid}/best_photo` and
//! `POST /memory/{uuid}/bestFrame?frame={n}`.
//!
//! The original server-side model and prompt are `unknown`. This module is an
//! independently implemented replacement: it asks the operator-configured
//! multimodal model to compare the three opened thumbnails and falls back to a
//! deterministic image-quality score when no model is configured or reachable.
//! All originals remain stored; selection changes only which frame Center uses
//! as the hero image.

use base64::Engine as _;
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MODEL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REASON_CHARS: usize = 180;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BestFrameSelection {
    pub frame: usize,
    /// `vision_v1`, `quality_v1`, or `manual`.
    pub method: String,
    pub reason: String,
}

#[derive(Deserialize)]
struct VisionChoice {
    best_frame: usize,
    #[serde(default)]
    reason: String,
}

fn bounded_reason(reason: &str, fallback: &str) -> String {
    let clean = reason.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = if clean.is_empty() { fallback } else { &clean };
    clean.chars().take(MAX_REASON_CHARS).collect()
}

fn json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (start <= end).then_some(&text[start..=end])
}

async fn vision_choice(frames: &[Vec<u8>]) -> Option<BestFrameSelection> {
    let config = crate::integrations::active().snapshot().assistant;
    if config.provider != crate::integrations::AssistantProvider::OpenAiCompatible
        || !config.configured()
    {
        return None;
    }
    let base_url = config.base_url;
    let api_key = config.api_key?;
    let model = config.model;

    let mut content = vec![serde_json::json!({
        "type": "text",
        "text": "These are consecutive frames from one wearable-camera photo burst, in zero-based order. Choose the single best keepsake photo. Prefer a sharp, well-exposed, unobstructed, naturally composed frame; avoid blink, motion blur and accidental occlusion. Return only JSON: {\"best_frame\":0,\"reason\":\"brief non-sensitive quality reason\"}."
    })];
    for frame in frames {
        content.push(serde_json::json!({
            "type": "image_url",
            "image_url": {
                "url": format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(frame)
                )
            }
        }));
    }
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "Select image quality only. Do not identify people, infer sensitive traits, or describe private scene contents."
            },
            { "role": "user", "content": content }
        ],
        // Reasoning models count hidden analysis against the completion cap.
        // 120 cut a real production answer off at `{"best_frame`; minimal
        // reasoning plus 512 leaves room for the tiny JSON contract to finish.
        "reasoning": { "effort": "minimal", "exclude": true },
        "max_tokens": 512
    });
    let request = reqwest::Client::new()
        .post(format!(
            "{}/chat/completions",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(api_key)
        .json(&body)
        .send();
    let response = tokio::time::timeout(MODEL_TIMEOUT, request)
        .await
        .ok()?
        .ok()?;
    let response = response.error_for_status().ok()?;
    let value: serde_json::Value = response.json().await.ok()?;
    let text = value
        .pointer("/choices/0/message/content")?
        .as_str()?
        .trim();
    let choice: VisionChoice = serde_json::from_str(json_object(text)?).ok()?;
    if choice.best_frame >= frames.len() {
        return None;
    }
    Some(BestFrameSelection {
        frame: choice.best_frame,
        method: "vision_v1".to_owned(),
        reason: bounded_reason(&choice.reason, "Selected by the configured vision model."),
    })
}

/// Variance of a four-neighbour Laplacian over a bounded grayscale preview.
/// High variance favours real edge detail over motion/defocus blur.
fn sharpness(image: &DynamicImage) -> f64 {
    let gray = image.thumbnail(256, 256).to_luma8();
    let (width, height) = gray.dimensions();
    if width < 3 || height < 3 {
        return 0.0;
    }
    let mut count = 0.0;
    let mut sum = 0.0;
    let mut sum_sq = 0.0;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let center = gray.get_pixel(x, y)[0] as f64;
            let lap = 4.0 * center
                - gray.get_pixel(x - 1, y)[0] as f64
                - gray.get_pixel(x + 1, y)[0] as f64
                - gray.get_pixel(x, y - 1)[0] as f64
                - gray.get_pixel(x, y + 1)[0] as f64;
            count += 1.0;
            sum += lap;
            sum_sq += lap * lap;
        }
    }
    let mean = sum / count;
    (sum_sq / count - mean * mean).max(0.0)
}

fn quality_score(bytes: &[u8]) -> Option<f64> {
    let image = image::load_from_memory(bytes).ok()?;
    let preview = image.thumbnail(256, 256).to_luma8();
    let pixels = preview.pixels().map(|p| p[0] as f64).collect::<Vec<_>>();
    if pixels.is_empty() {
        return None;
    }
    let count = pixels.len() as f64;
    let mean = pixels.iter().sum::<f64>() / count;
    let variance = pixels
        .iter()
        .map(|value| {
            let delta = value - mean;
            delta * delta
        })
        .sum::<f64>()
        / count;
    let clipped = pixels
        .iter()
        .filter(|value| **value < 6.0 || **value > 249.0)
        .count() as f64
        / count;
    let exposure = 1.0 - ((mean - 127.5).abs() / 127.5).min(1.0);
    // Log sharpness prevents one noisy frame from overwhelming exposure and
    // contrast. The values are comparative inside one burst, not universal.
    Some((1.0 + sharpness(&image)).ln() * 2.2 + variance.sqrt() * 0.05 + exposure - clipped * 2.0)
}

fn quality_choice(frames: &[Vec<u8>]) -> Option<BestFrameSelection> {
    let (frame, _) = frames
        .iter()
        .enumerate()
        .filter_map(|(index, bytes)| quality_score(bytes).map(|score| (index, score)))
        .max_by(|left, right| left.1.total_cmp(&right.1))?;
    Some(BestFrameSelection {
        frame,
        method: "quality_v1".to_owned(),
        reason: "Selected for sharpness, exposure and contrast.".to_owned(),
    })
}

pub(crate) async fn choose_best_frame(frames: &[Vec<u8>]) -> Option<BestFrameSelection> {
    if frames.is_empty() {
        return None;
    }
    if frames.len() == 1 {
        return Some(BestFrameSelection {
            frame: 0,
            method: "quality_v1".to_owned(),
            reason: "Only one frame was available.".to_owned(),
        });
    }
    vision_choice(frames)
        .await
        .or_else(|| quality_choice(frames))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_accepts_a_json_object_inside_a_fenced_answer() {
        let text = "```json\n{\"best_frame\":2,\"reason\":\"sharpest\"}\n```";
        let choice: VisionChoice = serde_json::from_str(json_object(text).unwrap()).unwrap();
        assert_eq!(choice.best_frame, 2);
    }

    #[test]
    fn reasons_are_bounded_and_whitespace_normalized() {
        let reason = bounded_reason("  one\n two   three ", "fallback");
        assert_eq!(reason, "one two three");
        assert!(bounded_reason(&"x".repeat(500), "fallback").chars().count() <= MAX_REASON_CHARS);
    }
}
