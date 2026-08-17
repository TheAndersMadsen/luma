use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::info;

use super::envelope::unwrap_plaintext_data_for_kid;
use crate::external::osm::OsmError;
use crate::nearby::NearbyClient;
use crate::proto::aibus::*;
use crate::proto::common::encryption::EncryptedData;
use crate::tier_a::proto_kids;

const MAX_NEARBY_REQUEST_BYTES: usize = 64 * 1024;

pub struct NearbySearchHandler {
    nearby_client: NearbyClient,
}

impl NearbySearchHandler {
    pub fn new(nearby_client: NearbyClient) -> Self {
        Self { nearby_client }
    }

    pub async fn encrypted_nearby_search(
        &self,
        request: Request<EncryptedNearbySearchRequest>,
    ) -> Result<Response<EncryptedNearbySearchResponse>, Status> {
        let req = request.into_inner();
        let request_bytes = unwrap_plaintext_data_for_kid(
            &req.request,
            proto_kids::NEARBY_SEARCH_REQUEST,
            MAX_NEARBY_REQUEST_BYTES,
        )?;
        let nearby_req = NearbySearchRequest::decode(request_bytes)
            .map_err(|_| Status::invalid_argument("bad NearbySearchRequest"))?;

        let location = nearby_req
            .location
            .ok_or_else(|| Status::invalid_argument("NearbySearchRequest missing location"))?;
        let lat = location.latitude;
        let lon = location.longitude;
        let radius = if nearby_req.radius_accuracy > 0.0 {
            nearby_req.radius_accuracy
        } else {
            1000.0
        };

        info!(">>> EncryptedNearbySearch");

        let nearby_places = self
            .nearby_client
            .search(lat, lon, radius, &nearby_req.text_query)
            .await
            .map_err(|error| {
                tracing::warn!(error_kind = error.kind(), "nearby provider request failed");
                nearby_status(error)
            })?;

        let result_count = nearby_places.len();
        let nearby_response = NearbySearchResponse {
            nearby_places,
            status: Some(NearbySearchResultStatus::Success as i32),
        };

        info!(results = result_count, "<<< EncryptedNearbySearch");
        Ok(Response::new(EncryptedNearbySearchResponse {
            response: Some(EncryptedData::new(
                proto_kids::NEARBY_SEARCH_RESPONSE,
                nearby_response.encode_to_vec(),
            )),
        }))
    }
}

fn nearby_status(error: OsmError) -> Status {
    match error {
        OsmError::InvalidRequest(_) => Status::invalid_argument("invalid nearby request"),
        OsmError::Disabled | OsmError::LocationConsentRequired => {
            Status::failed_precondition("nearby provider is not enabled")
        }
        OsmError::Timeout
        | OsmError::Transport
        | OsmError::ProviderRejected
        | OsmError::ProviderUnavailable
        | OsmError::ResponseTooLarge
        | OsmError::NotFound
        | OsmError::InvalidResponse => {
            Status::unavailable("nearby provider is temporarily unavailable")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::Code;

    #[test]
    fn nearby_errors_preserve_client_config_and_transient_semantics() {
        assert_eq!(
            nearby_status(OsmError::InvalidRequest("bad geometry")).code(),
            Code::InvalidArgument
        );
        assert_eq!(
            nearby_status(OsmError::LocationConsentRequired).code(),
            Code::FailedPrecondition
        );
        assert_eq!(
            nearby_status(OsmError::ProviderUnavailable).code(),
            Code::Unavailable
        );
    }
}
