use std::convert::Infallible;

use rig::completion::ToolDefinition;
use rig::tool::{Tool, ToolEmbedding};
use serde::Deserialize;
use serde_json::json;

use crate::external::osm::{OsmClient, OsmError, ReverseGeocodeResult};

#[derive(Clone)]
pub struct ReverseGeocodeTool {
    osm: OsmClient,
}

impl ReverseGeocodeTool {
    pub fn new(osm: OsmClient) -> Self {
        Self { osm }
    }
}

#[derive(Debug, Deserialize)]
pub struct ReverseGeocodeArgs {
    pub latitude: f64,
    pub longitude: f64,
}

impl Tool for ReverseGeocodeTool {
    const NAME: &'static str = "reverse_geocode";

    type Error = OsmError;
    type Args = ReverseGeocodeArgs;
    type Output = ReverseGeocodeResult;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Look up the human-readable address or place name for latitude and longitude coordinates. Use this for questions like where am I, what city am I in, what is this address, or what place is at these coordinates. CAUTION: Results returned by this lookup may be imprecise or outdated (such as if the user moved).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "latitude": {
                        "type": "number",
                        "description": "Latitude to reverse geocode. Required; use the current request latitude from system/status context when available."
                    },
                    "longitude": {
                        "type": "number",
                        "description": "Longitude to reverse geocode. Required; use the current request longitude from system/status context when available."
                    }
                },
                "required": ["latitude", "longitude"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.osm
            .reverse_geocode(args.latitude, args.longitude)
            .await
    }
}

impl ToolEmbedding for ReverseGeocodeTool {
    type InitError = Infallible;
    type Context = ();
    type State = OsmClient;

    fn embedding_docs(&self) -> Vec<String> {
        vec!["Reverse geocode coordinates into a human-readable address, city, state, country, postal code, or place name. Use for questions like: where am I, what city am I in, what is this address, what neighborhood is this, what place is at my current coordinates.".to_string()]
    }

    fn context(&self) -> Self::Context {}

    fn init(state: Self::State, _context: Self::Context) -> Result<Self, Self::InitError> {
        Ok(Self::new(state))
    }
}
