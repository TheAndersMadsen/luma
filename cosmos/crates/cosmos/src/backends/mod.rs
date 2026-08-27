//! Real external backends — the vendors cosmos's serverside actually called.
//!
//! Clean-room compatibility evidence identifies which third-party API sat
//! behind each surface. This module implements the
//! adapters for the ones we hold credentials for, mapping each vendor response
//! onto the **exact** proto the device expects — so a Pin cannot tell our
//! `EncryptedWeather` or `EncryptedNearbySearch` from cosmos's.
//!
//! ## Configuration
//!
//! Every backend is keyed by an environment variable and is **absent by
//! default**. A backend with no key configured does not degrade to a guess: the
//! caller reports the capability as unavailable, exactly as before. Credentials
//! are never compiled in, logged, or echoed on the wire.
//!
//! | Env var | Backend | Surfaces |
//! |---|---|---|
//! | `COSMOS_AZURE_SPEECH_KEY` + `COSMOS_AZURE_SPEECH_REGION` | Azure AI Speech | unary/streaming TTS, translated speech |
//! | `COSMOS_GOOGLE_MAPS_KEY` | Google Maps Platform | nearby search, reverse geocode, directions |
//! | `COSMOS_SEARXNG_BASE_URL` | Private SearXNG (preferred when configured) | `web_search` (`MODE_SERP_API`) |
//! | `COSMOS_SERPAPI_KEY` | SerpApi (fallback when SearXNG is absent, unavailable, or empty) | `web_search` (`MODE_SERP_API`) |
//! | `COSMOS_PIRATE_WEATHER_KEY` | Pirate Weather | weather (`MODE_WEATHER`) |
//! | `COSMOS_WOLFRAM_APP_ID` | Wolfram|Alpha LLM API | `wolfram` (`MODE_WOLFRAM`) |
//! | `COSMOS_PPLX_API_KEY` | Perplexity | `ask_online` (`MODE_PPLX_API`) |
//! | _(none)_ | Wikipedia | `wikipedia` (`MODE_WIKIPEDIA`) |
//!
//! **Implemented, not observed:** private SearXNG is an Ai Pin Revival
//! deployment choice. Its adapter preserves the observed `web_search` tool
//! boundary; it is not a claim about Humane's internal search infrastructure.
//!
//! Azure Speech additionally accepts `COSMOS_AZURE_SPEECH_VOICE` (default:
//! `en-US-AvaMultilingualNeural`).
//!
//! ## Fidelity note on weather
//!
//! cosmos's `WeatherResponse` is an **AccuWeather** payload (a numeric
//! `weather_icon`, 1–44). Pirate Weather is **Dark Sky**-shaped and reports a
//! *string* icon from an 11-value default set, with a documented rare `none` and
//! future `hail`. Every other field maps exactly; the icon is translated through
//! a documented table in [`weather`], and that translation is an approximation
//! between two genuinely different vendors — flagged there rather than passed
//! off as identical.

pub mod azure_speech;
pub mod food;
pub mod music;
pub mod perplexity;
pub mod places;
pub mod search;
pub mod shopping;
pub mod weather;
pub mod wikipedia;
pub mod wolfram;

use std::sync::OnceLock;
use std::time::Duration;

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

/// Shared HTTP client for all outbound vendor calls.
///
/// Bounded so a wedged vendor cannot consume the wearer's turn: the device tears
/// a turn down at ~25s, and the assistant already caps each model step at 10s, so
/// a tool call must resolve well inside that.
pub(crate) fn http() -> reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .connect_timeout(Duration::from_secs(4))
            .build()
            .unwrap_or_default()
    })
    .clone()
}

/// Read a backend setting from Cosmos's provider authority. Environment values
/// seed that authority on first boot, before Center has saved a configuration.
///
/// Returns `None` when unset or blank, which every caller treats as "this
/// capability is not hosted here" — never as a reason to invent a result.
pub(crate) fn key(var: &str) -> Option<String> {
    crate::integrations::value(var)
}

/// Why a backend call produced no answer. Deliberately carries no vendor payload
/// and no credential — only enough for the caller to say something honest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendError {
    /// No credential configured; the capability is not hosted in this deployment.
    NotConfigured,
    /// The vendor was reached but returned nothing usable.
    NoResult,
    /// Transport, timeout, or an error status from the vendor.
    Unavailable,
}

impl BackendError {
    /// A phrase safe to fold back into the model's transcript. States the
    /// limitation plainly; never implies a result exists.
    pub fn observation(self, capability: &str) -> String {
        match self {
            Self::NotConfigured => {
                format!("No {capability} backend is connected in this deployment.")
            }
            Self::NoResult => format!("The {capability} lookup returned no results."),
            Self::Unavailable => format!("The {capability} backend could not be reached."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_key_is_treated_as_absent_not_as_a_credential() {
        // SAFETY: single-threaded test scope; no other thread reads this var.
        unsafe {
            std::env::set_var("COSMOS_TEST_BLANK_KEY", "   ");
        }
        assert!(key("COSMOS_TEST_BLANK_KEY").is_none());
        unsafe {
            std::env::remove_var("COSMOS_TEST_BLANK_KEY");
        }
        assert!(key("COSMOS_TEST_ABSENT_KEY").is_none());
    }

    #[test]
    fn observations_state_the_limit_without_implying_a_result() {
        let text = BackendError::NotConfigured.observation("weather");
        assert!(text.contains("not connected") || text.contains("No weather"));
        assert!(!text.is_empty());
        assert!(
            BackendError::NoResult
                .observation("nearby search")
                .contains("no results")
        );
    }
}
