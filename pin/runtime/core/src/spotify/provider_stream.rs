use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use reqwest::Url;

use crate::config::MusicProvider;

const STREAM_TTL: Duration = Duration::from_secs(45 * 60);
const MAX_STREAMS: usize = 8;
const MAX_STREAM_URL_BYTES: usize = 16 * 1024;
const TIDAL_STREAM_HOST_SUFFIXES: &[&str] = &["tidal.com", "tdlcdn.com", "akamaihd.net"];

#[derive(Clone)]
pub(super) struct ProviderStream {
    pub provider: MusicProvider,
    pub track_id: String,
    pub url: Url,
    expires_at: Instant,
}

#[derive(Default)]
pub(super) struct ProviderStreamRegistry {
    streams: HashMap<String, ProviderStream>,
    order: VecDeque<String>,
}

impl ProviderStreamRegistry {
    fn prune(&mut self, now: Instant) {
        self.streams.retain(|_, stream| stream.expires_at > now);
        self.order
            .retain(|ticket| self.streams.contains_key(ticket));
        while self.streams.len() >= MAX_STREAMS {
            let Some(ticket) = self.order.pop_front() else {
                break;
            };
            self.streams.remove(&ticket);
        }
    }

    pub fn insert(
        &mut self,
        ticket: String,
        provider: MusicProvider,
        track_id: String,
        url: &str,
    ) -> Result<(), &'static str> {
        let url = validate_provider_stream_url(provider, url)?;
        self.prune(Instant::now());
        if self.streams.contains_key(&ticket) {
            return Err("music playback ticket collision");
        }
        self.order.push_back(ticket.clone());
        self.streams.insert(
            ticket,
            ProviderStream {
                provider,
                track_id,
                url,
                expires_at: Instant::now() + STREAM_TTL,
            },
        );
        Ok(())
    }

    pub fn get(&mut self, ticket: &str) -> Option<ProviderStream> {
        if !valid_ticket(ticket) {
            return None;
        }
        self.prune(Instant::now());
        self.streams.get(ticket).cloned()
    }

    pub fn replace_url(&mut self, ticket: &str, previous: &Url, value: &str) -> bool {
        let Some(current) = self.streams.get_mut(ticket) else {
            return false;
        };
        if &current.url != previous {
            return false;
        }
        let Ok(url) = validate_provider_stream_url(current.provider, value) else {
            return false;
        };
        current.url = url;
        current.expires_at = Instant::now() + STREAM_TTL;
        true
    }

    pub fn clear(&mut self) {
        self.streams.clear();
        self.order.clear();
    }
}

fn valid_ticket(ticket: &str) -> bool {
    ticket.len() == 43
        && ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn host_has_suffix(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

pub(super) fn validate_provider_stream_url(
    provider: MusicProvider,
    value: &str,
) -> Result<Url, &'static str> {
    if value.len() > MAX_STREAM_URL_BYTES {
        return Err("music stream URL is too large");
    }
    let url = Url::parse(value).map_err(|_| "music stream URL is invalid")?;
    let host = url
        .host_str()
        .map(|value| value.trim_end_matches('.').to_ascii_lowercase())
        .ok_or("music stream host is missing")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("music stream URL is unsafe");
    }
    let allowed = match provider {
        MusicProvider::YoutubeMusic => host_has_suffix(&host, "googlevideo.com"),
        MusicProvider::Tidal => TIDAL_STREAM_HOST_SUFFIXES
            .iter()
            .any(|suffix| host_has_suffix(&host, suffix)),
        MusicProvider::Spotify | MusicProvider::AppleMusic => false,
    };
    if !allowed {
        return Err("music stream host is not allowed");
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_streams_accept_only_the_two_working_provider_cdns() {
        assert!(validate_provider_stream_url(
            MusicProvider::YoutubeMusic,
            "https://r1---sn.example.googlevideo.com/videoplayback?id=fixture&pot=proof",
        )
        .is_ok());
        assert!(validate_provider_stream_url(
            MusicProvider::Tidal,
            "https://audio.tdlcdn.com/full.m4a",
        )
        .is_ok());
        for (provider, url) in [
            (
                MusicProvider::YoutubeMusic,
                "https://googlevideo.com.evil.test/audio",
            ),
            (
                MusicProvider::YoutubeMusic,
                "http://r1.googlevideo.com/audio",
            ),
            (MusicProvider::Tidal, "https://tidal.com.evil.test/audio"),
            (
                MusicProvider::AppleMusic,
                "https://audio-ssl.itunes.apple.com/audio.m4a",
            ),
            (MusicProvider::Spotify, "https://audio.tdlcdn.com/full.m4a"),
        ] {
            assert!(
                validate_provider_stream_url(provider, url).is_err(),
                "accepted {provider:?} {url}"
            );
        }
    }

    #[test]
    fn registry_keeps_provider_urls_behind_opaque_bounded_tickets() {
        let mut registry = ProviderStreamRegistry::default();
        let ticket = "a".repeat(43);
        registry
            .insert(
                ticket.clone(),
                MusicProvider::YoutubeMusic,
                "youtube_music:Zi_XLOBDo_Y".into(),
                "https://r1---sn.example.googlevideo.com/videoplayback?id=fixture",
            )
            .unwrap();
        let stream = registry.get(&ticket).unwrap();
        assert_eq!(stream.provider, MusicProvider::YoutubeMusic);
        assert_eq!(stream.track_id, "youtube_music:Zi_XLOBDo_Y");
        assert!(registry.get("not-a-ticket").is_none());
        assert!(registry.replace_url(
            &ticket,
            &stream.url,
            "https://r2---sn.example.googlevideo.com/videoplayback?id=renewed",
        ));
        assert_eq!(
            registry.get(&ticket).unwrap().url.host_str(),
            Some("r2---sn.example.googlevideo.com"),
        );
    }
}
