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
        // Stock humane.experience.music.playback.MediaPlayer.togglePlayback
        // prepares MusicPrefs.getMusicUri again after any length of pause.
        // INFERRED: the latest successfully issued ticket represents that URI;
        // retain only it until another playback ticket or clear replaces it.
        let current = self.order.back();
        self.streams
            .retain(|ticket, stream| current == Some(ticket) || stream.expires_at > now);
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

    // Failure modes: a long pause loses the saved URI, expired previous URIs
    // stay usable, clear fails to revoke playback, or retention defeats cap/collision.
    // Stock MediaPlayer.togglePlayback reuses MusicPrefs.getMusicUri and seeks
    // before prepare/play. No new playback-info call refreshes that ticket.
    #[tokio::test]
    async fn paused_current_ticket_resumes_over_http_but_previous_and_cleared_expire() {
        use super::super::*;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let directory = tempfile::tempdir().unwrap();
        let service = SpotifyService::new(
            MusicConfig {
                active_provider: MusicProvider::YoutubeMusic,
                gateway_url: Some("https://center.test".into()),
                gateway_token: Some("t".repeat(32)),
            },
            SpotifyConfig::default(),
            &directory.path().join("config.toml"),
            listener.local_addr().unwrap(),
            Client::builder().no_proxy().build().unwrap(),
            EsimBridge::start(),
            Database::open(directory.path().join("activity.sqlite")).unwrap(),
        )
        .await;
        let current = "c".repeat(43);
        let previous = "p".repeat(43);
        {
            let mut registry = service.inner.provider_streams.lock().await;
            for ticket in [&previous, &current] {
                registry
                    .insert(
                        ticket.clone(),
                        MusicProvider::YoutubeMusic,
                        "fixture".into(),
                        "https://r1.googlevideo.com/audio",
                    )
                    .unwrap();
                let stream = registry.streams.get_mut(ticket).unwrap();
                // Fixture-only origin substitution. Production inserts enforce HTTPS CDN URLs.
                stream.url = Url::parse(&format!("{origin}/fixture-audio")).unwrap();
            }
            for stream in registry.streams.values_mut() {
                stream.expires_at = Instant::now() - Duration::from_secs(1);
            }
        }
        let app = internal_router(service.clone()).route(
            "/fixture-audio",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers.get(header::RANGE).unwrap(), "bytes=2-");
                (
                    StatusCode::PARTIAL_CONTENT,
                    [
                        (header::CONTENT_TYPE, "audio/mp4"),
                        (header::CONTENT_RANGE, "bytes 2-5/6"),
                        (header::ACCEPT_RANGES, "bytes"),
                    ],
                    "cdef",
                )
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = Client::builder().no_proxy().build().unwrap();
        let path = |ticket: &str| format!("{origin}/internal/spotify/provider-stream/{ticket}");
        let response = client
            .get(path(&current))
            .header(header::RANGE, "bytes=2-")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 2-5/6"
        );
        assert_eq!(response.text().await.unwrap(), "cdef");
        assert_eq!(
            client.get(path(&previous)).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        let next = "n".repeat(43);
        service
            .inner
            .provider_streams
            .lock()
            .await
            .insert(
                next.clone(),
                MusicProvider::YoutubeMusic,
                "next".into(),
                "https://r1.googlevideo.com/audio",
            )
            .unwrap();
        assert_eq!(
            client.get(path(&current)).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        service.inner.provider_streams.lock().await.clear();
        assert_eq!(
            client.get(path(&next)).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
    }

    #[test]
    fn retained_current_ticket_keeps_registry_capacity_and_collision_checks() {
        let mut registry = ProviderStreamRegistry::default();
        for index in 0..MAX_STREAMS + 1 {
            registry
                .insert(
                    format!("{index:043}"),
                    MusicProvider::YoutubeMusic,
                    "fixture".into(),
                    "https://r1.googlevideo.com/audio",
                )
                .unwrap();
        }
        assert_eq!(registry.streams.len(), MAX_STREAMS);
        assert!(registry.get(&format!("{:043}", 0)).is_none());
        let latest = format!("{MAX_STREAMS:043}");
        registry.streams.get_mut(&latest).unwrap().expires_at =
            Instant::now() - Duration::from_secs(1);
        assert_eq!(
            registry.insert(
                latest.clone(),
                MusicProvider::YoutubeMusic,
                "fixture".into(),
                "https://r1.googlevideo.com/audio"
            ),
            Err("music playback ticket collision")
        );
        assert!(registry.get(&latest).is_some());
    }

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
}
