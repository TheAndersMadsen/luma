use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// How long a captured image is retained after its last access
const IMAGE_TTL: Duration = Duration::from_secs(300);

/// Hard cap on the number of distinct run images held at once. Oldest entries are evicted first when exceeded
// TODO: This is not purged on a timer
const MAX_IMAGES: usize = 16;

/// Run ids are transport metadata, normally UUID-sized. Keep malformed or sentinel
/// metadata from becoming a shared cache key across otherwise unrelated requests.
const MAX_RUN_ID_BYTES: usize = 128;

/// A store for captured VLM images, keyed by run id, with automatic eviction of old entries
///
/// This is used to pass images from AnalyzeImage to later Understand calls without needing to resend the image bytes through gRPC
/// or re-capture them on the device
#[derive(Clone)]
pub struct LiveImageStore {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
    next_generation: Arc<AtomicU64>,
}

struct Entry {
    generation: CaptureGeneration,
    bytes: Vec<u8>,
    question: String,
    hints: Vec<String>,
    observation: Option<String>,
    last_access: Instant,
}

/// Opaque identity for one exact in-memory capture insertion. It contains no
/// image, prompt, hash, or other user-derived material and is never persisted
/// or logged. Replacing a run-id entry always produces a new generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CaptureGeneration(u64);

/// Bounded request context retained only for the current live camera run.
/// Image/OCR content is never persisted by this store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedImage {
    pub bytes: Vec<u8>,
    pub question: String,
    pub hints: Vec<String>,
    pub observation: Option<String>,
}

impl LiveImageStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            next_generation: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Store image bytes under a run id
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn put(&self, run_id: &str, bytes: Vec<u8>) {
        let _ = self
            .put_capture(run_id, bytes, String::new(), Vec::new())
            .await;
    }

    /// Store one camera capture and its sanitized, bounded request context.
    pub async fn put_capture(
        &self,
        run_id: &str,
        bytes: Vec<u8>,
        question: String,
        hints: Vec<String>,
    ) -> Option<CaptureGeneration> {
        if !valid_run_id(run_id) {
            return None;
        }

        let generation = CaptureGeneration(self.next_generation.fetch_add(1, Ordering::Relaxed));

        let mut map = self.inner.lock().await;

        prune(&mut map);

        map.insert(
            run_id.to_string(),
            Entry {
                generation,
                bytes,
                question,
                hints,
                observation: None,
                last_access: Instant::now(),
            },
        );
        Some(generation)
    }

    /// Attach an observation only if this run still points to the exact capture
    /// generation that started the asynchronous analysis. A replaced/expired
    /// capture fails closed and is not refreshed.
    pub async fn set_observation(
        &self,
        run_id: &str,
        generation: CaptureGeneration,
        observation: String,
    ) -> bool {
        if !valid_run_id(run_id) {
            return false;
        }

        let mut map = self.inner.lock().await;
        prune(&mut map);
        let Some(entry) = map.get_mut(run_id) else {
            return false;
        };
        if entry.generation != generation {
            return false;
        }
        entry.observation = Some(observation);
        entry.last_access = Instant::now();
        true
    }

    /// Remove only the exact capture generation owned by a revoked request.
    /// A stale cleanup can never erase a newer capture that reused the same
    /// transport run id.
    pub(crate) async fn remove_if_generation(
        &self,
        run_id: &str,
        generation: CaptureGeneration,
    ) -> bool {
        if !valid_run_id(run_id) {
            return false;
        }

        let mut map = self.inner.lock().await;
        prune(&mut map);
        if !map
            .get(run_id)
            .is_some_and(|entry| entry.generation == generation)
        {
            return false;
        }
        map.remove(run_id);
        true
    }

    // Retained for potential future use in current-turn image resolution; unused after R-001 history strip
    #[allow(dead_code)]
    /// Fetch image bytes for a run id, refreshing its expiry on hit
    pub async fn get_refresh(&self, run_id: &str) -> Option<Vec<u8>> {
        self.get_capture_refresh(run_id)
            .await
            .map(|capture| capture.bytes)
    }

    /// Fetch the current live capture and request context, refreshing expiry.
    pub async fn get_capture_refresh(&self, run_id: &str) -> Option<CapturedImage> {
        if !valid_run_id(run_id) {
            return None;
        }

        let mut map = self.inner.lock().await;

        prune(&mut map);

        let entry = map.get_mut(run_id)?;
        entry.last_access = Instant::now();

        Some(CapturedImage {
            bytes: entry.bytes.clone(),
            question: entry.question.clone(),
            hints: entry.hints.clone(),
            observation: entry.observation.clone(),
        })
    }
}

fn valid_run_id(run_id: &str) -> bool {
    let trimmed = run_id.trim();
    !trimmed.is_empty()
        && run_id.len() <= MAX_RUN_ID_BYTES
        && !trimmed.eq_ignore_ascii_case("unknown")
        && !run_id.chars().any(char::is_control)
}

/// Drop expired entries and enforce the size cap by evicting the least-recently-accessed entries
fn prune(map: &mut HashMap<String, Entry>) {
    map.retain(|_, entry| entry.last_access.elapsed() < IMAGE_TTL);

    if map.len() <= MAX_IMAGES {
        return;
    }

    let mut ordered: Vec<(String, Instant)> = map
        .iter()
        .map(|(run_id, entry)| (run_id.clone(), entry.last_access))
        .collect();

    ordered.sort_by_key(|(_, last_access)| Reverse(*last_access));

    let keep: HashSet<String> = ordered
        .into_iter()
        .take(MAX_IMAGES)
        .map(|(run_id, _)| run_id)
        .collect();

    map.retain(|run_id, _| keep.contains(run_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invalid_run_ids() -> Vec<String> {
        vec![
            String::new(),
            "   ".into(),
            "unknown".into(),
            "UnKnOwN".into(),
            "  UNKNOWN  ".into(),
            "x".repeat(MAX_RUN_ID_BYTES + 1),
            "run\nid".into(),
            "run\u{0000}id".into(),
        ]
    }

    fn entry(bytes: Vec<u8>) -> Entry {
        Entry {
            generation: CaptureGeneration(1),
            bytes,
            question: String::new(),
            hints: Vec::new(),
            observation: None,
            last_access: Instant::now(),
        }
    }

    #[tokio::test]
    async fn put_then_get_returns_bytes() {
        let store = LiveImageStore::new();
        store.put("run-a", vec![1, 2, 3]).await;
        assert_eq!(store.get_refresh("run-a").await, Some(vec![1, 2, 3]));
    }

    #[tokio::test]
    async fn miss_returns_none() {
        let store = LiveImageStore::new();
        assert_eq!(store.get_refresh("nope").await, None);
    }

    #[tokio::test]
    async fn invalid_run_ids_are_rejected_on_put() {
        for run_id in invalid_run_ids() {
            let store = LiveImageStore::new();
            store.put(&run_id, vec![1, 2, 3]).await;
            assert!(
                store.inner.lock().await.is_empty(),
                "invalid run id was cached: {run_id:?}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_run_ids_are_rejected_on_get() {
        for run_id in invalid_run_ids() {
            let store = LiveImageStore::new();
            store
                .inner
                .lock()
                .await
                .insert(run_id.clone(), entry(vec![1, 2, 3]));
            assert_eq!(
                store.get_capture_refresh(&run_id).await,
                None,
                "invalid run id was readable: {run_id:?}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_run_ids_are_rejected_on_set_observation() {
        for run_id in invalid_run_ids() {
            let store = LiveImageStore::new();
            store
                .inner
                .lock()
                .await
                .insert(run_id.clone(), entry(vec![1, 2, 3]));
            store
                .set_observation(&run_id, CaptureGeneration(1), "must not be stored".into())
                .await;
            assert_eq!(
                store
                    .inner
                    .lock()
                    .await
                    .get(&run_id)
                    .and_then(|entry| entry.observation.as_deref()),
                None,
                "invalid run id was mutable: {run_id:?}"
            );
        }
    }

    #[tokio::test]
    async fn get_refresh_can_be_read_repeatedly() {
        let store = LiveImageStore::new();
        store.put("run-a", vec![9]).await;
        assert_eq!(store.get_refresh("run-a").await, Some(vec![9]));
        // A second follow-up against the same image still hits.
        assert_eq!(store.get_refresh("run-a").await, Some(vec![9]));
    }

    #[tokio::test]
    async fn capture_context_and_observation_are_live_and_bounded_with_the_image() {
        let store = LiveImageStore::new();
        let generation = store
            .put_capture(
                "run-a",
                vec![1, 2],
                "What is this?".into(),
                vec!["food".into()],
            )
            .await
            .unwrap();
        assert!(
            store
                .set_observation("run-a", generation, "It looks like an apple.".into(),)
                .await
        );
        assert_eq!(
            store.get_capture_refresh("run-a").await,
            Some(CapturedImage {
                bytes: vec![1, 2],
                question: "What is this?".into(),
                hints: vec!["food".into()],
                observation: Some("It looks like an apple.".into()),
            })
        );
    }

    #[tokio::test]
    async fn older_async_completion_cannot_annotate_replacement_capture() {
        let store = LiveImageStore::new();
        let older = store
            .put_capture("shared-run", vec![1], "first question".into(), Vec::new())
            .await
            .unwrap();
        let newer = store
            .put_capture("shared-run", vec![2], "second question".into(), Vec::new())
            .await
            .unwrap();
        let replacement_last_access = store
            .inner
            .lock()
            .await
            .get("shared-run")
            .unwrap()
            .last_access;

        // Deterministically model the first provider call completing after the
        // second capture replaced it under the same transport run id.
        assert!(
            !store
                .set_observation("shared-run", older, "stale first result".into())
                .await
        );
        assert_eq!(
            store
                .inner
                .lock()
                .await
                .get("shared-run")
                .unwrap()
                .last_access,
            replacement_last_access,
            "a stale completion must not extend the replacement capture TTL"
        );
        assert_eq!(
            store.get_capture_refresh("shared-run").await,
            Some(CapturedImage {
                bytes: vec![2],
                question: "second question".into(),
                hints: Vec::new(),
                observation: None,
            })
        );

        assert!(
            store
                .set_observation("shared-run", newer, "current second result".into())
                .await
        );
        assert_eq!(
            store
                .get_capture_refresh("shared-run")
                .await
                .and_then(|capture| capture.observation),
            Some("current second result".into())
        );
    }

    #[tokio::test]
    async fn generation_conditional_removal_preserves_a_newer_replacement() {
        let store = LiveImageStore::new();
        let older = store
            .put_capture("shared-run", vec![1], "first question".into(), Vec::new())
            .await
            .unwrap();
        let newer = store
            .put_capture("shared-run", vec![2], "second question".into(), Vec::new())
            .await
            .unwrap();

        assert!(!store.remove_if_generation("shared-run", older).await);
        assert_eq!(store.get_refresh("shared-run").await, Some(vec![2]));
        assert!(store.remove_if_generation("shared-run", newer).await);
        assert!(store.get_capture_refresh("shared-run").await.is_none());
    }

    #[tokio::test]
    async fn capacity_evicts_least_recently_accessed() {
        let store = LiveImageStore::new();
        // Fill beyond capacity; oldest insert (run-0) is dropped.
        for i in 0..(MAX_IMAGES + 1) {
            store.put(&format!("run-{i}"), vec![i as u8]).await;
        }
        assert_eq!(store.get_refresh("run-0").await, None);
        // The newest entry survives.
        assert_eq!(
            store.get_refresh(&format!("run-{MAX_IMAGES}")).await,
            Some(vec![MAX_IMAGES as u8])
        );
    }

    #[tokio::test]
    async fn expired_entries_are_pruned() {
        let store = LiveImageStore::new();
        store.put("run-a", vec![1]).await;
        // Force the entry's last_access well past the TTL.
        {
            let mut map = store.inner.lock().await;
            if let Some(entry) = map.get_mut("run-a") {
                entry.last_access = Instant::now() - IMAGE_TTL - Duration::from_secs(1);
            }
        }
        assert_eq!(store.get_refresh("run-a").await, None);
    }
}
