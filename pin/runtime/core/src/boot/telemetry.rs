//! Process telemetry and environment loading: the `.env` file next to the
//! config, and the tracing stack (stdout + optional rolling file appender).
//! Moved out of `main.rs`; filters, rotation, and warnings are unchanged.

use std::path::Path as FsPath;

use tracing::{info, warn};

use crate::config::Config;

#[cfg(not(target_os = "android"))]
pub(crate) fn load_dotenv(config_path: &FsPath) {
    let Some(config_dir) = config_path.parent() else {
        return;
    };

    let dotenv_path = config_dir.join(".env");
    if !dotenv_path.exists() {
        return;
    }

    match dotenvy::from_path(&dotenv_path) {
        Ok(()) => info!(path = %dotenv_path.display(), "loaded .env file"),
        Err(error) => warn!(path = %dotenv_path.display(), %error, "failed to load .env file"),
    }
}

#[cfg(target_os = "android")]
pub(crate) fn load_dotenv(_config_path: &FsPath) {}

/// Install the process-wide tracing subscriber.
pub(crate) fn init_tracing(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    // `librespot_playback::player` is raised to debug on purpose. It is the only
    // place the applied loudness-normalisation gain is reported ("Calculated
    // Normalisation Factor"), and that gain is otherwise invisible: with
    // normalisation on and no pregain, every track above Spotify's reference
    // level is quietly attenuated by an amount nobody can see. The module has
    // ~18 debug sites and they fire per track load, so the added volume is
    // negligible next to the value of knowing the gain. The lines are
    // content-free (a percentage and the normalisation type). RUST_LOG still
    // overrides everything.
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,librespot_playback::player=debug".into());

    // Optional rolling file appender, used both for persistence and for the
    // `/api/logs/server` REST endpoint. The guard must outlive the program;
    // we leak it intentionally.
    let file_layer = if let Some(dir) = config.logging.log_dir.as_deref() {
        match std::fs::create_dir_all(dir) {
            Ok(()) => {
                let appender = tracing_appender::rolling::Builder::new()
                    .rotation(tracing_appender::rolling::Rotation::DAILY)
                    .filename_prefix(&config.logging.file_prefix)
                    .max_log_files(config.logging.max_files)
                    .build(dir)
                    .map_err(|e| format!("failed to build rolling log appender: {e}"))?;
                let (nb, guard) = tracing_appender::non_blocking(appender);
                Box::leak(Box::new(guard));
                Some(
                    tracing_subscriber::fmt::layer()
                        .with_writer(nb)
                        .with_ansi(false)
                        .with_target(true),
                )
            }
            Err(e) => {
                eprintln!(
                    "warning: failed to create log_dir {:?}: {}. file logging disabled",
                    dir, e
                );
                None
            }
        }
    } else {
        None
    };

    {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;

        #[cfg(target_os = "android")]
        let stdout_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .compact()
            .without_time();
        #[cfg(not(target_os = "android"))]
        let stdout_layer = tracing_subscriber::fmt::layer();

        tracing_subscriber::registry()
            .with(env_filter)
            .with(stdout_layer)
            .with(file_layer)
            .init();
    }
    Ok(())
}
