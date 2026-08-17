use tonic::{Request, Response, Status};
use tracing::info;

use crate::proto::account::user_information_service_server::UserInformationService;
use crate::proto::account::*;

pub struct UserInformationServiceImpl;

#[tonic::async_trait]
impl UserInformationService for UserInformationServiceImpl {
    async fn get_user_personal_details(
        &self,
        _request: Request<()>,
    ) -> Result<Response<PersonalDetailsResponse>, Status> {
        info!(">>> UserInformation.GetUserPersonalDetails");
        Ok(Response::new(PersonalDetailsResponse {
            account_info: Some(AccountInfo {
                preferred_name: "User".into(),
                pronunciation: String::new(),
            }),
            secure_bio_data: None,
        }))
    }
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::*;

    // Independent stock-wire projections reconstructed from the firmware's
    // generated protobuf-lite classes. Keeping these separate from the server's
    // generated types makes this test catch accidental field-number drift.
    #[derive(Clone, PartialEq, Message)]
    struct StockAccountInfo {
        #[prost(string, tag = "1")]
        preferred_name: String,
        #[prost(string, tag = "2")]
        pronunciation: String,
    }

    #[derive(Clone, PartialEq, Message)]
    struct StockPersonalDetailsResponse {
        #[prost(message, optional, tag = "1")]
        account_info: Option<StockAccountInfo>,
    }

    #[tokio::test]
    async fn personal_details_response_matches_stock_account_info_wire_shape() {
        let response = UserInformationServiceImpl
            .get_user_personal_details(Request::new(()))
            .await
            .expect("personal details response")
            .into_inner();

        let stock = StockPersonalDetailsResponse::decode(response.encode_to_vec().as_slice())
            .expect("stock client must decode the response");
        assert_eq!(
            stock
                .account_info
                .expect("stock account_info")
                .preferred_name,
            "User"
        );
    }
}
