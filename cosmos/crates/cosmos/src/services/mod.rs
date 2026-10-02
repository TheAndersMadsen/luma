//! gRPC service handlers for the Cosmos-compatible workloads.
//!
//! Each workload deployment exposes only its own services; `cosmos::run`
//! selects them by `Workload`. Handlers share the [`RequestAuthenticator`]
//! auth seam and the deployment's message-size limits.

pub mod account;
pub mod aibus_extra;
pub mod aibus_main;
pub mod capture;
pub mod contacts;
pub mod device_block;
pub mod events;
pub mod feature_flags;
pub mod gates;
pub mod location;
pub mod partnerservices;
pub mod provisioning;
pub mod public_privacy;
pub mod pushrelay;

use cosmos_protocol::featureflags::feature_flags_service_server::FeatureFlagsServiceServer;
use cosmos_protocol::provisioning::device_onboarding_dac_service_server::DeviceOnboardingDacServiceServer;

use crate::{auth::RequestAuthenticator, config::Limits};
use feature_flags::FeatureFlags;
use provisioning::Provisioning;

/// Builds the feature-flags gRPC service over the store holding each account's
/// Settings → Features choices, with this deployment's message-size limits.
pub fn feature_flags(
    authenticator: RequestAuthenticator,
    limits: &Limits,
    store: crate::store::SharedStore,
) -> FeatureFlagsServiceServer<FeatureFlags> {
    FeatureFlagsServiceServer::new(FeatureFlags::new(authenticator, store))
        .max_decoding_message_size(limits.max_decode_bytes)
        .max_encoding_message_size(limits.max_encode_bytes)
}

/// Builds the device-onboarding (provisioning) gRPC service.
pub fn provisioning(
    limits: &Limits,
    store: crate::store::SharedStore,
) -> DeviceOnboardingDacServiceServer<Provisioning> {
    DeviceOnboardingDacServiceServer::new(Provisioning::with_account_store(
        crate::enrollment::Enrollment::from_env(),
        store,
    ))
    .max_decoding_message_size(limits.max_decode_bytes)
    .max_encoding_message_size(limits.max_encode_bytes)
}
