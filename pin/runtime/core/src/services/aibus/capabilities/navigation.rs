use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use super::super::envelope::unwrap_plaintext_data_for_kid;
use crate::external::google_maps::{GoogleMapsClient, GoogleMapsError};
use crate::proto::aibus::*;
use crate::proto::common::encryption::{self, EncryptedData};

const NAVIGATION_REQUEST_KID: &str = crate::tier_a::proto_kids::NAVIGATION_DIRECTIONS_REQUEST;
const NAVIGATION_LOCATION_KID: &str = crate::tier_a::proto_kids::LOCATION_ENVELOPE;
const NAVIGATION_RESPONSE_KID: &str = crate::tier_a::proto_kids::NAVIGATION_DIRECTIONS_RESPONSE;
const MAX_NAVIGATION_REQUEST_BYTES: usize = 4 * 1024;
const MAX_LOCATION_ENVELOPE_BYTES: usize = 16 * 1024;

pub struct NavigationDirectionsHandler {
    google_maps: GoogleMapsClient,
}

impl Default for NavigationDirectionsHandler {
    fn default() -> Self {
        Self::new(GoogleMapsClient::disabled(reqwest::Client::new()))
    }
}

impl NavigationDirectionsHandler {
    pub fn new(google_maps: GoogleMapsClient) -> Self {
        Self { google_maps }
    }

    pub async fn encrypted_navigation_directions(
        &self,
        request: Request<EncryptedNavigationDirectionsRequest>,
    ) -> Result<Response<EncryptedNavigationDirectionsResponse>, Status> {
        let request = request.into_inner();
        let location_bytes = unwrap_plaintext_data_for_kid(
            &request.location,
            NAVIGATION_LOCATION_KID,
            MAX_LOCATION_ENVELOPE_BYTES,
        )?;
        let location = encryption::LocationEnvelope::decode(location_bytes)
            .map_err(|_| Status::invalid_argument("bad LocationEnvelope"))?;

        let navigation_bytes = unwrap_plaintext_data_for_kid(
            &request.request,
            NAVIGATION_REQUEST_KID,
            MAX_NAVIGATION_REQUEST_BYTES,
        )?;
        let navigation_request = NavigationDirectionsRequest::decode(navigation_bytes)
            .map_err(|_| Status::invalid_argument("bad NavigationDirectionsRequest"))?;

        info!(">>> EncryptedNavigationDirections");
        let response = match self
            .google_maps
            .compute_route(
                location.latitude.into(),
                location.longitude.into(),
                &navigation_request.destination,
            )
            .await
        {
            Ok(response) => response,
            Err(GoogleMapsError::Disabled) => {
                info!("navigation provider is disabled");
                NavigationDirectionsResponse::default()
            }
            Err(GoogleMapsError::NotFound | GoogleMapsError::BadRequest) => {
                info!("navigation provider found no route");
                NavigationDirectionsResponse::default()
            }
            Err(GoogleMapsError::InvalidRequest(_)) => {
                return Err(Status::invalid_argument("invalid navigation request"));
            }
            Err(GoogleMapsError::RoutesComplianceRequired) => {
                return Err(Status::failed_precondition(
                    "navigation provider compliance acknowledgement is required",
                ));
            }
            Err(GoogleMapsError::NotConfigured) => {
                return Err(Status::unavailable("navigation provider is not configured"));
            }
            Err(error) => {
                warn!(
                    provider = "google_routes",
                    error_kind = error.kind(),
                    "navigation provider request failed"
                );
                return Err(Status::unavailable(
                    "navigation provider is temporarily unavailable",
                ));
            }
        };

        info!(
            steps = response.steps.len(),
            "<<< EncryptedNavigationDirections"
        );
        Ok(Response::new(EncryptedNavigationDirectionsResponse {
            response: Some(EncryptedData::new(
                NAVIGATION_RESPONSE_KID,
                response.encode_to_vec(),
            )),
        }))
    }
}

#[cfg(test)]
mod tests {
    use prost::Message as _;

    use super::*;

    fn encrypted(kid: &str, data: Vec<u8>) -> EncryptedData {
        EncryptedData::new(kid, data)
    }

    #[test]
    fn navigation_request_wire_layout_matches_stock_destination_field() {
        let encoded = NavigationDirectionsRequest {
            destination: "x".into(),
        }
        .encode_to_vec();
        assert_eq!(encoded, [0x0a, 0x01, b'x']);
    }

    #[tokio::test]
    async fn disabled_routes_preserve_the_stock_empty_response_stub() {
        let handler = NavigationDirectionsHandler::default();
        let location = encryption::LocationEnvelope {
            longitude: 12.0,
            latitude: 55.0,
            ..Default::default()
        };
        let navigation = NavigationDirectionsRequest {
            destination: "Copenhagen".into(),
        };
        let request = EncryptedNavigationDirectionsRequest {
            location: Some(encrypted(NAVIGATION_LOCATION_KID, location.encode_to_vec())),
            request: Some(encrypted(
                NAVIGATION_REQUEST_KID,
                navigation.encode_to_vec(),
            )),
        };

        let response = handler
            .encrypted_navigation_directions(Request::new(request))
            .await
            .unwrap()
            .into_inner()
            .response
            .unwrap();
        assert_eq!(
            response.encryption_information.unwrap().kid,
            NAVIGATION_RESPONSE_KID
        );
        assert_eq!(
            NavigationDirectionsResponse::decode(response.data.as_slice()).unwrap(),
            NavigationDirectionsResponse::default()
        );
    }

    #[tokio::test]
    async fn navigation_rejects_a_valid_payload_with_the_wrong_kid() {
        let handler = NavigationDirectionsHandler::default();
        let request = EncryptedNavigationDirectionsRequest {
            location: Some(encrypted(
                crate::tier_a::proto_kids::NAVIGATION_DIRECTIONS_REQUEST,
                encryption::LocationEnvelope::default().encode_to_vec(),
            )),
            request: Some(encrypted(
                NAVIGATION_REQUEST_KID,
                NavigationDirectionsRequest::default().encode_to_vec(),
            )),
        };
        let status = handler
            .encrypted_navigation_directions(Request::new(request))
            .await
            .unwrap_err();
        assert_eq!(status.code(), tonic::Code::InvalidArgument);
    }
}
