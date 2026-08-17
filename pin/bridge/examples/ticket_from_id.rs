//! Build an `EndpointTicket` from a bare `EndpointId` (the Pin logs its
//! EndpointId at startup: `iroh connector initialized with node ID`).
//!
//! With the N0 discovery preset the bridge can dial the Pin by EndpointId alone
//! (n0 DNS resolves its relay/direct addresses), so an address-less ticket is
//! enough — and it stays valid as the Pin's addresses change.
//!
//!   cargo run --release --example ticket_from_id -- <endpoint-id>

use std::str::FromStr;

use iroh::{EndpointAddr, EndpointId};
use iroh_tickets::endpoint::EndpointTicket;

fn main() {
    let id_str = std::env::args()
        .nth(1)
        .expect("usage: ticket_from_id <endpoint-id>");
    let id = EndpointId::from_str(id_str.trim())
        .unwrap_or_else(|e| panic!("invalid endpoint id {id_str:?}: {e}"));
    println!("{}", EndpointTicket::new(EndpointAddr::new(id)));
}
