//! Remote Center security boundary.
//!
//! The remote transport must terminate authentication before calling this
//! module and dispatch the returned typed operation in-process. It must never
//! forward the caller's raw target to the Server's loopback listener: doing so
//! would turn a remote request into a loopback request and could bypass
//! device-local peer checks.

// The policy engine ships ahead of its full consumer: the connector's request
// path currently performs the core `authorize` check, while the replay-safe
// idempotency ledger and capability-scoped reservation machinery are staged for
// the next step of wiring. Keep them compiled and unit-tested without a
// dead-code wall until that path lands (mirrors the staged `nlu` module).
pub mod iroh_connector;
#[allow(dead_code)]
pub mod policy;
pub mod system_dns;
