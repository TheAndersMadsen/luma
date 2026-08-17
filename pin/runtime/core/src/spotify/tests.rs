use super::*;
use librespot_playback::audio_backend::Sink as _;
use tempfile::tempdir;

#[test]
fn pin_speaker_profile_levels_and_limits_playback() {
    let config = pin_speaker_player_config();

    // The whole point of the profile: without normalisation every track
    // plays at its own master level, so loud masters jump in volume and
    // clip the Pin's small driver. `Dynamic` adds the limiter that keeps
    // those peaks off the rail.
    assert!(config.normalisation);
    assert_eq!(config.normalisation_method, NormalisationMethod::Dynamic);
    // Per-track levelling: the Pin plays individually requested songs, not
    // albums in order, so album-relative gain would leave quiet tracks
    // inaudible on this speaker.
    assert_eq!(config.normalisation_type, NormalisationType::Track);

    // No make-up gain. The platform's speaker calibration is selected by the
    // volume index (the `volume_listener` effect on the music stream), so
    // pre-boosting the signal spends the speaker-protection algorithm's
    // excursion/thermal headroom and buys ramp-down, not loudness.
    assert_eq!(
        config.normalisation_pregain_db, 0.0,
        "pre-boosting fights the platform's volume-indexed speaker calibration",
    );
    // The limiter exists to guard our own digital headroom, not the driver —
    // the driver is already protected in hardware — so the ceiling stays at
    // librespot's default rather than being tightened for "speaker safety".
    assert_eq!(
        config.normalisation_threshold_dbfs,
        PlayerConfig::default().normalisation_threshold_dbfs,
    );

    // Source quality, and the per-track WAV sink contract that gapless
    // playback would violate.
    assert_eq!(config.bitrate, Bitrate::Bitrate320);
    assert!(!config.gapless);
    assert!(!config.passthrough);

    // The sink converts f64 samples to s16; keep librespot's ditherer so
    // that truncation noise does not land on top of quiet passages.
    assert!(config.ditherer.is_some());
}

#[test]
fn artist_top_tracks_backoff_window_is_time_bounded() {
    let now = Instant::now();
    assert!(!artist_top_tracks_backoff_is_active(None, now));
    assert!(artist_top_tracks_backoff_is_active(
        Some(now + Duration::from_secs(1)),
        now,
    ));
    assert!(!artist_top_tracks_backoff_is_active(Some(now), now));
    assert!(!artist_top_tracks_backoff_is_active(
        Some(now),
        now + Duration::from_secs(1),
    ));
}

fn scored_track(id: &str, popularity: Option<u32>) -> SpotifyTrack {
    SpotifyTrack {
        id: id.into(),
        title: "Song".into(),
        artists: vec!["Artist".into()],
        album: "Album".into(),
        duration_ms: 200_000,
        track_number: 1,
        disc_number: 1,
        explicit: false,
        popularity,
    }
}

#[test]
fn popularity_order_describes_the_list_without_reordering_it() {
    // The second, provider-independent opinion on "is this really a ranking?".
    // A top-tracks page descends; a relevance-ordered search generally does
    // not. This must only ever DESCRIBE — the played track stays rank one.
    let descending = [
        scored_track("4uLU6hMCjMI75M1A2tKUQC", Some(90)),
        scored_track("0d28khcov6AiegSCpG5TuT", Some(90)),
        scored_track("1weenld61qoidwYuZ1GESA", Some(41)),
    ];
    assert_eq!(popularity_order(&descending), "descending");

    let jumbled = [
        scored_track("4uLU6hMCjMI75M1A2tKUQC", Some(41)),
        scored_track("0d28khcov6AiegSCpG5TuT", Some(90)),
    ];
    assert_eq!(popularity_order(&jumbled), "mixed");

    // An unscored track must make the answer `unknown`, never a free pass:
    // treating `None` as zero would report any unscored list as perfectly
    // descending, which is exactly the false reassurance this exists to avoid.
    let partly_scored = [
        scored_track("4uLU6hMCjMI75M1A2tKUQC", Some(90)),
        scored_track("0d28khcov6AiegSCpG5TuT", None),
    ];
    assert_eq!(popularity_order(&partly_scored), "unknown");
    assert_eq!(popularity_order(&[]), "descending");
}

#[test]
fn track_popularity_is_parsed_and_stays_absent_when_unscored() {
    // Spotify track objects carry a documented 0-100 `popularity`, the same
    // field `select_artist_id` already reads for artists. Parsing it gives the
    // ordering check a second, independent input.
    let scored = serde_json::json!({
        "tracks": { "items": [{
            "id": "4uLU6hMCjMI75M1A2tKUQC",
            "name": "Billie Jean",
            "artists": [{"name": "Michael Jackson"}],
            "album": {"name": "Thriller"},
            "duration_ms": 293_827,
            "popularity": 86
        }, {
            "id": "0d28khcov6AiegSCpG5TuT",
            "name": "Chicago",
            "artists": [{"name": "Michael Jackson"}],
            "album": {"name": "Xscape"},
            "duration_ms": 227_346
        }]}
    });
    let tracks = parse_track_array(scored.pointer("/tracks/items"), 10);
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0].popularity, Some(86));
    // A trimmed object that omits the field is unscored, not zero-scored.
    assert_eq!(tracks[1].popularity, None);
    // One unscored entry is enough to refuse a monotonicity claim.
    assert_eq!(popularity_order(&tracks), "unknown");

    // The provider's own documented ceiling. A nonsense value is clamped
    // rather than propagated into an ordering comparison.
    let absurd = serde_json::json!({"items": [{
        "id": "4uLU6hMCjMI75M1A2tKUQC",
        "name": "Song",
        "artists": [{"name": "Artist"}],
        "album": {"name": "Album"},
        "duration_ms": 200_000,
        "popularity": 4_000_000_000_u64
    }]});
    assert_eq!(
        parse_track_array(absurd.pointer("/items"), 10)[0].popularity,
        Some(100),
    );
}

/// Ranking provenance is decided inside `query`, on branches that each need a
/// live Spotify session and two provider round-trips, so the decision cannot be
/// exercised from a unit test. Pin it against the source instead: the property
/// that matters is that EVERY exit from the artist branch assigns a provenance
/// and every degraded exit also logs the operational marker. Deleting either
/// assignment turns this red, which is the failure the "Chicago" incident had
/// no way to detect.
#[test]
fn every_artist_ranking_exit_records_its_provenance() {
    // The scanned corpus is `mod.rs`, never this file, so the anchors below
    // cannot match themselves and let the guard pass vacuously.
    const SOURCE: &str = include_str!("mod.rs");
    const DEGRADED_PROVENANCE: &str =
        "ranking = SpotifyRankingProvenance::SearchRelevanceFallback;";
    const RANKED_PROVENANCE: &str = "ranking = SpotifyRankingProvenance::ProviderTopTracks;";
    const DEGRADED_MARKER: &str = "log_degraded_artist_ranking(";
    const FALLBACK_QUERY: &str = "artist_top_tracks_fallback_query(artist_name),";

    // Both degraded exits — the failure that OPENS the backoff window and
    // every request served during it. Only the first used to log at all,
    // which is why a fallback could go unrecorded for ten minutes.
    assert_eq!(
        SOURCE.matches(FALLBACK_QUERY).count(),
        2,
        "the artist branch should have exactly two relevance-search exits",
    );
    assert_eq!(
        SOURCE.matches(DEGRADED_PROVENANCE).count(),
        2,
        "every relevance-search exit must record the degraded provenance",
    );
    assert_eq!(
        SOURCE.matches(DEGRADED_MARKER).count(),
        3,
        "both degraded exits must emit the marker (plus its one definition)",
    );
    assert_eq!(
        SOURCE.matches(RANKED_PROVENANCE).count(),
        1,
        "the provider top-tracks exit must record the provider-ranked provenance",
    );
    // And the decision has to actually reach the response.
    assert!(SOURCE.contains("ranking_provenance: ranking,"));
    // Selection itself must stay untouched: measuring how often the degraded
    // path fires comes BEFORE changing which track plays.
    assert!(
        !SOURCE.contains("sort_by_key(|track| track.popularity"),
        "provenance is a measurement, not a licence to reorder results",
    );
}

fn enabled_spotify_settings() -> SpotifyConfig {
    SpotifyConfig {
        enabled: true,
        experimental_acknowledged: true,
        ..SpotifyConfig::default()
    }
}

fn ready_runtime(session: Session) -> Runtime {
    Runtime {
        state: RuntimeState::Ready {
            username: Some("listener".into()),
        },
        playback_epoch: 0,
        session: Some(session),
        player: None,
        sink_controller: None,
        playback_watcher: None,
        active_buffer: None,
        buffers: HashMap::new(),
        buffer_order: VecDeque::new(),
        tracks: HashMap::new(),
        reconnect_failures: 0,
        reconnect_not_before: None,
        reconnect_error: None,
    }
}

fn test_player(session: Session, controller: &SwitchableWavSinkController) -> Arc<Player> {
    let player_controller = controller.clone();
    Player::new(
        PlayerConfig {
            gapless: false,
            ..PlayerConfig::default()
        },
        session,
        Box::new(NoOpVolume),
        move || Box::new(player_controller.sink()),
    )
}

async fn assert_player_dropped(player: std::sync::Weak<Player>) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while player.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("stale Player must be stopped and dropped off the async worker");
}

fn stored_auth() -> StoredAuth {
    StoredAuth {
        version: AUTH_VERSION,
        device_id: Uuid::new_v4().to_string(),
        credentials: Credentials::with_access_token("never-log-this-token"),
    }
}

#[test]
fn credentials_round_trip_in_private_bounded_artifact() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("spotify-auth.json");
    let auth = stored_auth();
    persist_auth(&path, &auth).unwrap();
    let loaded = load_auth(&path).unwrap();
    assert_eq!(loaded.version, AUTH_VERSION);
    assert_eq!(loaded.credentials.auth_data, b"never-log-this-token");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn stored_auth_debug_surface_never_contains_secret() {
    let auth = stored_auth();
    let status = format!("version={} device={}", auth.version, auth.device_id);
    assert!(!status.contains("never-log-this-token"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_before_player_install_rejects_the_stale_epoch() {
    let session = Session::new(SessionConfig::default(), None);
    let lease = PlaybackLease {
        epoch: 0,
        session_id: session.session_id(),
    };
    let settings = Arc::new(RwLock::new(enabled_spotify_settings()));
    let runtime = Arc::new(Mutex::new(ready_runtime(session.clone())));
    let controller = SwitchableWavSinkController::new();
    let player = test_player(session, &controller);
    let stale_player = Arc::downgrade(&player);
    let player_ready = Arc::new(tokio::sync::Barrier::new(2));
    let teardown_done = Arc::new(tokio::sync::Barrier::new(2));

    let install_task = {
        let settings = settings.clone();
        let runtime = runtime.clone();
        let controller = controller.clone();
        let player_ready = player_ready.clone();
        let teardown_done = teardown_done.clone();
        tokio::spawn(async move {
            // Player::new has completed, but publication is deliberately
            // held until teardown wins and advances the epoch.
            player_ready.wait().await;
            teardown_done.wait().await;
            let settings = settings.read().await;
            let mut runtime = runtime.lock().await;
            let installed =
                install_player_if_current(&mut runtime, &settings, &lease, &player, &controller);
            drop(runtime);
            if !installed {
                stop_stale_player(player);
            }
            installed
        })
    };

    player_ready.wait().await;
    let resources = {
        let mut runtime = runtime.lock().await;
        take_runtime_resources(&mut runtime, RuntimeState::SignedOut, true)
    };
    SpotifyService::shutdown_runtime_resources(resources).await;
    teardown_done.wait().await;

    assert!(!install_task.await.unwrap());
    let runtime = runtime.lock().await;
    assert_eq!(runtime.playback_epoch, 1);
    assert!(matches!(runtime.state, RuntimeState::SignedOut));
    assert!(runtime.session.is_none());
    assert!(runtime.player.is_none());
    assert!(runtime.sink_controller.is_none());
    drop(runtime);
    assert_player_dropped(stale_player).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn teardown_after_playing_before_publish_rejects_the_stale_buffer() {
    let directory = tempdir().unwrap();
    let session = Session::new(SessionConfig::default(), None);
    let lease = PlaybackLease {
        epoch: 0,
        session_id: session.session_id(),
    };
    let settings = Arc::new(RwLock::new(enabled_spotify_settings()));
    let controller = SwitchableWavSinkController::new();
    let player = test_player(session.clone(), &controller);
    let stale_player = Arc::downgrade(&player);
    let buffer = PlaybackBuffer::create(directory.path(), "stale-ticket".into(), 1_000).unwrap();
    let route_generation = controller.stage(buffer.clone()).unwrap();
    let mut sink = controller.sink();
    sink.start().unwrap();
    let mut initial_runtime = ready_runtime(session);
    initial_runtime.player = Some(player.clone());
    initial_runtime.sink_controller = Some(controller.clone());
    let runtime = Arc::new(Mutex::new(initial_runtime));
    let playing_observed = Arc::new(tokio::sync::Barrier::new(2));
    let teardown_done = Arc::new(tokio::sync::Barrier::new(2));

    let publish_task = {
        let settings = settings.clone();
        let runtime = runtime.clone();
        let controller = controller.clone();
        let buffer = buffer.clone();
        let playing_observed = playing_observed.clone();
        let teardown_done = teardown_done.clone();
        tokio::spawn(async move {
            // This barrier represents the exact Playing event. Teardown
            // then wins before the detached task can publish its URL.
            playing_observed.wait().await;
            teardown_done.wait().await;
            let watcher = tokio::spawn(std::future::pending::<()>());
            let pending = PendingPlaybackPublication {
                ticket: "stale-ticket".into(),
                buffer,
                watcher,
            };
            let publication = {
                let settings = settings.read().await;
                let mut runtime = runtime.lock().await;
                publish_playback_if_current(
                    &mut runtime,
                    &settings,
                    &lease,
                    &player,
                    &controller,
                    pending,
                )
            };
            let Err(pending) = publication else {
                return false;
            };
            pending.watcher.abort();
            let cancelled = controller.cancel(route_generation);
            pending.buffer.finish(true);
            stop_stale_player(player);
            cancelled
        })
    };

    playing_observed.wait().await;
    let resources = {
        let mut runtime = runtime.lock().await;
        take_runtime_resources(&mut runtime, RuntimeState::SignedOut, true)
    };
    SpotifyService::shutdown_runtime_resources(resources).await;
    teardown_done.wait().await;

    assert!(publish_task.await.unwrap());
    let runtime = runtime.lock().await;
    assert_eq!(runtime.playback_epoch, 1);
    assert!(matches!(runtime.state, RuntimeState::SignedOut));
    assert!(runtime.active_buffer.is_none());
    assert!(runtime.playback_watcher.is_none());
    assert!(!runtime.buffers.contains_key("stale-ticket"));
    assert!(runtime.buffer_order.is_empty());
    assert!(!controller.is_active(route_generation));
    drop(runtime);
    assert_player_dropped(stale_player).await;
}

#[tokio::test]
async fn reused_player_load_binds_the_first_announced_request_id() {
    let track_id = SpotifyUri::from_uri("spotify:track:0d28khcov6AiegSCpG5TuT").unwrap();
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    sender
        .send(PlayerEvent::PlayRequestIdChanged {
            play_request_id: 42,
        })
        .unwrap();
    // A different request for the same URI must never satisfy this load.
    sender
        .send(PlayerEvent::Playing {
            play_request_id: 41,
            track_id: track_id.clone(),
            position_ms: 0,
        })
        .unwrap();
    sender
        .send(PlayerEvent::Playing {
            play_request_id: 42,
            track_id,
            position_ms: 0,
        })
        .unwrap();

    assert_eq!(
        await_player_load(&mut events, Duration::from_millis(50)).await,
        Ok(42)
    );
}

#[tokio::test]
async fn exact_unavailable_event_fails_without_invalidating_reusable_player() {
    let track_id = SpotifyUri::from_uri("spotify:track:0d28khcov6AiegSCpG5TuT").unwrap();
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    sender
        .send(PlayerEvent::PlayRequestIdChanged { play_request_id: 7 })
        .unwrap();
    sender
        .send(PlayerEvent::Unavailable {
            play_request_id: 7,
            track_id,
        })
        .unwrap();

    let failure = await_player_load(&mut events, Duration::from_millis(50))
        .await
        .unwrap_err();
    assert_eq!(failure, PlayerLoadFailure::Unavailable);
    assert!(!failure.invalidates_player());
    assert!(PlayerLoadFailure::Timeout.invalidates_player());
    assert!(PlayerLoadFailure::ChannelClosed.invalidates_player());
}

#[test]
fn pairing_finalization_never_publishes_partial_or_cancelled_state() {
    let mut finalization = PairingFinalization::default();
    assert!(!finalization.can_publish(false));

    finalization.local_auth_written = true;
    assert!(!finalization.can_publish(false));

    finalization.vault_confirmed = true;
    assert!(finalization.can_publish(false));
    assert!(!finalization.can_publish(true));
}

#[tokio::test]
async fn lifecycle_transitions_serialize_and_invalidate_stale_publication() {
    let lifecycle = Arc::new(LifecycleGate::default());
    let first_generation = lifecycle.begin_transition().await;
    let settings = SpotifyConfig {
        enabled: true,
        experimental_acknowledged: true,
        ..SpotifyConfig::default()
    };
    assert!(publication_allowed(
        first_generation,
        first_generation,
        &settings
    ));

    let waiting_lifecycle = lifecycle.clone();
    let mut waiter = tokio::spawn(async move { waiting_lifecycle.begin_transition().await });
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut waiter)
        .await
        .is_err());

    lifecycle.end_transition(first_generation).await;
    let second_generation = tokio::time::timeout(Duration::from_millis(100), waiter)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first_generation, second_generation);
    assert!(!publication_allowed(
        second_generation,
        first_generation,
        &settings
    ));
    lifecycle.end_transition(second_generation).await;
}

#[tokio::test]
async fn detached_transition_owner_survives_request_cancellation() {
    let lifecycle = Arc::new(LifecycleGate::default());
    let generation = lifecycle.begin_transition().await;
    let (started, started_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let owner = lifecycle.clone();
    let caller = tokio::spawn(async move {
        await_owned_transition(owner, generation, async move {
            let _ = started.send(());
            let _ = release_rx.await;
            Ok::<_, SpotifyError>(())
        })
        .await
    });
    started_rx.await.unwrap();

    caller.abort();
    let _ = caller.await;
    assert_eq!(
        lifecycle.state.lock().await.transition_generation,
        Some(generation)
    );

    let changed = lifecycle.changed.notified();
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_millis(100), changed)
        .await
        .unwrap();
    let next = lifecycle.begin_transition().await;
    assert_ne!(next, generation);
    lifecycle.end_transition(next).await;
}

#[tokio::test]
async fn detached_transition_owner_releases_after_operation_panic() {
    let lifecycle = Arc::new(LifecycleGate::default());
    let generation = lifecycle.begin_transition().await;
    let result = await_owned_transition(lifecycle.clone(), generation, async move {
        panic!("test panic inside lifecycle operation");
        #[allow(unreachable_code)]
        Ok::<_, SpotifyError>(())
    })
    .await;
    assert!(matches!(result, Err(SpotifyError::Unavailable)));
    assert!(lifecycle.state.lock().await.transition_generation.is_none());
}

#[tokio::test]
async fn concurrent_pairing_start_cannot_replace_or_invalidate_active_task() {
    let lifecycle = LifecycleGate::default();
    let generation = lifecycle.begin_pairing_transition().await.unwrap();
    let (cancel, _) = watch::channel(false);
    let handle = tokio::spawn(std::future::pending::<()>());
    {
        let mut state = lifecycle.state.lock().await;
        assert!(install_pairing_task(
            &mut state,
            PairingTask {
                generation,
                cancel,
                handle,
            },
        )
        .is_ok());
    }
    lifecycle.end_transition(generation).await;

    assert!(lifecycle.begin_pairing_transition().await.is_err());
    assert!(lifecycle.try_begin_reconnect_transition().await.is_err());
    assert_eq!(lifecycle.state.lock().await.generation, generation);
    {
        let mut state = lifecycle.state.lock().await;
        assert!(take_pairing_task_for_generation(&mut state, generation + 1).is_none());
        assert!(state.pairing_task.is_some());
    }

    let cancellation_generation = lifecycle.begin_transition().await;
    assert_ne!(generation, cancellation_generation);
    let task = lifecycle.state.lock().await.pairing_task.take().unwrap();
    task.cancel.send_replace(true);
    task.handle.abort();
    let _ = task.handle.await;
    lifecycle.end_transition(cancellation_generation).await;
}

#[test]
fn publication_guard_rechecks_both_enablement_gates() {
    let mut settings = SpotifyConfig {
        enabled: true,
        experimental_acknowledged: true,
        ..SpotifyConfig::default()
    };
    assert!(publication_allowed(7, 7, &settings));
    assert!(!publication_allowed(8, 7, &settings));
    settings.enabled = false;
    assert!(!publication_allowed(7, 7, &settings));
    settings.enabled = true;
    settings.experimental_acknowledged = false;
    assert!(!publication_allowed(7, 7, &settings));
}

#[test]
fn saved_session_restore_skips_only_live_or_pairing_states() {
    assert!(should_restore_saved_session(
        &RuntimeState::Ready {
            username: Some("user".into()),
        },
        false,
    ));
    assert!(should_restore_saved_session(
        &RuntimeState::Error {
            message: "connection closed".into(),
        },
        false,
    ));
    assert!(!should_restore_saved_session(
        &RuntimeState::Ready { username: None },
        true,
    ));
    // A disabled service can retain a durably vaulted credential. After it
    // is re-enabled, SignedOut must be allowed to attempt that credential;
    // load_auth still returns NotPaired when no credential actually exists.
    assert!(should_restore_saved_session(
        &RuntimeState::SignedOut,
        false
    ));
    assert!(!should_restore_saved_session(
        &RuntimeState::Pairing { expires_at: 1 },
        false,
    ));
}

#[test]
fn reconnect_backoff_is_exponential_and_capped() {
    assert_eq!(reconnect_backoff(1), Duration::from_secs(2));
    assert_eq!(reconnect_backoff(2), Duration::from_secs(4));
    assert_eq!(reconnect_backoff(3), Duration::from_secs(8));
    assert_eq!(reconnect_backoff(4), Duration::from_secs(16));
    assert_eq!(reconnect_backoff(5), Duration::from_secs(30));
    assert_eq!(reconnect_backoff(50), Duration::from_secs(30));
}

#[test]
fn reconnect_cooldown_blocks_repeated_attempts_until_due() {
    let now = tokio::time::Instant::now();
    assert!(reconnect_is_due(None, now));
    assert!(!reconnect_is_due(Some(now + Duration::from_secs(2)), now));
    assert!(reconnect_is_due(Some(now), now));
}

#[test]
fn only_transient_restore_failures_start_reconnect_backoff() {
    assert!(reconnect_failure_needs_backoff(&SpotifyError::Unavailable));
    assert!(reconnect_failure_needs_backoff(&SpotifyError::Persistence));
    assert!(!reconnect_failure_needs_backoff(&SpotifyError::Disabled));
    assert!(!reconnect_failure_needs_backoff(
        &SpotifyError::AcknowledgementRequired
    ));
    assert!(!reconnect_failure_needs_backoff(&SpotifyError::NotPaired));
    assert!(!reconnect_failure_needs_backoff(&SpotifyError::Pairing));
}

#[tokio::test]
async fn reconnect_transition_is_single_flight() {
    let lifecycle = LifecycleGate::default();
    let generation = lifecycle
        .try_begin_reconnect_transition()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        lifecycle.try_begin_reconnect_transition().await.unwrap(),
        None
    );
    lifecycle.end_transition(generation).await;
    assert!(lifecycle
        .try_begin_reconnect_transition()
        .await
        .unwrap()
        .is_some());
}

#[test]
fn reconnect_cleanup_preserves_contextual_track_metadata() {
    let track = SpotifyTrack {
        id: "0d28khcov6AiegSCpG5TuT".into(),
        title: "Feel Good Inc.".into(),
        artists: vec!["Gorillaz".into()],
        album: "Demon Days".into(),
        duration_ms: 222_640,
        track_number: 6,
        disc_number: 1,
        explicit: false,
        popularity: None,
    };
    let mut runtime = Runtime {
        state: RuntimeState::Ready {
            username: Some("listener".into()),
        },
        playback_epoch: 0,
        session: None,
        player: None,
        sink_controller: None,
        playback_watcher: None,
        active_buffer: None,
        buffers: HashMap::new(),
        buffer_order: VecDeque::new(),
        tracks: HashMap::from([(track.id.clone(), track.clone())]),
        reconnect_failures: 2,
        reconnect_not_before: Some(tokio::time::Instant::now()),
        reconnect_error: Some("network changed".into()),
    };

    let resources = take_runtime_resources(
        &mut runtime,
        RuntimeState::Ready {
            username: Some("listener".into()),
        },
        false,
    );

    assert!(resources.0.is_none() && resources.1.is_none() && resources.2.is_none());
    assert_eq!(runtime.playback_epoch, 1);
    assert_eq!(runtime.tracks.get(&track.id), Some(&track));
    assert_eq!(runtime.reconnect_failures, 2);
}

#[tokio::test]
async fn pairing_cancellation_is_sticky_before_waiter_runs() {
    let (cancel, mut cancel_rx) = watch::channel(false);
    cancel.send_replace(true);
    tokio::time::timeout(
        Duration::from_millis(50),
        wait_for_pairing_cancellation(&mut cancel_rx),
    )
    .await
    .unwrap();
    assert!(pairing_cancelled(&cancel_rx));
}

#[test]
fn parses_current_search_track_shape() {
    let body = serde_json::json!({
        "tracks": { "items": [{
            "id": "4uLU6hMCjMI75M1A2tKUQC",
            "name": "Never Gonna Give You Up",
            "artists": [{"name": "Rick Astley"}],
            "album": {"name": "Whenever You Need Somebody"},
            "duration_ms": 213573,
            "track_number": 1,
            "disc_number": 1,
            "explicit": false
        }]}
    });
    let tracks = parse_track_array(body.pointer("/tracks/items"), 10);
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].artists, vec!["Rick Astley"]);
}

#[test]
fn collection_contract_keeps_search_requests_at_ten() {
    assert_eq!(types::MAX_SEARCH_RESULTS, 10);
    assert_eq!(types::MAX_COLLECTION_RESULTS, 100);
    assert_eq!(search_page_size(100), 10);
    assert_eq!(search_page_size(7), 7);
    assert!(!uses_personal_top_tracks("top_hits"));
    assert!(uses_personal_top_tracks("featured"));
    assert!(!uses_personal_top_tracks("track"));

    let top_hits = SpotifyQueryRequest {
        kind: "top_hits".into(),
        primary: Some("Blue in Green".into()),
        secondary: Some("Miles Davis".into()),
        ids: Vec::new(),
        limit: 1,
    };
    assert_eq!(
        build_search_query(&top_hits),
        "Blue in Green artist:Miles Davis"
    );
}

#[test]
fn playlist_reference_accepts_id_and_uri_only() {
    let id = "37i9dQZF1DWSw8liJZcPOI";
    assert_eq!(parse_playlist_reference(id).as_deref(), Some(id));
    assert_eq!(
        parse_playlist_reference(&format!("spotify:playlist:{id}")).as_deref(),
        Some(id)
    );
    assert_eq!(
        parse_playlist_reference(&format!("spotify:track:{id}")),
        None
    );
    assert_eq!(parse_playlist_reference("Morning music"), None);
}

#[test]
fn album_resolution_prefers_exact_artist_match_without_reordering_tracks() {
    let items = serde_json::json!([{
        "id": "0sNOF9WDwhWunNAHPD3Baj",
        "name": "Kind of Blue",
        "artists": [{"name": "Cover Artist"}]
    }, {
        "id": "1weenld61qoidwYuZ1GESA",
        "name": "Kind of Blue",
        "artists": [{"name": "Miles Davis"}]
    }]);
    assert_eq!(
        select_album_id(Some(&items), "kind of blue", Some("miles davis")).as_deref(),
        Some("1weenld61qoidwYuZ1GESA")
    );
}

#[test]
fn contextual_artist_resolution_requires_an_exact_unambiguous_catalog_identity() {
    let artists = serde_json::json!([{
        "id": "0123456789012345678901",
        "name": "Gorillaz Tribute",
        "popularity": 90
    }, {
        "id": "1234567890123456789012",
        "name": "Gorillaz",
        "popularity": 88
    }]);
    assert_eq!(
        select_artist_id(Some(&artists), " gorillaz ").as_deref(),
        Some("1234567890123456789012")
    );

    let ambiguous = serde_json::json!([{
        "id": "0123456789012345678901",
        "name": "Phoenix",
        "popularity": 50
    }, {
        "id": "1234567890123456789012",
        "name": "Phoenix",
        "popularity": 50
    }]);
    assert_eq!(select_artist_id(Some(&ambiguous), "Phoenix"), None);

    let ranked = serde_json::json!([{
        "id": "0123456789012345678901",
        "name": "Muse",
        "popularity": 40
    }, {
        "id": "1234567890123456789012",
        "name": "Muse",
        "popularity": 80
    }]);
    assert_eq!(
        select_artist_id(Some(&ranked), "Muse").as_deref(),
        Some("1234567890123456789012")
    );
}

#[test]
fn contextual_artist_search_fallback_is_limited_to_transient_provider_failures() {
    assert!(artist_top_tracks_needs_search_fallback(
        &SpotifyError::Unavailable
    ));
    assert!(artist_top_tracks_needs_search_fallback(
        &SpotifyError::RateLimited
    ));

    for error in [
        SpotifyError::Disabled,
        SpotifyError::AcknowledgementRequired,
        SpotifyError::NotPaired,
        SpotifyError::Pairing,
        SpotifyError::AlreadyPaired,
        SpotifyError::InvalidRequest("invalid artist name"),
        SpotifyError::Persistence,
    ] {
        assert!(!artist_top_tracks_needs_search_fallback(&error));
    }
}

#[test]
fn contextual_artist_search_fallback_preserves_the_artist_qualifier() {
    assert_eq!(
        artist_top_tracks_fallback_query("  Gorillaz  "),
        "artist:Gorillaz"
    );
}

#[test]
fn truncated_metadata_playlist_is_never_reported_as_complete_without_enough_items() {
    assert!(!metadata_playlist_is_complete(true, 20, 80, 20, 50));
    assert!(metadata_playlist_is_complete(true, 50, 80, 50, 50));
    assert!(metadata_playlist_is_complete(true, 40, 40, 35, 50));
    assert!(metadata_playlist_is_complete(false, 20, 80, 20, 50));
    let incomplete_page = serde_json::json!({"total": 80});
    assert!(page_has_unseen_items(Some(&incomplete_page), 50));
    assert!(!page_has_unseen_items(Some(&incomplete_page), 80));
}

#[test]
fn playlist_parser_skips_episodes_but_rejects_malformed_declared_tracks() {
    let episode = serde_json::json!({"item": {"type": "episode"}});
    assert!(parse_playlist_entry(&episode).unwrap().is_none());

    let malformed = serde_json::json!({
        "item": {
            "type": "track",
            "id": "4uLU6hMCjMI75M1A2tKUQC",
            "name": "Missing documented fields"
        }
    });
    assert!(matches!(
        parse_playlist_entry(&malformed),
        Err(SpotifyError::Unavailable)
    ));
}

#[test]
fn retry_after_is_bounded_and_radio_fallback_is_explicit() {
    let mut headers = HeaderMap::new();
    headers.insert("retry-after", "5".parse().unwrap());
    assert_eq!(retry_after_delay(&headers), Some(Duration::from_secs(5)));
    headers.insert("retry-after", "6".parse().unwrap());
    assert_eq!(retry_after_delay(&headers), None);

    let seed = SpotifyTrack {
        id: "4uLU6hMCjMI75M1A2tKUQC".into(),
        title: "Seed Song".into(),
        artists: vec!["Seed Artist".into()],
        album: "Album".into(),
        duration_ms: 120_000,
        track_number: 1,
        disc_number: 1,
        explicit: false,
        popularity: None,
    };
    assert_eq!(
        radio_fallback_query(Some(&seed), None, None),
        "artist:Seed Artist Seed Song"
    );
    assert_eq!(radio_fallback_query(None, None, None), "top hits");
}

#[test]
fn internal_control_requires_loopback_and_exact_private_token() {
    let token = "a".repeat(BRIDGE_TOKEN_CHARS);
    let loopback: SocketAddr = "127.0.0.1:10".parse().unwrap();
    let remote: SocketAddr = "192.0.2.4:10".parse().unwrap();
    let mut headers = HeaderMap::new();

    assert!(!internal_control_authorized(
        &loopback,
        &headers,
        Some(&token)
    ));
    headers.insert(BRIDGE_TOKEN_HEADER, token.parse().unwrap());
    assert!(internal_control_authorized(
        &loopback,
        &headers,
        Some(&token)
    ));
    assert!(!internal_control_authorized(
        &remote,
        &headers,
        Some(&token)
    ));
    assert!(!internal_control_authorized(&loopback, &headers, None));

    headers.append(BRIDGE_TOKEN_HEADER, token.parse().unwrap());
    assert!(!internal_control_authorized(
        &loopback,
        &headers,
        Some(&token)
    ));
}
