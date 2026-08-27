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
    fn prune_expired(&mut self, now: Instant) {
        self.streams.retain(|_, stream| stream.expires_at > now);
        self.order
            .retain(|ticket| self.streams.contains_key(ticket));
    }

    fn make_room_for_insert(&mut self) {
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
        self.prune_expired(Instant::now());
        if self.streams.contains_key(&ticket) {
            return Err("music playback ticket collision");
        }
        self.make_room_for_insert();
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
        self.prune_expired(Instant::now());
        self.streams.get(ticket).cloned()
    }

    pub fn replace_url_or_current(
        &mut self,
        ticket: &str,
        previous: &ProviderStream,
        value: &str,
    ) -> Option<ProviderStream> {
        let current = self.streams.get_mut(ticket)?;
        if current.provider != previous.provider || current.track_id != previous.track_id {
            return None;
        }
        if current.url != previous.url {
            return Some(current.clone());
        }
        let url = validate_provider_stream_url(current.provider, value).ok()?;
        current.url = url;
        current.expires_at = Instant::now() + STREAM_TTL;
        Some(current.clone())
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
        assert!(registry
            .replace_url_or_current(
                &ticket,
                &stream,
                "https://r2---sn.example.googlevideo.com/videoplayback?id=renewed",
            )
            .is_some());
        assert_eq!(
            registry.get(&ticket).unwrap().url.host_str(),
            Some("r2---sn.example.googlevideo.com"),
        );
    }

    #[test]
    fn full_registry_remains_readable_until_an_insert_needs_capacity() {
        let mut registry = ProviderStreamRegistry::default();
        let tickets = (0..MAX_STREAMS)
            .map(|index| format!("{index:0>43}"))
            .collect::<Vec<_>>();
        for (index, ticket) in tickets.iter().enumerate() {
            registry
                .insert(
                    ticket.clone(),
                    MusicProvider::YoutubeMusic,
                    format!("youtube_music:fixture-{index}"),
                    &format!(
                        "https://r{index}---sn.example.googlevideo.com/videoplayback?id=fixture"
                    ),
                )
                .unwrap();
        }

        for ticket in &tickets {
            assert!(
                registry.get(ticket).is_some(),
                "a read evicted full-capacity ticket {ticket}",
            );
        }

        let next_ticket = format!("{:0>43}", MAX_STREAMS);
        registry
            .insert(
                next_ticket.clone(),
                MusicProvider::YoutubeMusic,
                "youtube_music:fixture-next".into(),
                "https://r9---sn.example.googlevideo.com/videoplayback?id=next",
            )
            .unwrap();
        assert!(registry.get(&tickets[0]).is_none());
        assert!(tickets[1..]
            .iter()
            .all(|ticket| registry.get(ticket).is_some()));
        assert!(registry.get(&next_ticket).is_some());
    }

    #[test]
    fn concurrent_renewal_loser_converges_on_the_winning_url() {
        let mut registry = ProviderStreamRegistry::default();
        let ticket = "a".repeat(43);
        registry
            .insert(
                ticket.clone(),
                MusicProvider::YoutubeMusic,
                "youtube_music:Zi_XLOBDo_Y".into(),
                "https://r1---sn.example.googlevideo.com/videoplayback?id=stale",
            )
            .unwrap();
        let stale = registry.get(&ticket).unwrap();

        assert!(registry
            .replace_url_or_current(
                &ticket,
                &stale,
                "https://r2---sn.example.googlevideo.com/videoplayback?id=winner",
            )
            .is_some());
        let converged = registry
            .replace_url_or_current(
                &ticket,
                &stale,
                "https://r3---sn.example.googlevideo.com/videoplayback?id=loser",
            )
            .expect("the losing renewal must reuse the winner's validated URL");

        assert_eq!(
            converged.url.as_str(),
            "https://r2---sn.example.googlevideo.com/videoplayback?id=winner",
        );
    }

    #[test]
    fn stale_renewal_cannot_overwrite_a_reused_ticket_with_a_different_track() {
        let mut registry = ProviderStreamRegistry::default();
        let ticket = "a".repeat(43);
        let stale_url = "https://r1---sn.example.googlevideo.com/videoplayback?id=stale";
        registry
            .insert(
                ticket.clone(),
                MusicProvider::YoutubeMusic,
                "youtube_music:old-track".into(),
                stale_url,
            )
            .unwrap();
        let stale = registry.get(&ticket).unwrap();

        registry.clear();
        registry
            .insert(
                ticket.clone(),
                MusicProvider::YoutubeMusic,
                "youtube_music:new-track".into(),
                stale_url,
            )
            .unwrap();

        assert!(registry
            .replace_url_or_current(
                &ticket,
                &stale,
                "https://r2---sn.example.googlevideo.com/videoplayback?id=wrong-track",
            )
            .is_none());
        let current = registry.get(&ticket).unwrap();
        assert_eq!(current.track_id, "youtube_music:new-track");
        assert_eq!(current.url.as_str(), stale_url);
    }
}
