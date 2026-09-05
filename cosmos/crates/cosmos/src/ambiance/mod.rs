//! Runtime authority. All transitions execute under the principal ledger lock.
pub mod analysis;
pub mod changes;
pub mod disclosure;
pub mod echo;
pub mod ledger;
pub mod pin_connection;
pub mod pin_media;
pub mod policy;
pub mod realtime;
pub mod runtime;
pub mod speech;
pub mod state;
pub mod stock;
pub use pin_connection::{PinConnection, PinProof};
pub use policy::{Channel, PrivacyClass, SemanticIntent};
pub use state::*;

#[cfg(test)]
mod ingress_tests;
