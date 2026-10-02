//! Generated gRPC bindings for the Cosmos-compatible wire contract.
//!
//! The `.proto` sources under `contracts/wire/` are independently authored interface
//! reconstructions, the service, method, message, and field-number contracts
//! required for wire interoperability. They are not copied from any private
//! source. Payload encryption is implemented separately by the `cosmos-crypto`
//! crate.

#![allow(clippy::all)]

/// Shared message packages (`humane.common` + `humane.common.*`).
pub mod common {
    tonic::include_proto!("humane.common");
    pub mod auth {
        tonic::include_proto!("humane.common.auth");
    }
    pub mod encryption {
        tonic::include_proto!("humane.common.encryption");
    }
    pub mod food {
        tonic::include_proto!("humane.common.food");
    }
    pub mod push {
        tonic::include_proto!("humane.common.push");
    }
}

/// Feature-flag distribution (`humane.featureflags`).
pub mod featureflags {
    tonic::include_proto!("humane.featureflags");
}

/// Device onboarding / provisioning (`humane.provisioning`).
pub mod provisioning {
    tonic::include_proto!("humane.provisioning");
}

/// Account services (`humane.account`).
pub mod account {
    tonic::include_proto!("humane.account");
}

/// Contacts (`humane.contacts`).
pub mod contacts {
    tonic::include_proto!("humane.contacts");
}

/// Notable events (`humane.events`).
pub mod events {
    tonic::include_proto!("humane.events");
}

/// Capture / memories (`humane.capture`).
pub mod capture {
    tonic::include_proto!("humane.capture");
}

/// Partner tokens (`humane.partnerservices`).
pub mod partnerservices {
    tonic::include_proto!("humane.partnerservices");
}

/// Push relay (`humane.pushrelay`).
pub mod pushrelay {
    tonic::include_proto!("humane.pushrelay");
}

/// AI-bus: the assistant + supporting services (`humane.aibus`).
pub mod aibus {
    tonic::include_proto!("humane.aibus");
}

/// Location (`humane.location.v1`).
pub mod location {
    pub mod v1 {
        tonic::include_proto!("humane.location.v1");
    }
}

/// Krypton key-management message contracts (`humane.krypton.grpc.*`).
pub mod krypton {
    pub mod grpc {
        pub mod auth {
            tonic::include_proto!("humane.krypton.grpc.auth");
        }
        pub mod key {
            tonic::include_proto!("humane.krypton.grpc.key");
        }
        pub mod crypto {
            tonic::include_proto!("humane.krypton.grpc.crypto");
        }
    }
}

/// Personal-data payload types (`humane.personaldata`).
pub mod personaldata {
    tonic::include_proto!("humane.personaldata");
}

/// Privacy / ephemeral-key lifecycle (`humane.privacy.grpc.*`).
pub mod privacy {
    pub mod grpc {
        pub mod common {
            tonic::include_proto!("humane.privacy.grpc.common");
        }
        // `pub` is the proto package's last segment and a Rust keyword. Prost
        // escapes it as `r#pub` in the generated module AND file name. The wire
        // service path stays `humane.privacy.grpc.pub.PublicPrivacyService`.
        pub mod r#pub {
            tonic::include_proto!("humane.privacy.grpc.r#pub");
        }
    }
}

#[cfg(test)]
mod wire_fidelity_tests {
    //! Decode bytes shaped the way the DEVICE emits them.
    //!
    //! These crates had no tests at all, which is how a field could be declared
    //! with the wrong scalar type and never be noticed: our own encoder and
    //! decoder agreed with each other, and nothing ever asked whether they
    //! agreed with the Pin. Each test below hand-writes the wire bytes rather
    //! than round-tripping our own types, so a wrong declaration cannot pass.

    use prost::Message as _;

    /// RUNTIME guard: a device-shaped `LocationEnvelope` must DECODE.
    ///
    /// Deliberately does not touch the field, so it stays compilable whatever the
    /// declaration says, which makes it genuinely falsifiable at run time. With
    /// `stalestatus` declared `bytes`, field 5 arrives as a varint (wire type 0)
    /// where prost expects length-delimited (wire type 2) and the WHOLE message
    /// fails to decode. The assistant path swallowed that error, so every
    /// encrypted turn silently lost the wearer's location.
    /// `QuickActionRouter.java:165-166` is the device builder.
    #[test]
    fn a_location_envelope_from_the_device_decodes_at_all() {
        // field 5, wire type 0 (varint) -> tag 0x28. Value 2 = NOT_STALE.
        let on_the_wire = [0x28u8, 0x02];
        assert!(
            crate::common::encryption::LocationEnvelope::decode(&on_the_wire[..]).is_ok(),
            "the device sends stalestatus as a varint enum; a `bytes` declaration \
             fails the whole LocationEnvelope decode and the wearer's location \
             vanishes from the turn with no error anywhere",
        );
    }

    /// RUNTIME guard for the bool, same reasoning.
    /// `NotificationSummarizer.java:275,279` calls `setSingleSender(true/false)`.
    #[test]
    fn a_conversation_summarization_request_from_the_device_decodes_at_all() {
        // field 2, wire type 0 (varint) -> tag 0x10. Value 1 = true.
        let on_the_wire = [0x10u8, 0x01];
        assert!(
            crate::aibus::ConversationSummarizationRequest::decode(&on_the_wire[..]).is_ok(),
            "the device sends singlesender as a bool varint; `bytes` fails the decode",
        );
    }

    /// COMPILE-TIME pin on the declared types. These comparisons only typecheck
    /// while the fields are the enum and the bool the device actually sends, so
    /// reverting either declaration breaks the build rather than going red.
    /// `LocationEnvelope.stalestatus` is an ENUM on the wire.
    ///
    /// `QuickActionRouter.java:165-166` builds it with
    /// `setStaleStatus(LocationStaleStatus)`, so field 5 arrives as a varint
    /// (wire type 0). Declared as `bytes`, prost expects a length-delimited
    /// field (wire type 2) and fails the WHOLE message decode, which the
    /// assistant path swallowed, so every encrypted turn silently lost the
    /// wearer's location.
    #[test]
    fn a_location_envelope_from_the_device_decodes_with_its_stale_status() {
        // field 5, wire type 0 (varint) -> tag 0x28. Value 2 = NOT_STALE.
        let on_the_wire = [0x28u8, 0x02];

        let envelope = crate::common::encryption::LocationEnvelope::decode(&on_the_wire[..])
            .expect(
                "the device sends stalestatus as a varint enum; a `bytes` \
                 declaration fails the whole LocationEnvelope decode and the \
                 wearer's location vanishes from the turn",
            );
        assert_eq!(
            envelope.stalestatus,
            crate::common::encryption::LocationStaleStatus::NotStale as i32,
        );
    }

    /// `ConversationSummarizationRequest.singlesender` is a BOOL on the wire.
    ///
    /// `NotificationSummarizer.java:275,279` calls `setSingleSender(true/false)`,
    /// so field 2 arrives as a varint. `bytes` fails the decode outright.
    #[test]
    fn a_conversation_summarization_request_from_the_device_decodes_its_bool() {
        // field 2, wire type 0 (varint) -> tag 0x10. Value 1 = true.
        let on_the_wire = [0x10u8, 0x01];

        let request = crate::aibus::ConversationSummarizationRequest::decode(&on_the_wire[..])
            .expect("the device sends singlesender as a bool varint");
        assert!(request.singlesender);
    }

    // ---------------------------------------------------------------------
    // Scalar types recovered from the device's own `newMessageInfo` field
    // descriptors. Every assertion below is written so it typechecks under the
    // OLD declaration too, reverting a `.proto` line must turn the test RED at
    // run time, not break the build (a build break means the test never ran and
    // proves nothing).
    // ---------------------------------------------------------------------

    /// `AnalyzeImageRequest.if_then` is a `map<string, string>`, not `bytes`.
    ///
    /// `AnalyzeImageRequest.java:645-646` puts `IfThenDefaultEntryHolder.
    /// defaultEntry` at field 6 with descriptor char '2' (`FieldType.MAP` = 50),
    /// and `AnalyzeImageRequest.java:237` pins the entry to
    /// `MapEntryLite.newDefaultInstance(STRING, "", STRING, "")`. The device
    /// populates this under VISION_ACTIONS_ENABLED, a flag we control.
    ///
    /// A `bytes` declaration is the quiet kind of wrong: each map entry is
    /// length-delimited, so the decode SUCCEEDS and the singular field keeps
    /// only the last entry's raw bytes. Every earlier if/then pair disappears
    /// with no error anywhere.
    #[test]
    fn an_analyze_image_request_from_the_device_decodes_its_if_then_map() {
        // field 6, wire type 2 -> tag 0x32. Two entries, each `key(1) value(2)`.
        let on_the_wire = [
            0x32, 0x06, 0x0A, 0x01, b'a', 0x12, 0x01, b'b', // "a" -> "b"
            0x32, 0x06, 0x0A, 0x01, b'c', 0x12, 0x01, b'd', // "c" -> "d"
        ];

        let request = crate::aibus::AnalyzeImageRequest::decode(&on_the_wire[..])
            .expect("the device sends if_then as a string->string map");
        assert_eq!(
            request.if_then.len(),
            2,
            "both if/then pairs must survive; a `bytes` declaration silently \
             keeps only the last entry's raw bytes",
        );
        let seen = format!("{:?}", request.if_then);
        assert!(
            seen.contains("\"a\": \"b\"") && seen.contains("\"c\": \"d\""),
            "if_then decoded as {seen}, not the device's string->string pairs",
        );
    }

    /// `ContactList.encrypted_contacts_versions` is PACKED int32.
    ///
    /// `ContactList.java:529` gives field 3 the descriptor char `'\''`
    /// (`FieldType.INT32_LIST_PACKED` = 39). Modelled as
    /// `repeated google.protobuf.Int32Value` the framings collide, both are
    /// length-delimited, so contact-version sync fails in both directions:
    /// the device's packed blob is parsed as a wrapper message (field number 0,
    /// invalid) and the WHOLE ContactList decode fails.
    #[test]
    fn a_contact_list_from_the_device_decodes_its_packed_versions() {
        // field 3, wire type 2 -> tag 0x1A; 3 bytes of packed varints.
        let on_the_wire = [0x1Au8, 0x03, 0x07, 0x09, 0x0B];

        let list = crate::contacts::ContactList::decode(&on_the_wire[..])
            .expect("the device sends encrypted_contacts_versions packed");
        assert_eq!(list.encrypted_contacts_versions, vec![7, 9, 11]);
    }

    /// Same packed int32 on the delta-sync response.
    /// `GetContactDeltasResponse.java:710` gives field 4 the char `'\''` (39).
    #[test]
    fn a_contact_deltas_response_from_the_device_decodes_its_packed_versions() {
        // field 4, wire type 2 -> tag 0x22.
        let on_the_wire = [0x22u8, 0x02, 0x04, 0x05];

        let response = crate::contacts::GetContactDeltasResponse::decode(&on_the_wire[..])
            .expect("the device sends encrypted_contacts_versions packed");
        assert_eq!(response.encrypted_contacts_versions, vec![4, 5]);
    }

    /// `CameraIntrinsics.distortion` is PACKED float.
    /// `CameraIntrinsics.java:518` gives field 5 the char '$'
    /// (`FieldType.FLOAT_LIST_PACKED` = 36).
    #[test]
    fn camera_intrinsics_from_the_device_decode_their_packed_distortion() {
        // field 5, wire type 2 -> tag 0x2A; 8 bytes = two little-endian f32.
        let on_the_wire = [
            0x2Au8, 0x08, //
            0x00, 0x00, 0x00, 0x3F, // 0.5
            0x00, 0x00, 0x80, 0xBE, // -0.25
        ];

        let intrinsics = crate::capture::CameraIntrinsics::decode(&on_the_wire[..])
            .expect("the device sends distortion as packed floats");
        assert_eq!(intrinsics.distortion, vec![0.5f32, -0.25f32]);
    }

    /// `FloatMatrix.data` is PACKED float.
    /// `FloatMatrix.java:289` gives field 3 the char '$' (36).
    #[test]
    fn a_float_matrix_from_the_device_decodes_its_packed_data() {
        // field 3, wire type 2 -> tag 0x1A.
        let on_the_wire = [0x1Au8, 0x04, 0x00, 0x00, 0x80, 0x3F]; // 1.0

        let matrix = crate::capture::FloatMatrix::decode(&on_the_wire[..])
            .expect("the device sends FloatMatrix.data as packed floats");
        assert_eq!(matrix.data, vec![1.0f32]);
    }

    /// `ImageMetadata.strides` is PACKED uint32.
    /// `ImageMetadata.java:978` gives field 7 the char '+'
    /// (`FieldType.UINT32_LIST_PACKED` = 43). Compared through `Debug` so the
    /// assertion still typechecks against the old `Vec<i32>` declaration.
    #[test]
    fn image_metadata_from_the_device_decodes_its_packed_strides() {
        // field 7, wire type 2 -> tag 0x3A. Varints for 1920 and 960.
        let on_the_wire = [0x3Au8, 0x04, 0x80, 0x0F, 0xC0, 0x07];

        let metadata = crate::capture::ImageMetadata::decode(&on_the_wire[..])
            .expect("the device sends strides as packed varints");
        assert_eq!(format!("{:?}", metadata.strides), "[1920, 960]");
    }

    /// `PushMessageResponse.subscribedexperiencestatuses` is a REPEATED
    /// `SubscribedExperienceStatus`, which is what that message is declared for.
    ///
    /// `PushMessageResponse.java:488-489` names `SubscribedExperienceStatus.
    /// class` for field 2 with the char 0x1b (`FieldType.MESSAGE_LIST` = 27).
    /// As `bytes` the decode succeeds and silently collapses the whole list to
    /// the last element's raw bytes, so a token-rotation signal is lost.
    #[test]
    fn a_push_message_response_from_the_device_decodes_its_status_list() {
        // field 2, wire type 2 -> tag 0x12. Two SubscribedExperienceStatus.
        let on_the_wire = [
            0x12, 0x05, 0x0A, 0x01, b'a', 0x10, 0x01, // {"a", rotate=true}
            0x12, 0x05, 0x0A, 0x01, b'b', 0x10, 0x00, // {"b", rotate=false}
        ];

        let response = crate::pushrelay::PushMessageResponse::decode(&on_the_wire[..])
            .expect("the device sends subscribedexperiencestatuses as messages");
        assert_eq!(
            response.subscribedexperiencestatuses.len(),
            2,
            "both statuses must survive; a `bytes` declaration keeps only the \
             last element's raw bytes and the rotate-token signal is lost",
        );
        let seen = format!("{:?}", response.subscribedexperiencestatuses);
        assert!(
            seen.contains("rotate_token: true") && seen.contains("rotate_token: false"),
            "subscribedexperiencestatuses decoded as {seen}",
        );
    }

    /// `RunState.agent_to_runs` is a `map<string, Runs>`, not `bytes`.
    ///
    /// The one divergence in `contracts/wire-divergence.json` that the SECOND
    /// wire tree (`pin/runtime/core/proto`) got right and this one got wrong:
    /// `bytes` was this tree's placeholder for a type the reconstruction could
    /// not resolve, and `humane.aibus.RunState.agent_to_runs (1)` is named for
    /// exactly what the sibling `Runs` message holds.
    ///
    /// Two entries, not one, and that is the whole point of the test. Each map
    /// entry is length-delimited, so a `bytes` declaration DECODES this without
    /// error and keeps only the last entry's raw bytes, a single-agent seed
    /// passes under both declarations and proves nothing. Every earlier agent's
    /// runs disappear with no error anywhere.
    #[test]
    fn a_run_state_seed_decodes_every_agent_not_just_the_last() {
        // field 1, wire type 2 -> tag 0x0A. Two entries, each `key(1) value(2)`,
        // with an empty `Runs` value so the bytes stay legible.
        let on_the_wire = [
            0x0A, 0x05, 0x0A, 0x01, b'a', 0x12, 0x00, // "a" -> Runs{}
            0x0A, 0x05, 0x0A, 0x01, b'b', 0x12, 0x00, // "b" -> Runs{}
        ];

        let state = crate::aibus::RunState::decode(&on_the_wire[..])
            .expect("the device seeds agent_to_runs as a string->Runs map");
        assert_eq!(
            state.agent_to_runs.len(),
            2,
            "both agents must survive; a `bytes` declaration silently keeps only \
             the last entry's raw bytes and every other agent's runs are gone",
        );
    }

    /// `OrientationInfo.horizon_angle` is SINT32 (zigzag), not int32.
    /// `OrientationInfo.java:164` gives field 1 the char 0x0f
    /// (`FieldType.SINT32` = 15). Read as plain int32 a negative tilt decodes
    /// as a positive one, so the horizon comes back mirrored.
    #[test]
    fn orientation_info_from_the_device_decodes_a_negative_angle() {
        // field 1, wire type 0 -> tag 0x08. Zigzag(-7) = 13.
        let on_the_wire = [0x08u8, 0x0D];

        let orientation = crate::capture::OrientationInfo::decode(&on_the_wire[..])
            .expect("horizon_angle is a varint either way");
        assert_eq!(
            orientation.horizon_angle, -7,
            "the device zigzag-encodes horizon_angle; a plain int32 declaration \
             turns every negative tilt into its positive mirror",
        );
    }
}
