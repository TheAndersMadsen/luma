//! Synthetic local HTTP proof of the stock AnalyzeImage -> GenericImageResponse
//! boundary. No owner configuration, recorded responses, or physical Pin.
use super::*;
use axum::{Json, Router, routing::post};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn jpeg_with_gps() -> Vec<u8> {
    let image = image::RgbImage::from_pixel(8, 8, image::Rgb([80, 120, 160]));
    let mut plain = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut plain, image::ImageFormat::Jpeg)
        .unwrap();
    let plain = plain.into_inner();
    let xmp = b"http://ns.adobe.com/xap/1.0/\0<exif:GPSLatitude>55,40N</exif:GPSLatitude>";
    let mut bytes = plain[..2].to_vec();
    bytes.extend_from_slice(&[0xff, 0xe1]);
    bytes.extend_from_slice(&((xmp.len() + 2) as u16).to_be_bytes());
    bytes.extend_from_slice(xmp);
    bytes.extend_from_slice(&plain[2..]);
    bytes
}

async fn through_http(
    request: pb::AnalyzeImageRequest,
    provider_text: &str,
) -> (Result<pb::AnalyzeImageResponse, Status>, Vec<Value>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let capture = seen.clone();
    let text = provider_text.to_owned();
    let app = Router::new().route(
        "/chat/completions",
        post(move |Json(body): Json<Value>| {
            let capture = capture.clone();
            let text = text.clone();
            async move {
                capture.lock().unwrap().push(body);
                Json(json!({"choices": [{"message": {"content": text}}]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let answer = AiBusMain::analyze_image_with_provider(request, |images, prompt| async move {
        crate::assistant::vision::openai_complete(
            &reqwest::Client::new(),
            &base,
            "synthetic-test-key",
            "synthetic-vision",
            &prompt,
            &images,
        )
        .await
        .map_err(|error| match error {
            crate::assistant::vision::VisionError::InvalidImage => {
                Status::invalid_argument("synthetic invalid image")
            }
            _ => Status::unavailable("synthetic provider failed"),
        })
    })
    .await;
    server.abort();
    let captured = seen.lock().unwrap().clone();
    (answer, captured)
}

#[tokio::test]
async fn analyze_image_http_projects_only_exact_wearer_rules_as_untrusted_data() {
    let request = pb::AnalyzeImageRequest {
        request: "What is here?".to_owned(),
        image_data: jpeg_with_gps(),
        if_then: std::collections::HashMap::from([
            ("a red cup".to_owned(), "say hello".to_owned()),
            ("a blue book".to_owned(), "send a message".to_owned()),
        ]),
        ..Default::default()
    };
    // Stable lexical IDs: blue book = 0, red cup = 1. The model sees
    // conditions, never executable 'then' text or confirmation authority.
    let text =
        json!({"description":"A red cup is on a table.", "matched_condition_ids":[1]}).to_string();
    let (result, seen) = through_http(request.clone(), &text).await;
    let response = result.unwrap();
    let observation: Value = serde_json::from_str(&response.observation).unwrap();
    assert_eq!(observation["description"], "A red cup is on a table.");
    assert_eq!(
        observation["untrusted_matched_rules"],
        json!([{"condition":"a red cup", "then":"say hello"}])
    );
    assert_eq!(observation["source"], "vision_observation");
    assert_eq!(
        response
            .nested_analyze_image_response
            .unwrap()
            .responseoneof,
        Some(
            pb::nested_analyze_image_response::Responseoneof::GenericImageResponse(
                pb::GenericImageResponse {
                    observation: response.observation
                }
            )
        )
    );
    assert_eq!(seen.len(), 1, "one bounded existing provider request");
    let prompt = seen[0]["messages"][1]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert!(prompt.contains("a red cup"));
    assert!(!prompt.contains("say hello"));
    assert!(!prompt.contains("send a message"));
    for invalid in [
        json!({"description":"cup", "matched_condition_ids":[99]}),
        json!({"description":"cup", "matched_condition_ids":[1,1]}),
        json!({"description":"cup", "matched_condition_ids":[1], "action":"FactoryReset"}),
        json!({"description":"cup", "matched_condition_ids":["1"]}),
    ] {
        let (result, _) = through_http(request.clone(), &invalid.to_string()).await;
        assert_eq!(
            result.unwrap().observation,
            VISION_UNAVAILABLE,
            "invalid matches cannot forward a rule"
        );
    }
    let mut oversized = request;
    oversized
        .if_then
        .insert("x".repeat(513), "say hello".to_owned());
    let (result, seen) = through_http(oversized, &text).await;
    assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
    assert!(
        seen.is_empty(),
        "rule bounds checked before provider egress"
    );
}

#[tokio::test]
async fn analyze_image_http_strips_gps_in_every_stock_image_form_without_changing_pixels() {
    let jpeg = jpeg_with_gps();
    let expected = crate::services::capture::strip_jpeg_metadata(&jpeg).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    for request in [
        pb::AnalyzeImageRequest {
            image_data: jpeg.clone(),
            ..Default::default()
        },
        pb::AnalyzeImageRequest {
            base_64_encoded_image: encoded.clone(),
            ..Default::default()
        },
        pb::AnalyzeImageRequest {
            base_64_encoded_image: format!("data:image/jpeg;base64,{encoded}"),
            ..Default::default()
        },
    ] {
        let (result, seen) = through_http(request, "An object is visible.").await;
        assert_eq!(result.unwrap().observation, "An object is visible.");
        assert_eq!(seen.len(), 1);
        let url = seen[0]["messages"][1]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(
            bytes, expected,
            "compressed JPEG pixels preserved, GPS removed"
        );
    }
    for invalid in [
        "data:image/jpeg;base64,@@@",
        "data:image/jpeg;base64,/9j/",
        "data:image/gif;base64,R0lGODlh",
    ] {
        let (result, seen) = through_http(
            pb::AnalyzeImageRequest {
                base_64_encoded_image: invalid.to_owned(),
                ..Default::default()
            },
            "ignored",
        )
        .await;
        assert!(result.is_err(), "malformed/unsupported input is refused");
        assert!(seen.is_empty(), "no malformed image provider call");
    }
}

#[tokio::test]
async fn analyze_image_http_sanitizes_static_png_webp_and_rejects_bounded_unsupported_input() {
    for format in [image::ImageFormat::Png, image::ImageFormat::WebP] {
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            8,
            8,
            image::Rgba([40, 80, 120, 160]),
        ));
        let mut output = std::io::Cursor::new(Vec::new());
        image.write_to(&mut output, format).unwrap();
        let bytes = output.into_inner();
        let (result, seen) = through_http(
            pb::AnalyzeImageRequest {
                image_data: bytes,
                ..Default::default()
            },
            "An object.",
        )
        .await;
        assert_eq!(result.unwrap().observation, "An object.");
        let url = seen[0]["messages"][1]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        assert!(
            url.starts_with("data:image/png;base64,"),
            "static images use lossless metadata-free output"
        );
        let sanitized = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').unwrap().1)
            .unwrap();
        assert_eq!(
            image::load_from_memory(&sanitized).unwrap().to_rgba8(),
            image.to_rgba8()
        );
    }
    let (result, seen) = through_http(
        pb::AnalyzeImageRequest {
            image_data: vec![0u8; 8 * 1024 * 1024 + 1],
            ..Default::default()
        },
        "ignored",
    )
    .await;
    assert!(result.is_err());
    assert!(seen.is_empty());
}
