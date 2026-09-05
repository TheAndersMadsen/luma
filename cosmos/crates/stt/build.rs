use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../native/stt-model.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let bytes = fs::read(manifest).expect("local STT model manifest");
    assert!(bytes.len() <= 4096, "local STT model manifest is too large");
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).expect("local STT model manifest JSON");
    let fields = value.as_object().expect("local STT model manifest object");
    assert_eq!(
        fields.len(),
        6,
        "unexpected local STT model manifest fields"
    );
    assert_eq!(value["schemaVersion"].as_u64(), Some(1));
    let text = |name: &str| {
        let field = value[name].as_str().expect("local STT model text field");
        assert!(field.is_ascii() && !field.is_empty() && field.len() <= 512);
        field
    };
    let id = text("id");
    let file = text("file");
    assert_eq!(file, "ggml-base.bin");
    let size = value["bytes"].as_u64().expect("local STT model size");
    assert!(size > 0 && size <= 1024 * 1024 * 1024);
    let hash = text("sha256");
    assert!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let url = text("url");
    let revision = url
        .strip_prefix("https://huggingface.co/ggerganov/whisper.cpp/resolve/")
        .and_then(|value| value.strip_suffix("/ggml-base.bin"))
        .expect("immutable local STT model URL");
    assert!(
        revision.len() == 40
            && revision
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let output = format!(
        "pub const MODEL_ID: &str = {id:?};\npub const MODEL_FILE: &str = {file:?};\npub const MODEL_BYTES: u64 = {size};\npub const MODEL_SHA256: &str = {hash:?};\npub const MODEL_URL: &str = {url:?};\n"
    );
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("model.rs"),
        output,
    )
    .expect("project local STT model constants");
}
