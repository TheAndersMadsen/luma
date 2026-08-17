use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hmac::{Hmac, Mac as _};
use sha2::Sha256;
use subtle::ConstantTimeEq as _;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{lookup_host, TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tracing::warn;

pub(crate) const PROXY_ADDRESS: &str = "127.0.0.1:8766";
const PROXY_CREDENTIAL_DOMAIN: &[u8] = b"humane-system-hook/codex-connect-proxy/v1\0";
const PROXY_USERNAME: &str = "penumbra";

const MAX_CONNECTIONS: usize = 16;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_REQUEST_LINE_BYTES: usize = 1024;
const MAX_HEADER_COUNT: usize = 32;
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TUNNEL_TIMEOUT: Duration = Duration::from_secs(300);
/// Refusals arrive in bursts, so only the first and every Nth get a log line.
const REFUSAL_LOG_INTERVAL: u64 = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProxyError {
    Bind,
    Accept,
}

impl fmt::Display for ProxyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Codex CONNECT proxy failed")
    }
}

impl std::error::Error for ProxyError {}

pub(crate) struct CodexConnectProxy {
    listener: TcpListener,
    expected_authorization: Arc<Vec<u8>>,
}

pub(crate) struct ProxyCredentials {
    url: String,
    authorization: Vec<u8>,
}

impl ProxyCredentials {
    pub(crate) fn derive(bridge_token: &str) -> Result<Self, ProxyError> {
        let mut mac = Hmac::<Sha256>::new_from_slice(bridge_token.as_bytes())
            .map_err(|_| ProxyError::Bind)?;
        mac.update(PROXY_CREDENTIAL_DOMAIN);
        let password = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        let userinfo = format!("{PROXY_USERNAME}:{password}");
        Ok(Self {
            url: format!("http://{userinfo}@{PROXY_ADDRESS}"),
            authorization: format!("Basic {}", STANDARD.encode(userinfo)).into_bytes(),
        })
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }
}

impl CodexConnectProxy {
    pub(crate) async fn bind(credentials: &ProxyCredentials) -> Result<Self, ProxyError> {
        let listener = TcpListener::bind(PROXY_ADDRESS)
            .await
            .map_err(|_| ProxyError::Bind)?;
        let local_address = listener.local_addr().map_err(|_| ProxyError::Bind)?;
        if !local_address.ip().is_loopback() || local_address.port() != 8766 {
            return Err(ProxyError::Bind);
        }
        Ok(Self {
            listener,
            expected_authorization: Arc::new(credentials.authorization.clone()),
        })
    }

    pub(crate) async fn serve(self) -> Result<(), ProxyError> {
        let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let expected_authorization = self.expected_authorization;
        let mut non_loopback = RefusalCounter::default();
        let mut pool_exhausted = RefusalCounter::default();
        loop {
            let (stream, peer) = self
                .listener
                .accept()
                .await
                .map_err(|_| ProxyError::Accept)?;
            if !peer.ip().is_loopback() {
                if let Some(refused_total) = non_loopback.record() {
                    warn!(
                        reason = "non_loopback_peer",
                        refused_total, "codex connect proxy refused a connection"
                    );
                }
                drop(stream);
                continue;
            }
            // Refusing under saturation is intended; refusing silently is not.
            // A permit is held for up to TUNNEL_TIMEOUT, so an exhausted pool
            // can starve real turns for minutes with nothing in logcat.
            let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                if let Some(refused_total) = pool_exhausted.record() {
                    warn!(
                        reason = "connection_pool_exhausted",
                        max_connections = MAX_CONNECTIONS,
                        refused_total,
                        "codex connect proxy refused a connection"
                    );
                }
                drop(stream);
                continue;
            };
            let expected_authorization = Arc::clone(&expected_authorization);
            tokio::spawn(async move {
                let _permit = permit;
                let _ = handle_connection(stream, &expected_authorization).await;
            });
        }
    }
}

/// Counts connections refused for one reason and decides when a refusal is
/// worth a log line. The running total travels with every line so a throttled
/// burst still reports its true size.
#[derive(Debug, Default)]
struct RefusalCounter {
    total: u64,
}

impl RefusalCounter {
    /// Records one refusal and returns the running total when this refusal
    /// should be logged: the first, then every `REFUSAL_LOG_INTERVAL`th.
    fn record(&mut self) -> Option<u64> {
        self.total = self.total.saturating_add(1);
        (self.total == 1 || self.total.is_multiple_of(REFUSAL_LOG_INTERVAL)).then_some(self.total)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConnectRequest {
    host: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestError {
    Malformed,
    Method,
    Forbidden,
    Timeout,
    Transport,
}

async fn handle_connection(
    mut client: TcpStream,
    expected_authorization: &[u8],
) -> Result<(), RequestError> {
    let header = timeout(HEADER_TIMEOUT, read_header(&mut client))
        .await
        .map_err(|_| RequestError::Timeout)??;
    let request = match parse_connect_request(&header, expected_authorization) {
        Ok(request) => request,
        Err(error) => {
            let (status, reason) = match error {
                RequestError::Method => (405, "Method Not Allowed"),
                RequestError::Forbidden => (403, "Forbidden"),
                _ => (400, "Bad Request"),
            };
            let _ = send_error(&mut client, status, reason).await;
            return Err(error);
        }
    };

    let mut upstream = match connect_upstream(&request.host).await {
        Ok(stream) => stream,
        Err(error) => {
            let _ = send_error(&mut client, 502, "Bad Gateway").await;
            return Err(error);
        }
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(|_| RequestError::Transport)?;
    client.flush().await.map_err(|_| RequestError::Transport)?;

    // TLS remains end-to-end between the static app-server and the upstream.
    // The proxy deliberately does not inspect or log tunnel contents.
    timeout(
        TUNNEL_TIMEOUT,
        tokio::io::copy_bidirectional(&mut client, &mut upstream),
    )
    .await
    .map_err(|_| RequestError::Timeout)?
    .map_err(|_| RequestError::Transport)?;
    Ok(())
}

async fn read_header(stream: &mut TcpStream) -> Result<Vec<u8>, RequestError> {
    let mut header = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|_| RequestError::Transport)?;
        if read == 0 {
            return Err(RequestError::Malformed);
        }
        if header.len().saturating_add(read) > MAX_HEADER_BYTES {
            return Err(RequestError::Malformed);
        }
        header.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&header) {
            if end != header.len() {
                // CONNECT has no request body. Reject bytes following the
                // header instead of accidentally forwarding prevalidated data.
                return Err(RequestError::Malformed);
            }
            return Ok(header);
        }
    }
}

fn find_header_end(header: &[u8]) -> Option<usize> {
    header
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

fn parse_connect_request(
    header: &[u8],
    expected_authorization: &[u8],
) -> Result<ConnectRequest, RequestError> {
    if header.len() > MAX_HEADER_BYTES || !header.ends_with(b"\r\n\r\n") {
        return Err(RequestError::Malformed);
    }
    if !header.is_ascii() || header.contains(&0) {
        return Err(RequestError::Malformed);
    }
    let text = std::str::from_utf8(header).map_err(|_| RequestError::Malformed)?;
    let mut lines = text[..text.len() - 4].split("\r\n");
    let request_line = lines.next().ok_or(RequestError::Malformed)?;
    if request_line.len() > MAX_REQUEST_LINE_BYTES {
        return Err(RequestError::Malformed);
    }
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or(RequestError::Malformed)?;
    let target = parts.next().ok_or(RequestError::Malformed)?;
    let version = parts.next().ok_or(RequestError::Malformed)?;
    if parts.next().is_some() || version != "HTTP/1.1" {
        return Err(RequestError::Malformed);
    }
    if method != "CONNECT" {
        return Err(RequestError::Method);
    }
    let (host, port) = split_authority(target)?;
    if port != "443" || !allowed_host(host) {
        return Err(RequestError::Forbidden);
    }

    let mut host_header = None;
    let mut proxy_authorization = None;
    let mut count = 0_usize;
    for line in lines {
        count += 1;
        if count > MAX_HEADER_COUNT
            || line.is_empty()
            || line.starts_with([' ', '\t'])
            || line.len() > MAX_REQUEST_LINE_BYTES
        {
            return Err(RequestError::Malformed);
        }
        let (name, value) = line.split_once(':').ok_or(RequestError::Malformed)?;
        if !valid_header_name(name) || !valid_header_value(value) {
            return Err(RequestError::Malformed);
        }
        let value = value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("host") && host_header.replace(value).is_some() {
            return Err(RequestError::Malformed);
        }
        if name.eq_ignore_ascii_case("proxy-authorization")
            && proxy_authorization.replace(value.as_bytes()).is_some()
        {
            return Err(RequestError::Malformed);
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value != "0")
        {
            return Err(RequestError::Malformed);
        }
    }
    let host_header = host_header.ok_or(RequestError::Malformed)?;
    let (header_host, header_port) = split_authority(host_header)?;
    if header_port != "443" || !header_host.eq_ignore_ascii_case(host) {
        return Err(RequestError::Malformed);
    }
    if !valid_proxy_authorization(proxy_authorization, expected_authorization) {
        return Err(RequestError::Forbidden);
    }

    Ok(ConnectRequest {
        host: host.to_ascii_lowercase(),
    })
}

fn valid_proxy_authorization(actual: Option<&[u8]>, expected: &[u8]) -> bool {
    let Some(actual) = actual else {
        let _ = expected.ct_eq(expected);
        return false;
    };
    if actual.len() != expected.len() {
        let _ = expected.ct_eq(expected);
        return false;
    }
    bool::from(actual.ct_eq(expected))
}

fn split_authority(authority: &str) -> Result<(&str, &str), RequestError> {
    if authority.is_empty()
        || authority.contains(['@', '/', '?', '#', '[', ']'])
        || authority.matches(':').count() != 1
    {
        return Err(RequestError::Malformed);
    }
    let (host, port) = authority.rsplit_once(':').ok_or(RequestError::Malformed)?;
    if host.is_empty() || port.is_empty() || host.parse::<IpAddr>().is_ok() {
        return Err(RequestError::Forbidden);
    }
    Ok((host, port))
}

fn allowed_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if host.len() > 253 || host.ends_with('.') || !valid_dns_name(&host) {
        return false;
    }
    ["openai.com", "chatgpt.com"].iter().any(|allowed| {
        host == *allowed
            || host
                .strip_suffix(allowed)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

fn valid_dns_name(host: &str) -> bool {
    !host.is_empty()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn valid_header_value(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte == b'\t' || (byte >= 0x20 && byte != 0x7f))
}

async fn connect_upstream(host: &str) -> Result<TcpStream, RequestError> {
    let addresses = timeout(CONNECT_TIMEOUT, lookup_host((host, 443)))
        .await
        .map_err(|_| RequestError::Timeout)?
        .map_err(|_| RequestError::Transport)?
        .filter(public_upstream_address)
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(RequestError::Forbidden);
    }

    timeout(CONNECT_TIMEOUT, async {
        for address in addresses {
            if let Ok(stream) = TcpStream::connect(address).await {
                return Ok(stream);
            }
        }
        Err(RequestError::Transport)
    })
    .await
    .map_err(|_| RequestError::Timeout)?
}

fn public_upstream_address(address: &SocketAddr) -> bool {
    address.port() == 443 && public_ip(address.ip())
}

fn public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => public_ipv4(address),
        IpAddr::V6(address) => public_ipv6(address),
    }
}

fn public_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_documentation()
        || octets[0] == 0
        || octets[0] >= 240
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && matches!(octets[1], 18 | 19)))
}

fn public_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if let Some(mapped) = address.to_ipv4_mapped() {
        return public_ipv4(mapped);
    }
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

async fn send_error(stream: &mut TcpStream, status: u16, reason: &str) -> Result<(), RequestError> {
    let response =
        format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|_| RequestError::Transport)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> ProxyCredentials {
        ProxyCredentials::derive("unit-test-bridge-token-0123456789abcdef").unwrap()
    }

    fn request(target: &str, host: &str) -> Vec<u8> {
        let credentials = credentials();
        format!(
            "CONNECT {target} HTTP/1.1\r\nHost: {host}\r\nProxy-Authorization: {}\r\nProxy-Connection: keep-alive\r\n\r\n",
            std::str::from_utf8(&credentials.authorization).unwrap()
        )
        .into_bytes()
    }

    fn parse(header: &[u8]) -> Result<ConnectRequest, RequestError> {
        parse_connect_request(header, &credentials().authorization)
    }

    #[test]
    fn connect_parser_accepts_only_tls_to_openai_or_chatgpt_domains() {
        assert_eq!(
            parse(&request("auth.openai.com:443", "auth.openai.com:443")),
            Ok(ConnectRequest {
                host: "auth.openai.com".into()
            })
        );
        assert_eq!(
            parse(&request("chatgpt.com:443", "chatgpt.com:443")),
            Ok(ConnectRequest {
                host: "chatgpt.com".into()
            })
        );
        assert_eq!(
            parse(&request("evilopenai.com:443", "evilopenai.com:443")),
            Err(RequestError::Forbidden)
        );
        assert_eq!(
            parse(&request(
                "openai.com.evil.test:443",
                "openai.com.evil.test:443"
            )),
            Err(RequestError::Forbidden)
        );
        assert_eq!(
            parse(&request("127.0.0.1:443", "127.0.0.1:443")),
            Err(RequestError::Forbidden)
        );
        assert_eq!(
            parse(&request("auth.openai.com:80", "auth.openai.com:80")),
            Err(RequestError::Forbidden)
        );
    }

    #[test]
    fn connect_parser_rejects_userinfo_mismatch_bodies_and_malformed_headers() {
        assert_eq!(
            parse(&request("user@auth.openai.com:443", "auth.openai.com:443")),
            Err(RequestError::Malformed)
        );
        assert_eq!(
            parse(&request("auth.openai.com:443", "api.openai.com:443")),
            Err(RequestError::Malformed)
        );
        assert_eq!(
            parse(b"GET https://auth.openai.com/ HTTP/1.1\r\nHost: auth.openai.com\r\n\r\n"),
            Err(RequestError::Method)
        );
        assert_eq!(
            parse(
                b"CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\nContent-Length: 1\r\n\r\n"
            ),
            Err(RequestError::Malformed)
        );
        assert_eq!(
            parse(b"CONNECT auth.openai.com:443 HTTP/1.1\nHost: auth.openai.com:443\n\n"),
            Err(RequestError::Malformed)
        );
    }

    #[test]
    fn connect_parser_requires_the_domain_separated_proxy_credential() {
        let missing = b"CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\n\r\n";
        assert_eq!(parse(missing), Err(RequestError::Forbidden));

        let wrong = b"CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\nProxy-Authorization: Basic d3Jvbmc=\r\n\r\n";
        assert_eq!(parse(wrong), Err(RequestError::Forbidden));

        let first = ProxyCredentials::derive("first-bridge-token-0123456789abcdef").unwrap();
        let second = ProxyCredentials::derive("second-bridge-token-0123456789abcdef").unwrap();
        assert_ne!(first.authorization, second.authorization);
        assert!(!first.url.contains("first-bridge-token"));
    }

    #[test]
    fn upstream_filter_rejects_non_public_destinations() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "192.0.2.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(public_ip("104.18.33.45".parse().unwrap()));
        assert!(public_ip("2606:4700::6812:212d".parse().unwrap()));
    }

    #[test]
    fn header_end_detection_is_strict() {
        assert_eq!(find_header_end(b"a\r\n\r\n"), Some(5));
        assert_eq!(find_header_end(b"a\n\n"), None);
    }

    #[test]
    fn refused_connections_are_counted_and_logged_first_then_every_interval() {
        let mut counter = RefusalCounter::default();

        // The first refusal is always visible: a single dropped connection was
        // previously indistinguishable from no refusal at all.
        assert_eq!(counter.record(), Some(1));
        for expected_total in 2..REFUSAL_LOG_INTERVAL {
            assert_eq!(counter.record(), None, "{expected_total}");
        }
        // Every refusal in between still counts, so the throttled line reports
        // the true total rather than the number of lines emitted.
        assert_eq!(counter.record(), Some(REFUSAL_LOG_INTERVAL));
        assert_eq!(counter.total, REFUSAL_LOG_INTERVAL);

        for _ in 0..REFUSAL_LOG_INTERVAL - 1 {
            assert_eq!(counter.record(), None);
        }
        assert_eq!(counter.record(), Some(REFUSAL_LOG_INTERVAL * 2));
    }

    #[test]
    fn refusal_counters_for_different_reasons_do_not_share_a_total() {
        let mut non_loopback = RefusalCounter::default();
        let mut pool_exhausted = RefusalCounter::default();
        assert_eq!(non_loopback.record(), Some(1));
        assert_eq!(pool_exhausted.record(), Some(1));
        assert_eq!(non_loopback.total, 1);
        assert_eq!(pool_exhausted.total, 1);
    }
}
