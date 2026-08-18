//! Visual product-catalog adapter.
//!
//! Product search is provider-specific and cannot be reconstructed from image
//! bytes alone. The configured endpoint receives bounded base64 images and must
//! return one real catalog row. Cosmos validates that row before exposing it on
//! the stock `AmazonShoppingService.VisualSearch` shape.

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::{BackendError, http, key};

const ENDPOINT_ENV: &str = "COSMOS_SHOPPING_VISUAL_SEARCH_URL";
const API_KEY_ENV: &str = "COSMOS_SHOPPING_API_KEY";
const ALLOWED_HOSTS_ENV: &str = "COSMOS_SHOPPING_ALLOWED_HOSTS";

#[derive(Serialize)]
struct SearchRequest {
    images_base64: Vec<String>,
}

#[derive(Deserialize)]
pub struct Product {
    pub title: String,
    pub price_usd: f32,
    pub deep_link: String,
    pub star_rating: f32,
}

fn validated_endpoint(endpoint: &str, allowed_hosts: &str) -> Option<reqwest::Url> {
    let endpoint = reqwest::Url::parse(endpoint.trim()).ok()?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return None;
    }
    let host = endpoint.host_str()?.to_ascii_lowercase();
    let allowed = allowed_hosts
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .any(|value| value.eq_ignore_ascii_case(&host));
    allowed.then_some(endpoint)
}

pub async fn visual_search(images: &[Vec<u8>]) -> Result<Product, BackendError> {
    let endpoint = key(ENDPOINT_ENV).ok_or(BackendError::NotConfigured)?;
    let allowed_hosts = key(ALLOWED_HOSTS_ENV).ok_or(BackendError::NotConfigured)?;
    let endpoint =
        validated_endpoint(&endpoint, &allowed_hosts).ok_or(BackendError::NotConfigured)?;
    if images.is_empty() || images.iter().any(Vec::is_empty) {
        return Err(BackendError::NoResult);
    }
    let request = SearchRequest {
        images_base64: images
            .iter()
            .map(|image| base64::engine::general_purpose::STANDARD.encode(image))
            .collect(),
    };
    let mut call = http().post(endpoint).json(&request);
    if let Some(api_key) = key(API_KEY_ENV) {
        call = call.bearer_auth(api_key);
    }
    let product: Product = call
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    let link = reqwest::Url::parse(product.deep_link.trim())
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"));
    if product.title.trim().is_empty()
        || !product.price_usd.is_finite()
        || product.price_usd < 0.0
        || !product.star_rating.is_finite()
        || !(0.0..=5.0).contains(&product.star_rating)
        || link.is_none()
    {
        return Err(BackendError::NoResult);
    }
    Ok(Product {
        title: product.title.trim().to_owned(),
        deep_link: link.unwrap().into(),
        ..product
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_shape_decodes_without_extra_generated_copy() {
        let product: Product = serde_json::from_str(
            r#"{"title":"Travel mug","price_usd":24.5,"deep_link":"https://shop.example/mug","star_rating":4.7}"#,
        )
        .unwrap();
        assert_eq!(product.title, "Travel mug");
        assert_eq!(product.price_usd, 24.5);
    }

    #[test]
    fn endpoint_requires_an_explicit_matching_host() {
        assert!(
            validated_endpoint(
                "https://catalog.example/v1/visual-search",
                "catalog.example, backup.example"
            )
            .is_some()
        );
        for (endpoint, hosts) in [
            ("https://catalog.example/v1/search", "other.example"),
            (
                "https://user:pass@catalog.example/search",
                "catalog.example",
            ),
            ("file:///tmp/catalog", "catalog.example"),
            (
                "https://catalog.example/search?token=secret",
                "catalog.example",
            ),
        ] {
            assert!(validated_endpoint(endpoint, hosts).is_none(), "{endpoint}");
        }
    }
}
