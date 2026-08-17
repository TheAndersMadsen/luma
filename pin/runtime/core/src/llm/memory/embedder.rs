use memvid_core::VecEmbedder;
use rig::embeddings::EmbeddingModel as _;

use crate::llm::tools::fastembed;

#[derive(Clone)]
pub struct MemvidEmbedder {
    model: rig_fastembed::EmbeddingModel,
}

impl MemvidEmbedder {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            model: fastembed::build_embedding_model()?,
        })
    }
}

impl VecEmbedder for MemvidEmbedder {
    fn embed_query(&self, text: &str) -> memvid_core::Result<Vec<f32>> {
        let embeddings = futures::executor::block_on(self.model.embed_texts([text.to_string()]))
            .map_err(|err| memvid_core::MemvidError::EmbeddingFailed {
                reason: err.to_string().into_boxed_str(),
            })?;

        let embedding = embeddings.into_iter().next().ok_or_else(|| {
            memvid_core::MemvidError::EmbeddingFailed {
                reason: "FastEmbed returned no embeddings".into(),
            }
        })?;

        Ok(embedding
            .vec
            .into_iter()
            // TODO: Is this precision loss acceptable?
            .map(|value| value as f32)
            .collect())
    }

    fn embed_chunks(&self, texts: &[&str]) -> memvid_core::Result<Vec<Vec<f32>>> {
        let input = texts
            .iter()
            .map(|text| (*text).to_string())
            .collect::<Vec<_>>();

        let embeddings =
            futures::executor::block_on(self.model.embed_texts(input)).map_err(|err| {
                memvid_core::MemvidError::EmbeddingFailed {
                    reason: err.to_string().into_boxed_str(),
                }
            })?;

        Ok(embeddings
            .into_iter()
            .map(|embedding| {
                embedding
                    .vec
                    .into_iter()
                    .map(|value| value as f32)
                    .collect()
            })
            .collect())
    }

    fn embedding_dimension(&self) -> usize {
        self.model.ndims()
    }
}
