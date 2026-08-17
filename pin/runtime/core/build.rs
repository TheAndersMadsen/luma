use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use hf_hub::api::sync::ApiBuilder;
use hf_hub::{Repo, RepoType};
use sha2::{Digest, Sha256};

const MODEL_REPO_ID: &str = "Qdrant/all-MiniLM-L6-v2-onnx";
const MODEL_REVISION: &str = "5f1b8cd78bc4fb444dd171e59b18f3a3af89a079";
const MODEL_OUT_DIR: &str = "embedded-embedding-model";

/// Every proto compiled into the server. The `rerun-if-changed` directives are
/// derived from this list so the two can never drift apart again: previously
/// only 5 of the 13 were declared, so editing one of the other 8 produced no
/// rebuild and left the generated code silently stale.
///
/// Paths are relative to the package root (`runtime/core/`), which is both the
/// build script's working directory and the base Cargo resolves
/// `rerun-if-changed` against, so the same strings serve both uses.
const PROTO_FILES: &[&str] = &[
    "proto/humane/aibus/aibus.proto",
    "proto/humane/pushrelay/pushrelay.proto",
    "proto/humane/featureflags/featureflags.proto",
    "proto/humane/account/account.proto",
    "proto/humane/contacts/contacts.proto",
    "proto/humane/events/events.proto",
    "proto/humane/provisioning/provisioning.proto",
    "proto/humane/capture/capture.proto",
    "proto/humane/common/encryption.proto",
    "proto/humane/common/food.proto",
    "proto/humane/partnerservices/partnerservices.proto",
    "proto/humane/privacy/privacy.proto",
    "proto/humane/privacy/privacy_common.proto",
];

const MODEL_FILES: &[(&str, &str)] = &[
    (
        "model.onnx",
        "bbd7b466f6d58e646fdc2bd5fd67b2f5e93c0b687011bd4548c420f7bd46f0c5",
    ),
    (
        "tokenizer.json",
        "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    ),
    (
        "config.json",
        "1b4d8e2a3988377ed8b519a31d8d31025a25f1c5f8606998e8014111438efcd7",
    ),
    (
        "special_tokens_map.json",
        "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
    ),
    (
        "tokenizer_config.json",
        "bd2e06a5b20fd1b13ca988bedc8763d332d242381b4fbc98f8fead4524158f79",
    ),
    (
        "vocab.txt",
        "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    ),
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Allow Gradle/Android to bake a custom version number.
    println!("cargo:rerun-if-env-changed=PENUMBRA_VERSION");
    let version =
        env::var("PENUMBRA_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=PENUMBRA_VERSION={version}");

    download_embedding_model();

    // Cargo disables its default "rerun if any package file changed" behavior as
    // soon as a build script emits ANY rerun-if-changed line, and prost-build
    // emits none of its own (see the TODO in prost-build 0.14 `config.rs`
    // `compile_protos`). Every compiled proto must therefore be declared here
    // explicitly, so both this loop and `compile_protos` below read the same list.
    for proto in PROTO_FILES {
        println!("cargo:rerun-if-changed={proto}");
    }

    tonic_prost_build::configure()
        .build_server(true)
        .build_client(true)
        // Box the oversized oneof variant so the generated Content enum stays
        // small; wire encoding is unchanged (in-memory representation only).
        .boxed(".humane.aibus.StreamingUnderstandRequest.content.understanding_request")
        .compile_protos(PROTO_FILES, &["proto"])?;
    Ok(())
}

fn download_embedding_model() {
    println!("cargo:rerun-if-env-changed=EMBED_MODEL_CACHE_DIR");
    println!("cargo:rerun-if-env-changed=EMBED_MODEL_OFFLINE");
    println!("cargo:rerun-if-env-changed=HF_HOME");
    println!("cargo:rerun-if-env-changed=HF_ENDPOINT");
    println!("cargo:rerun-if-env-changed=HF_TOKEN");
    println!("cargo:rerun-if-env-changed=HUGGINGFACE_HUB_TOKEN");
    println!("cargo:rerun-if-env-changed=CARGO_NET_OFFLINE");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let model_out_dir = out_dir.join(MODEL_OUT_DIR);
    fs::create_dir_all(&model_out_dir).expect("failed to create embedded model output directory");

    let offline = env_truthy("EMBED_MODEL_OFFLINE") || env_truthy("CARGO_NET_OFFLINE");
    let mut api_builder = ApiBuilder::from_env()
        .with_progress(false)
        .with_retries(if offline { 0 } else { 2 });

    if let Some(cache_dir) = env::var_os("EMBED_MODEL_CACHE_DIR") {
        api_builder = api_builder.with_cache_dir(PathBuf::from(cache_dir));
    }

    let api = api_builder
        .build()
        .expect("failed to initialize Hugging Face Hub build client");
    let repo = Repo::with_revision(
        MODEL_REPO_ID.to_string(),
        RepoType::Model,
        MODEL_REVISION.to_string(),
    );
    let api_repo = api.repo(repo);

    for (file_name, expected_sha256) in MODEL_FILES {
        let cached_path = api_repo.get(file_name).unwrap_or_else(|err| {
            let mode = if offline { "offline/cached" } else { "online" };
            panic!(
                "failed to fetch embedding model file {file_name} from {MODEL_REPO_ID}@{MODEL_REVISION} during {mode} build: {err}"
            );
        });

        verify_sha256(&cached_path, expected_sha256);

        let dest = model_out_dir.join(file_name);
        fs::copy(&cached_path, &dest).unwrap_or_else(|err| {
            panic!(
                "failed to copy embedding model file {} from {} to {}: {}",
                file_name,
                cached_path.display(),
                dest.display(),
                err
            )
        });
        println!("cargo:rerun-if-changed={}", dest.display());
    }
}

fn env_truthy(name: &str) -> bool {
    matches!(
        env::var(name).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES") | Ok("on") | Ok("ON")
    )
}

fn verify_sha256(path: &Path, expected_sha256: &str) {
    let mut file = fs::File::open(path)
        .unwrap_or_else(|err| panic!("failed to open {} for hashing: {}", path.display(), err));
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];

    loop {
        let n = file
            .read(&mut buf)
            .unwrap_or_else(|err| panic!("failed to read {} for hashing: {}", path.display(), err));
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    let actual = hex::encode(hasher.finalize());
    if actual != expected_sha256 {
        panic!(
            "SHA-256 mismatch for {}: expected {}, got {}",
            path.display(),
            expected_sha256,
            actual
        );
    }
}
