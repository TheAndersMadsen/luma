//! Router-stack helpers shared by the HTTP and gRPC listeners: the fallback
//! for unmatched routes and the UNIMPLEMENTED-status log tap. The tests here
//! pin the axum/h2/tonic stack the composition root serves.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use tracing::warn;

/// Catches any request that doesn't match a registered HTTP or gRPC route.
/// Logs a warning and returns HTTP 404.
pub(crate) async fn fallback_handler(request: axum::extract::Request) -> impl IntoResponse {
    warn!(
        method = %request.method(),
        content_type = request.headers().get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("none"),
        "unhandled request. No matching route"
    );
    (StatusCode::NOT_FOUND, "not found")
}

/// Middleware that inspects gRPC responses for UNIMPLEMENTED status (code 12)
/// and logs a warning when one is detected.
pub(crate) async fn log_grpc_unimplemented(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path().to_owned();
    let response = next.run(request).await;

    // gRPC status code 12 = UNIMPLEMENTED.
    // Tonic sets this in the `grpc-status` header for routing-level rejections.
    if let Some(status) = response.headers().get("grpc-status") {
        if status.as_bytes() == b"12" {
            warn!(path = %path, "gRPC UNIMPLEMENTED. method not registered");
        }
    }

    response
}

#[cfg(test)]
mod tests {
    use crate::dedup::DedupRouter;
    use crate::proto::account::wifi_config_service_client::WifiConfigServiceClient;
    use crate::proto::account::wifi_config_service_server::WifiConfigServiceServer;
    use crate::proto::account::ListSecureWifiConfigsRequest;
    use crate::services::wifi_config::WifiConfigServiceImpl;

    async fn require_http2(
        request: axum::extract::Request,
        next: axum::middleware::Next,
    ) -> axum::response::Response {
        assert_eq!(request.version(), axum::http::Version::HTTP_2);
        next.run(request).await
    }

    #[tokio::test]
    async fn axum_serve_accepts_tonic_http2_requests() {
        let manifest: toml::Value =
            toml::from_str(include_str!("../../Cargo.toml")).expect("parse Cargo.toml");
        let axum_features = manifest["dependencies"]["axum"]["features"]
            .as_array()
            .expect("Axum dependency must declare features explicitly");
        assert!(
            axum_features
                .iter()
                .any(|feature| feature.as_str() == Some("http2")),
            "Axum must explicitly enable HTTP/2; relying on transitive feature unification is not a release contract"
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Axum gRPC test listener");
        let address = listener.local_addr().expect("Axum gRPC test address");
        let router = DedupRouter::new(WifiConfigServiceServer::new(WifiConfigServiceImpl))
            .into_axum_router()
            .layer(axum::middleware::from_fn(require_http2));
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Tonic route through Axum");
        });

        let mut client = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            WifiConfigServiceClient::connect(format!("http://{address}")),
        )
        .await
        .expect("Tonic HTTP/2 handshake timed out")
        .expect("Axum must accept the Tonic HTTP/2 connection");
        let response = client
            .list_secure_wifi_configs(ListSecureWifiConfigsRequest {})
            .await
            .expect("Tonic request must traverse the Axum router")
            .into_inner();
        assert!(response.secure_wifi_configs.is_empty());

        server.abort();
        let _ = server.await;
    }

    /// Full-stack streaming regression: tonic-encoded server-streaming RPCs
    /// must forward frames through dedup + axum + h2 before the stream closes.
    /// This exercises the real tonic codec layer that the raw-body test bypasses.
    #[tokio::test]
    async fn tonic_streaming_responses_forward_through_dedup_and_h2() {
        use crate::proto::contacts::contacts_rpc_service_client::ContactsRpcServiceClient;
        use crate::proto::contacts::contacts_rpc_service_server::{
            ContactsRpcService, ContactsRpcServiceServer,
        };
        use crate::proto::contacts::*;
        use prost_types::Timestamp;
        use std::pin::Pin;
        use tokio::sync::mpsc;
        use tokio_stream::wrappers::ReceiverStream;
        use tonic::{Request, Response, Status};

        // Mock service that feeds channel responses through tonic's real stream wrapper
        struct MockContacts;
        #[tonic::async_trait]
        impl ContactsRpcService for MockContacts {
            type GetContactsStreamingStream = Pin<
                Box<
                    dyn futures::Stream<Item = Result<GetContactsStreamingResponse, Status>> + Send,
                >,
            >;
            type GetContactsPaginatedStreamingStream = Pin<
                Box<
                    dyn futures::Stream<Item = Result<GetContactsStreamingPageResponse, Status>>
                        + Send,
                >,
            >;

            async fn get_contacts(
                &self,
                _: Request<GetContactsRequest>,
            ) -> Result<Response<ContactList>, Status> {
                Ok(Response::new(ContactList::default()))
            }
            async fn get_contact_deltas(
                &self,
                _: Request<GetContactDeltasRequest>,
            ) -> Result<Response<GetContactDeltasResponse>, Status> {
                Ok(Response::new(GetContactDeltasResponse::default()))
            }
            async fn get_contacts_streaming(
                &self,
                _: Request<GetContactsStreamingRequest>,
            ) -> Result<Response<Self::GetContactsStreamingStream>, Status> {
                let (tx, rx) = mpsc::channel(16);
                tokio::spawn(async move {
                    let _ = tx
                        .send(Ok(GetContactsStreamingResponse {
                            modified_time: Some(Timestamp {
                                seconds: 1,
                                nanos: 0,
                            }),
                            response: Some(
                                get_contacts_streaming_response::Response::DeletedContactId(
                                    "first".into(),
                                ),
                            ),
                        }))
                        .await;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let _ = tx
                        .send(Ok(GetContactsStreamingResponse {
                            modified_time: Some(Timestamp {
                                seconds: 2,
                                nanos: 0,
                            }),
                            response: Some(
                                get_contacts_streaming_response::Response::DeletedContactId(
                                    "second".into(),
                                ),
                            ),
                        }))
                        .await;
                });
                Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
            }
            async fn get_contacts_paginated_streaming(
                &self,
                _: Request<GetContactsStreamingPageRequest>,
            ) -> Result<Response<Self::GetContactsPaginatedStreamingStream>, Status> {
                Ok(Response::new(Box::pin(futures::stream::empty())))
            }
            async fn create_contacts(
                &self,
                _: Request<ContactList>,
            ) -> Result<Response<ContactList>, Status> {
                Ok(Response::new(ContactList::default()))
            }
            async fn update_contacts(
                &self,
                _: Request<ContactList>,
            ) -> Result<Response<()>, Status> {
                Ok(Response::new(()))
            }
            async fn delete_contacts(
                &self,
                _: Request<DeleteContactRequest>,
            ) -> Result<Response<()>, Status> {
                Ok(Response::new(()))
            }
        }

        let router = DedupRouter::new(ContactsRpcServiceServer::new(MockContacts))
            .dedup::<ContactsRpcServiceServer<MockContacts>>(
                "GetContactsStreaming",
                std::time::Duration::from_millis(200),
            )
            .into_axum_router();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve");
        });

        let mut client = ContactsRpcServiceClient::connect(format!("http://{address}"))
            .await
            .expect("connect");

        let stream = client
            .get_contacts_streaming(GetContactsStreamingRequest {
                sync_option: Some(get_contacts_streaming_request::SyncOption::FullSync(true)),
                server_should_decrypt: false,
            })
            .await
            .expect("request")
            .into_inner();

        use futures::StreamExt;
        let mut stream = Box::pin(stream);

        // First message must arrive before the handler task completes
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("first message must not wait for stream end")
            .expect("stream yields first message")
            .expect("message is ok");

        assert!(matches!(
            first.response,
            Some(get_contacts_streaming_response::Response::DeletedContactId(ref id)) if id == "first"
        ));

        let second = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("second message delivered")
            .expect("stream yields second")
            .expect("ok");
        assert!(matches!(
            second.response,
            Some(get_contacts_streaming_response::Response::DeletedContactId(ref id)) if id == "second"
        ));

        server.abort();
        let _ = server.await;
    }
}
