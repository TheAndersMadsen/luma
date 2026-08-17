use std::convert::Infallible;
use std::sync::Arc;

use rig::completion::ToolDefinition;
use rig::tool::{Tool, ToolEmbedding};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::external::osm::OsmError;
use crate::nearby::NearbyClient;

const DEFAULT_RADIUS_METERS: f64 = 1000.0;
const DEFAULT_RESULT_LIMIT: usize = 8;
const MAX_RESULT_LIMIT: usize = 10;

#[derive(Clone)]
pub struct NearbySearchTool {
    nearby_client: Arc<NearbyClient>,
}

impl NearbySearchTool {
    pub fn new(nearby_client: Arc<NearbyClient>) -> Self {
        Self { nearby_client }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct NearbySearchToolContext;

#[derive(Debug, Deserialize)]
pub struct NearbySearchArgs {
    pub latitude: f64,
    pub longitude: f64,
    pub radius_meters: Option<f64>,
    pub query: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NearbySearchOutput {
    pub places: Vec<NearbyPlaceSummary>,
}

#[derive(Debug, Serialize)]
pub struct NearbyPlaceSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
}

#[derive(Debug)]
pub struct NearbyToolError(String);

impl std::fmt::Display for NearbyToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NearbyToolError {}

impl From<OsmError> for NearbyToolError {
    fn from(value: OsmError) -> Self {
        Self(value.to_string())
    }
}

impl Tool for NearbySearchTool {
    const NAME: &'static str = "nearby_search";

    type Error = NearbyToolError;
    type Args = NearbySearchArgs;
    type Output = NearbySearchOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Search for places, businesses, services, and points of interest near a latitude and longitude. Use this for nearby coffee shops, restaurants, parks, pharmacies, gas stations, stores, attractions, and other local places. The current request coordinates may be available in the system/status context; pass those as latitude and longitude when the user asks for places near them. radius_meters defaults to 1000 meters when omitted. query examples: coffee, restaurant, park, pharmacy, gas station, grocery.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "latitude": {
                        "type": "number",
                        "description": "Latitude of the search center. Required; use the current request latitude from system/status context when available."
                    },
                    "longitude": {
                        "type": "number",
                        "description": "Longitude of the search center. Required; use the current request longitude from system/status context when available."
                    },
                    "radius_meters": {
                        "type": "number",
                        "description": "Optional search radius in meters. Defaults to 1000 if omitted or non-positive."
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional place/business/category query such as coffee, restaurant, park, pharmacy, gas station, or grocery."
                    }
                },
                "required": ["latitude", "longitude"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let radius = args
            .radius_meters
            .filter(|radius| radius.is_finite() && *radius > 0.0)
            .unwrap_or(DEFAULT_RADIUS_METERS);
        let query = args.query.unwrap_or_default();

        let places = self
            .nearby_client
            .search(args.latitude, args.longitude, radius, &query)
            .await?
            .into_iter()
            .filter_map(|place| {
                let location = place.location?;
                Some(NearbyPlaceSummary {
                    name: place.name,
                    address: optional_non_empty(place.formatted_address),
                    description: optional_non_empty(place.place_description),
                    latitude: location.latitude,
                    longitude: location.longitude,
                    website_url: optional_non_empty(place.website_url),
                })
            })
            .take(DEFAULT_RESULT_LIMIT.min(MAX_RESULT_LIMIT))
            .collect();

        Ok(NearbySearchOutput { places })
    }
}

impl ToolEmbedding for NearbySearchTool {
    type InitError = Infallible;
    type Context = NearbySearchToolContext;
    type State = Arc<NearbyClient>;

    fn embedding_docs(&self) -> Vec<String> {
        vec!["Find nearby places, businesses, points of interest, restaurants, coffee shops, parks, stores, pharmacies, gas stations, grocery stores, services, or attractions around a latitude and longitude. Use for questions like: find coffee near me, restaurants nearby, closest park, is there a pharmacy around here, find gas stations nearby, what stores are close by.".to_string()]
    }

    fn context(&self) -> Self::Context {
        NearbySearchToolContext
    }

    fn init(state: Self::State, _context: Self::Context) -> Result<Self, Self::InitError> {
        Ok(Self::new(state))
    }
}

fn optional_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
