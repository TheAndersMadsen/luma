//! Range-aware media file serving for the memory gallery endpoints.
//!
//! Upstream served whole files; the fork adds bounded HTTP byte-range support
//! (for scrubbing captured video) plus a store-error to HTTP-status mapping.

use std::io::SeekFrom;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::storage::{MediaStoreError, OpenedMediaFile};

pub(super) fn media_open_status(error: MediaStoreError) -> StatusCode {
    match error {
        MediaStoreError::InvalidMemoryId | MediaStoreError::InvalidFilename => {
            StatusCode::BAD_REQUEST
        }
        MediaStoreError::MemoryNotFound | MediaStoreError::UnexpectedFilename => {
            StatusCode::NOT_FOUND
        }
        MediaStoreError::UploadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        MediaStoreError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND
        }
        MediaStoreError::Io(error) => {
            tracing::error!(error = %error, "failed to open media file");
            StatusCode::INTERNAL_SERVER_ERROR
        }
        MediaStoreError::Database => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MediaByteRange {
    pub(super) start: u64,
    pub(super) end: u64,
}

pub(super) fn parse_media_range(
    headers: &HeaderMap,
    total: u64,
) -> Result<Option<MediaByteRange>, StatusCode> {
    let mut range_values = headers.get_all(header::RANGE).iter();
    let Some(raw) = range_values.next() else {
        return Ok(None);
    };
    if range_values.next().is_some() {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    if total == 0 {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let raw = raw
        .to_str()
        .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
    let raw = raw
        .strip_prefix("bytes=")
        .ok_or(StatusCode::RANGE_NOT_SATISFIABLE)?;
    if raw.contains(',') {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let (start, end) = raw
        .split_once('-')
        .ok_or(StatusCode::RANGE_NOT_SATISFIABLE)?;
    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
        if suffix == 0 {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        (total.saturating_sub(suffix.min(total)), total - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
        if start >= total {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        let end = if end.is_empty() {
            total - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?
                .min(total - 1)
        };
        if end < start {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        (start, end)
    };
    Ok(Some(MediaByteRange { start, end }))
}

pub(super) async fn serve_file(
    opened: OpenedMediaFile,
    content_type: &str,
    request_headers: &HeaderMap,
) -> Response {
    let total = opened.len;
    let range = match parse_media_range(request_headers, total) {
        Ok(range) => range,
        Err(_) => return media_range_not_satisfiable(total),
    };
    let (start, end, partial) = match range {
        Some(range) => (range.start, range.end, true),
        None if total > 0 => (0, total - 1, false),
        None => (0, 0, false),
    };
    let content_length = if total == 0 { 0 } else { end - start + 1 };
    let body = if content_length == 0 {
        Body::empty()
    } else {
        let mut file = tokio::fs::File::from_std(opened.file);
        let stream = async_stream::stream! {
            if let Err(error) = file.seek(SeekFrom::Start(start)).await {
                yield Err::<bytes::Bytes, std::io::Error>(error);
                return;
            }
            let mut remaining = content_length;
            let mut buffer = vec![0u8; 64 * 1024];
            while remaining > 0 {
                let wanted = remaining.min(buffer.len() as u64) as usize;
                let count = match file.read(&mut buffer[..wanted]).await {
                    Ok(0) => {
                        yield Err::<bytes::Bytes, std::io::Error>(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "media file ended before its opened length",
                        ));
                        return;
                    }
                    Ok(count) => count,
                    Err(error) => {
                        yield Err::<bytes::Bytes, std::io::Error>(error);
                        return;
                    }
                };
                remaining -= count as u64;
                yield Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::copy_from_slice(&buffer[..count]));
            }
        };
        Body::from_stream(stream)
    };

    let mut response = Response::new(body);
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string()).unwrap(),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    if partial {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")).unwrap(),
        );
    }
    response
}

fn media_range_not_satisfiable(total: u64) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_RANGE,
        HeaderValue::from_str(&format!("bytes */{total}")).unwrap(),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    response
}
