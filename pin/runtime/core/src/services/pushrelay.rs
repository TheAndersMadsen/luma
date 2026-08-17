use std::pin::Pin;

use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};
use tracing::info;

use crate::proto::pushrelay::push_relay_service_server::PushRelayService;
use crate::proto::pushrelay::*;

pub struct PushRelayServiceImpl;

#[tonic::async_trait]
impl PushRelayService for PushRelayServiceImpl {
    type SubscribeStream = Pin<Box<dyn Stream<Item = Result<PushMessageResponse, Status>> + Send>>;

    async fn subscribe(
        &self,
        request: Request<Streaming<PushMessageRequest>>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        info!(">>> PushRelay.Subscribe — connection opened");

        let mut in_stream = request.into_inner();

        // Use a channel: we spawn a task to consume client messages,
        // and the receiver stream stays open (we never send responses).
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<PushMessageResponse, Status>>(1);

        tokio::spawn(async move {
            while let Some(result) = in_stream.next().await {
                match result {
                    Ok(msg) => {
                        let experiences: Vec<_> = msg
                            .subscribed_experiences
                            .iter()
                            .map(|e| e.experience_name.as_str())
                            .collect();
                        info!(
                            acks = ?msg.acks,
                            experiences = ?experiences,
                            conn_type = msg.conn_type,
                            "    PushRelay.Subscribe received"
                        );
                    }
                    Err(e) => {
                        info!(error = %e, "    PushRelay.Subscribe client error");
                        break;
                    }
                }
            }
            info!("<<< PushRelay.Subscribe — connection closed");
            // tx is dropped here, which closes the rx stream
            drop(tx);
        });

        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }

    async fn get_push_tokens(
        &self,
        request: Request<PushTokenRequest>,
    ) -> Result<Response<PushTokenResponse>, Status> {
        let req = request.into_inner();
        info!(app_names = ?req.app_names, ">>> PushRelay.GetPushTokens");
        Ok(Response::new(PushTokenResponse { tokens: vec![] }))
    }
}
