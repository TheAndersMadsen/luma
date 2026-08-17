//! Operator overrides for the feature-flag response.
//!
//! The values in `services::feature_flags` are not preferences — most carry a
//! `carry-raw.log` citation, because they are what the REAL carry cloud served to
//! a stock Pin. That makes them evidence, and evidence should not be edited in
//! place to change a device's behaviour.
//!
//! So overrides live here instead: a separate, persisted layer applied on top of
//! the observed defaults. Three properties follow from that and are the point of
//! the design:
//!
//!   1. The observed value is never lost. It can always be read back, and
//!      clearing an override restores it exactly.
//!   2. An override is visibly a deviation from what carry did, not a silent
//!      redefinition of it.
//!   3. Changes apply to the next flag sync with no rebuild and no restart.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// A flag value, mirroring the three arms the device's `requireType` accepts.
/// Sending the wrong arm makes the stock client throw, so the type is preserved
/// across an override rather than inferred from the new value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum FlagValue {
    Bool(bool),
    Int(i64),
    Text(String),
}

impl FlagValue {
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Bool(_) => "bool",
            Self::Int(_) => "int",
            Self::Text(_) => "text",
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct OverrideFile {
    overrides: BTreeMap<String, FlagValue>,
}

fn path() -> Option<PathBuf> {
    let dir = std::env::var("CARRY_STATE_DIR").ok()?;
    Some(PathBuf::from(dir).join("flag-overrides.json"))
}

#[derive(Default)]
struct Cached {
    map: BTreeMap<String, FlagValue>,
    seen: Option<std::time::SystemTime>,
    loaded: bool,
}

fn cache() -> &'static Mutex<Cached> {
    static STORE: OnceLock<Mutex<Cached>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Cached::default()))
}

/// Read the overrides, reloading if the file changed underneath us.
///
/// The reload is the whole point and was missing at first. Every workload mounts
/// the SAME `carry-state` volume, so an override written by one process lands in
/// a file the others can see — but a load-once cache never looked again. The
/// admin API returned 200, the file on disk was correct, and the device kept
/// receiving the old value, because the process serving flags had cached an empty
/// map at startup. Verifying on the gRPC wire is what exposed it; the API's own
/// response could not.
fn read_through() -> std::sync::MutexGuard<'static, Cached> {
    let mut cached = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mtime = path()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|meta| meta.modified().ok());
    if !cached.loaded || cached.seen != mtime {
        cached.map = path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|text| serde_json::from_str::<OverrideFile>(&text).ok())
            .map(|file| file.overrides)
            .unwrap_or_default();
        cached.seen = mtime;
        cached.loaded = true;
    }
    cached
}

/// Write-and-rename so a crash mid-write cannot leave a truncated file that
/// silently resets every override on the next boot.
fn persist(map: &BTreeMap<String, FlagValue>) {
    let Some(target) = path() else { return };
    let file = OverrideFile {
        overrides: map.clone(),
    };
    let Ok(encoded) = serde_json::to_vec_pretty(&file) else {
        return;
    };
    let temporary = target.with_extension("json.tmp");
    if std::fs::write(&temporary, encoded).is_ok() {
        if let Err(error) = std::fs::rename(&temporary, &target) {
            tracing::warn!(%error, "could not persist flag overrides");
        }
    }
}

thread_local! {
    /// The override map pinned for the duration of one [`scoped`] call.
    ///
    /// Thread-local, like `feature_flags::OBSERVING` next door and for the same
    /// reason: a concurrent request on another thread is building its own
    /// response and must keep reading through to the file.
    static SCOPE: RefCell<Option<Arc<BTreeMap<String, FlagValue>>>> =
        const { RefCell::new(None) };
}

/// Build one answer against ONE read of the override file.
///
/// Every flag in a response used to reach [`get`] independently, and each of
/// those `read_through`s is two `std::env::var` lookups, a `stat` of
/// `$CARRY_STATE_DIR/flag-overrides.json` and a global mutex — for a set of 33
/// flags, 33 of each per `GetFlags`, and 166 per `/demo-api/flags` because the
/// admin view rebuilds the whole set again for every overridden key.
///
/// Pinning the map is also the more correct reading, not just the cheaper one.
/// An operator `set()` landing midway through a build used to be able to serve
/// half a response from the old map and half from the new; the device applies
/// `defineAllServerFlags` as a full replace, so that mixture would have been
/// installed as if it were one coherent assignment set.
pub fn scoped<T>(body: impl FnOnce() -> T) -> T {
    // Reentrancy: `observed_value` runs a nested build inside the admin path.
    // The outer pin is restored on the way out rather than cleared, so a nested
    // call cannot silently unpin its caller.
    //
    // Restored from a `Drop`, not from a statement after `body()`, because these
    // run on tokio worker threads that outlive any one request. A panic inside a
    // handler would otherwise leave this thread pinned to the map that was
    // current when it failed, and every later response built on that worker
    // would serve overrides frozen at that moment — with nothing to point at,
    // because the file on disk would be correct.
    struct Restore(Option<Arc<BTreeMap<String, FlagValue>>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take();
            SCOPE.with(|scope| *scope.borrow_mut() = previous);
        }
    }

    let pinned = Arc::new(read_through().map.clone());
    let _restore = Restore(SCOPE.with(|scope| scope.borrow_mut().replace(pinned)));
    body()
}

/// The override for `key`, if an operator set one.
pub fn get(key: &str) -> Option<FlagValue> {
    if let Some(pinned) = SCOPE.with(|scope| scope.borrow().clone()) {
        return pinned.get(key).cloned();
    }
    read_through().map.get(key).cloned()
}

/// All overrides currently in force.
pub fn all() -> BTreeMap<String, FlagValue> {
    read_through().map.clone()
}

/// Set an override. Returns the previous one, if any.
pub fn set(key: &str, value: FlagValue) -> Option<FlagValue> {
    let mut cached = read_through();
    let previous = cached.map.insert(key.to_owned(), value);
    let snapshot = cached.map.clone();
    drop(cached);
    persist(&snapshot);
    // Drop the mtime so this process re-reads its own write and stays in step
    // with whatever another workload may have written concurrently.
    if let Ok(mut cached) = cache().lock() {
        cached.seen = None;
    }
    previous
}

/// Clear an override, restoring the observed default.
pub fn clear(key: &str) -> Option<FlagValue> {
    let mut cached = read_through();
    let previous = cached.map.remove(key);
    let snapshot = cached.map.clone();
    drop(cached);
    persist(&snapshot);
    if let Ok(mut cached) = cache().lock() {
        cached.seen = None;
    }
    previous
}

/// Clear every override at once — the "put it back the way carry had it" button.
pub fn clear_all() -> usize {
    let mut cached = read_through();
    let count = cached.map.len();
    cached.map.clear();
    drop(cached);
    persist(&BTreeMap::new());
    if let Ok(mut cached) = cache().lock() {
        cached.seen = None;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_override_preserves_its_declared_type() {
        assert_eq!(FlagValue::Bool(true).type_name(), "bool");
        assert_eq!(FlagValue::Int(7).type_name(), "int");
        assert_eq!(FlagValue::Text("x".into()).type_name(), "text");
    }

    /// One response is built from ONE reading of the overrides.
    ///
    /// This is the property [`scoped`] exists for, and it is a correctness
    /// property before it is a cost one: the device applies a flag response as a
    /// full replace, so a `set()` landing midway through a build must not be
    /// able to produce a response that is half old and half new. Asserted by
    /// making the change *during* the scope and requiring the pinned answer.
    #[test]
    fn a_scope_pins_one_reading_of_the_overrides() {
        let key = "a_scope_pins_one_reading";
        let before = get(key);

        scoped(|| {
            assert_eq!(get(key), before, "the scope starts from what is on disk");
            // A concurrent operator write, simulated in-process.
            set(key, FlagValue::Bool(true));
            assert_eq!(
                get(key),
                before,
                "a write during a build must not reach the response being built",
            );
        });

        // Outside the scope the write is visible, so nothing is being cached
        // beyond the one response it was pinned for.
        assert_eq!(get(key), Some(FlagValue::Bool(true)));
        clear(key);
        assert_eq!(get(key), None);
    }

    /// A panicking build unpins the thread it ran on.
    ///
    /// These run on tokio workers that serve request after request, so a scope
    /// left pinned by a failed handler would freeze that worker's view of the
    /// overrides for the life of the process.
    #[test]
    fn a_panicking_scope_still_unpins_the_thread() {
        let key = "a_panicking_scope_unpins";
        let panicked = std::panic::catch_unwind(|| {
            scoped(|| {
                set(key, FlagValue::Bool(true));
                panic!("a handler failed mid-build");
            })
        });
        assert!(panicked.is_err(), "the panic propagates");
        assert_eq!(
            get(key),
            Some(FlagValue::Bool(true)),
            "the thread reads through again rather than staying pinned",
        );
        clear(key);
    }

    /// A nested build — `feature_flags::observed_value` runs one inside the
    /// admin path — restores its caller's pin rather than clearing it.
    #[test]
    fn a_nested_scope_restores_the_outer_one() {
        let key = "a_nested_scope_restores";
        scoped(|| {
            set(key, FlagValue::Int(1));
            scoped(|| {
                assert_eq!(
                    get(key),
                    Some(FlagValue::Int(1)),
                    "the inner scope re-reads"
                );
            });
            assert_eq!(
                get(key),
                None,
                "the outer pin is back, not the inner scope's reading",
            );
        });
        clear(key);
    }

    /// The serialized form is what survives a restart, so it is pinned: a change
    /// here silently drops every operator override on the next deploy.
    #[test]
    fn the_persisted_shape_round_trips() {
        let mut map = BTreeMap::new();
        map.insert(
            "synapse_bidirectional_streaming".to_owned(),
            FlagValue::Bool(true),
        );
        map.insert("touchcode_timeout_millis".to_owned(), FlagValue::Int(9000));
        map.insert(
            "server_side_speech_synthesis_voice_name".to_owned(),
            FlagValue::Text("en-US-Ava".into()),
        );
        let encoded = serde_json::to_string(&OverrideFile {
            overrides: map.clone(),
        })
        .unwrap();
        let decoded: OverrideFile = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.overrides, map);
        assert!(
            encoded.contains(r#""type":"bool""#),
            "type tag must survive: {encoded}"
        );
    }
}
