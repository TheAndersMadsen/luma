use std::convert::Infallible;

use memvid_core::FrameId;
use rig::{
    completion::ToolDefinition,
    tool::{Tool, ToolEmbedding},
};
use serde::Deserialize;
use serde_json::json;

use crate::llm::memory::{MemoryKind, MemoryRecord, MemoryService};

#[derive(Clone)]
pub struct UpdateMemoryTool {
    memory: MemoryService,
}

impl UpdateMemoryTool {
    pub fn new(memory: MemoryService) -> Self {
        Self { memory }
    }
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemoryArgs {
    pub id: FrameId,
    pub text: String,
    pub kind: Option<MemoryKind>,
    pub importance: Option<f32>,
}

impl Tool for UpdateMemoryTool {
    const NAME: &'static str = "update_memory";

    type Error = super::MemoryToolError;
    type Args = UpdateMemoryArgs;
    type Output = MemoryRecord;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Update an existing long-term assistant memory by id. Use after searching memory or when the user identifies a saved memory that should change.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "integer",
                        "description": "The memory id/frame id to update."
                    },
                    "text": {
                        "type": "string",
                        "description": "The replacement memory text as a concise standalone statement."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["preference", "fact", "project", "instruction", "relationship", "other"],
                        "description": "Optional replacement memory kind."
                    },
                    "importance": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1,
                        "description": "Optional replacement importance from 0.0 to 1.0."
                    }
                },
                "required": ["id", "text"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.memory
            .update(args.id, args.text, args.kind, args.importance)
            .await
            .map_err(Into::into)
    }
}

impl ToolEmbedding for UpdateMemoryTool {
    type InitError = Infallible;
    type Context = ();
    type State = MemoryService;

    fn embedding_docs(&self) -> Vec<String> {
        vec!["Update edit correct replace modify existing saved long term assistant memory by id change preference fact instruction".to_string()]
    }

    fn context(&self) -> Self::Context {}

    fn init(state: Self::State, _context: Self::Context) -> Result<Self, Self::InitError> {
        Ok(Self::new(state))
    }
}
