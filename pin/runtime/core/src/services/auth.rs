//! gRPC authentication interceptor for local server.
//!
//! The server mounts privileged gRPC services on a loopback listener. This
//! interceptor checks for a bearer token in gRPC metadata, reusing the same
//! token from config. Any local process without the token is rejected.

use std::fmt;
use std::sync::Arc;

use subtle::ConstantTimeEq as _;
use tonic::service::Interceptor;
use tonic::{Request, Status};

use crate::config::{MAX_ADMIN_TOKEN_BYTES, MIN_ADMIN_TOKEN_BYTES};

/// Authenticates gRPC requests by checking for a bearer token in metadata.
///
/// The interceptor looks for an "authorization" header with "Bearer <token>" format.
///
/// Host-only development may construct this with `None`. Android startup rejects
/// that configuration before the interceptor is installed.
#[derive(Clone)]
pub struct GrpcAuthInterceptor {
    expected_token: Option<Arc<[u8]>>,
}

impl fmt::Debug for GrpcAuthInterceptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GrpcAuthInterceptor")
            .field("authentication_enabled", &self.expected_token.is_some())
            .finish()
    }
}

impl GrpcAuthInterceptor {
    /// Create a new interceptor with the expected bearer token.
    ///
    /// When `token` is `Some`, every request must carry one matching bearer token.
    /// `None` is reserved for host-only development; Android startup forbids it.
    pub fn new(token: Option<String>) -> Self {
        Self {
            expected_token: token.map(|token| Arc::<[u8]>::from(token.into_bytes())),
        }
    }

    /// Extract bearer token from request metadata.
    fn extract_bearer_token(request: &Request<()>) -> Option<&[u8]> {
        let mut values = request.metadata().get_all("authorization").iter();
        let auth_header = values.next()?;
        if values.next().is_some() {
            return None;
        }
        let auth_str = auth_header.to_str().ok()?;
        let token = auth_str.strip_prefix("Bearer ")?.as_bytes();
        ((MIN_ADMIN_TOKEN_BYTES..=MAX_ADMIN_TOKEN_BYTES).contains(&token.len())
            && token.iter().all(u8::is_ascii_graphic))
        .then_some(token)
    }

    fn token_matches(presented: &[u8], expected: &[u8]) -> bool {
        let mut presented_padded = [0_u8; MAX_ADMIN_TOKEN_BYTES];
        let mut expected_padded = [0_u8; MAX_ADMIN_TOKEN_BYTES];

        let presented_copy_len = presented.len().min(MAX_ADMIN_TOKEN_BYTES);
        let expected_copy_len = expected.len().min(MAX_ADMIN_TOKEN_BYTES);
        presented_padded[..presented_copy_len].copy_from_slice(&presented[..presented_copy_len]);
        expected_padded[..expected_copy_len].copy_from_slice(&expected[..expected_copy_len]);

        let same_length = (presented.len() as u64).ct_eq(&(expected.len() as u64));
        let same_content = presented_padded.ct_eq(&expected_padded);
        bool::from(same_length & same_content)
    }
}

impl Interceptor for GrpcAuthInterceptor {
    fn call(&mut self, request: Request<()>) -> Result<Request<()>, Status> {
        let Some(expected) = &self.expected_token else {
            return Ok(request);
        };

        match Self::extract_bearer_token(&request) {
            Some(token) if Self::token_matches(token, expected) => Ok(request),
            Some(_) => Err(Status::unauthenticated("invalid bearer token")),
            None => Err(Status::unauthenticated("missing or invalid bearer token")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::metadata::MetadataValue;

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn make_request(token: Option<&str>) -> Request<()> {
        let mut request = Request::new(());

        if let Some(token) = token {
            let auth_value: MetadataValue<_> = format!("Bearer {}", token).parse().unwrap();
            request.metadata_mut().insert("authorization", auth_value);
        }

        request
    }

    #[test]
    fn valid_token_allows_request() {
        let mut interceptor = GrpcAuthInterceptor::new(Some(TOKEN.to_string()));
        let request = make_request(Some(TOKEN));

        let result = interceptor.call(request);
        assert!(result.is_ok());
    }

    #[test]
    fn missing_token_rejected() {
        let mut interceptor = GrpcAuthInterceptor::new(Some(TOKEN.to_string()));
        let request = make_request(None);

        let result = interceptor.call(request);
        assert!(result.is_err());
        let status = result.unwrap_err();
        assert_eq!(status.code(), tonic::Code::Unauthenticated);
        assert!(status.message().contains("missing or invalid bearer token"));
    }

    #[test]
    fn wrong_token_rejected() {
        let mut interceptor = GrpcAuthInterceptor::new(Some(TOKEN.to_string()));
        let request = make_request(Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));

        let result = interceptor.call(request);
        assert!(result.is_err());
        let status = result.unwrap_err();
        assert_eq!(status.code(), tonic::Code::Unauthenticated);
        assert!(status.message().contains("invalid bearer token"));
    }

    #[test]
    fn malformed_authorization_header_rejected() {
        let mut interceptor = GrpcAuthInterceptor::new(Some(TOKEN.to_string()));

        let mut request = Request::new(());

        // Missing "Bearer " prefix
        let auth_value: MetadataValue<_> = TOKEN.parse().unwrap();
        request.metadata_mut().insert("authorization", auth_value);

        let result = interceptor.call(request);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code(), tonic::Code::Unauthenticated);
    }

    #[test]
    fn no_token_configured_passes_through() {
        let mut interceptor = GrpcAuthInterceptor::new(None);

        // Any request passes without a token when no token is configured
        let request = make_request(None);
        assert!(interceptor.call(request).is_ok());

        // Even with a token present, pass through when none is expected
        let request = make_request(Some(TOKEN));
        assert!(interceptor.call(request).is_ok());
    }

    #[test]
    fn duplicate_and_invalid_length_headers_are_rejected() {
        let mut interceptor = GrpcAuthInterceptor::new(Some(TOKEN.to_string()));
        let mut duplicate = make_request(Some(TOKEN));
        duplicate
            .metadata_mut()
            .append("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        assert_eq!(
            interceptor.call(duplicate).unwrap_err().code(),
            tonic::Code::Unauthenticated
        );

        let short = make_request(Some("too-short"));
        assert_eq!(
            interceptor.call(short).unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
    }

    #[test]
    fn debug_output_never_contains_the_token() {
        let interceptor = GrpcAuthInterceptor::new(Some(TOKEN.to_string()));
        let output = format!("{interceptor:?}");
        assert!(output.contains("authentication_enabled: true"));
        assert!(!output.contains(TOKEN));
    }
}
