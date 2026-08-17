//! Situation context: the one line of wearer-situation prose both transports
//! prepend to a run, built from the state the device replayed.

use cosmos_protocol::aibus as pb;

/// The situation line: device wall clock, zone, resolved place, lock state, and
/// coordinates — only what the request actually carried, in a fixed order.
pub(crate) fn situation_line(req: &pb::SynapseUnderstandingRequest) -> Option<String> {
    let situation = req
        .device_context
        .as_ref()
        .and_then(|dc| dc.situation.as_ref());
    let mut parts: Vec<String> = Vec::new();

    if let Some(s) = situation {
        if let Some(ts) = s.timestamp.as_ref() {
            // Render the device's own wall clock; the zone id is the device's too.
            let mut when = format!(
                "The wearer's current time is {} (epoch seconds)",
                ts.seconds
            );
            if !s.time_zone_id.is_empty() {
                when = format!(
                    "The wearer's current time is {} (epoch seconds) in time zone {}",
                    ts.seconds, s.time_zone_id
                );
            }
            parts.push(when);
        } else if !s.time_zone_id.is_empty() {
            parts.push(format!("The wearer's time zone is {}", s.time_zone_id));
        }
        if !s.location_string.is_empty() {
            parts.push(format!("The wearer is near {}", s.location_string));
        }
    }

    // A human-readable place the device already resolved beats raw coordinates.
    if let Some(dc) = req.device_context.as_ref() {
        if !dc.reverse_geocoded_location.is_empty() {
            parts.push(format!(
                "The wearer's location is {}",
                dc.reverse_geocoded_location
            ));
        }
        if dc.is_locked {
            parts.push("The pin is locked.".to_owned());
        }
    }
    if let Some(loc) = req.location.as_ref() {
        parts.push(format!(
            "The wearer's coordinates are {:.5}, {:.5}",
            loc.latitude, loc.longitude
        ));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(". ") + ".")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> pb::SynapseUnderstandingRequest {
        pb::SynapseUnderstandingRequest::default()
    }

    #[test]
    fn an_empty_request_contributes_no_situation_line() {
        assert_eq!(situation_line(&request()), None);
    }

    #[test]
    fn time_zone_place_lock_and_coordinates_compose_in_fixed_order() {
        let mut req = request();
        req.device_context = Some(pb::SynapseDeviceContext {
            situation: Some(pb::SynapseUserSituation {
                timestamp: Some(prost_types::Timestamp {
                    seconds: 1_700_000_000,
                    nanos: 0,
                }),
                time_zone_id: "Europe/Copenhagen".to_owned(),
                location_string: "the harbour".to_owned(),
                ..Default::default()
            }),
            reverse_geocoded_location: "Copenhagen, Denmark".to_owned(),
            is_locked: true,
            ..Default::default()
        });
        req.location = Some(pb::Location {
            latitude: 55.676_1,
            longitude: 12.568_3,
        });

        let line = situation_line(&req).expect("a populated request yields a line");
        // The doubled period after the lock sentence is the behavior both
        // transports shipped (the part carries its own full stop and the join
        // adds another); the fixture pins what IS, so the extraction cannot
        // change what the model reads.
        assert_eq!(
            line,
            "The wearer's current time is 1700000000 (epoch seconds) in time zone \
             Europe/Copenhagen. The wearer is near the harbour. The wearer's location is \
             Copenhagen, Denmark. The pin is locked.. The wearer's coordinates are \
             55.67610, 12.56830."
        );
    }

    #[test]
    fn a_zone_without_a_clock_still_reads_as_a_zone() {
        let mut req = request();
        req.device_context = Some(pb::SynapseDeviceContext {
            situation: Some(pb::SynapseUserSituation {
                time_zone_id: "UTC".to_owned(),
                ..Default::default()
            }),
            ..Default::default()
        });
        assert_eq!(
            situation_line(&req).as_deref(),
            Some("The wearer's time zone is UTC.")
        );
    }
}
