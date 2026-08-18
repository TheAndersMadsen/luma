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

use std::collections::HashMap;

use cosmos_protocol::common::food;
use serde::Deserialize;

use super::{BackendError, http};

#[derive(Deserialize)]
struct OffSearch {
    #[serde(default)]
    products: Vec<OffProduct>,
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
    let url = format!(
        "https://world.openfoodfacts.org/cgi/search.pl?search_terms={}&search_simple=1\
         &action=process&json=1&page_size=1\
         &fields=product_name,brands,serving_size,code,ingredients_text,nutriments",
        super::places::encode(query)
    );
    let resp: OffSearch = http()
        .get(url)
        // Open Food Facts requires an identifying User-Agent.
        .header("User-Agent", "ai-pin-revival-cosmos/1.0 (nutrition lookup)")
        .send()
        .await
        .map_err(|_| BackendError::Unavailable)?
        .error_for_status()
        .map_err(|_| BackendError::Unavailable)?
        .json()
        .await
        .map_err(|_| BackendError::Unavailable)?;

    let product = resp
        .products
        .into_iter()
        .find(|p| !p.product_name.trim().is_empty())
        .ok_or(BackendError::NoResult)?;

    Ok(to_lookup(product))
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
