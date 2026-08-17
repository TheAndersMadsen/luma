mod delete;
mod save;
mod search;
mod update;

pub use delete::ForgetMemoryTool;
pub use save::RememberTool;
pub use search::SearchMemoryTool;
pub use update::UpdateMemoryTool;

#[derive(Debug)]
pub struct MemoryToolError(String);

impl std::fmt::Display for MemoryToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MemoryToolError {}

impl From<String> for MemoryToolError {
    fn from(value: String) -> Self {
        Self(value)
    }
}
