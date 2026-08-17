use std::convert::Infallible;

use memvid_core::FrameId;
use rig::{
    completion::ToolDefinition,
    tool::{Tool, ToolEmbedding},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::llm::memory::MemoryService;

#[derive(Clone)]
pub struct ForgetMemoryTool {
    memory: MemoryService,
}

impl ForgetMemoryTool {
    pub fn new(memory: MemoryService) -> Self {
        Self { memory }
    }
}

#[derive(Debug, Deserialize)]
pub struct ForgetMemoryArgs {
    pub id: FrameId,
}

#[derive(Debug, Serialize)]
pub struct ForgetMemoryOutput {
    pub id: FrameId,
    pub forgotten: bool,
}

impl Tool for ForgetMemoryTool {
    const NAME: &'static str = "forget_memory";

    type Error = super::MemoryToolError;
    type Args = ForgetMemoryArgs;
    type Output = ForgetMemoryOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "Delete a long-term assistant memory by id. Use when the user asks you to forget something or remove a saved memory.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "integer",
                        "description": "The memory id/frame id to delete."
                    }
                },
                "required": ["id"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.memory.forget(args.id).await?;

        Ok(ForgetMemoryOutput {
            id: args.id,
            forgotten: true,
        })
    }
}

impl ToolEmbedding for ForgetMemoryTool {
    type InitError = Infallible;
    type Context = ();
    type State = MemoryService;

    fn embedding_docs(&self) -> Vec<String> {
        vec!["Forget delete remove erase long term assistant memory saved fact preference instruction by id user asks forget this".to_string()]
    }

    fn context(&self) -> Self::Context {}

    fn init(state: Self::State, _context: Self::Context) -> Result<Self, Self::InitError> {
        Ok(Self::new(state))
    }
}
