//! Behavior genuinely shared by the two assistant transports.
//!
//! `engine.rs` (the request/stream `Understand` loop) and `bidi.rs` (the
//! bidirectional session) are DIFFERENT state machines and stay that way, one
//! issues a fresh RPC per hop and replays history, the other holds one stream
//! open and pauses on device actions. What lives here is only what the two had
//! copied verbatim: turn-frame construction, situation context, speakable-text
//! selection, and the bounded model-facing observation.
//!
//! Deliberately NOT here, because the transports disagree on purpose:
//!
//!   * `bounded_tool` / run budgets, the legacy engine reserves an answer
//!     window inside the tool budget and speaks a different timeout string. The
//!     bidirectional session bounds the remaining run directly.
//!   * `build_history`, the legacy engine enforces `CONTEXT_CAPACITY` over the
//!     replayed turns. The bidirectional session replays what it was handed.
//!   * `resolve_catalog`, same catalog call, but the entitlement input is a
//!     transport concern (`subscribed: bool` vs `&Entitlement`).
//!
//! Each move carried its fixture with it (the `tests` modules below), so the
//! extraction is pinned by the same cases the two copies answered before.

pub(super) mod context;
pub(super) mod frames;
pub(super) mod text;
