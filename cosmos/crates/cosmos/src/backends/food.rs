//! Food nutrition lookup — **Open Food Facts** (openfoodfacts.org).
//!
//! cosmos's food stack was Google Vision / Calorie Mama for *image* recognition
//! and **Nutritionix** for the *nutrition database* (branded foods, barcodes, the
//! `nf_*` fields). We don't hold a Nutritionix key, but Open Food Facts is a free,
//! **keyless**, openly-licensed database with the same shape — branded products,
//! barcodes, and per-serving / per-100g nutriments — so it is a compatible
//! substitute for the *nutrition* half. Image recognition still needs a vision
//! vendor and stays honest-UNIMPLEMENTED.
//!
//! The returned values are mapped onto cosmos's `NutrientType` enum in cosmos's
//! unit convention (Nutritionix's `nf_*`): calories in kcal, macros in grams,
//! minerals + vitamin C in milligrams, vitamin A in micrograms. Open Food Facts
//! reports everything in grams, so mineral/vitamin values are scaled up. Nothing
//! is invented — a nutrient absent from the product is simply omitted.

use std::collections::{HashMap, HashSet};

use cosmos_protocol::common::food;
use serde::Deserialize;

use super::{BackendError, http};

const SEARCH_ENDPOINT: &str = "https://search.openfoodfacts.org/search";
const PRODUCT_ENDPOINT: &str = "https://world.openfoodfacts.org/api/v2/product";
const AUTH_ENDPOINT: &str = "https://world.openfoodfacts.org/cgi/auth.pl";
const USER_AGENT: &str =
    "ai-pin-revival-cosmos/1.0 (https://github.com/TheAndersMadsen/ai-pin-revival)";
const PRODUCT_FIELDS: &str = "product_name,brands,serving_size,code,ingredients_text,nutriments";

#[derive(Deserialize)]
struct OffSearch {
    #[serde(default, alias = "hits")]
    products: Vec<OffSearchHit>,
}

#[derive(Deserialize)]
struct OffSearchHit {
    #[serde(default)]
    code: String,
    #[serde(default)]
    product_name: serde_json::Value,
    #[serde(default)]
    generic_name: serde_json::Value,
    #[serde(default)]
    brands: serde_json::Value,
    #[serde(default)]
    categories: serde_json::Value,
}

#[derive(Deserialize)]
struct OffProductResponse {
    #[serde(default)]
    status: i32,
    product: Option<OffProduct>,
}

#[derive(Deserialize)]
struct OffAuthResponse {
    #[serde(default)]
    status: i32,
    #[serde(default)]
    user_id: String,
}

#[derive(Deserialize)]
struct OffProduct {
    #[serde(default)]
    product_name: String,
    #[serde(default)]
    brands: String,
    #[serde(default)]
    serving_size: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    ingredients_text: String,
    #[serde(default)]
    nutriments: HashMap<String, serde_json::Value>,
}

/// (`NutrientType`, Open Food Facts base key, grams→cosmos-unit multiplier).
/// Calories (kcal) and macros (g) need no conversion; minerals + vitamin C go
/// grams→mg (×1000); vitamin A goes grams→mcg (×1e6).
const MAP: &[(i32, &str, f64)] = &[
    (food::NutrientType::Calories as i32, "energy-kcal", 1.0),
    (food::NutrientType::TotalFat as i32, "fat", 1.0),
    (
        food::NutrientType::SaturatedFat as i32,
        "saturated-fat",
        1.0,
    ),
    (food::NutrientType::TransFat as i32, "trans-fat", 1.0),
    (
        food::NutrientType::MonounsaturatedFat as i32,
        "monounsaturated-fat",
        1.0,
    ),
    (
        food::NutrientType::PolyunsaturatedFat as i32,
        "polyunsaturated-fat",
        1.0,
    ),
    (food::NutrientType::TotalCarbs as i32, "carbohydrates", 1.0),
    (food::NutrientType::DietaryFiber as i32, "fiber", 1.0),
    (food::NutrientType::Sugars as i32, "sugars", 1.0),
    (food::NutrientType::Protein as i32, "proteins", 1.0),
    (food::NutrientType::Sodium as i32, "sodium", 1000.0),
    (food::NutrientType::Potassium as i32, "potassium", 1000.0),
    (
        food::NutrientType::Cholesterol as i32,
        "cholesterol",
        1000.0,
    ),
    (food::NutrientType::Calcium as i32, "calcium", 1000.0),
    (food::NutrientType::Iron as i32, "iron", 1000.0),
    (food::NutrientType::VitaminC as i32, "vitamin-c", 1000.0),
    (
        food::NutrientType::VitaminA as i32,
        "vitamin-a",
        1_000_000.0,
    ),
];

/// A resolved food record, in the fields cosmos's `FoodIdentifyResponse` /
/// `FoodItem` cosmos.
pub struct FoodLookup {
    pub item_name: String,
    pub brand: String,
    pub barcode: String,
    pub serving_size: String,
    pub ingredients: Vec<String>,
    pub nutrition: Vec<food::NutritionInfo>,
}

/// Look up the best-matching food by name and return its nutrition.
pub async fn lookup(query: &str) -> Result<FoodLookup, BackendError> {
    lookup_from_endpoints(query, SEARCH_ENDPOINT, PRODUCT_ENDPOINT).await
}

/// Verify an Open Food Facts account without exposing credentials in a URL.
/// Nutrition reads intentionally stay keyless per the provider's API contract.
pub async fn authenticate(username: &str, password: &str) -> Result<(), BackendError> {
    authenticate_at_endpoint(username, password, AUTH_ENDPOINT).await
}

async fn authenticate_at_endpoint(
    username: &str,
    password: &str,
    endpoint: &str,
) -> Result<(), BackendError> {
    let response: OffAuthResponse = http()
        .post(endpoint)
        .header("User-Agent", USER_AGENT)
        .form(&[("user_id", username), ("password", password), ("body", "1")])
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    if response.status == 1 && response.user_id == username {
        Ok(())
    } else {
        Err(BackendError::Unavailable)
    }
}

async fn lookup_from_endpoints(
    query: &str,
    search_endpoint: &str,
    product_endpoint: &str,
) -> Result<FoodLookup, BackendError> {
    let search_terms = food_search_terms(query);
    if search_terms.is_empty() {
        return Err(BackendError::NoResult);
    }
    let search_url = format!(
        "{search_endpoint}?q={}&page_size=5",
        super::places::encode(&search_terms.join(" "))
    );
    let search: OffSearch = http()
        .get(search_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    let query_tokens = search_terms
        .iter()
        .map(|term| match_token(term))
        .collect::<HashSet<_>>();
    let code = best_search_hit(search.products, &query_tokens)
        .map(|product| product.code)
        .ok_or(BackendError::NoResult)?;

    let product_url = format!("{product_endpoint}/{code}?fields={PRODUCT_FIELDS}");
    let response: OffProductResponse = http()
        .get(product_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;
    if response.status != 1 {
        return Err(BackendError::NoResult);
    }
    let product = response
        .product
        .filter(|product| !product.product_name.trim().is_empty())
        .ok_or(BackendError::NoResult)?;

    Ok(to_lookup(product))
}

const FOOD_QUERY_FILLER: &[&str] = &[
    "a",
    "an",
    "are",
    "calorie",
    "calories",
    "carb",
    "carbs",
    "contain",
    "contains",
    "do",
    "does",
    "fat",
    "fats",
    "fact",
    "facts",
    "fiber",
    "fibre",
    "find",
    "for",
    "give",
    "have",
    "has",
    "how",
    "in",
    "is",
    "look",
    "many",
    "me",
    "much",
    "nutrient",
    "nutrients",
    "nutrition",
    "nutritional",
    "of",
    "one",
    "please",
    "protein",
    "proteins",
    "serving",
    "servings",
    "sugar",
    "sugars",
    "tell",
    "the",
    "there",
    "three",
    "to",
    "two",
    "up",
    "what",
];

fn words(value: &str) -> Vec<String> {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn match_token(value: &str) -> String {
    if value.len() > 3 && value.ends_with('s') && !value.ends_with("ss") {
        value[..value.len() - 1].to_owned()
    } else {
        value.to_owned()
    }
}

fn food_search_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    words(query)
        .into_iter()
        .filter(|word| {
            !word.bytes().all(|byte| byte.is_ascii_digit())
                && !FOOD_QUERY_FILLER.contains(&word.as_str())
        })
        .filter(|word| seen.insert(match_token(word)))
        .take(8)
        .collect()
}

fn append_value_tokens(value: &serde_json::Value, tokens: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(text) => {
            tokens.extend(words(text).into_iter().map(|word| match_token(&word)));
        }
        serde_json::Value::Array(values) => {
            for value in values {
                append_value_tokens(value, tokens);
            }
        }
        _ => {}
    }
}

fn value_tokens(value: &serde_json::Value) -> HashSet<String> {
    let mut tokens = HashSet::new();
    append_value_tokens(value, &mut tokens);
    tokens
}

fn search_hit_score(product: &OffSearchHit, query_tokens: &HashSet<String>) -> usize {
    let product_name = value_tokens(&product.product_name);
    let generic_name = value_tokens(&product.generic_name);
    let categories = value_tokens(&product.categories);
    let brands = value_tokens(&product.brands);

    query_tokens
        .iter()
        .map(|token| {
            if product_name.contains(token) {
                4
            } else if generic_name.contains(token) {
                3
            } else if categories.contains(token) {
                2
            } else if brands.contains(token) {
                1
            } else {
                0
            }
        })
        .sum()
}

fn best_search_hit(
    products: Vec<OffSearchHit>,
    query_tokens: &HashSet<String>,
) -> Option<OffSearchHit> {
    let mut best = None;
    let mut best_score = 0;
    for product in products {
        if !valid_product_code(&product.code) {
            continue;
        }
        let score = search_hit_score(&product, query_tokens);
        if score > best_score {
            best = Some(product);
            best_score = score;
        }
    }
    best
}

fn valid_product_code(code: &str) -> bool {
    (4..=32).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_digit())
}

/// Map an Open Food Facts product onto cosmos's food record + nutrient units.
fn to_lookup(product: OffProduct) -> FoodLookup {
    // Prefer per-serving values when the product declares a serving; otherwise
    // per-100g, and label the serving as such.
    let serving_mode = !product.serving_size.trim().is_empty()
        && number(&product.nutriments, "energy-kcal_serving").is_some();
    let suffix = if serving_mode { "_serving" } else { "_100g" };

    let mut nutrition = Vec::new();
    for (nutrient_type, base, mult) in MAP {
        let value = number(&product.nutriments, &format!("{base}{suffix}"))
            .or_else(|| number(&product.nutriments, &format!("{base}_100g")));
        if let Some(v) = value {
            let scaled = v * mult;
            if scaled.is_finite() {
                nutrition.push(food::NutritionInfo {
                    nutrient_type: *nutrient_type,
                    value: scaled as f32,
                });
            }
        }
    }

    let serving_size = if serving_mode {
        product.serving_size.clone()
    } else {
        "100 g".to_owned()
    };
    let ingredients = product
        .ingredients_text
        .split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();

    FoodLookup {
        item_name: product.product_name,
        brand: product.brands,
        barcode: product.code,
        serving_size,
        ingredients,
        nutrition,
    }
}

/// Read a numeric nutriment that Open Food Facts may encode as a number or a
/// stringified number.
fn number(m: &HashMap<String, serde_json::Value>, key: &str) -> Option<f64> {
    m.get(key).and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    async fn serve_once(body: &'static str) -> (String, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = oneshot::channel();
        let body = Arc::new(body);
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 8 * 1024];
            let read = socket.read(&mut request).await.unwrap_or(0);
            let _ = request_tx.send(String::from_utf8_lossy(&request[..read]).into_owned());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body,
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        (format!("http://{address}"), request_rx)
    }

    #[test]
    fn dedicated_search_service_hits_are_accepted() {
        let response: OffSearch =
            serde_json::from_str(r#"{"hits":[{"code":"12345678","product_name":"Oatmeal"}]}"#)
                .unwrap();

        assert_eq!(response.products.len(), 1);
        assert_eq!(response.products[0].code, "12345678");
    }

    #[test]
    fn dedicated_search_service_lightweight_hits_are_accepted() {
        let response: OffSearch = serde_json::from_str(
            r#"{"hits":[{"code":"6052028799002","product_name":"Oatmeal","brands":[],"serving_size":null,"ingredients_text":null,"nutriments":{}}]}"#,
        )
        .unwrap();

        assert_eq!(response.products.len(), 1);
        assert_eq!(response.products[0].code, "6052028799002");
    }

    #[test]
    fn food_terms_ignore_question_and_nutrient_filler() {
        assert_eq!(
            food_search_terms("What are the nutrition facts for oatmeal?"),
            ["oatmeal"]
        );
        assert_eq!(
            food_search_terms("How much protein is in two eggs?"),
            ["eggs"]
        );
    }

    #[test]
    fn product_name_relevance_beats_a_brand_only_match() {
        let search: OffSearch = serde_json::from_str(
            r#"{"hits":[{"code":"11111111","product_name":"Cookies","brands":["Oatmeal"]},{"code":"22222222","product_name":"Original instant oatmeal","brands":["Oatmeal"]}]}"#,
        )
        .unwrap();
        let query = ["oatmeal".to_owned()].into_iter().collect();

        assert_eq!(
            best_search_hit(search.products, &query)
                .expect("one relevant hit")
                .code,
            "22222222"
        );
    }

    #[test]
    fn repeated_metadata_cannot_outscore_an_earlier_product_name_match() {
        let search: OffSearch = serde_json::from_str(
            r#"{"hits":[{"code":"11111111","product_name":"Original instant oatmeal","brands":["Oatmeal"],"categories":"Cereals"},{"code":"22222222","product_name":"Oatmeal raisin cookie","generic_name":"Oatmeal cookie","categories":"Cookies, Oatmeal cookies"}]}"#,
        )
        .unwrap();
        let query = ["oatmeal".to_owned()].into_iter().collect();

        assert_eq!(
            best_search_hit(search.products, &query)
                .expect("one relevant hit")
                .code,
            "11111111"
        );
    }

    #[test]
    fn search_hits_without_relevant_metadata_are_rejected() {
        let search: OffSearch = serde_json::from_str(
            r#"{"hits":[{"code":"11111111","product_name":"Apricot jam"},{"code":"22222222"}]}"#,
        )
        .unwrap();
        let query = ["oatmeal".to_owned()].into_iter().collect();

        assert!(best_search_hit(search.products, &query).is_none());
    }

    #[tokio::test]
    async fn lookup_uses_search_index_then_complete_product_record() {
        let (search_base, search_request) =
            serve_once(r#"{"hits":[{"code":"12345678","product_name":"Oatmeal"}]}"#).await;
        let (product_base, product_request) = serve_once(
            r#"{"status":1,"product":{"product_name":"Oatmeal","brands":"Test","serving_size":"","code":"12345678","ingredients_text":"oats","nutriments":{"energy-kcal_100g":68.0,"proteins_100g":2.4}}}"#,
        )
        .await;

        let result = lookup_from_endpoints(
            "plain oatmeal",
            &format!("{search_base}/search"),
            &format!("{product_base}/product"),
        )
        .await
        .unwrap();

        assert_eq!(result.item_name, "Oatmeal");
        assert_eq!(result.serving_size, "100 g");
        assert_eq!(result.nutrition.len(), 2);

        let search_request = search_request.await.unwrap();
        assert!(search_request.starts_with("GET /search?q=plain+oatmeal&page_size=5 "));
        assert!(search_request.contains(&format!("user-agent: {USER_AGENT}")));

        let product_request = product_request.await.unwrap();
        assert!(product_request.starts_with("GET /product/12345678?fields="));
        assert!(product_request.contains(&format!("user-agent: {USER_AGENT}")));
    }

    #[tokio::test]
    async fn lookup_skips_unrelated_first_hit_for_a_nutrition_question() {
        let (search_base, _search_request) = serve_once(
            r#"{"hits":[{"code":"11111111","product_name":"Apricot jam"},{"code":"22222222","product_name":"Plain oatmeal"}]}"#,
        )
        .await;
        let (product_base, product_request) = serve_once(
            r#"{"status":1,"product":{"product_name":"Plain oatmeal","brands":"Test","serving_size":"","code":"22222222","ingredients_text":"oats","nutriments":{"energy-kcal_100g":68.0}}}"#,
        )
        .await;

        let result = lookup_from_endpoints(
            "What are the nutrition facts for oatmeal?",
            &format!("{search_base}/search"),
            &format!("{product_base}/product"),
        )
        .await
        .unwrap();

        assert_eq!(result.item_name, "Plain oatmeal");
        assert!(
            product_request
                .await
                .unwrap()
                .starts_with("GET /product/22222222?fields=")
        );
    }

    #[tokio::test]
    async fn authentication_posts_credentials_in_the_body() {
        let (endpoint, request) =
            serve_once(r#"{"status":1,"status_verbose":"user signed-in","user_id":"account"}"#)
                .await;

        authenticate_at_endpoint("account", "private value", &endpoint)
            .await
            .unwrap();

        let request = request.await.unwrap();
        assert!(request.starts_with("POST / HTTP/1.1"));
        assert!(request.contains("content-type: application/x-www-form-urlencoded"));
        assert!(request.contains("user_id=account&password=private+value&body=1"));
        assert!(!request.starts_with("POST /?"));
    }

    #[test]
    fn product_codes_are_path_safe_gtins() {
        assert!(valid_product_code("12345678"));
        for invalid in ["", "123", "123/456", "abc123", &"1".repeat(33)] {
            assert!(!valid_product_code(invalid));
        }
    }

    fn product(nutriments: &[(&str, f64)]) -> OffProduct {
        OffProduct {
            product_name: "Banana".into(),
            brands: "Acme".into(),
            serving_size: String::new(),
            code: "123".into(),
            ingredients_text: "banana, sugar".into(),
            nutriments: nutriments
                .iter()
                .map(|(k, v)| (k.to_string(), serde_json::json!(v)))
                .collect(),
        }
    }

    #[test]
    fn maps_100g_nutriments_into_cosmos_units() {
        let p = product(&[
            ("energy-kcal_100g", 89.0),
            ("fat_100g", 0.3),
            ("proteins_100g", 1.1),
            ("sodium_100g", 0.001), // 0.001 g -> 1 mg
            ("carbohydrates_100g", 23.0),
        ]);
        let out = to_lookup(p);
        assert_eq!(out.item_name, "Banana");
        assert_eq!(out.serving_size, "100 g");
        assert_eq!(out.ingredients, vec!["banana", "sugar"]);
        let by = |t: food::NutrientType| {
            out.nutrition
                .iter()
                .find(|n| n.nutrient_type == t as i32)
                .map(|n| n.value)
        };
        assert_eq!(by(food::NutrientType::Calories), Some(89.0));
        assert_eq!(by(food::NutrientType::TotalFat), Some(0.3));
        // sodium grams -> milligrams
        assert_eq!(by(food::NutrientType::Sodium), Some(1.0));
        // absent nutrient is omitted, never invented
        assert_eq!(by(food::NutrientType::VitaminA), None);
    }

    #[test]
    fn prefers_per_serving_values_when_a_serving_is_declared() {
        let mut p = product(&[("energy-kcal_100g", 89.0), ("energy-kcal_serving", 105.0)]);
        p.serving_size = "1 medium (118 g)".into();
        let out = to_lookup(p);
        assert_eq!(out.serving_size, "1 medium (118 g)");
        let cal = out
            .nutrition
            .iter()
            .find(|n| n.nutrient_type == food::NutrientType::Calories as i32)
            .map(|n| n.value);
        assert_eq!(cal, Some(105.0));
    }

    #[test]
    fn a_string_encoded_number_still_parses() {
        let p = OffProduct {
            nutriments: [("energy-kcal_100g".to_string(), serde_json::json!("89"))]
                .into_iter()
                .collect(),
            ..product(&[])
        };
        let out = to_lookup(p);
        assert_eq!(out.nutrition.len(), 1);
    }
}
