use std::convert::Infallible;

use memvid_core::normalize_text;
use rig::{
    completion::ToolDefinition,
    tool::{Tool, ToolEmbedding},
};
use serde::Deserialize;
use serde_json::json;

use crate::llm::memory::{MemoryKind, MemoryRecord, MemoryService};

#[derive(Clone)]
pub struct RememberTool {
    memory: MemoryService,
}

impl RememberTool {
    pub fn new(memory: MemoryService) -> Self {
        Self { memory }
    }
}

#[derive(Debug, Deserialize)]
pub struct RememberArgs {
    pub text: String,
    #[serde(default)]
    pub kind: MemoryKind,
    pub importance: Option<f32>,
}

impl Tool for RememberTool {
    const NAME: &'static str = "remember";

    type Error = super::MemoryToolError;
    type Args = RememberArgs;
    type Output = MemoryRecord;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Save a durable long-term assistant memory. Use only when the user explicitly asks you to remember something, or when a stable user preference/fact/project instruction is clearly worth retaining. Do not store transient conversation details.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The durable memory to store as a concise standalone statement."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["preference", "fact", "project", "instruction", "relationship", "other"],
                        "description": "The type of memory. Defaults to other."
                    },
                    "importance": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                        "description": "Memory importance from 0.0 to 1.0. Defaults to 0.5."
                    }
                },
                "required": ["text"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let text = match normalize_text(&args.text, 100000) {
            Some(text) => text,
            None => return Err(super::MemoryToolError("Memory text cannot be empty".into())),
        };
        let importance = args.importance.unwrap_or(0.5).clamp(0.0, 1.0);

        self.memory
            .remember(text.text, args.kind, importance)
            .await
            .map_err(Into::into)
    }
}

impl ToolEmbedding for RememberTool {
    type InitError = Infallible;
    type Context = ();
    type State = MemoryService;

    fn embedding_docs(&self) -> Vec<String> {
        vec!["Save remember store durable long term assistant memory user preferences facts project instructions relationships explicit remember this keep in mind".to_string()]
    }

    fn context(&self) -> Self::Context {}

    fn init(state: Self::State, _context: Self::Context) -> Result<Self, Self::InitError> {
        Ok(Self::new(state))
    }
}
