//! Runtime authority. All transitions execute under the principal ledger lock.
pub mod account;
pub mod action;
pub mod analysis;
pub mod changes;
pub mod continuation;
pub mod disclosure;
pub mod document;
pub mod echo;
pub mod grant;
pub mod ledger;
pub mod lookup;
pub mod native_connection;
pub mod native_voice;
pub mod note;
pub mod openrouter;
pub mod personal;
pub mod pin_connection;
pub mod pin_media;
pub mod policy;
pub mod realtime;
pub mod runtime;
pub mod screen;
pub mod speech;
pub mod state;
pub mod status;
pub mod stock;
pub mod visual;
pub mod voice;
pub use native_connection::NativeProof;
pub use pin_connection::{PinConnection, PinProof};
pub use policy::{Channel, PrivacyClass, SemanticIntent};
pub use state::*;

#[cfg(test)]
mod ingress_tests;
#[cfg(test)]
mod native_room_tests;
