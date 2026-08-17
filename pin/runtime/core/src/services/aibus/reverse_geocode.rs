use prost::Message as _;
use tonic::{Request, Response, Status};
use tracing::{info, warn};

use super::envelope::unwrap_plaintext_data_for_kid;
use crate::external::osm::{OsmClient, OsmOptions};
use crate::proto::aibus::*;
use crate::proto::common::encryption::{self, EncryptedData};
use crate::tier_a::proto_kids;

const MAX_LOCATION_ENVELOPE_BYTES: usize = 16 * 1024;

pub struct ReverseGeocodeHandler {
    osm: OsmClient,
}

impl ReverseGeocodeHandler {
    pub fn new(http_client: reqwest::Client, options: OsmOptions) -> Self {
        Self {
            osm: OsmClient::new(http_client, options),
        }
    }

    pub async fn encrypted_reverse_geocode(
        &self,
        request: Request<EncryptedReverseGeocodeRequest>,
    ) -> Result<Response<EncryptedReverseGeocodeResponse>, Status> {
        let req = request.into_inner();
        let location_bytes = unwrap_plaintext_data_for_kid(
            &req.location,
            proto_kids::LOCATION_ENVELOPE,
            MAX_LOCATION_ENVELOPE_BYTES,
        )?;
        let location = encryption::LocationEnvelope::decode(location_bytes)
            .map_err(|_| Status::invalid_argument("bad LocationEnvelope"))?;

        info!(">>> EncryptedReverseGeocode");

        let result = self
            .osm
            .reverse_geocode(location.latitude.into(), location.longitude.into())
            .await
            .map_err(|error| {
                warn!(
                    error_kind = error.kind(),
                    "reverse geocode provider request failed"
                );
                Status::unavailable("reverse geocode provider is temporarily unavailable")
            })?;

        let reverse_response = ReverseGeocodeResponse {
            street_number: result.street_number.unwrap_or_default(),
            street_name: result.street_name.unwrap_or_default(),
            municipality: result.municipality.unwrap_or_default(),
            country_subdivision: result.country_subdivision.unwrap_or_default(),
            country: result.country.unwrap_or_default(),
            postal_code: result.postal_code.unwrap_or_default(),
        };

        Ok(Response::new(EncryptedReverseGeocodeResponse {
            response: Some(EncryptedData::new(
                proto_kids::REVERSE_GEOCODE_RESPONSE,
                reverse_response.encode_to_vec(),
            )),
        }))
    }
}
