//! Bounded native bootstrap HTTPS. Response text and transport errors never
//! become application errors because they can contain capabilities or URLs.
use crate::{
    Error,
    wire::{canonical_origin, decode_secret},
};
use reqwest::{
    StatusCode,
    header::{ACCEPT, CONTENT_TYPE, HeaderMap},
};
use serde::{Serialize, de::DeserializeOwned};
use std::{io::Write, time::Duration};

const REQUEST_BYTES: usize = 2048;
const RESPONSE_BYTES: usize = 8192;

pub(crate) struct Http {
    client: reqwest::Client,
}

impl Http {
    pub(crate) fn new() -> Result<Self, Error> {
        Self::build(None)
    }

    pub(crate) fn with_root_certificate(pem: &[u8]) -> Result<Self, Error> {
        if pem.is_empty() || pem.len() > 65_536 {
            return Err(Error::InvalidConfig);
        }
        // The rustls implementation of from_pem defers parsing and accepts
        // input containing no certificates. Parse and count before adding trust.
        let mut certificates =
            reqwest::Certificate::from_pem_bundle(pem).map_err(|_| Error::InvalidConfig)?;
        if certificates.len() != 1 {
            return Err(Error::InvalidConfig);
        }
        let certificate = certificates.pop().ok_or(Error::InvalidConfig)?;
        Self::build(Some(certificate)).map_err(|_| Error::InvalidConfig)
    }

    fn build(root: Option<reqwest::Certificate>) -> Result<Self, Error> {
        let mut builder = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20));
        if let Some(root) = root {
            builder = builder.add_root_certificate(root);
        }
        let client = builder.build().map_err(|_| Error::Unavailable)?;
        Ok(Self { client })
    }

    pub(crate) async fn post<T: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        origin: &str,
        path: &str,
        body: &T,
        bearer: Option<&str>,
    ) -> Result<R, Error> {
        let url = endpoint(origin, path)?;
        let mut request = self
            .client
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .body(body_bytes(body)?);
        if let Some(secret) = bearer {
            decode_secret(secret).map_err(|_| Error::InvalidConfig)?;
            request = request.bearer_auth(secret);
        }
        let mut response = request.send().await.map_err(|_| Error::Unavailable)?;
        response_status(response.status())?;
        json_content_type(response.headers())?;
        if response
            .content_length()
            .is_some_and(|bytes| bytes > RESPONSE_BYTES as u64)
        {
            return Err(Error::InvalidResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
            append_response(&mut bytes, &chunk)?;
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidResponse)
    }
}

fn endpoint(origin: &str, path: &str) -> Result<String, Error> {
    let origin = canonical_origin(origin)?;
    if !matches!(
        path,
        "/runtime-api/v1/native/challenge"
            | "/runtime-api/v1/native/open"
            | "/runtime-api/v1/native/room"
    ) {
        return Err(Error::InvalidConfig);
    }
    Ok(format!("{origin}{path}"))
}

fn body_bytes<T: Serialize + ?Sized>(body: &T) -> Result<Vec<u8>, Error> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > REQUEST_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("request too large"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded(Vec::new());
    serde_json::to_writer(&mut output, body).map_err(|_| Error::InvalidResponse)?;
    Ok(output.0)
}

fn append_response(output: &mut Vec<u8>, chunk: &[u8]) -> Result<(), Error> {
    if chunk.len() > RESPONSE_BYTES.saturating_sub(output.len()) {
        return Err(Error::InvalidResponse);
    }
    output.extend_from_slice(chunk);
    Ok(())
}

fn response_status(status: StatusCode) -> Result<(), Error> {
    match status {
        StatusCode::OK => Ok(()),
        StatusCode::BAD_REQUEST => Err(Error::InvalidResponse),
        StatusCode::NOT_FOUND => Err(Error::Denied),
        StatusCode::CONFLICT => Err(Error::Stale),
        StatusCode::TOO_MANY_REQUESTS => Err(Error::Busy),
        _ => Err(Error::Unavailable),
    }
}

fn json_content_type(headers: &HeaderMap) -> Result<(), Error> {
    let mut values = headers.get_all(CONTENT_TYPE).iter();
    let value = values
        .next()
        .ok_or(Error::InvalidResponse)?
        .to_str()
        .map_err(|_| Error::InvalidResponse)?;
    if values.next().is_some() {
        return Err(Error::InvalidResponse);
    }
    let mut parts = value.split(';');
    if !parts
        .next()
        .is_some_and(|part| part.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(Error::InvalidResponse);
    }
    if let Some(parameter) = parts.next() {
        let (name, value) = parameter.split_once('=').ok_or(Error::InvalidResponse)?;
        if !name.trim().eq_ignore_ascii_case("charset")
            || !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "utf-8" | "\"utf-8\""
            )
        {
            return Err(Error::InvalidResponse);
        }
    }
    if parts.next().is_some() {
        return Err(Error::InvalidResponse);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;
    use serde_json::json;

    #[test]
    fn additional_root_must_be_a_bounded_pem_certificate() {
        const INVALID_CERTIFICATE: &[u8] =
            b"-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n";
        for pem in [
            b"".as_slice(),
            b"not a certificate",
            &[0; 65_537],
            INVALID_CERTIFICATE,
        ] {
            assert!(matches!(
                Http::with_root_certificate(pem),
                Err(Error::InvalidConfig)
            ));
        }
        let multiple = [INVALID_CERTIFICATE, INVALID_CERTIFICATE].concat();
        assert!(matches!(
            Http::with_root_certificate(&multiple),
            Err(Error::InvalidConfig)
        ));
    }

    #[test]
    fn native_endpoints_cannot_change_the_configured_origin_or_route() {
        for route in ["challenge", "open", "room"] {
            let path = format!("/runtime-api/v1/native/{route}");
            assert_eq!(
                endpoint("https://center.example.test/", &path).unwrap(),
                format!("https://center.example.test{path}")
            );
        }
        for path in [
            "https://elsewhere.test/runtime-api/v1/native/open",
            "//elsewhere.test/runtime-api/v1/native/open",
            "/runtime-api/v1/native/open?token=value",
            "/runtime-api/v1/native/open#fragment",
            "/runtime-api/v1/native/../native/open",
            "/surface-api/v1/native",
            "/runtime-api/v1/native/open/",
        ] {
            assert!(matches!(
                endpoint("https://center.example.test", path),
                Err(Error::InvalidConfig)
            ));
        }
        assert!(endpoint("http://127.0.0.1", "/runtime-api/v1/native/open").is_err());
    }

    #[test]
    fn request_serialization_is_bounded_after_json_escaping() {
        let value = "x".repeat(REQUEST_BYTES - 2);
        assert_eq!(body_bytes(value.as_str()).unwrap().len(), REQUEST_BYTES);
        assert!(body_bytes(&format!("{value}x")).is_err());
        // Each ASCII control character expands to a six-byte JSON escape.
        assert!(body_bytes(&"\u{0001}".repeat(REQUEST_BYTES / 6 + 1)).is_err());
        assert_eq!(
            body_bytes(&json!({"sequence": 1})).unwrap(),
            br#"{"sequence":1}"#
        );
    }

    #[test]
    fn streamed_response_cannot_exceed_the_limit_across_chunks() {
        let mut output = Vec::new();
        append_response(&mut output, &[1; 4096]).unwrap();
        append_response(&mut output, &[2; 4096]).unwrap();
        assert_eq!(output.len(), RESPONSE_BYTES);
        assert!(append_response(&mut output, &[3]).is_err());
        assert_eq!(output.len(), RESPONSE_BYTES);
        assert!(append_response(&mut Vec::new(), &[0; RESPONSE_BYTES + 1]).is_err());
    }

    #[test]
    fn only_200_is_success_and_status_errors_are_static() {
        response_status(StatusCode::OK).unwrap();
        assert!(matches!(
            response_status(StatusCode::BAD_REQUEST),
            Err(Error::InvalidResponse)
        ));
        assert!(matches!(
            response_status(StatusCode::NOT_FOUND),
            Err(Error::Denied)
        ));
        assert!(matches!(
            response_status(StatusCode::CONFLICT),
            Err(Error::Stale)
        ));
        assert!(matches!(
            response_status(StatusCode::TOO_MANY_REQUESTS),
            Err(Error::Busy)
        ));
        for code in [201, 204, 301, 302, 307, 308, 401, 403, 500, 502, 503] {
            assert!(matches!(
                response_status(StatusCode::from_u16(code).unwrap()),
                Err(Error::Unavailable)
            ));
        }
    }

    #[test]
    fn responses_require_one_json_content_type_with_optional_utf8_charset() {
        for value in [
            "application/json",
            "Application/JSON",
            "application/json; charset=UTF-8",
            "application/json;charset=\"utf-8\"",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(value).unwrap());
            json_content_type(&headers).unwrap();
        }
        assert!(json_content_type(&HeaderMap::new()).is_err());
        for value in [
            "text/json",
            "text/html",
            "application/problem+json",
            "application/jsonp",
            "application/json, application/json",
            "application/json;",
            "application/json; charset=latin1",
            "application/json; charset=utf8",
            "application/json; charset=utf-8; charset=utf-8",
            "application/json; anything=value",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(value).unwrap());
            assert!(json_content_type(&headers).is_err(), "{value}");
        }
        let mut headers = HeaderMap::new();
        headers.append(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.append(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert!(json_content_type(&headers).is_err());
    }
}
