use std::env;

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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Allow Gradle/Android to bake a custom version number.
    println!("cargo:rerun-if-env-changed=PENUMBRA_VERSION");
    let version =
        env::var("PENUMBRA_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=PENUMBRA_VERSION={version}");

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
        // small. Wire encoding is unchanged (in-memory representation only).
        .boxed(".humane.aibus.StreamingUnderstandRequest.content.understanding_request")
        .compile_protos(PROTO_FILES, &["proto"])?;
    Ok(())
}
