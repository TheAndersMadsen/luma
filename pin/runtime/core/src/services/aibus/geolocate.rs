use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use super::envelope::unwrap_plaintext_data_for_kid;
use crate::external::google_maps::{GeoLocationFix, GoogleMapsClient, GoogleMapsError};
use crate::proto::{aibus::*, common::encryption::EncryptedData};
use crate::tier_a::proto_kids;

const MAX_GEOLOCATE_REQUEST_BYTES: usize = 128 * 1024;

pub struct GeoLocateHandler {
    google_maps: GoogleMapsClient,
}

impl Default for GeoLocateHandler {
    fn default() -> Self {
        Self::new(GoogleMapsClient::disabled(reqwest::Client::new()))
    }
}

impl GeoLocateHandler {
    pub fn new(google_maps: GoogleMapsClient) -> Self {
        Self { google_maps }
    }

    pub async fn encrypted_geo_locate(
        &self,
        request: Request<EncryptedGeoLocateRequest>,
    ) -> Result<Response<EncryptedGeoLocateResponse>, Status> {
        let request = request.into_inner();
        let request_bytes = unwrap_plaintext_data_for_kid(
            &request.request,
            proto_kids::GEO_LOCATE_REQUEST,
            MAX_GEOLOCATE_REQUEST_BYTES,
        )?;
        let geolocate_request = GeoLocateRequest::decode(request_bytes)
            .map_err(|_| Status::invalid_argument("bad GeoLocateRequest"))?;

        info!(
            cell_towers = geolocate_request.cell_towers.len(),
            wifi_access_points = geolocate_request.wifi_access_points.len(),
            consider_ip = geolocate_request.consider_ip,
            ">>> EncryptedGeoLocate"
        );

        let (status, location, radius_accuracy) =
            match self.google_maps.geolocate(&geolocate_request).await {
                Ok(fix) => (
                    GeoLocateResponseStatus::GeolocateResponseStatusSuccess,
                    Some(fix_location(fix)),
                    fix.accuracy_meters,
                ),
                Err(error) => {
                    let status = semantic_status(error);
                    if matches!(
                        status,
                        GeoLocateResponseStatus::GeolocateResponseStatusInternalError
                    ) {
                        warn!(
                            provider = "google_geolocation",
                            error_kind = error.kind(),
                            "geolocation provider request failed"
                        );
                    } else {
                        info!(
                            provider = "google_geolocation",
                            error_kind = error.kind(),
                            "geolocation did not produce a location"
                        );
                    }
                    (status, None, 0.0)
                }
            };

        let response = GeoLocateResponse {
            location,
            radius_accuracy,
            status: status as i32,
        };

        info!(status = status.as_str_name(), "<<< EncryptedGeoLocate");
        Ok(Response::new(EncryptedGeoLocateResponse {
            response: Some(EncryptedData::new(
                proto_kids::GEO_LOCATE_RESPONSE,
                response.encode_to_vec(),
            )),
        }))
    }
}

fn fix_location(fix: GeoLocationFix) -> Location {
    Location {
        latitude: fix.latitude,
        longitude: fix.longitude,
    }
}

fn semantic_status(error: GoogleMapsError) -> GeoLocateResponseStatus {
    match error {
        GoogleMapsError::Disabled | GoogleMapsError::NotFound => {
            GeoLocateResponseStatus::GeolocateResponseStatusNotFound
        }
        GoogleMapsError::InvalidRequest(_) | GoogleMapsError::BadRequest => {
            GeoLocateResponseStatus::GeolocateResponseStatusBadRequest
        }
        GoogleMapsError::NotConfigured
        | GoogleMapsError::RoutesComplianceRequired
        | GoogleMapsError::RateLimited
        | GoogleMapsError::Transport
        | GoogleMapsError::ProviderUnavailable
        | GoogleMapsError::MalformedResponse
        | GoogleMapsError::ResponseTooLarge => {
            GeoLocateResponseStatus::GeolocateResponseStatusInternalError
        }
    }
}

#[cfg(test)]
mod tests {
    use prost::Message as _;

    use super::*;

    #[test]
    fn geolocate_request_wire_layout_matches_stock_consider_ip_field() {
        let encoded = GeoLocateRequest {
            consider_ip: true,
            ..Default::default()
        }
        .encode_to_vec();
        assert_eq!(encoded, [0x28, 0x01]);
    }

    #[tokio::test]
    async fn disabled_geolocation_returns_stock_not_found_response() {
        let handler = GeoLocateHandler::default();
        let request = EncryptedGeoLocateRequest {
            request: Some(EncryptedData::new(
                proto_kids::GEO_LOCATE_REQUEST,
                GeoLocateRequest::default().encode_to_vec(),
            )),
        };

        let response = handler
            .encrypted_geo_locate(Request::new(request))
            .await
            .unwrap()
            .into_inner()
            .response
            .unwrap();
        assert_eq!(
            response.encryption_information.unwrap().kid,
            proto_kids::GEO_LOCATE_RESPONSE
        );
        let response = GeoLocateResponse::decode(response.data.as_slice()).unwrap();
        assert_eq!(response.location, None);
        assert_eq!(response.radius_accuracy, 0.0);
        assert_eq!(
            response.status,
            GeoLocateResponseStatus::GeolocateResponseStatusNotFound as i32
        );
    }

    #[test]
    fn provider_errors_map_only_to_stock_semantic_statuses() {
        assert_eq!(
            semantic_status(GoogleMapsError::Disabled),
            GeoLocateResponseStatus::GeolocateResponseStatusNotFound
        );
        assert_eq!(
            semantic_status(GoogleMapsError::BadRequest),
            GeoLocateResponseStatus::GeolocateResponseStatusBadRequest
        );
        assert_eq!(
            semantic_status(GoogleMapsError::ProviderUnavailable),
            GeoLocateResponseStatus::GeolocateResponseStatusInternalError
        );
        assert_eq!(
            semantic_status(GoogleMapsError::NotConfigured),
            GeoLocateResponseStatus::GeolocateResponseStatusInternalError
        );
    }
}
