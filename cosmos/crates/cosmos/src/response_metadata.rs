use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

use axum::http::{HeaderValue, Request, Response, header::HeaderName};
use cosmos_core::ServicePath;
use tower::{Layer, Service};

const SERVICE_PATH_HEADER: HeaderName = HeaderName::from_static("x-humane-service-path");

#[derive(Clone)]
pub struct ServicePathLayer {
    value: HeaderValue,
}

impl ServicePathLayer {
    pub fn new(path: &ServicePath) -> Self {
        let value = HeaderValue::from_str(path.as_str())
            .expect("validated service path is always an ASCII header value");
        Self { value }
    }
}

impl<S> Layer<S> for ServicePathLayer {
    type Service = ServicePathService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ServicePathService {
            inner,
            value: self.value.clone(),
        }
    }
}

#[derive(Clone)]
pub struct ServicePathService<S> {
    inner: S,
    value: HeaderValue,
}

impl<S, RequestBody, ResponseBody> Service<Request<RequestBody>> for ServicePathService<S>
where
    S: Service<Request<RequestBody>, Response = Response<ResponseBody>> + Send + 'static,
    S::Future: Send + 'static,
    RequestBody: Send + 'static,
    ResponseBody: Send + 'static,
{
    type Response = Response<ResponseBody>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: Request<RequestBody>) -> Self::Future {
        let future = self.inner.call(request);
        let value = self.value.clone();
        Box::pin(async move {
            let mut response = future.await?;
            response.headers_mut().insert(SERVICE_PATH_HEADER, value);
            Ok(response)
        })
    }
}
