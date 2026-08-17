//! Compiles the independently authored Carry-compatible wire contract with tonic.

use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Use a vendored protoc so the build is hermetic — no system protoc is
    // required in CI or the slim container image. Respect an explicit PROTOC.
    if std::env::var_os("PROTOC").is_none() {
        let protoc = protoc_bin_vendored::protoc_bin_path()?;
        // SAFETY: single-threaded build script, set before any protoc use.
        unsafe {
            std::env::set_var("PROTOC", protoc);
        }
    }

    // Wire definitions are a workspace-level boundary shared by Cosmos, Center,
    // and the Pin. Keep protocol generation pointed at that one canonical copy;
    // the Cosmos image mirrors the same root layout through its named BuildKit
    // `wire_contracts` context.
    let contract_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/wire");
    let proto_names: &[&str] = &[
        "humane/common.proto",
        "humane/common/auth.proto",
        "humane/common/encryption.proto",
        "humane/common/food.proto",
        "humane/common/push.proto",
        "humane/personaldata.proto",
        "humane/krypton/grpc/crypto.proto",
        "humane/aibus.proto",
        "humane/location/v1.proto",
        "humane/krypton/grpc/auth.proto",
        "humane/krypton/grpc/key.proto",
        "humane/privacy/grpc/common.proto",
        "humane/privacy/grpc/pub.proto",
        "humane/featureflags.proto",
        "humane/provisioning.proto",
        "humane/account.proto",
        "humane/contacts.proto",
        "humane/events.proto",
        "humane/capture.proto",
        "humane/partnerservices.proto",
        "humane/pushrelay.proto",
    ];
    let protos: Vec<PathBuf> = proto_names
        .iter()
        .map(|proto| contract_root.join(proto))
        .collect();
    for proto in &protos {
        println!("cargo:rerun-if-changed={}", proto.display());
    }
    println!("cargo:rerun-if-changed={}", contract_root.display());

    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(&protos, std::slice::from_ref(&contract_root))?;
    Ok(())
}
