//! Server-side resolution of the device's `tool_set_version` pointer.
//!
//! ## The shape this mirrors
//!
//! cosmos's device does **not** ship the catalog. It sends an empty
//! `action_definitions` plus a two-field pointer — `ToolSetVersion { set_name,
//! version }` — and the server resolves that pointer to a concrete system prompt
//! and a concrete tool subset. Stock ran a **two-tier** topology on top of that:
//! a supervisor turn (`supervisor@7` on the active Understand path) that can hand
//! off to a small number of capability children, each of which selects its own
//! tool set over ChatCompletion:
//!
//! | wrapper          | tool set      |
//! |------------------|---------------|
//! | `Settings`       | `settings@3`  |
//! | `Timer`          | `timer@1`     |
//! | `Alarm`          | `alarm@1`     |
//! | `Contacts`       | `contacts@1`  |
//! | `ManageNutrition`| `food@4`      |
//!
//! All five share the inherited `Request` + `Terminal` fields. `ManageMemory` is
//! **not** a sixth set — it is a separate Supervisor action containing `Task`.
//! `music@1` was observed live as a server-only set with no shipped client
//! wrapper. The supporting evidence remains in the operator-controlled archive.
//!
//! The clone previously ignored `tool_set_version` outright and served one flat
//! set to every caller. This module makes the pointer load-bearing: which
//! capability owns which tools, and that each set carries its own short spoken-
//! style guidance, is the recovered *structure*. Everything the model reads here
//! is written by us.
//!
//! ## Why the prompts are authored in Rust and not read from `prompts/`
//!
//! `prompts/registry.json` holds 22 clean-room prompts, but (a) it covers only
//! three of the seven sets below — there is no settings/timer/alarm/contacts
//! entry — so wiring it would leave the guidance split across two authorship
//! surfaces, and (b) the runtime image does not ship that directory. The
//! guidance therefore lives here, in the crate, in our own words. The registry
//! remains the machine-checked source for the prompt text it owns.
//!
//! ## Degrading, never failing
//!
//! An unrecognized pointer must not cost the wearer their turn. Every failure to
//! resolve falls back to the default set and is reported through
//! [`Resolution`] so the caller can log it; nothing here returns an error.

use super::catalog::RESPOND_ACTION;

/// Which tools a set exposes, always **within** the deployment catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetTools {
    /// The deployment's whole catalog — the flat supervisor set.
    All,
    /// Only these names. Applied as an intersection with the deployment catalog,
    /// so a set can only ever *narrow* what is offered: naming a tool the
    /// catalog withholds (a factory reset, say) cannot smuggle it back in.
    Only(&'static [&'static str]),
}

/// A server-owned tool set: what `{set_name, version}` resolves to.
#[derive(Clone, Copy, Debug)]
pub struct ToolSet {
    pub name: &'static str,
    pub version: i32,
    /// Short spoken-style guidance appended to the base system prompt. Ours.
    pub guidance: &'static str,
    pub tools: SetTools,
}

impl ToolSet {
    /// Whether this set offers `tool`, before the deployment's own gates.
    pub fn offers(&self, tool: &str) -> bool {
        match self.tools {
            SetTools::All => true,
            SetTools::Only(names) => names.contains(&tool),
        }
    }
}

/// The pointer the active Understand path selects on stock, and this clone's
/// default whenever the device's pointer is absent or unrecognized.
pub const DEFAULT_SET_NAME: &str = "supervisor";
pub const DEFAULT_SET_VERSION: i32 = 7;

/// Every set this deployment serves. The first entry is the default.
///
/// Membership is expressed as device-action / server-tool names; each is
/// intersected with the deployment catalog at resolution time, so this table
/// cannot widen the catalog and cannot be used to re-offer a withheld action.
///
/// No capability set lists its own wrapper action (`Settings`, `Timer`,
/// `Alarm`, `Contacts`): a child that could dispatch the wrapper that invoked it
/// is a dispatch loop, and the wearer's turn burns its whole action budget
/// bouncing between the two tiers.
pub const SETS: &[ToolSet] = &[
    ToolSet {
        name: DEFAULT_SET_NAME,
        version: DEFAULT_SET_VERSION,
        // The flat set already carries the base prompt; nothing to add.
        guidance: "",
        tools: SetTools::All,
    },
    ToolSet {
        name: "settings",
        version: 3,
        guidance: "This turn handles device settings and device status only. Change or report \
                   exactly what was asked and nothing adjacent. Confirm in a few words what the \
                   pin is now set to, or report the current value. If the requested setting is \
                   not one of the available tools, say plainly that it cannot be changed from \
                   here rather than changing something else.",
        // `Settings` itself is deliberately absent, as is every other set's own
        // wrapper. `Settings` is the SUPERVISOR's hand-off action; by the time
        // the pointer reads `settings@3` the device is already inside that
        // child, so offering it here would be the child dispatching its own
        // wrapper. See `no_set_offers_its_own_wrapper`.
        tools: SetTools::Only(&[
            RESPOND_ACTION,
            "GetBatteryLevel",
            "AmIOnline",
            "ChangeQuickAction",
            "GetCurrentVolume",
            "SetVolume",
            "IncrementVolume",
            "DecrementVolume",
            "TurnOnWifi",
            "TurnOffWifi",
            "ConnectToWifi",
            "TurnOnBluetooth",
            "TurnOffBluetooth",
            "TurnOnAirplaneMode",
            "TurnOffAirplaneMode",
        ]),
    },
    ToolSet {
        name: "timer",
        version: 1,
        guidance: "This turn handles countdown timers only. Resolve the duration from what was \
                   said, and when a timer is named keep the name. Read the wearer's current time \
                   before reasoning about how long is left. Confirm the timer in a few words. \
                   Alarms are a different capability — do not set one here.",
        tools: SetTools::Only(&[
            RESPOND_ACTION,
            "SetTimer",
            "EditTimer",
            "DisplayTimer",
            "PauseTimer",
            "ResumeTimer",
            "GetCurrentTime",
        ]),
    },
    ToolSet {
        name: "alarm",
        version: 1,
        guidance: "This turn handles alarms only. Resolve the clock time and, when the wearer \
                   said one, the day or the recurring days — using only the values the tool \
                   accepts. Check the wearer's current time before deciding whether an alarm \
                   lands today or tomorrow. Confirm the alarm in a few words. Countdown timers \
                   are a different capability — do not set one here.",
        tools: SetTools::Only(&[
            RESPOND_ACTION,
            "SetAlarm",
            "DisplayAlarm",
            "GetCurrentTime",
            "WorldClock",
        ]),
    },
    ToolSet {
        name: "contacts",
        version: 1,
        guidance: "This turn handles the wearer's contacts only. Never state a name, number, or \
                   address that a tool result did not return, and never guess which person was \
                   meant when several could match — ask which one. Reading a contact back is a \
                   disclosure of private data: say only what was asked for.\n\
                   Contact lookup runs on the pin, so a match may not be visible from here; when \
                   nothing is returned, say plainly that the contact could not be read rather \
                   than that the wearer has no such contact.",
        // `SearchContact`, `DisplayContact`, and `UpdateContactTrusted` are NOT
        // here: they are absent from the pin's central `SchemaCatalog`, so the
        // device answers them "Unrecognized function name and/or arguments" and
        // the turn is wasted. They belong to the contacts experience itself.
        tools: SetTools::Only(&[RESPOND_ACTION, "CreateContact", "OpenContacts"]),
    },
    ToolSet {
        name: "food",
        version: 4,
        // Stock's `ManageNutrition` child logged and tracked what the wearer ate.
        // This deployment has no nutrition store, so the set answers nutrition
        // *questions* from real lookups and is told to say plainly that nothing
        // is being recorded — the honest shape. Silently "logging" a meal into
        // nothing would be a fabricated success.
        guidance: "This turn handles food and nutrition questions. Answer from what the lookup \
                   tools actually returned, keeping serving size and units attached to any \
                   number, and say when a figure is an approximation. Do not give medical or \
                   allergy advice. Nothing is being recorded: this deployment keeps no food \
                   diary, so if the wearer asks for a meal to be logged or tracked, say that \
                   plainly instead of confirming it.",
        tools: SetTools::Only(&[RESPOND_ACTION, "ask_online", "wikipedia", "web_search"]),
    },
    ToolSet {
        name: "music",
        version: 1,
        // Observed live as a server-only set (it accepted an exact canary through
        // ChatCompletion) with no shipped client wrapper. Its recovered *content*
        // is a single-transform, low-to-moderate-confidence candidate and is
        // deliberately not used: the tools below come from our own recovered
        // device-action interface and the wording is ours.
        guidance: "This turn handles music playback only. For viral, trending, newest, \
                   underrated, similar-to, mood, or situation requests, call music_discover \
                   once; it verifies the choice against the active provider. Resolve ordinary \
                   requests to the narrowest thing that fits — a track, artist, album, or genre — and \
                   ask which was meant when it genuinely matters. Do not say playback started \
                   unless the result says so; if the exact item is unavailable, name what is \
                   playing instead.",
        tools: SetTools::Only(&[
            RESPOND_ACTION,
            "music_discover",
            "PlayMusic",
            "PauseMusic",
            "ResumeMusic",
            "NextTrack",
            "PreviousTrack",
            "RestartTrack",
            "GetMusicQueue",
            "SaveCurrentTrackToFavorites",
            "PlayFavoriteTracks",
            "GenerateMusicPlaylist",
        ]),
    },
];

/// How the device's pointer was resolved. Reported so a degraded resolution is
/// visible in the logs instead of silently changing what the wearer can do.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Resolution {
    /// Name and version both matched a set we serve.
    Exact,
    /// The name matched but the version did not. The wearer's turn stays on the
    /// capability they asked for — serving the version we have is far closer to
    /// their intent than dropping them into the flat supervisor set.
    VersionFallback { requested: i32 },
    /// The device sent no pointer (or an empty name). The default set applies —
    /// this is the ordinary case for callers that predate the field.
    Absent,
    /// The pointer named a set this deployment does not serve. The default set
    /// applies: an unknown pointer must never cost the wearer their turn.
    UnknownSet,
}

impl Resolution {
    pub fn is_degraded(&self) -> bool {
        !matches!(self, Resolution::Exact)
    }
}

/// A resolved pointer: the set to serve, and how it was arrived at.
#[derive(Clone, Copy, Debug)]
pub struct ResolvedToolSet {
    pub set: &'static ToolSet,
    pub resolution: Resolution,
}

/// The set served when nothing else resolves.
pub fn default_set() -> &'static ToolSet {
    &SETS[0]
}

/// Resolve `{set_name, version}` to a concrete tool set.
///
/// Never fails: an unusable pointer degrades to [`default_set`] and says so in
/// the returned [`Resolution`].
pub fn resolve(pointer: Option<(&str, i32)>) -> ResolvedToolSet {
    let Some((name, version)) = pointer.filter(|(name, _)| !name.trim().is_empty()) else {
        return ResolvedToolSet {
            set: default_set(),
            resolution: Resolution::Absent,
        };
    };
    let name = name.trim();

    if let Some(set) = SETS
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(name) && s.version == version)
    {
        return ResolvedToolSet {
            set,
            resolution: Resolution::Exact,
        };
    }
    if let Some(set) = SETS.iter().find(|s| s.name.eq_ignore_ascii_case(name)) {
        return ResolvedToolSet {
            set,
            resolution: Resolution::VersionFallback { requested: version },
        };
    }
    ResolvedToolSet {
        set: default_set(),
        resolution: Resolution::UnknownSet,
    }
}

/// Render `{set_name, version}` for logs.
pub fn pointer_label(name: &str, version: i32) -> String {
    format!("{name}@{version}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::catalog;

    #[test]
    fn the_five_shipped_wrapper_sets_and_the_supervisor_default_resolve_exactly() {
        // The bounded shipped-client scan found exactly these five first-party
        // wrappers and the tool set each selects; the active Understand path
        // selects supervisor@7.
        for (name, version) in [
            ("supervisor", 7),
            ("settings", 3),
            ("timer", 1),
            ("alarm", 1),
            ("contacts", 1),
            ("food", 4),
        ] {
            let resolved = resolve(Some((name, version)));
            assert_eq!(resolved.resolution, Resolution::Exact, "{name}@{version}");
            assert_eq!(resolved.set.name, name);
            assert_eq!(resolved.set.version, version);
        }
    }

    /// `ManageMemory` is a Supervisor action containing `Task`, not a sixth tool
    /// set — and stock's live negative matrix returned INVALID_ARGUMENT for
    /// `answers@1`, `messages@1`, `photography@1`, `translation@1`, and
    /// `systemnavigation@1`. None of those may become a set here.
    #[test]
    fn names_stock_does_not_serve_are_not_sets() {
        for name in [
            "managememory",
            "memory",
            "answers",
            "messages",
            "photography",
            "translation",
            "systemnavigation",
        ] {
            assert!(
                !SETS.iter().any(|s| s.name.eq_ignore_ascii_case(name)),
                "{name} is not a stock tool set"
            );
        }
    }

    /// An unknown or absent pointer must cost the wearer nothing: it degrades to
    /// the default set rather than failing the turn.
    #[test]
    fn an_unusable_pointer_degrades_instead_of_failing_the_turn() {
        for pointer in [None, Some(("", 0)), Some(("   ", 3))] {
            let resolved = resolve(pointer);
            assert_eq!(resolved.set.name, DEFAULT_SET_NAME);
            assert_eq!(resolved.resolution, Resolution::Absent);
        }

        let unknown = resolve(Some(("nutrition-v9", 12)));
        assert_eq!(unknown.set.name, DEFAULT_SET_NAME);
        assert_eq!(unknown.resolution, Resolution::UnknownSet);
        assert!(unknown.resolution.is_degraded());
        assert!(matches!(unknown.set.tools, SetTools::All));

        // A known capability at an unserved revision stays on that capability.
        let old = resolve(Some(("settings", 2)));
        assert_eq!(old.set.name, "settings");
        assert_eq!(old.resolution, Resolution::VersionFallback { requested: 2 });
        assert!(old.resolution.is_degraded());
    }

    /// A set may narrow the deployment catalog; it may never widen it. Every
    /// name a set lists has to already be offered by the flat catalog, or the
    /// table is silently claiming a capability the deployment withholds.
    #[test]
    fn no_set_can_widen_the_deployment_catalog() {
        let offered: Vec<String> = catalog::tool_catalog()
            .into_iter()
            .map(|t| t.name)
            .collect();
        for set in SETS {
            let SetTools::Only(names) = set.tools else {
                continue;
            };
            for name in names {
                assert!(
                    offered.iter().any(|o| o == name),
                    "{}@{} lists {name}, which the deployment catalog does not offer",
                    set.name,
                    set.version
                );
            }
        }
    }

    /// A CAPABILITY CHILD MUST NOT BE ABLE TO DISPATCH ITS OWN WRAPPER.
    ///
    /// The topology is two-tier: the supervisor dispatches `Settings` / `Timer` /
    /// `Alarm` / `Contacts`, and THAT hand-off is what selects the matching set.
    /// So by the time the pointer reads `settings@3` the device is already inside
    /// the Settings child, and offering `Settings` there is the child handing off
    /// to itself — a wasted turn at best, a loop at worst.
    ///
    /// This is pinned as a test because the absence reads like an omission: all
    /// four sets look like they are "missing" their own capability, and the
    /// obvious-looking fix is to add it. It is not a gap.
    #[test]
    fn no_set_offers_its_own_wrapper() {
        for (set_name, wrapper) in [
            ("settings", "Settings"),
            ("timer", "Timer"),
            ("alarm", "Alarm"),
            ("contacts", "Contacts"),
        ] {
            let Some(set) = SETS.iter().find(|s| s.name == set_name) else {
                continue;
            };
            assert!(
                !set.offers(wrapper),
                "{set_name}@{} offers {wrapper}, its own hand-off action — the \
                 device is already inside this child when the pointer resolves here",
                set.version
            );
        }
    }

    /// Every set must be able to end the turn. A set with no terminal `Respond`
    /// leaves the model no way to speak, and the wearer hears nothing.
    #[test]
    fn every_set_can_speak_and_carries_its_own_guidance() {
        for set in SETS {
            assert!(
                set.offers(RESPOND_ACTION),
                "{}@{} cannot terminate a turn",
                set.name,
                set.version
            );
            if !matches!(set.tools, SetTools::All) {
                assert!(
                    !set.guidance.trim().is_empty(),
                    "{}@{} has no guidance of its own",
                    set.name,
                    set.version
                );
            }
        }
    }

    /// A capability child that can dispatch its own wrapper is a dispatch loop:
    /// the wrapper re-enters the child, which emits the wrapper again, until the
    /// run hits the action limit and the wearer gets the runaway apology.
    #[test]
    fn no_capability_set_can_dispatch_its_own_wrapper() {
        for (set_name, wrapper) in [
            ("settings", "Settings"),
            ("timer", "Timer"),
            ("alarm", "Alarm"),
            ("contacts", "Contacts"),
        ] {
            let set = SETS
                .iter()
                .find(|s| s.name == set_name)
                .unwrap_or_else(|| panic!("{set_name} must be a served set"));
            assert!(
                !set.offers(wrapper),
                "{set_name} must not be able to dispatch {wrapper}"
            );
        }
    }
}
