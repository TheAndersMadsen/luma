//! Local quality-only photo selection. Private visual indexing requires a
//! future origin-scoped runtime service; uploaded frames never reach cognition.

use image::DynamicImage;
use serde::{Deserialize, Serialize};

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
    quality_choice(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_sidecars_deserialize_without_visual_metadata() {
        let selection: BestFrameSelection =
            serde_json::from_str(r#"{"frame":1,"method":"quality_v1","reason":"sharp"}"#).unwrap();
        assert!(!selection.has_visual_index());
    }
}
