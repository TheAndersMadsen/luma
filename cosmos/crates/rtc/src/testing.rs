//! Explicit transport injection for one isolated acceptance-test process.
//! The gateway uses real TLS with the fixture's sole trust root. The separate
//! internal SFU endpoint is an exact, explicitly permitted loopback origin.

use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use livekit_net::{
    Header, HttpClient, HttpMethod, HttpResponse, TransportError, WsClient, WsConnectResult,
    WsConnection,
};
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, pem::PemObject},
};
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
    tungstenite::{
        Error as WsError, Message, client::IntoClientRequest, protocol::WebSocketConfig,
    },
};
use url::{Host, Url};

const MAX_BODY: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum InstallError {
    #[error("invalid loopback transport configuration")]
    Invalid,
    #[error("loopback transport already configured differently")]
    AlreadyConfigured,
    #[error("another SDK transport is already registered")]
    RegistrationConflict,
}

#[derive(Clone, PartialEq, Eq)]
struct Origin {
    host: IpAddr,
    port: u16,
}

impl Origin {
    fn parse(value: &str, scheme: &str) -> Result<Self, InstallError> {
        let parsed = Url::parse(value).map_err(|_| InstallError::Invalid)?;
        if parsed.scheme() != scheme
            || parsed.path() != "/"
            || parsed.query().is_some()
            || !clean_authority(&parsed)
        {
            return Err(InstallError::Invalid);
        }
        let host = match parsed.host() {
            Some(Host::Ipv4(ip)) => IpAddr::V4(ip),
            Some(Host::Ipv6(ip)) => IpAddr::V6(ip),
            _ => return Err(InstallError::Invalid),
        };
        let port = parsed
            .port_or_known_default()
            .ok_or(InstallError::Invalid)?;
        if !host.is_loopback() || port == 0 {
            return Err(InstallError::Invalid);
        }
        Ok(Self { host, port })
    }

    fn matches(&self, url: &Url) -> bool {
        let host = match url.host() {
            Some(Host::Ipv4(ip)) => IpAddr::V4(ip),
            Some(Host::Ipv6(ip)) => IpAddr::V6(ip),
            _ => return false,
        };
        self.host == host && Some(self.port) == url.port_or_known_default()
    }
}

fn clean_authority(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
}

#[derive(PartialEq, Eq)]
struct Configuration {
    gateway: Origin,
    internal: Origin,
    certificates: Vec<Vec<u8>>,
}

impl Configuration {
    fn authorize(&self, value: &str, websocket: bool) -> Result<Url, TransportError> {
        let url = Url::parse(value).map_err(|_| denied())?;
        let gateway_scheme = if websocket { "wss" } else { "https" };
        let internal_scheme = if websocket { "ws" } else { "http" };
        if clean_authority(&url)
            && ((url.scheme() == gateway_scheme && self.gateway.matches(&url))
                || (url.scheme() == internal_scheme && self.internal.matches(&url)))
        {
            Ok(url)
        } else {
            Err(denied())
        }
    }
}

struct Transport {
    configuration: Configuration,
    tls: Arc<ClientConfig>,
    http: reqwest::Client,
}

static INSTALLED: Mutex<Option<Arc<Transport>>> = Mutex::new(None);

/// Install before any fixture SDK connections. Origins have no path or query;
/// only loopback IP literals are accepted, never names resolved through DNS.
///
/// The SDK's setters are first-registration-wins. After setting both clients,
/// pointer identity verifies that neither registration was silently ignored.
/// A registration conflict is fatal for this fixture process: SDK globals
/// cannot be reset, and one registration may already have succeeded.
pub fn install_loopback_tls_transport(
    gateway_https_origin: &str,
    internal_ws_origin: &str,
    ca_pem: &[u8],
) -> Result<(), InstallError> {
    if ca_pem.is_empty() || ca_pem.len() > 64 * 1024 {
        return Err(InstallError::Invalid);
    }
    let gateway = Origin::parse(gateway_https_origin, "https")?;
    let internal = Origin::parse(internal_ws_origin, "ws")?;
    // The internal exception must never authorize a downgrade of the gateway.
    if gateway == internal {
        return Err(InstallError::Invalid);
    }
    let certificates = CertificateDer::pem_slice_iter(ca_pem)
        .map(|certificate| certificate.map(|der| der.as_ref().to_vec()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| InstallError::Invalid)?;
    if certificates.len() != 1 {
        return Err(InstallError::Invalid);
    }
    let configuration = Configuration {
        gateway,
        internal,
        certificates,
    };
    let mut installed = INSTALLED
        .lock()
        .map_err(|_| InstallError::RegistrationConflict)?;
    if let Some(existing) = installed.as_ref() {
        if existing.configuration != configuration {
            return Err(InstallError::AlreadyConfigured);
        }
        return verify_registration(existing);
    }
    let mut roots = RootCertStore::empty();
    for certificate in &configuration.certificates {
        roots
            .add(CertificateDer::from(certificate.clone()))
            .map_err(|_| InstallError::Invalid)?;
    }
    let tls =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| InstallError::Invalid)?
            .with_root_certificates(roots)
            .with_no_client_auth();
    let http = reqwest::Client::builder()
        .use_preconfigured_tls(tls.clone())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| InstallError::Invalid)?;
    let transport = Arc::new(Transport {
        configuration,
        tls: Arc::new(tls),
        http,
    });
    livekit_net::set_ws_client(transport.clone());
    livekit_net::set_http_client(transport.clone());
    verify_registration(&transport)?;
    *installed = Some(transport);
    Ok(())
}

fn verify_registration(transport: &Arc<Transport>) -> Result<(), InstallError> {
    let expected_ws: Arc<dyn WsClient> = transport.clone();
    let expected_http: Arc<dyn HttpClient> = transport.clone();
    if livekit_net::ws_client().is_some_and(|actual| Arc::ptr_eq(&actual, &expected_ws))
        && livekit_net::http_client().is_some_and(|actual| Arc::ptr_eq(&actual, &expected_http))
    {
        Ok(())
    } else {
        Err(InstallError::RegistrationConflict)
    }
}

fn denied() -> TransportError {
    TransportError::Other("test transport origin denied".into())
}

fn connection_error() -> TransportError {
    // SDK errors can contain query-bearing URLs, credentials or response bodies.
    TransportError::Connection("test transport connection failed".into())
}

fn validate_headers(headers: &[Header]) -> Result<(), TransportError> {
    if headers.len() > 64
        || headers.iter().any(|header| {
            header.name.eq_ignore_ascii_case("host")
                || header.name.len() > 256
                || header.value.len() > 16 * 1024
        })
    {
        return Err(TransportError::Other(
            "invalid test transport headers".into(),
        ));
    }
    Ok(())
}

#[async_trait::async_trait]
impl HttpClient for Transport {
    async fn request(
        &self,
        method: HttpMethod,
        url: String,
        headers: Vec<Header>,
        body: Option<Vec<u8>>,
    ) -> Result<HttpResponse, TransportError> {
        let url = self.configuration.authorize(&url, false)?;
        validate_headers(&headers)?;
        if body.as_ref().is_some_and(|body| body.len() > MAX_BODY) {
            return Err(TransportError::Other(
                "test transport body too large".into(),
            ));
        }
        let mut request = match method {
            HttpMethod::Get => self.http.get(url),
            HttpMethod::Post => self.http.post(url),
        };
        for header in headers {
            request = request.header(header.name, header.value);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let mut response = request.send().await.map_err(|_| connection_error())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value.to_str().ok().map(|value| Header {
                    name: name.as_str().to_owned(),
                    value: value.to_owned(),
                })
            })
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| connection_error())? {
            if chunk.len() > MAX_BODY.saturating_sub(body.len()) {
                return Err(TransportError::Other(
                    "test transport body too large".into(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Connection {
    writer: tokio::sync::Mutex<SplitSink<Socket, Message>>,
    reader: tokio::sync::Mutex<SplitStream<Socket>>,
}

#[async_trait::async_trait]
impl WsClient for Transport {
    async fn connect(
        &self,
        url: String,
        headers: Vec<Header>,
        timeout_ms: u64,
    ) -> Result<WsConnectResult, TransportError> {
        let url = self.configuration.authorize(&url, true)?;
        validate_headers(&headers)?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| connection_error())?;
        for header in headers {
            let name = header
                .name
                .parse::<tokio_tungstenite::tungstenite::http::HeaderName>()
                .map_err(|_| connection_error())?;
            let value = header.value.parse().map_err(|_| connection_error())?;
            request.headers_mut().insert(name, value);
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_BODY))
            .max_frame_size(Some(MAX_BODY));
        let connector = if url.scheme() == "wss" {
            Connector::Rustls(self.tls.clone())
        } else {
            Connector::Plain
        };
        let connect = connect_async_tls_with_config(request, Some(config), true, Some(connector));
        let (socket, _) = tokio::time::timeout(
            Duration::from_millis(timeout_ms).min(REQUEST_TIMEOUT),
            connect,
        )
        .await
        .map_err(|_| TransportError::Timeout)?
        .map_err(|error| match error {
            WsError::Http(response) => TransportError::Http {
                status: response.status().as_u16(),
            },
            _ => connection_error(),
        })?;
        let (writer, reader) = socket.split();
        Ok(WsConnectResult {
            connection: Arc::new(Connection {
                writer: tokio::sync::Mutex::new(writer),
                reader: tokio::sync::Mutex::new(reader),
            }),
        })
    }
}

impl Connection {
    async fn write(&self, message: Message) -> Result<(), TransportError> {
        tokio::time::timeout(WRITE_TIMEOUT, async {
            self.writer.lock().await.send(message).await
        })
        .await
        .map_err(|_| TransportError::Timeout)?
        .map_err(|_| connection_error())
    }
}

#[async_trait::async_trait]
impl WsConnection for Connection {
    async fn send(&self, frame: Vec<u8>) -> Result<(), TransportError> {
        if frame.len() > MAX_BODY {
            return Err(TransportError::Other(
                "test transport body too large".into(),
            ));
        }
        self.write(Message::Binary(frame.into())).await
    }

    async fn recv(&self) -> Result<Option<Vec<u8>>, TransportError> {
        let mut reader = self.reader.lock().await;
        loop {
            match reader.next().await {
                Some(Ok(Message::Binary(frame))) => return Ok(Some(frame.to_vec())),
                Some(Ok(Message::Ping(payload))) => self.write(Message::Pong(payload)).await?,
                Some(Ok(Message::Close(_))) | None => {
                    self.close().await;
                    return Ok(None);
                }
                Some(Ok(Message::Pong(_) | Message::Frame(_) | Message::Text(_))) => {}
                Some(Err(WsError::ConnectionClosed | WsError::AlreadyClosed)) => return Ok(None),
                Some(Err(_)) => return Err(connection_error()),
            }
        }
    }

    async fn close(&self) {
        let _ = tokio::time::timeout(WRITE_TIMEOUT, async {
            self.writer.lock().await.close().await
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration() -> Configuration {
        Configuration {
            gateway: Origin::parse("https://127.0.0.1:8443", "https").unwrap(),
            internal: Origin::parse("ws://127.0.0.1:7880", "ws").unwrap(),
            certificates: Vec::new(),
        }
    }

    #[test]
    fn test_tls_origin_configuration_requires_distinct_ip_loopback_origins() {
        for invalid in [
            "http://127.0.0.1:8443",
            "https://localhost:8443",
            "https://example.com:8443",
            "https://192.168.1.1:8443",
            "https://127.0.0.1:0",
            "https://user:secret@127.0.0.1:8443",
            "https://127.0.0.1:8443/livekit",
            "https://127.0.0.1:8443/?token=secret",
            "https://127.0.0.1:8443/#fragment",
        ] {
            assert!(Origin::parse(invalid, "https").is_err());
        }
        assert!(Origin::parse("https://[::1]:8443", "https").is_ok());
        assert_eq!(
            install_loopback_tls_transport(
                "https://127.0.0.1:8443",
                "ws://127.0.0.1:8443",
                b"invalid certificate",
            ),
            Err(InstallError::Invalid),
        );
    }

    #[test]
    fn test_tls_origin_authority_rejects_downgrades_substitution_and_secret_errors() {
        let configuration = configuration();
        for (url, websocket) in [
            (
                "https://127.0.0.1:8443/livekit/rtc/validate?access_token=secret",
                false,
            ),
            ("wss://127.0.0.1:8443/livekit/rtc?access_token=secret", true),
            ("http://127.0.0.1:7880/rtc/validate", false),
            ("ws://127.0.0.1:7880/rtc", true),
        ] {
            assert!(configuration.authorize(url, websocket).is_ok());
        }
        for (url, websocket) in [
            ("ws://127.0.0.1:8443/rtc?access_token=secret", true),
            ("http://127.0.0.1:8443/rtc/validate", false),
            ("wss://127.0.0.1:7880/rtc", true),
            ("wss://127.0.0.1:8444/rtc", true),
            ("wss://127.0.0.2:8443/rtc", true),
            ("wss://localhost:8443/rtc", true),
            ("wss://user:secret@127.0.0.1:8443/rtc", true),
            ("wss://example.com/rtc", true),
            ("https://127.0.0.1:8443/rtc", true),
            ("wss://127.0.0.1:8443/rtc#secret", true),
        ] {
            let error = configuration
                .authorize(url, websocket)
                .unwrap_err()
                .to_string();
            assert_eq!(error, "transport error: test transport origin denied");
            assert!(!error.contains("secret"));
        }
    }
}
