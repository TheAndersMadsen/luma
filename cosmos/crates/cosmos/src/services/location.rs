//! `humane.location.v1.E911GeoLocationService`, resolve a device's physical
//! position from observed radio fingerprints (cell towers + Wi-Fi access points).
//!
//! `GeoLocate` is the E911 wireless-positioning lookup: the device sends the
//! `GeoLocateRequest.cell_towers` / `wifi_access_points` it can see and expects a
//! `Location { latitude, longitude }` with a `radius_accuracy`. Turning radio
//! observations into real coordinates requires an external Wi-Fi/cell positioning
//! database (Google Geolocation / Mozilla Location Service or equivalent), it is
//! unguessable external state this clone does not host.
//!
//! Because this is an *emergency* location service, a fabricated or defaulted
//! position would be actively harmful: a `(0, 0)` fix or a `SUCCESS`/`NOT_FOUND`
//! answer would read as authoritative and could misdirect an E911 flow.
//! When the backend key is present, this RPC returns a real geolocation result;
//! when absent, it returns `UNIMPLEMENTED` rather than fabricating coordinates.
//! Nothing here fabricates location data.
//!
//! Authentication is enforced at the mTLS edge (DeviceUser client cert /
//! `X-Forwarded-Client-Cert` principal, per RUNTIME-CONTRACTS §2). This handler
//! trusts the already-authenticated channel and holds no state.

use cosmos_protocol::aibus;
use cosmos_protocol::location::v1 as pb;

use crate::backends::BackendError;
use pb::e911_geo_location_service_server::E911GeoLocationService;
use tonic::{Request, Response, Status};

/// `humane.location.v1.E911GeoLocationService`, E911 wireless positioning.
#[derive(Clone, Default)]
pub struct Location;

/// Translate provider outcomes into stable public gRPC semantics without
/// leaking vendor responses or ever manufacturing an E911 fix.
fn backend_status(error: BackendError) -> Status {
    match error {
        BackendError::NotConfigured => Status::unimplemented(
            "E911 GeoLocate requires an external Wi-Fi/cell positioning provider \
             (Google Geolocation / Google Maps); set COSMOS_GOOGLE_MAPS_KEY",
        ),
        BackendError::NoResult => {
            Status::not_found("E911 GeoLocate could not resolve the radio observations")
        }
        BackendError::Unavailable => {
            Status::unavailable("E911 GeoLocate provider is currently unreachable")
        }
    }
}

#[tonic::async_trait]
impl E911GeoLocationService for Location {
    /// Resolve radio observations into coordinates using the backend geolocation
    /// adapter (`Google Geolocation API`, when `COSMOS_GOOGLE_MAPS_KEY` is set).
    /// The service is intentionally no longer blanket-`UNIMPLEMENTED`: when
    /// credentials are present, it returns a real location response. When missing,
    /// it returns a clear gRPC capability error instead of fabricating coordinates.
    async fn geo_locate(
        &self,
        request: Request<aibus::GeoLocateRequest>,
    ) -> Result<Response<aibus::GeoLocateResponse>, Status> {
        let request = request.into_inner();
        let response = crate::backends::places::geolocate(&request)
            .await
            .map_err(backend_status)?;
        Ok(Response::new(response))
    }
}
