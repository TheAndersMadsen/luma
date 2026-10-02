//! Dev/test helper: print a valid-format `EndpointTicket` for a random,
//! unreachable endpoint (no addresses embedded).
//!
//! Useful for smoke-testing the bridge and its systemd service without a live
//! Pin: the bridge parses the ticket, binds its loopback HTTP port, and serves
//! `/__control/status`, but any actual proxy request fails to dial (the endpoint id was
//! never published). Do NOT use this as a real credential.
//!
//!   cargo run --release --example gen_ticket

use iroh::{EndpointAddr, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;

fn main() {
    let secret = SecretKey::generate();
    let addr = EndpointAddr::new(secret.public());
    println!("{}", EndpointTicket::new(addr));
}
