use tonic::{Request, Response, Status};
use tracing::info;

use crate::proto::account::wifi_config_service_server::WifiConfigService;
use crate::proto::account::*;

pub struct WifiConfigServiceImpl;

#[tonic::async_trait]
impl WifiConfigService for WifiConfigServiceImpl {
    async fn list_secure_wifi_configs(
        &self,
        _request: Request<ListSecureWifiConfigsRequest>,
    ) -> Result<Response<ListSecureWifiConfigsResponse>, Status> {
        info!(">>> WifiConfig.ListSecureWifiConfigs");
        // Sealed envelopes, empty. This deployment stores no wearer Wi-Fi
        // credentials on the device, and the field is
        // `repeated humane.common.encryption.EncryptedData` precisely so that a
        // future row cannot cross the wire as plaintext SSID and PSK.
        Ok(Response::new(ListSecureWifiConfigsResponse {
            secure_wifi_configs: vec![],
        }))
    }
}
