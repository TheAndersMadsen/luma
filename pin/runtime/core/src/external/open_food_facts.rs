//! Bounded, read-only Open Food Facts adapter for barcode and explicit name lookups.
//!
//! Open Food Facts database data is offered under ODbL 1.0 and individual
//! contents under the Database Contents License. Consumers must provide the
//! required attribution and comply with share-alike requirements when they
//! publish a derivative database. This adapter requests no product images and
//! never uploads user images; image reuse has separate CC BY-SA obligations.
//!
//! Open Food Facts' current v3 API supports product-by-barcode reads, but not
//! full-text search. The isolated name-search path therefore uses the documented
//! documented `/cgi/search.pl` endpoint. Official references:
//! - <https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/>
//! - <https://openfoodfacts.github.io/openfoodfacts-server/api/ref-cheatsheet/>

use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use reqwest::header::{HeaderValue, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::{Map, Value};

const PRODUCT_ENDPOINT: &str = "https://world.openfoodfacts.org/api/v3/product/";
const NAME_SEARCH_ENDPOINT: &str = "https://world.openfoodfacts.org/cgi/search.pl";
const PRODUCT_FIELDS: &str = "code,product_name,brands,serving_size,nutriments";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_BARCODE_INPUT_BYTES: usize = 64;
const MAX_NAME_QUERY_BYTES: usize = 96;
const MAX_NAME_QUERY_TOKENS: usize = 12;
const MAX_NAME_QUERY_PUNCTUATION: usize = 12;
const MAX_SEARCH_RESULTS: usize = 5;
const SEARCH_REQUESTS_PER_WINDOW: usize = 10;
const SEARCH_RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_ITEM_NAME_BYTES: usize = 256;
const MAX_BRAND_BYTES: usize = 128;
const MAX_SERVING_SIZE_BYTES: usize = 64;
const MAX_NUTRIENT_VALUE: f64 = 10_000_000.0;

pub const OPEN_FOOD_FACTS_ATTRIBUTION: &str =
    "Product data © Open Food Facts contributors, licensed under ODbL 1.0";
pub const OPEN_FOOD_FACTS_LICENSE_URL: &str = "https://opendatacommons.org/licenses/odbl/1-0/";
pub const DEFAULT_OPEN_FOOD_FACTS_USER_AGENT: &str = concat!(
    "humane-system-hook/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/PenumbraOS/humane-system-hook)"
);

/// Explicit Open Food Facts options. Network access is disabled by default.
#[derive(Clone)]
pub struct OpenFoodFactsOptions {
    enabled: bool,
    attribution_acknowledged: bool,
    user_agent: String,
    timeout: Duration,
}

impl Default for OpenFoodFactsOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            attribution_acknowledged: false,
            user_agent: DEFAULT_OPEN_FOOD_FACTS_USER_AGENT.to_string(),
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

impl fmt::Debug for OpenFoodFactsOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenFoodFactsOptions")
            .field("enabled", &self.enabled)
            .field("attribution_acknowledged", &self.attribution_acknowledged)
            .field("user_agent_configured", &!self.user_agent.is_empty())
            .finish()
    }
}

impl OpenFoodFactsOptions {
    #[cfg(test)]
    pub fn new(user_agent: impl Into<String>) -> Self {
        Self {
            user_agent: user_agent.into(),
            ..Self::default()
        }
    }

    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Acknowledge that the caller has implemented the applicable Open Food
    /// Facts attribution and ODbL/DbCL share-alike requirements. This is
    /// deliberately independent from provider enablement.
    pub fn with_attribution_acknowledged(mut self, acknowledged: bool) -> Self {
        self.attribution_acknowledged = acknowledged;
        self
    }

    #[cfg(test)]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        if !timeout.is_zero() {
            self.timeout = timeout;
        }
        self
    }

    #[cfg(test)]
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    #[cfg(test)]
    pub fn attribution_acknowledged(&self) -> bool {
        self.attribution_acknowledged
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoodNutrientKind {
    Calcium,
    Calories,
    Cholesterol,
    DietaryFiber,
    Iron,
    MonounsaturatedFat,
    PolyunsaturatedFat,
    Potassium,
    Protein,
    SaturatedFat,
    Sodium,
    Sugars,
    TotalCarbs,
    TotalFat,
    TransFat,
    VitaminA,
    VitaminC,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FoodNutrient {
    pub kind: FoodNutrientKind,
    pub value: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FoodProduct {
    pub item_name: String,
    pub typical_serving_size: String,
    pub brand: String,
    pub nutrients: Vec<FoodNutrient>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFoodFactsError {
    Disabled,
    AttributionAcknowledgementRequired,
    InvalidConfiguration,
    InvalidBarcode,
    InvalidQuery,
    NotFound,
    RateLimited,
    ProviderUnavailable,
    Transport,
    InvalidResponse,
    ResponseTooLarge,
}

impl OpenFoodFactsError {
    pub fn kind(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::AttributionAcknowledgementRequired => "attribution_acknowledgement_required",
            Self::InvalidConfiguration => "invalid_configuration",
            Self::InvalidBarcode => "invalid_barcode",
            Self::InvalidQuery => "invalid_query",
            Self::NotFound => "not_found",
            Self::RateLimited => "rate_limited",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::Transport => "transport",
            Self::InvalidResponse => "invalid_response",
            Self::ResponseTooLarge => "response_too_large",
        }
    }
}

impl fmt::Display for OpenFoodFactsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.kind())
    }
}

impl std::error::Error for OpenFoodFactsError {}

#[derive(Debug, Default)]
struct SearchRateLimiter {
    requests: VecDeque<Instant>,
}

impl SearchRateLimiter {
    fn try_acquire(&mut self, now: Instant) -> bool {
        while self.requests.front().is_some_and(|oldest| {
            now.checked_duration_since(*oldest)
                .is_some_and(|elapsed| elapsed >= SEARCH_RATE_WINDOW)
        }) {
            self.requests.pop_front();
        }
        if self.requests.len() >= SEARCH_REQUESTS_PER_WINDOW {
            return false;
        }
        self.requests.push_back(now);
        true
    }
}

/// Cloneable Open Food Facts client. Clones share the search rate budget.
#[derive(Clone)]
pub struct OpenFoodFactsClient {
    http: Client,
    options: OpenFoodFactsOptions,
    user_agent: HeaderValue,
    product_endpoint: Url,
    name_search_endpoint: Url,
    search_rate_limiter: Arc<tokio::sync::Mutex<SearchRateLimiter>>,
}

impl fmt::Debug for OpenFoodFactsClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenFoodFactsClient")
            .field("options", &self.options)
            .field("provider", &"open_food_facts")
            .finish_non_exhaustive()
    }
}

impl OpenFoodFactsClient {
    /// Production constructor with redirects disabled so a product request is
    /// never replayed to another origin.
    pub fn from_options(options: OpenFoodFactsOptions) -> Result<Self, OpenFoodFactsError> {
        let http = Client::builder()
            .redirect(Policy::none())
            .build()
            .map_err(|_| OpenFoodFactsError::InvalidConfiguration)?;
        Self::new(http, options)
    }

    /// Internal constructor. Enabled production clients are only exposed via
    /// `from_options`, which always applies the no-redirect policy.
    fn new(http: Client, options: OpenFoodFactsOptions) -> Result<Self, OpenFoodFactsError> {
        let user_agent = HeaderValue::from_str(options.user_agent.trim())
            .map_err(|_| OpenFoodFactsError::InvalidConfiguration)?;
        if user_agent.is_empty() || user_agent.as_bytes().len() > 256 {
            return Err(OpenFoodFactsError::InvalidConfiguration);
        }
        let product_endpoint =
            Url::parse(PRODUCT_ENDPOINT).map_err(|_| OpenFoodFactsError::InvalidConfiguration)?;
        let name_search_endpoint = Url::parse(NAME_SEARCH_ENDPOINT)
            .map_err(|_| OpenFoodFactsError::InvalidConfiguration)?;
        Ok(Self {
            http,
            options,
            user_agent,
            product_endpoint,
            name_search_endpoint,
            search_rate_limiter: Arc::new(tokio::sync::Mutex::new(SearchRateLimiter::default())),
        })
    }

    pub fn disabled(http: Client) -> Self {
        Self::new(http, OpenFoodFactsOptions::default())
            .expect("the built-in Open Food Facts configuration is valid")
    }

    #[cfg(test)]
    pub fn options(&self) -> &OpenFoodFactsOptions {
        &self.options
    }

    #[cfg(test)]
    pub(crate) fn with_test_product_endpoint(mut self, endpoint: &str) -> Self {
        self.product_endpoint = Url::parse(endpoint).expect("valid test product endpoint");
        self
    }

    #[cfg(test)]
    pub(crate) fn with_test_search_endpoint(mut self, endpoint: &str) -> Self {
        self.name_search_endpoint = Url::parse(endpoint).expect("valid test search endpoint");
        self
    }

    /// Resolve either a valid GTIN or a committed, bounded food-name query.
    /// Numeric input is never allowed to fall through from failed GTIN
    /// validation into full-text search.
    pub async fn lookup(&self, input: &str) -> Result<Vec<FoodProduct>, OpenFoodFactsError> {
        let trimmed = input.trim();
        if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
            return self
                .lookup_barcode(trimmed)
                .await
                .map(|product| vec![product]);
        }
        self.lookup_name(trimmed).await
    }

    pub async fn lookup_barcode(&self, input: &str) -> Result<FoodProduct, OpenFoodFactsError> {
        let barcode = validate_barcode(input)?;
        self.ensure_network_allowed()?;

        let mut url = self
            .product_endpoint
            .join(barcode)
            .map_err(|_| OpenFoodFactsError::InvalidConfiguration)?;
        url.query_pairs_mut().append_pair("fields", PRODUCT_FIELDS);
        if !same_origin(&url, &self.product_endpoint) {
            return Err(OpenFoodFactsError::InvalidConfiguration);
        }

        let response = self
            .http
            .get(url)
            .header(USER_AGENT, self.user_agent.clone())
            .timeout(self.options.timeout)
            .send()
            .await
            .map_err(|_| OpenFoodFactsError::Transport)?;
        if !same_origin(response.url(), &self.product_endpoint) {
            return Err(OpenFoodFactsError::ProviderUnavailable);
        }

        match response.status() {
            StatusCode::NOT_FOUND => return Err(OpenFoodFactsError::NotFound),
            StatusCode::TOO_MANY_REQUESTS => return Err(OpenFoodFactsError::RateLimited),
            status if !status.is_success() => return Err(OpenFoodFactsError::ProviderUnavailable),
            _ => {}
        }

        let response: ProductResponse = decode_limited_json(response).await?;
        let product = response.product.ok_or(OpenFoodFactsError::NotFound)?;
        product_from_response(product).ok_or(OpenFoodFactsError::NotFound)
    }

    /// Full-text product-name search is intentionally isolated here because
    /// Open Food Facts documents it as a documented-only capability. Callers invoke
    /// this once for a completed voice request, never for search-as-you-type.
    pub async fn lookup_name(&self, input: &str) -> Result<Vec<FoodProduct>, OpenFoodFactsError> {
        let query = validate_name_query(input)?;
        self.ensure_network_allowed()?;

        // OFF publishes a 10 requests/minute/IP search limit and explicitly
        // warns against search-as-you-type. Enforce the same rolling limit
        // locally across all clones rather than relying on provider throttling.
        if !self
            .search_rate_limiter
            .lock()
            .await
            .try_acquire(Instant::now())
        {
            return Err(OpenFoodFactsError::RateLimited);
        }

        let mut url = self.name_search_endpoint.clone();
        if url.cannot_be_a_base() || url.fragment().is_some() || url.query().is_some() {
            return Err(OpenFoodFactsError::InvalidConfiguration);
        }
        url.query_pairs_mut()
            .append_pair("search_terms", &query)
            .append_pair("search_simple", "1")
            .append_pair("action", "process")
            .append_pair("json", "1")
            .append_pair("page", "1")
            .append_pair("page_size", &MAX_SEARCH_RESULTS.to_string())
            .append_pair("fields", PRODUCT_FIELDS);
        if !same_origin(&url, &self.name_search_endpoint) {
            return Err(OpenFoodFactsError::InvalidConfiguration);
        }

        let response = self
            .http
            .get(url)
            .header(USER_AGENT, self.user_agent.clone())
            .timeout(self.options.timeout)
            .send()
            .await
            .map_err(|_| OpenFoodFactsError::Transport)?;
        // Production construction disables redirects. Keep this check as a
        // second boundary for tests or callers that inject their own client.
        if !same_origin(response.url(), &self.name_search_endpoint) {
            return Err(OpenFoodFactsError::ProviderUnavailable);
        }

        match response.status() {
            StatusCode::NOT_FOUND => return Err(OpenFoodFactsError::NotFound),
            StatusCode::TOO_MANY_REQUESTS => return Err(OpenFoodFactsError::RateLimited),
            status if !status.is_success() => return Err(OpenFoodFactsError::ProviderUnavailable),
            _ => {}
        }

        let response: SearchResponse = decode_limited_json(response).await?;
        let products = response
            .products
            .into_iter()
            .take(MAX_SEARCH_RESULTS)
            .filter_map(product_from_response)
            .collect::<Vec<_>>();
        if products.is_empty() {
            Err(OpenFoodFactsError::NotFound)
        } else {
            Ok(products)
        }
    }

    fn ensure_network_allowed(&self) -> Result<(), OpenFoodFactsError> {
        if !self.options.enabled {
            return Err(OpenFoodFactsError::Disabled);
        }
        if !self.options.attribution_acknowledged {
            return Err(OpenFoodFactsError::AttributionAcknowledgementRequired);
        }
        Ok(())
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn validate_barcode(input: &str) -> Result<&str, OpenFoodFactsError> {
    if input.len() > MAX_BARCODE_INPUT_BYTES {
        return Err(OpenFoodFactsError::InvalidBarcode);
    }
    let barcode = input.trim();
    if !matches!(barcode.len(), 8 | 12 | 13 | 14)
        || !barcode.bytes().all(|byte| byte.is_ascii_digit())
        || !has_valid_gtin_check_digit(barcode)
    {
        return Err(OpenFoodFactsError::InvalidBarcode);
    }
    Ok(barcode)
}

fn validate_name_query(input: &str) -> Result<String, OpenFoodFactsError> {
    if input.len() > MAX_NAME_QUERY_BYTES || input.chars().any(char::is_control) {
        return Err(OpenFoodFactsError::InvalidQuery);
    }
    let query = input.split_whitespace().collect::<Vec<_>>();
    if query.is_empty() || query.len() > MAX_NAME_QUERY_TOKENS {
        return Err(OpenFoodFactsError::InvalidQuery);
    }
    let query = query.join(" ");
    if query.len() < 3 || query.len() > MAX_NAME_QUERY_BYTES {
        return Err(OpenFoodFactsError::InvalidQuery);
    }

    let mut letters = 0;
    let mut punctuation = 0;
    for character in query.chars() {
        if character.is_alphabetic() {
            letters += 1;
        } else if character.is_alphanumeric() || character == ' ' {
            // accepted
        } else if matches!(
            character,
            '\'' | '’' | '-' | '&' | '+' | '.' | ',' | '(' | ')'
        ) {
            punctuation += 1;
        } else {
            return Err(OpenFoodFactsError::InvalidQuery);
        }
    }
    if letters < 2 || punctuation > MAX_NAME_QUERY_PUNCTUATION {
        return Err(OpenFoodFactsError::InvalidQuery);
    }
    Ok(query)
}

fn has_valid_gtin_check_digit(barcode: &str) -> bool {
    let digits = barcode
        .bytes()
        .map(|byte| u32::from(byte - b'0'))
        .collect::<Vec<_>>();
    let Some((&check_digit, body)) = digits.split_last() else {
        return false;
    };
    let sum = body
        .iter()
        .rev()
        .enumerate()
        .map(|(index, digit)| digit * if index % 2 == 0 { 3 } else { 1 })
        .sum::<u32>();
    (10 - (sum % 10)) % 10 == check_digit
}

async fn decode_limited_json<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, OpenFoodFactsError> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| OpenFoodFactsError::Transport)?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(OpenFoodFactsError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| OpenFoodFactsError::InvalidResponse)
}

#[derive(Deserialize)]
struct ProductResponse {
    product: Option<ProductData>,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    products: Vec<ProductData>,
}

#[derive(Deserialize)]
struct ProductData {
    product_name: Option<String>,
    brands: Option<String>,
    serving_size: Option<String>,
    #[serde(default)]
    nutriments: Map<String, Value>,
}

fn product_from_response(product: ProductData) -> Option<FoodProduct> {
    let item_name = bounded_text(product.product_name?, MAX_ITEM_NAME_BYTES)?;
    let brand = product
        .brands
        .and_then(|value| bounded_text(value, MAX_BRAND_BYTES))
        .unwrap_or_default();
    let declared_serving = product
        .serving_size
        .and_then(|value| bounded_text(value, MAX_SERVING_SIZE_BYTES));
    let use_serving_values = declared_serving.is_some()
        && NUTRIENT_MAPPINGS.iter().any(|mapping| {
            numeric_value(
                product
                    .nutriments
                    .get(&format!("{}_serving", mapping.source_key)),
            )
            .is_some()
        });
    let suffix = if use_serving_values {
        "serving"
    } else {
        "100g"
    };
    let nutrients = NUTRIENT_MAPPINGS
        .iter()
        .filter_map(|mapping| mapped_nutrient(&product.nutriments, mapping, suffix))
        .collect::<Vec<_>>();
    let typical_serving_size = if use_serving_values || nutrients.is_empty() {
        declared_serving.unwrap_or_default()
    } else {
        "100 g".to_string()
    };

    Some(FoodProduct {
        item_name,
        typical_serving_size,
        brand,
        nutrients,
    })
}

fn bounded_text(value: String, maximum_bytes: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control))
        .then(|| value.to_string())
}

#[derive(Clone, Copy)]
enum NutrientUnit {
    Kilocalories,
    Grams,
    Milligrams,
    Micrograms,
}

struct NutrientMapping {
    source_key: &'static str,
    kind: FoodNutrientKind,
    target_unit: NutrientUnit,
    default_source_unit: Option<NutrientUnit>,
}

const NUTRIENT_MAPPINGS: &[NutrientMapping] = &[
    nutrient(
        "calcium",
        FoodNutrientKind::Calcium,
        NutrientUnit::Milligrams,
        None,
    ),
    nutrient(
        "energy-kcal",
        FoodNutrientKind::Calories,
        NutrientUnit::Kilocalories,
        Some(NutrientUnit::Kilocalories),
    ),
    nutrient(
        "cholesterol",
        FoodNutrientKind::Cholesterol,
        NutrientUnit::Milligrams,
        None,
    ),
    nutrient(
        "fiber",
        FoodNutrientKind::DietaryFiber,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "iron",
        FoodNutrientKind::Iron,
        NutrientUnit::Milligrams,
        None,
    ),
    nutrient(
        "monounsaturated-fat",
        FoodNutrientKind::MonounsaturatedFat,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "polyunsaturated-fat",
        FoodNutrientKind::PolyunsaturatedFat,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "potassium",
        FoodNutrientKind::Potassium,
        NutrientUnit::Milligrams,
        None,
    ),
    nutrient(
        "proteins",
        FoodNutrientKind::Protein,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "saturated-fat",
        FoodNutrientKind::SaturatedFat,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "sodium",
        FoodNutrientKind::Sodium,
        NutrientUnit::Milligrams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "sugars",
        FoodNutrientKind::Sugars,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "carbohydrates",
        FoodNutrientKind::TotalCarbs,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "fat",
        FoodNutrientKind::TotalFat,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "trans-fat",
        FoodNutrientKind::TransFat,
        NutrientUnit::Grams,
        Some(NutrientUnit::Grams),
    ),
    nutrient(
        "vitamin-a",
        FoodNutrientKind::VitaminA,
        NutrientUnit::Micrograms,
        None,
    ),
    nutrient(
        "vitamin-c",
        FoodNutrientKind::VitaminC,
        NutrientUnit::Milligrams,
        None,
    ),
];

const fn nutrient(
    source_key: &'static str,
    kind: FoodNutrientKind,
    target_unit: NutrientUnit,
    default_source_unit: Option<NutrientUnit>,
) -> NutrientMapping {
    NutrientMapping {
        source_key,
        kind,
        target_unit,
        default_source_unit,
    }
}

fn mapped_nutrient(
    nutriments: &Map<String, Value>,
    mapping: &NutrientMapping,
    suffix: &str,
) -> Option<FoodNutrient> {
    let value_key = format!("{}_{}", mapping.source_key, suffix);
    let value = numeric_value(nutriments.get(&value_key))?;
    let unit_key = format!("{}_unit", mapping.source_key);
    let source_unit = match nutriments.get(&unit_key).and_then(Value::as_str) {
        Some(unit) => parse_unit(unit)?,
        None => mapping.default_source_unit?,
    };
    let value = convert_unit(value, source_unit, mapping.target_unit)?;
    if !value.is_finite() || value <= 0.0 || value > MAX_NUTRIENT_VALUE {
        return None;
    }
    let value = value as f32;
    value.is_finite().then_some(FoodNutrient {
        kind: mapping.kind,
        value,
    })
}

fn numeric_value(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn parse_unit(unit: &str) -> Option<NutrientUnit> {
    match unit.trim().to_ascii_lowercase().as_str() {
        "kcal" | "kilocalorie" | "kilocalories" => Some(NutrientUnit::Kilocalories),
        "g" | "gram" | "grams" => Some(NutrientUnit::Grams),
        "mg" | "milligram" | "milligrams" => Some(NutrientUnit::Milligrams),
        "µg" | "μg" | "ug" | "mcg" | "microgram" | "micrograms" => Some(NutrientUnit::Micrograms),
        _ => None,
    }
}

fn convert_unit(value: f64, source: NutrientUnit, target: NutrientUnit) -> Option<f64> {
    match (source, target) {
        (NutrientUnit::Kilocalories, NutrientUnit::Kilocalories)
        | (NutrientUnit::Grams, NutrientUnit::Grams)
        | (NutrientUnit::Milligrams, NutrientUnit::Milligrams)
        | (NutrientUnit::Micrograms, NutrientUnit::Micrograms) => Some(value),
        (NutrientUnit::Grams, NutrientUnit::Milligrams) => Some(value * 1_000.0),
        (NutrientUnit::Grams, NutrientUnit::Micrograms) => Some(value * 1_000_000.0),
        (NutrientUnit::Milligrams, NutrientUnit::Grams) => Some(value / 1_000.0),
        (NutrientUnit::Milligrams, NutrientUnit::Micrograms) => Some(value * 1_000.0),
        (NutrientUnit::Micrograms, NutrientUnit::Grams) => Some(value / 1_000_000.0),
        (NutrientUnit::Micrograms, NutrientUnit::Milligrams) => Some(value / 1_000.0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::body::{to_bytes, Body};
    use axum::extract::{Request, State};
    use axum::http::{HeaderMap, Method, StatusCode, Uri};
    use axum::response::IntoResponse;
    use axum::routing::{any, get};
    use axum::Router;

    use super::*;

    #[derive(Clone)]
    struct MockReply {
        status: StatusCode,
        body: String,
        delay: Duration,
    }

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Vec<u8>,
    }

    #[derive(Clone)]
    struct MockState {
        reply: MockReply,
        requests: Arc<Mutex<Vec<CapturedRequest>>>,
    }

    async fn mock_product(
        State(state): State<MockState>,
        request: Request<Body>,
    ) -> impl IntoResponse {
        let (parts, body) = request.into_parts();
        let body = to_bytes(body, MAX_RESPONSE_BYTES + 1).await.unwrap();
        state.requests.lock().unwrap().push(CapturedRequest {
            method: parts.method,
            uri: parts.uri,
            headers: parts.headers,
            body: body.to_vec(),
        });
        if !state.reply.delay.is_zero() {
            tokio::time::sleep(state.reply.delay).await;
        }
        (
            state.reply.status,
            [("content-type", "application/json")],
            state.reply.body,
        )
    }

    async fn mock_server(reply: MockReply) -> (String, Arc<Mutex<Vec<CapturedRequest>>>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/api/v3/product/{barcode}", any(mock_product))
            .with_state(MockState {
                reply,
                requests: Arc::clone(&requests),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/api/v3/product/"), requests)
    }

    async fn mock_search_server(reply: MockReply) -> (String, Arc<Mutex<Vec<CapturedRequest>>>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/cgi/search.pl", any(mock_product))
            .with_state(MockState {
                reply,
                requests: Arc::clone(&requests),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/cgi/search.pl"), requests)
    }

    fn enabled_client(endpoint: &str) -> OpenFoodFactsClient {
        OpenFoodFactsClient::from_options(
            OpenFoodFactsOptions::new("humane-food-tests/1.0 (food@example.invalid)")
                .with_enabled(true)
                .with_attribution_acknowledged(true),
        )
        .unwrap()
        .with_test_product_endpoint(endpoint)
    }

    fn enabled_search_client(endpoint: &str) -> OpenFoodFactsClient {
        OpenFoodFactsClient::from_options(
            OpenFoodFactsOptions::new("humane-food-tests/1.0 (food@example.invalid)")
                .with_enabled(true)
                .with_attribution_acknowledged(true),
        )
        .unwrap()
        .with_test_search_endpoint(endpoint)
    }

    fn reply(status: StatusCode, body: impl Into<String>) -> MockReply {
        MockReply {
            status,
            body: body.into(),
            delay: Duration::ZERO,
        }
    }

    #[test]
    fn barcode_validation_accepts_gtins_and_rejects_text_or_bad_checksums() {
        for valid in [
            "96385074",
            "012345678905",
            "3017620422003",
            "00012345600012",
        ] {
            assert_eq!(validate_barcode(valid), Ok(valid));
        }
        for invalid in [
            "apple",
            "3017620422004",
            "3017 6204 22003",
            "3017620422003?fields=all",
            "",
        ] {
            assert_eq!(
                validate_barcode(invalid),
                Err(OpenFoodFactsError::InvalidBarcode)
            );
        }
    }

    #[tokio::test]
    async fn network_is_disabled_by_default() {
        let (endpoint, requests) = mock_server(reply(StatusCode::OK, "{}")).await;
        let client = OpenFoodFactsClient::disabled(reqwest::Client::new())
            .with_test_product_endpoint(&endpoint);
        assert_eq!(
            client.lookup_barcode("3017620422003").await,
            Err(OpenFoodFactsError::Disabled)
        );
        assert!(requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn enablement_does_not_bypass_the_attribution_acknowledgement() {
        let (endpoint, requests) = mock_server(reply(StatusCode::OK, "{}")).await;
        let options = OpenFoodFactsOptions::new("humane-food-tests/1.0 (food@example.invalid)")
            .with_enabled(true);
        assert!(options.enabled());
        assert!(!options.attribution_acknowledged());
        let client = OpenFoodFactsClient::from_options(options)
            .unwrap()
            .with_test_product_endpoint(&endpoint);
        assert_eq!(
            client.lookup_barcode("3017620422003").await,
            Err(OpenFoodFactsError::AttributionAcknowledgementRequired)
        );
        assert!(requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn arbitrary_text_is_rejected_before_network_access() {
        let (endpoint, requests) = mock_server(reply(StatusCode::OK, "{}")).await;
        let client = enabled_client(&endpoint);
        assert_eq!(
            client.lookup_barcode("hazelnut spread").await,
            Err(OpenFoodFactsError::InvalidBarcode)
        );
        assert!(requests.lock().unwrap().is_empty());
    }

    #[test]
    fn name_queries_are_normalized_and_strictly_bounded() {
        assert_eq!(
            validate_name_query("  Ben & Jerry's   chocolate fudge  "),
            Ok("Ben & Jerry's chocolate fudge".into())
        );
        assert_eq!(validate_name_query("7-Up"), Ok("7-Up".into()));
        for invalid in [
            "",
            "a",
            "123456789",
            "https://private.invalid/food",
            "apple?fields=all",
            "apple\nprivate",
        ] {
            assert_eq!(
                validate_name_query(invalid),
                Err(OpenFoodFactsError::InvalidQuery),
                "accepted {invalid:?}"
            );
        }
        assert_eq!(
            validate_name_query(&"a".repeat(MAX_NAME_QUERY_BYTES + 1)),
            Err(OpenFoodFactsError::InvalidQuery)
        );
        assert_eq!(
            validate_name_query(&vec!["food"; MAX_NAME_QUERY_TOKENS + 1].join(" ")),
            Err(OpenFoodFactsError::InvalidQuery)
        );
    }

    #[tokio::test]
    async fn name_search_requires_enablement_and_license_acknowledgement() {
        let body = serde_json::json!({"products":[{"product_name":"Apple"}]}).to_string();
        let (endpoint, requests) = mock_search_server(reply(StatusCode::OK, body.clone())).await;
        let disabled = OpenFoodFactsClient::disabled(reqwest::Client::new())
            .with_test_search_endpoint(&endpoint);
        assert_eq!(
            disabled.lookup_name("apple").await,
            Err(OpenFoodFactsError::Disabled)
        );
        assert!(requests.lock().unwrap().is_empty());

        let enabled_without_ack = OpenFoodFactsClient::from_options(
            OpenFoodFactsOptions::new("humane-food-tests/1.0 (food@example.invalid)")
                .with_enabled(true),
        )
        .unwrap()
        .with_test_search_endpoint(&endpoint);
        assert_eq!(
            enabled_without_ack.lookup_name("apple").await,
            Err(OpenFoodFactsError::AttributionAcknowledgementRequired)
        );
        assert!(requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn explicit_name_lookup_is_a_bounded_get() {
        let body = serde_json::json!({
            "products": [
                {"product_name":"Apple","brands":"Orchard"},
                {"product_name":"Apple slices","brands":"Market"},
                {"brands":"missing required name"}
            ]
        });
        let (endpoint, requests) =
            mock_search_server(reply(StatusCode::OK, body.to_string())).await;
        let products = enabled_search_client(&endpoint)
            .lookup_name("  apple   slices ")
            .await
            .unwrap();
        assert_eq!(products.len(), 2);
        assert_eq!(products[0].item_name, "Apple");
        assert_eq!(products[1].item_name, "Apple slices");

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, Method::GET);
        assert_eq!(request.uri.path(), "/cgi/search.pl");
        let query_url = Url::parse(&format!("http://localhost{}", request.uri)).unwrap();
        assert_eq!(
            query_url
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>(),
            [
                ("search_terms".into(), "apple slices".into()),
                ("search_simple".into(), "1".into()),
                ("action".into(), "process".into()),
                ("json".into(), "1".into()),
                ("page".into(), "1".into()),
                ("page_size".into(), MAX_SEARCH_RESULTS.to_string()),
                ("fields".into(), PRODUCT_FIELDS.into()),
            ]
        );
        assert_eq!(
            request.headers.get(USER_AGENT).unwrap(),
            "humane-food-tests/1.0 (food@example.invalid)"
        );
        assert!(request.body.is_empty());
    }

    #[tokio::test]
    async fn search_budget_is_ten_per_minute_and_shared_across_clones() {
        let body = serde_json::json!({"products":[{"product_name":"Apple"}]}).to_string();
        let (endpoint, requests) = mock_search_server(reply(StatusCode::OK, body)).await;
        let client = enabled_search_client(&endpoint);
        for _ in 0..SEARCH_REQUESTS_PER_WINDOW {
            client.clone().lookup_name("apple").await.unwrap();
        }
        assert_eq!(
            client.lookup_name("apple").await,
            Err(OpenFoodFactsError::RateLimited)
        );
        assert_eq!(requests.lock().unwrap().len(), SEARCH_REQUESTS_PER_WINDOW);
    }

    #[tokio::test]
    async fn production_client_does_not_follow_search_redirects() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first_calls = Arc::clone(&calls);
        let redirected_calls = Arc::clone(&calls);
        let app = Router::new()
            .route(
                "/cgi/search.pl",
                get(move || {
                    first_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async { (StatusCode::FOUND, [("location", "/redirected")]) }
                }),
            )
            .route(
                "/redirected",
                get(move || {
                    redirected_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async { "should not be requested" }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let endpoint = format!("http://{address}/cgi/search.pl");

        assert_eq!(
            enabled_search_client(&endpoint).lookup_name("apple").await,
            Err(OpenFoodFactsError::ProviderUnavailable)
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn search_rate_window_releases_only_expired_requests() {
        let now = Instant::now();
        let mut limiter = SearchRateLimiter::default();
        for _ in 0..SEARCH_REQUESTS_PER_WINDOW {
            assert!(limiter.try_acquire(now));
        }
        assert!(!limiter.try_acquire(now + SEARCH_RATE_WINDOW - Duration::from_millis(1)));
        assert!(limiter.try_acquire(now + SEARCH_RATE_WINDOW));
    }

    #[tokio::test]
    async fn lookup_is_a_barcode_only_v3_get_with_user_agent_and_no_body() {
        let product = serde_json::json!({
            "product": {
                "product_name": "  Test spread  ",
                "brands": " Example Brand ",
                "serving_size": "30 g",
                "nutriments": {
                    "calcium_serving": 0.03,
                    "calcium_unit": "g",
                    "energy-kcal_serving": 120,
                    "proteins_serving": "3.5",
                    "sodium_serving": 0.2,
                    "vitamin-a_serving": 0.0009,
                    "vitamin-a_unit": "g",
                    "fat_serving": -1,
                    "unrecognized-private-field_serving": 999
                }
            }
        });
        let (endpoint, requests) = mock_server(reply(StatusCode::OK, product.to_string())).await;
        let product = enabled_client(&endpoint)
            .lookup_barcode("3017620422003")
            .await
            .unwrap();

        assert_eq!(product.item_name, "Test spread");
        assert_eq!(product.brand, "Example Brand");
        assert_eq!(product.typical_serving_size, "30 g");
        assert_eq!(
            product.nutrients,
            vec![
                FoodNutrient {
                    kind: FoodNutrientKind::Calcium,
                    value: 30.0,
                },
                FoodNutrient {
                    kind: FoodNutrientKind::Calories,
                    value: 120.0,
                },
                FoodNutrient {
                    kind: FoodNutrientKind::Protein,
                    value: 3.5,
                },
                FoodNutrient {
                    kind: FoodNutrientKind::Sodium,
                    value: 200.0,
                },
                FoodNutrient {
                    kind: FoodNutrientKind::VitaminA,
                    value: 900.0,
                },
            ]
        );

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, Method::GET);
        assert_eq!(request.uri.path(), "/api/v3/product/3017620422003");
        let query_url = Url::parse(&format!("http://localhost{}", request.uri)).unwrap();
        assert_eq!(
            query_url
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>(),
            [("fields".to_string(), PRODUCT_FIELDS.to_string())]
        );
        assert_eq!(
            request.headers.get(USER_AGENT).unwrap(),
            "humane-food-tests/1.0 (food@example.invalid)"
        );
        assert!(request.body.is_empty());
    }

    #[tokio::test]
    async fn unified_lookup_resolves_valid_gtin_and_never_searches_bad_numeric_input() {
        let body = serde_json::json!({
            "product": {"product_name":"Barcode product"}
        });
        let (endpoint, requests) = mock_server(reply(StatusCode::OK, body.to_string())).await;
        let client = enabled_client(&endpoint);
        let products = client.lookup("3017620422003").await.unwrap();
        assert_eq!(products.len(), 1);
        assert_eq!(products[0].item_name, "Barcode product");
        assert_eq!(
            client.lookup("3017620422004").await,
            Err(OpenFoodFactsError::InvalidBarcode)
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn provider_bodies_and_barcodes_never_enter_errors() {
        let private_body = "private-provider-body-3017620422003";
        let (endpoint, _) = mock_server(reply(StatusCode::OK, private_body)).await;
        let error = enabled_client(&endpoint)
            .lookup_barcode("3017620422003")
            .await
            .unwrap_err();
        assert_eq!(error, OpenFoodFactsError::InvalidResponse);
        for rendered in [error.to_string(), format!("{error:?}")] {
            assert!(!rendered.contains(private_body));
            assert!(!rendered.contains("3017620422003"));
        }

        let (endpoint, _) =
            mock_server(reply(StatusCode::INTERNAL_SERVER_ERROR, private_body)).await;
        let error = enabled_client(&endpoint)
            .lookup_barcode("3017620422003")
            .await
            .unwrap_err();
        assert_eq!(error, OpenFoodFactsError::ProviderUnavailable);
        assert!(!format!("{error:?}").contains(private_body));
    }

    #[tokio::test]
    async fn status_size_and_timeout_failures_are_bounded_categories() {
        let (endpoint, _) = mock_server(reply(StatusCode::NOT_FOUND, "private")).await;
        assert_eq!(
            enabled_client(&endpoint)
                .lookup_barcode("3017620422003")
                .await,
            Err(OpenFoodFactsError::NotFound)
        );

        let (endpoint, _) =
            mock_server(reply(StatusCode::OK, "x".repeat(MAX_RESPONSE_BYTES + 1))).await;
        assert_eq!(
            enabled_client(&endpoint)
                .lookup_barcode("3017620422003")
                .await,
            Err(OpenFoodFactsError::ResponseTooLarge)
        );

        let (endpoint, _) = mock_server(MockReply {
            status: StatusCode::OK,
            body: "{}".into(),
            delay: Duration::from_millis(100),
        })
        .await;
        let client = OpenFoodFactsClient::from_options(
            OpenFoodFactsOptions::new("humane-food-tests/1.0 (food@example.invalid)")
                .with_enabled(true)
                .with_attribution_acknowledged(true)
                .with_timeout(Duration::from_millis(5)),
        )
        .unwrap()
        .with_test_product_endpoint(&endpoint);
        assert_eq!(
            client.lookup_barcode("3017620422003").await,
            Err(OpenFoodFactsError::Transport)
        );
    }

    #[test]
    fn debug_output_redacts_the_configured_user_agent() {
        let private_user_agent = "private-app/1.0 (private@example.invalid)";
        let options = OpenFoodFactsOptions::new(private_user_agent).with_enabled(true);
        let options_debug = format!("{options:?}");
        assert!(options_debug.contains("enabled: true"));
        assert!(options_debug.contains("attribution_acknowledged: false"));
        assert!(options_debug.contains("user_agent_configured: true"));
        assert!(!options_debug.contains("timeout"));
        assert!(!options_debug.contains(private_user_agent));
        assert!(!options_debug.contains("private@example.invalid"));

        let client = OpenFoodFactsClient::from_options(options).unwrap();
        let client_debug = format!("{client:?}");
        assert!(!client_debug.contains(private_user_agent));
        assert!(!client_debug.contains("private@example.invalid"));
    }

    #[test]
    fn micronutrients_without_explicit_units_are_not_guessed() {
        let product = ProductData {
            product_name: Some("Example".into()),
            brands: None,
            serving_size: None,
            nutriments: serde_json::from_value(serde_json::json!({
                "calcium_100g": 1,
                "iron_100g": 2,
                "proteins_100g": 3,
                "sodium_100g": 0.1
            }))
            .unwrap(),
        };
        let product = product_from_response(product).unwrap();
        assert_eq!(product.typical_serving_size, "100 g");
        assert_eq!(
            product.nutrients,
            vec![
                FoodNutrient {
                    kind: FoodNutrientKind::Protein,
                    value: 3.0,
                },
                FoodNutrient {
                    kind: FoodNutrientKind::Sodium,
                    value: 100.0,
                },
            ]
        );
    }
}
