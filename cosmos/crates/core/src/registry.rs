//! Clean-room inventory of the device-visible gRPC method names.
//!
//! The registry separates two claims for every method:
//!
//! * `evidence` describes the stock-facing name/cardinality evidence.
//! * `implementation` describes whether this source tree contains a concrete
//!   handler. It does not claim Humane's hidden implementation or a successful
//!   physical-device acceptance run.
//!
//! `handler_source` makes the implementation claim auditable and is held to an
//! existing source file by the tests below. This turns the table into the
//! 22-service/98-RPC source evidence manifest instead of a path list whose
//! implementation column was permanently stale.

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Priority {
    P0,
    P1,
    P2,
    P3,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum EvidenceGrade {
    Observed,
    Derived,
    Implemented,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ImplementationState {
    Unimplemented,
    Partial,
    Implemented,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Cardinality {
    Unknown,
    Unary,
    ServerStreaming,
    BidirectionalStreaming,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MethodDescriptor {
    pub service: &'static str,
    pub method: &'static str,
    pub path: &'static str,
    pub priority: Priority,
    pub evidence: EvidenceGrade,
    pub implementation: ImplementationState,
    pub cardinality: Cardinality,
    pub handler_source: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServiceDescriptor {
    pub name: &'static str,
    pub methods: &'static [MethodDescriptor],
}

macro_rules! method_cardinality {
    () => {
        Cardinality::Unknown
    };
    ($cardinality:ident) => {
        Cardinality::$cardinality
    };
}

macro_rules! service {
    ($service:literal, $handler_source:literal; $(($method:literal, $priority:ident $(, $cardinality:ident)?)),+ $(,)?) => {
        ServiceDescriptor {
            name: $service,
            methods: &[
                $(MethodDescriptor {
                    service: $service,
                    method: $method,
                    path: concat!("/", $service, "/", $method),
                    priority: Priority::$priority,
                    evidence: EvidenceGrade::Derived,
                    implementation: ImplementationState::Implemented,
                    cardinality: method_cardinality!($($cardinality)?),
                    handler_source: $handler_source,
                }),+
            ],
        }
    };
}

pub const SERVICES: &[ServiceDescriptor] = &[
    service!("humane.account.FoodPreferencesService", "cosmos/crates/cosmos/src/services/account.rs";
        ("EncryptedGetFoodRestrictions", P2),
        ("EncryptedSetFoodRestrictions", P2),
        ("GetUserDailyIntakeGoals", P2),
        ("SetUserDailyIntakeGoals", P2),
    ),
    service!("humane.account.UserInformationService", "cosmos/crates/cosmos/src/services/account.rs";
        ("GetUserPersonalDetails", P0),
    ),
    service!("humane.account.WifiConfigService", "cosmos/crates/cosmos/src/services/account.rs";
        ("ListSecureWifiConfigs", P1),
    ),
    service!("humane.aibus.AIBusService", "cosmos/crates/cosmos/src/services/aibus_main.rs";
        ("ActionExecutionTest", P3),
        ("AnalyzeImage", P1),
        ("BidirectionalStreamingUnderstand", P0),
        ("EncryptedActionBasedInterstitial", P0),
        ("EncryptedAnalyzeFoodImage", P2),
        ("EncryptedAnalyzeImage", P1),
        ("EncryptedChatCompletion", P0),
        ("EncryptedCompletion", P0),
        ("EncryptedFunctionExecution", P0),
        ("EncryptedGeoLocate", P1),
        ("EncryptedGetFoodItem", P2),
        ("EncryptedLoadingMessage", P0),
        ("EncryptedNavigationDirections", P1),
        ("EncryptedNearbySearch", P1),
        ("EncryptedReverseGeocode", P1),
        ("EncryptedSmartPlaylist", P1),
        ("EncryptedStreamAIBus", P0),
        ("EncryptedUnderstand", P0),
        ("EncryptedWeather", P1),
        ("FunctionExecution", P0),
        ("ServerStatefulUnderstand", P0),
        ("TranscriptionRepairTest", P3),
        ("Translate", P1),
        ("Understand", P0),
        ("UploadFile", P1),
    ),
    service!("humane.aibus.AmazonShoppingService", "cosmos/crates/cosmos/src/services/aibus_extra.rs";
        ("VisualSearch", P2),
    ),
    service!("humane.aibus.CompositionService", "cosmos/crates/cosmos/src/services/aibus_extra.rs";
        ("CategorizeNotifications", P1),
        ("EncryptedComposeMessage", P1),
        ("EncryptedSummarizeMessages", P1),
        ("SummarizeNotifications", P1),
    ),
    service!("humane.aibus.DeviceMessagesService", "cosmos/crates/cosmos/src/services/aibus_extra.rs";
        ("BackupMessages", P1),
        ("QueryMessages", P1),
        ("UploadAttachment", P1),
    ),
    service!("humane.aibus.FoodService", "cosmos/crates/cosmos/src/services/aibus_extra.rs";
        ("EncryptedIdentifyFood", P2),
        ("Feedback", P2),
    ),
    service!("humane.aibus.SpeechService", "cosmos/crates/cosmos/src/services/aibus_extra.rs";
        ("CanTranslate", P1),
        ("StreamingTextToSpeech", P0, ServerStreaming),
        ("TextToSpeech", P0, Unary),
        ("TranslateConversation", P1, BidirectionalStreaming),
        ("TranslateText", P1),
    ),
    service!("humane.aibus.TestAutomationService", "cosmos/crates/cosmos/src/services/aibus_extra.rs";
        ("createNewCalendarEvents", P3),
        ("deleteAllCalendarEvents", P3),
        ("getCalendarEvents", P3),
        ("initializeCalendar", P3),
    ),
    service!("humane.aibus.WebSearchService", "cosmos/crates/cosmos/src/services/aibus_extra.rs";
        ("search", P1),
    ),
    service!("humane.capture.CaptureService", "cosmos/crates/cosmos/src/services/capture/mod.rs";
        ("CreateMemory", P1),
        ("DeclareMemoryCreateIntent", P1),
        ("DeleteMemory", P1),
        ("GetCaptureConfig", P1),
        ("GetFoodLogSummary", P2),
        ("GetMemoryShareLink", P2),
        ("GetShareLinkContents", P2),
        ("ReportPhotographyExperienceStatus", P2),
        ("SaveSharedMemory", P2),
        ("UploadComplete", P1),
        ("UploadFile", P1),
    ),
    service!("humane.capture.TestingAutomationService", "cosmos/crates/cosmos/src/services/capture/mod.rs";
        ("CreateNote", P3),
        ("DeleteAllNotes", P3),
        ("DeleteMemory", P3),
        ("GetRecentNotes", P3),
    ),
    service!("humane.contacts.ContactsRPCService", "cosmos/crates/cosmos/src/services/contacts.rs";
        ("CreateContacts", P1),
        ("DeleteContacts", P1),
        ("GetContactDeltas", P0),
        ("GetContacts", P0),
        ("GetContactsPaginatedStreaming", P0),
        ("GetContactsStreaming", P0),
        ("UpdateContacts", P1),
    ),
    service!("humane.events.DeviceEventsHistoryService", "cosmos/crates/cosmos/src/services/events.rs";
        ("QueryEvents", P1),
    ),
    service!("humane.events.EventsIngestService", "cosmos/crates/cosmos/src/services/events.rs";
        ("IngestBatch", P1),
        ("Ingest", P1),
    ),
    service!("humane.featureflags.FeatureFlagsService", "cosmos/crates/cosmos/src/services/feature_flags.rs";
        ("GetFlags", P0),
    ),
    service!("humane.location.v1.E911GeoLocationService", "cosmos/crates/cosmos/src/services/location.rs";
        ("GeoLocate", P1),
    ),
    service!("humane.partnerservices.PartnerTokenRPCService", "cosmos/crates/cosmos/src/services/partnerservices.rs";
        ("GetToken", P1),
        ("GetTokens", P1),
    ),
    service!("humane.provisioning.DeviceOnboardingDACService", "cosmos/crates/cosmos/src/services/provisioning.rs";
        ("CreateDeviceUserBinding", P0),
        ("CreateLoginFinish", P0),
        ("CreateLoginInit", P0),
        ("GetAssignedUserDAC", P0),
        ("GetSubscriptionStatus", P0),
        ("VerifyHmcAssociation", P0),
        ("VerifyHmcByPass", P0),
    ),
    service!("humane.pushrelay.PushRelayService", "cosmos/crates/cosmos/src/services/pushrelay.rs";
        ("GetPushTokens", P1, Unary),
        ("Subscribe", P1, BidirectionalStreaming),
    ),
    service!("humane.privacy.grpc.pub.PublicPrivacyService", "cosmos/crates/cosmos/src/services/public_privacy.rs";
        ("EstablishWrappingKeys", P0, Unary),
        ("GetConfiguration", P1, Unary),
        ("GetSettings", P1, Unary),
        ("ImportKeys", P0, Unary),
        ("RemoveKeys", P1, Unary),
        ("RequestKeys", P1, Unary),
        ("SyncKeys", P0, Unary),
        ("UpdateKeys", P1, Unary),
        ("UpdateSettings", P1, Unary),
    ),
];

pub fn method(path: &str) -> Option<&'static MethodDescriptor> {
    SERVICES
        .iter()
        .flat_map(|service| service.methods)
        .find(|method| method.path == path)
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;

    #[test]
    fn registry_has_twenty_two_services_and_ninety_eight_unique_paths() {
        assert_eq!(SERVICES.len(), 22);

        let service_names = SERVICES
            .iter()
            .map(|service| service.name)
            .collect::<HashSet<_>>();
        assert_eq!(service_names.len(), 22);

        let methods = SERVICES
            .iter()
            .flat_map(|service| service.methods)
            .collect::<Vec<_>>();
        assert_eq!(methods.len(), 98);
        assert_eq!(
            methods
                .iter()
                .map(|method| method.path)
                .collect::<HashSet<_>>()
                .len(),
            98
        );
        assert!(
            methods
                .iter()
                .all(|method| { method.path == format!("/{}/{}", method.service, method.method) })
        );
    }

    #[test]
    fn registry_preserves_priority_counts_and_audits_every_handler_source() {
        let mut priorities = HashMap::new();
        for method in SERVICES.iter().flat_map(|service| service.methods) {
            *priorities.entry(method.priority).or_insert(0) += 1;
            assert_eq!(method.evidence, EvidenceGrade::Derived);
            assert_eq!(method.implementation, ImplementationState::Implemented);

            let relative = method
                .handler_source
                .strip_prefix("cosmos/crates/core/")
                .unwrap_or(method.handler_source);
            let workspace_relative = relative
                .strip_prefix("cosmos/")
                .expect("handler source stays inside the Cosmos workspace");
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(workspace_relative);
            assert!(
                path.is_file(),
                "{} claims a missing handler source: {}",
                method.path,
                method.handler_source,
            );
        }

        assert_eq!(priorities.get(&Priority::P0), Some(&29));
        assert_eq!(priorities.get(&Priority::P1), Some(&45));
        assert_eq!(priorities.get(&Priority::P2), Some(&14));
        assert_eq!(priorities.get(&Priority::P3), Some(&10));
    }

    #[test]
    fn lookup_is_by_full_path_not_ambiguous_leaf_name() {
        let capture =
            method("/humane.capture.CaptureService/UploadFile").expect("capture upload method");
        let ai_bus = method("/humane.aibus.AIBusService/UploadFile").expect("AI bus upload method");

        assert_ne!(capture.service, ai_bus.service);
        assert!(method("UploadFile").is_none());
    }

    #[test]
    fn generated_stock_stub_facts_preserve_cardinality_and_method_case() {
        let unary_tts = method("/humane.aibus.SpeechService/TextToSpeech").expect("unary TTS");
        assert_eq!(unary_tts.cardinality, Cardinality::Unary);
        assert_eq!(unary_tts.evidence, EvidenceGrade::Derived);

        let streaming_tts =
            method("/humane.aibus.SpeechService/StreamingTextToSpeech").expect("streaming TTS");
        assert_eq!(streaming_tts.cardinality, Cardinality::ServerStreaming);
        assert_eq!(streaming_tts.evidence, EvidenceGrade::Derived);

        let translate = method("/humane.aibus.SpeechService/TranslateConversation")
            .expect("conversation translation");
        assert_eq!(translate.cardinality, Cardinality::BidirectionalStreaming);
        assert_eq!(translate.evidence, EvidenceGrade::Derived);

        let search =
            method("/humane.aibus.WebSearchService/search").expect("lowercase search path");
        assert_eq!(search.method, "search");
        assert_eq!(search.evidence, EvidenceGrade::Derived);
        assert_eq!(search.cardinality, Cardinality::Unknown);
        assert!(method("/humane.aibus.WebSearchService/Search").is_none());

        for calendar in [
            "createNewCalendarEvents",
            "deleteAllCalendarEvents",
            "getCalendarEvents",
            "initializeCalendar",
        ] {
            let path = format!("/humane.aibus.TestAutomationService/{calendar}");
            assert!(method(&path).is_some(), "stock lowerCamel path {path}");
            let pascal = format!("{}{}", calendar[..1].to_uppercase(), &calendar[1..]);
            let pascal = format!("/humane.aibus.TestAutomationService/{pascal}");
            assert!(method(&pascal).is_none(), "{pascal} is not a stock path");
        }

        assert_eq!(
            SERVICES
                .iter()
                .flat_map(|service| service.methods)
                .filter(|method| method.cardinality != Cardinality::Unknown)
                .count(),
            14
        );
    }
}
