//! Standalone server for Humane AI Pin.
//!
//! Serves gRPC services and an HTTP upload endpoint on the same port.
//! gRPC requests (content-type: application/grpc) are routed to tonic;
//! HTTP PUT /upload/:uuid/:filename is handled by axum for media uploads.

mod api;
mod boot;
mod config;
mod db;
// The live eSIM socket transport is Android-only. Host builds retain the
// public bridge facade for tests and local development, so transport-only
// helpers are intentionally unreachable there.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod esim;
mod external;
mod feature_flags;
mod fitness;
#[cfg(feature = "iroh")]
mod remote_center;
mod services;
mod spotify;
mod storage;
mod tier_a;
mod util;

/// Generated protobuf/gRPC modules.
#[allow(unused)]
mod proto {
    #[allow(clippy::enum_variant_names)]
    pub mod aibus {
        tonic::include_proto!("humane.aibus");
    }
    pub mod pushrelay {
        tonic::include_proto!("humane.pushrelay");
    }
    #[allow(clippy::enum_variant_names)]
    pub mod featureflags {
        tonic::include_proto!("humane.featureflags");
    }
    pub mod account {
        tonic::include_proto!("humane.account");
    }
    #[allow(clippy::large_enum_variant)]
    pub mod contacts {
        tonic::include_proto!("humane.contacts");
    }
    pub mod events {
        tonic::include_proto!("humane.events");
    }
    #[allow(clippy::enum_variant_names)]
    pub mod provisioning {
        tonic::include_proto!("humane.provisioning");
    }
    #[allow(clippy::enum_variant_names)]
    pub mod capture {
        tonic::include_proto!("humane.capture");
    }
    pub mod partnerservices {
        tonic::include_proto!("humane.partnerservices");
    }
    pub mod common {
        pub mod encryption {
            tonic::include_proto!("humane.common.encryption");
        }
        pub mod food {
            tonic::include_proto!("humane.common.food");
        }
    }
    pub mod privacy {
        #[allow(clippy::enum_variant_names)]
        pub mod common {
            tonic::include_proto!("humane.privacy.grpc.common");
        }
        pub mod pub_ {
            tonic::include_proto!("humane.privacy.grpc.r#pub");
        }
    }
}

use std::io::Read;
#[cfg(target_os = "android")]
use std::path::Path as FsPath;
use std::path::PathBuf;

use zeroize::Zeroizing;

// ─── main ───────────────────────────────────────────────────────────

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    // Locate config file: check --config <path>, then ./config.toml, then next to binary
    let config_path = args
        .iter()
        .position(|a| a == "--config")
        .and_then(|i| args.get(i + 1).cloned())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("config.toml"));

    let database_key = if args.iter().any(|arg| arg == "--database-key-stdin") {
        let mut input = Vec::new();
        std::io::stdin().take(66).read_to_end(&mut input)?;
        if input.last() == Some(&b'\n') {
            input.pop();
        }
        let key = String::from_utf8(input)?;
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid database key received on stdin".into());
        }
        Some(Zeroizing::new(key))
    } else {
        None
    };

    #[cfg(target_os = "android")]
    if database_key.is_none() {
        return Err("Android requires a database key on stdin".into());
    }

    #[cfg(target_os = "android")]
    {
        let config_dir = config_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| FsPath::new("."));
        let tmp_dir = config_dir.join("tmp");
        std::fs::create_dir_all(&tmp_dir)?;

        // We need to set the envvar before Tokio starts
        unsafe {
            std::env::set_var("TMPDIR", &tmp_dir);
        }
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(boot::run(config_path, database_key))
}
