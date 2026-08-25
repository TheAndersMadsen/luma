//! Best-frame selection and private visual-search metadata for Pin photos.
//!
//! The photography app uploads every frame and thumbnail in a stock photo
//! burst. Cosmos asks the operator-selected multimodal assistant to choose the
//! best frame and describe visible content, then falls back to a deterministic
//! quality score when vision is unavailable. Every original remains stored.

use base64::Engine as _;
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const MAX_CONCURRENT_RANKINGS: usize = 2;

const MAX_REASON_CHARS: usize = 180;
const MAX_CAPTION_CHARS: usize = 240;
const MAX_TAG_CHARS: usize = 48;
const MAX_TAGS: usize = 24;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BestFrameSelection {
    pub frame: usize,
    /// `vision_v1`, `quality_v1`, or `manual`.
    pub method: String,
    pub reason: String,
    /// Private visual-search metadata; capture API responses never expose it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub caption: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl BestFrameSelection {
    pub(crate) fn has_visual_index(&self) -> bool {
        !self.caption.is_empty() || !self.tags.is_empty()
    }
}

#[derive(Deserialize)]
struct VisionChoice {
    best_frame: usize,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    caption: String,
    #[serde(default)]
    tags: Vec<String>,
}

fn bounded_text(text: &str, maximum: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(maximum)
        .collect()
}

fn bounded_reason(reason: &str, fallback: &str) -> String {
    let clean = bounded_text(reason, MAX_REASON_CHARS);
    if clean.is_empty() {
        fallback.to_owned()
    } else {
        clean
    }
}

fn normalized_tags(tags: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for tag in tags {
        let clean = tag
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        let clean = clean
            .trim_matches(|character: char| !character.is_alphanumeric())
            .chars()
            .take(MAX_TAG_CHARS)
            .collect::<String>();
        if !clean.is_empty() && !normalized.contains(&clean) {
            normalized.push(clean);
        }
        if normalized.len() == MAX_TAGS {
            break;
        }
    }
    normalized
}

fn json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (start <= end).then_some(&text[start..=end])
}

async fn vision_choice(frames: &[Vec<u8>]) -> Option<BestFrameSelection> {
    static LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let _permit = LIMIT
        .get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_RANKINGS))
        .acquire()
        .await
        .ok()?;
    let image_urls = frames
        .iter()
        .map(|frame| {
            format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(frame)
            )
        })
        .collect::<Vec<_>>();
    let prompt = "These are consecutive frames from one wearable-camera photo burst, in zero-based order. Choose the single best keepsake photo. Prefer a sharp, well-exposed, unobstructed, naturally composed frame. Also describe visible content for private search. Return only JSON: {\"best_frame\":0,\"reason\":\"brief quality reason\",\"caption\":\"objective description, at most 20 words\",\"tags\":[\"specific object\",\"broader category\"]}. Use lower-case tags for visible objects, animals, settings, and activities; include useful broader categories (for example cat, pet, animal). Never name or identify a person, infer sensitive traits, or include text that is not visibly supported.";
    let text = crate::assistant::vision::complete(prompt, &image_urls)
        .await
        .ok()?;
    let choice: VisionChoice = serde_json::from_str(json_object(&text)?).ok()?;
    if choice.best_frame >= frames.len() {
        return None;
    }
    Some(BestFrameSelection {
        frame: choice.best_frame,
        method: "vision_v1".to_owned(),
        reason: bounded_reason(&choice.reason, "Selected by the configured vision model."),
        caption: bounded_text(&choice.caption, MAX_CAPTION_CHARS),
        tags: normalized_tags(&choice.tags),
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
        reason: if frames.len() == 1 {
            "Only one frame was available.".to_owned()
        } else {
            "Selected for sharpness, exposure and contrast.".to_owned()
        },
        caption: String::new(),
        tags: Vec::new(),
    })
}

pub(crate) async fn choose_best_frame(frames: &[Vec<u8>]) -> Option<BestFrameSelection> {
    if frames.is_empty() {
        return None;
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

    #[test]
    fn visual_metadata_is_normalized_and_bounded() {
        let tags = (0..40)
            .map(|index| format!("  Cat {index} !!! "))
            .chain(std::iter::once("CAT 0".to_owned()))
            .collect::<Vec<_>>();
        let normalized = normalized_tags(&tags);
        assert_eq!(normalized.len(), MAX_TAGS);
        assert_eq!(normalized[0], "cat 0");
        assert!(normalized.iter().all(|tag| tag.len() <= MAX_TAG_CHARS));
        assert!(
            bounded_text(&"word ".repeat(100), MAX_CAPTION_CHARS)
                .chars()
                .count()
                <= MAX_CAPTION_CHARS
        );
    }

    #[test]
    fn old_sidecars_deserialize_without_visual_metadata() {
        let selection: BestFrameSelection =
            serde_json::from_str(r#"{"frame":1,"method":"quality_v1","reason":"sharp"}"#).unwrap();
        assert!(!selection.has_visual_index());
    }
}
