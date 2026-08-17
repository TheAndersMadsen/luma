use tonic::{Request, Response, Status};
use tracing::info;

use crate::proto::privacy::common::{KeyState, KeyStateResponse};
use crate::proto::privacy::pub_::public_privacy_service_server::PublicPrivacyService;
use crate::proto::privacy::pub_::*;

pub struct PublicPrivacyServiceImpl;

#[tonic::async_trait]
impl PublicPrivacyService for PublicPrivacyServiceImpl {
    async fn establish_wrapping_keys(
        &self,
        _request: Request<EstablishWrappingKeysRequest>,
    ) -> Result<Response<EstablishWrappingKeysResponse>, Status> {
        info!(">>> PublicPrivacy.EstablishWrappingKeys");
        Ok(Response::new(EstablishWrappingKeysResponse::default()))
    }

    async fn import_keys(
        &self,
        request: Request<ImportKeysRequest>,
    ) -> Result<Response<ImportKeysResponse>, Status> {
        let inner = request.into_inner();
        info!(">>> PublicPrivacy.ImportKeys ({} keys)", inner.keys.len());
        let results = inner
            .keys
            .into_iter()
            .map(|k| KeyStateResponse {
                kid: k.kid,
                status: KeyState::KeyImported as i32,
            })
            .collect();
        Ok(Response::new(ImportKeysResponse { results }))
    }

    async fn request_keys(
        &self,
        request: Request<RequestKeysRequest>,
    ) -> Result<Response<RequestKeysResponse>, Status> {
        let inner = request.into_inner();
        info!(">>> PublicPrivacy.RequestKeys ({} kids)", inner.kids.len());
        Ok(Response::new(RequestKeysResponse::default()))
    }

    async fn update_keys(
        &self,
        request: Request<UpdateKeysRequest>,
    ) -> Result<Response<UpdateKeysResponse>, Status> {
        let inner = request.into_inner();
        info!(
            ">>> PublicPrivacy.UpdateKeys ({} updates)",
            inner.updates.len()
        );
        let results = inner
            .updates
            .into_iter()
            .map(|u| KeyStateResponse {
                kid: u.kid,
                status: KeyState::KeyUpdated as i32,
            })
            .collect();
        Ok(Response::new(UpdateKeysResponse { results }))
    }

    async fn remove_keys(
        &self,
        request: Request<RemoveKeysRequest>,
    ) -> Result<Response<RemoveKeysResponse>, Status> {
        let inner = request.into_inner();
        info!(">>> PublicPrivacy.RemoveKeys ({} kids)", inner.kids.len());
        let results = inner
            .kids
            .into_iter()
            .map(|kid| KeyStateResponse {
                kid,
                status: KeyState::KeyRemoved as i32,
            })
            .collect();
        Ok(Response::new(RemoveKeysResponse { results }))
    }

    async fn sync_keys(
        &self,
        _request: Request<SyncKeysRequest>,
    ) -> Result<Response<SyncKeysResponse>, Status> {
        info!(">>> PublicPrivacy.SyncKeys");
        Ok(Response::new(SyncKeysResponse::default()))
    }

    async fn get_settings(
        &self,
        request: Request<GetSettingsRequest>,
    ) -> Result<Response<GetSettingsResponse>, Status> {
        let inner = request.into_inner();
        info!(
            ">>> PublicPrivacy.GetSettings ({} names)",
            inner.names.len()
        );
        Ok(Response::new(GetSettingsResponse::default()))
    }

    async fn update_settings(
        &self,
        request: Request<UpdateSettingsRequest>,
    ) -> Result<Response<UpdateSettingsResponse>, Status> {
        let inner = request.into_inner();
        info!(
            ">>> PublicPrivacy.UpdateSettings ({} settings)",
            inner.settings.len()
        );
        Ok(Response::new(UpdateSettingsResponse::default()))
    }

    async fn get_configuration(
        &self,
        _request: Request<GetConfigurationRequest>,
    ) -> Result<Response<GetConfigurationResponse>, Status> {
        info!(">>> PublicPrivacy.GetConfiguration");
        Ok(Response::new(GetConfigurationResponse::default()))
    }
}
