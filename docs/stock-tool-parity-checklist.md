# Stock tool/action parity checklist

This is the binary source-level audit of every stock native action name currently
recorded in the Tier-A ledger. It includes the 105 callable actions in
`NATIVE_ACTION_CATALOG` and the 33 stock context, internal, developer,
replacement, and stock-only actions that must not be mistaken for ordinary prompts.

Sources: [`native-actions.tsv`](../pin/contracts/tier-a/native-actions.tsv),
[`catalog.rs`](../pin/runtime/core/src/synapse/catalog.rs), and
[`catalog/tests.rs`](../pin/runtime/core/src/synapse/catalog/tests.rs).

## What the marks mean

- ✅ The action behavior is restored, replaced by the evidenced real RPC, or
  correctly constrained to its stock context/internal/developer role.
- ❌ The feature is intentionally not restored, only partly restored, stock-only,
  dependent on an unclaimed original backend, or explicitly unverified.

A ✅ is not a physical-device acceptance result. It means the current source and
catalog guards support the verdict. Provider accounts, feature flags, lock state,
and the exact Pin still decide whether a path works end to end.

## Summary

| Scope | ✅ | ❌ | Total |
| --- | ---: | ---: | ---: |
| Callable stock action catalog | 103 | 2 | 105 |
| Non-callable stock ledger | 30 | 3 | 33 |
| **All stock action names** | **133** | **5** | **138** |

The 5 open parity gaps are:

- 2 partly restored callable actions: `SetDefaultTranslateLanguage` and `WorldClock`;
- 2 original account/subscription transitions: `InvalidSubscription` and
  `UnauthorizedDevice`;
- 1 stock-only diagnostic path: `TriggerBugReport` cloud delivery.

## Callable stock action catalog: 105

These are the actions admitted by `NATIVE_ACTION_CATALOG`. They are validation
targets, not all independent wearer prompts. See the
[prompting map](prompting-map.md) for the 89 wearer capabilities.

### Direct restored actions: 40

Direct deterministic or tightly grounded routes that return the installed stock action.

Result: 40 ✅, 0 ❌.

| | Stock call | Experience | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `AcceptCall` | `DIALER` | Strict fallback emits the installed native action. |
| ✅ | `AddIfThenEntry` | `CENTRAL` | Feature-gated by vision_actions_enabled; the strict fallback emits the installed native action only while enabled. |
| ✅ | `AmIOnline` | `CENTRAL` | Strict fallback emits the installed native action. |
| ✅ | `CallPerson` | `DIALER` | Strict fallback emits one explicit non-emergency recipient. |
| ✅ | `CapturePhotograph` | `PHOTOGRAPHY` | Strict fallback emits the installed native action. |
| ✅ | `CaptureVideo` | `PHOTOGRAPHY` | Strict fallback emits the installed native action. |
| ✅ | `CatchMeUp` | `NOTIFICATIONS` | Strict fallback preserves the stock unlocked-only boundary. |
| ✅ | `ChangeQuickAction` | `AGENT_SETTINGS` | Feature-gated strict fallback emits the installed native action. |
| ✅ | `ClearIfThenMap` | `CENTRAL` | Feature-gated strict fallback emits the installed native action. |
| ✅ | `ClearUnderstandingContext` | `CENTRAL` | Strict fallback emits the installed native action. |
| ✅ | `ComposeMessage` | `MESSAGES` | Strict draft planner preserves confirmation and lock policy. |
| ✅ | `DecrementVolume` | `CENTRAL` | Strict fallback emits the installed native action. |
| ✅ | `DisplayMessages` | `MESSAGES` | Strict unlocked fallback requests bounded local results. |
| ✅ | `EndCall` | `DIALER` | Exact control is useful only against matching call state. |
| ✅ | `EnterPrivacyMode` | `CENTRAL` | Strict fallback emits the installed native action. |
| ✅ | `GetAirplaneModeStatus` | `CENTRAL` | Strict read-only fallback emits the installed native action. |
| ✅ | `GetBatteryLevel` | `CENTRAL` | Strict read-only fallback emits the installed native action. |
| ✅ | `GetBluetoothStatus` | `CENTRAL` | Strict read-only fallback emits the installed native action. |
| ✅ | `GetCurrentLocation` | `CENTRAL` | Stock observation remains the sole coordinate authority. |
| ✅ | `GetCurrentTime` | `CENTRAL` | Strict read-only fallback emits the installed native action. |
| ✅ | `GetCurrentVolume` | `CENTRAL` | Strict read-only fallback emits the installed native action. |
| ✅ | `GetIfThenMapSize` | `CENTRAL` | Feature-gated strict fallback emits the installed native action. |
| ✅ | `GetPhoneNumber` | `CENTRAL` | Strict read-only fallback emits the installed native action. |
| ✅ | `GetSerialNumber` | `CENTRAL` | Strict fallback requires explicit unlocked state. |
| ✅ | `IncrementVolume` | `CENTRAL` | Strict fallback emits the installed native action. |
| ✅ | `LockDevice` | `AGENT_SETTINGS` | Strict fallback requires explicit unlocked state. |
| ✅ | `MessageSearch` | `MESSAGES_BACKGROUND` | One linked result may continue to DisplayMessages; no IDs are invented. |
| ✅ | `OpenContacts` | `CONTACTS` | Strict fallback requires explicit unlocked state. |
| ✅ | `OpenDialerHome` | `DIALER` | Strict UI fallback requires explicit unlocked state. |
| ✅ | `OpenDialpad` | `DIALER` | Strict UI fallback requires explicit unlocked state. |
| ✅ | `OpenMessagesMainMenu` | `MESSAGES` | Strict UI fallback requires explicit unlocked state. |
| ✅ | `OpenRecentCalls` | `DIALER` | Strict private-history fallback requires explicit unlocked state. |
| ✅ | `OpenRecentPhotos` | `PHOTOGRAPHY` | Strict private-gallery fallback requires explicit unlocked state. |
| ✅ | `OpenTutorial` | `SYSTEM_NAVIGATION` | Strict fallback requires explicit unlocked state. |
| ✅ | `ResumeCall` | `DIALER` | Exact control is useful only against matching call state. |
| ✅ | `SetVolume` | `AGENT_SETTINGS` | Bounded 0-100 strict fallback emits the installed native action. |
| ✅ | `StartActivityTracker` | `CENTRAL` | Feature-gated strict fallback emits the installed native action. |
| ✅ | `StopActivityTracker` | `CENTRAL` | Exact Stop remains reachable when fitness_tracker_enabled is false so an active session can close safely. |
| ✅ | `StopVideo` | `PHOTOGRAPHY` | Strict fallback emits the installed native action. |
| ✅ | `Tickle` | `TICKLE_PROTOTYPE` | Feature-gated direct route preserves the installed native experience. |

### Restored stock-local actions: 25

Strict routes that hand the request to the installed stock handler. The clone
does not replace Android radio, modem, contact, trust, power, or reset UI logic.

Result: 25 ✅, 0 ❌.

| | Stock call | Experience | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `ConnectToWifi` | `CENTRAL` | Opens the installed Wi-Fi selector/QR flow; no server-side credential handling. |
| ✅ | `CreateContact` | `CONTACTS` | Requires an exact name and phone number while unlocked; preserves stock’s forced-trusted behavior. |
| ✅ | `DisconnectWifi` | `CENTRAL` | Strict command emits the installed disconnect action. |
| ✅ | `FactoryReset` | `CENTRAL` | Unlocked strict command enters the installed confirmation flow; it does not reset directly. |
| ✅ | `Reboot` | `AGENT_SETTINGS` | Strict command emits the installed reboot action. |
| ✅ | `SetUpTouchcode` | `CENTRAL` | Opens the installed Touchcode enrollment flow. |
| ✅ | `TrustLock` | `CENTRAL` | Unlocked strict command emits the installed Trust Lock action. |
| ✅ | `TurnOffAirplaneMode` | `AGENT_SETTINGS` | Strict command emits the installed airplane-mode action. |
| ✅ | `TurnOffAmberAlert` | `CENTRAL` | Unlocked strict command emits the installed Amber-alert action. |
| ✅ | `TurnOffBluetooth` | `AGENT_SETTINGS` | Strict command emits the installed Bluetooth action. |
| ✅ | `TurnOffCellularData` | `CENTRAL` | Unlocked strict command emits the installed cellular-data action. |
| ✅ | `TurnOffCellularRoaming` | `CENTRAL` | Unlocked strict command emits the installed roaming action. |
| ✅ | `TurnOffDevice` | `AGENT_SETTINGS` | Strict command emits the installed power-off action. |
| ✅ | `TurnOffEmergencyAlert` | `CENTRAL` | Unlocked strict command emits the installed emergency-alert action. |
| ✅ | `TurnOffPublicSafetyAlert` | `CENTRAL` | Unlocked strict command emits the installed public-safety-alert action. |
| ✅ | `TurnOffWifi` | `AGENT_SETTINGS` | Strict command emits the installed Wi-Fi radio action. |
| ✅ | `TurnOnAirplaneMode` | `AGENT_SETTINGS` | Strict command emits the installed airplane-mode action. |
| ✅ | `TurnOnAmberAlert` | `CENTRAL` | Unlocked strict command emits the installed Amber-alert action. |
| ✅ | `TurnOnBluetooth` | `AGENT_SETTINGS` | Strict command emits the installed Bluetooth action. |
| ✅ | `TurnOnCellularData` | `CENTRAL` | Unlocked strict command emits the installed cellular-data action. |
| ✅ | `TurnOnCellularRoaming` | `CENTRAL` | Unlocked strict command emits the installed roaming action. |
| ✅ | `TurnOnEmergencyAlert` | `CENTRAL` | Unlocked strict command emits the installed emergency-alert action. |
| ✅ | `TurnOnPublicSafetyAlert` | `CENTRAL` | Unlocked strict command emits the installed public-safety-alert action. |
| ✅ | `TurnOnWifi` | `AGENT_SETTINGS` | Strict command emits the installed Wi-Fi radio action. |
| ✅ | `WifiQrScan` | `CENTRAL` | Opens the installed Wi-Fi QR scanner; credentials stay on the device. |

### Restored stock-agent actions: 24

Bounded clock, contacts, settings, nutrition, and related agent routes, including their nested tools.

Result: 23 ✅, 1 ❌.

| | Stock call | Experience | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `Alarm` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `CancelAlarm` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `ConnectToBluetooth` | `AGENT_SETTINGS` | Unlocked named-device lookup must yield one exact address. |
| ✅ | `Contacts` | `CONTACTS` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `DeleteTimer` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `DeviceStatus` | `AGENT_SETTINGS` | Exact linked CurrentStatus must prove the Pin unlocked. |
| ✅ | `DisconnectBluetooth` | `AGENT_SETTINGS` | Unlocked named-device lookup must yield one exact address. |
| ✅ | `DisplayAlarm` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `DisplayContact` | `CONTACTS` | Contact ID must come from the exact linked search result. |
| ✅ | `DisplayTimer` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `EditTimer` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `GetNewBluetoothAddress` | `AGENT_SETTINGS` | Only first step of the unlocked named-device loop. |
| ✅ | `GetPairedBluetoothAddress` | `AGENT_SETTINGS` | Only first step of the unlocked named-device loop. |
| ✅ | `GetQuickMessagingParticipants` | `CONTACTS` | Exact linked CurrentStatus must prove the Pin unlocked. |
| ✅ | `ManageNutrition` | `FOOD` | Bounded food agent and provider-backed nested tools are restored. |
| ✅ | `PauseTimer` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `ResumeTimer` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `SearchContact` | `CONTACTS` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `SetAlarm` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `SetQuickMessagingContact` | `CONTACTS` | Contact ID must come from the exact linked search result. |
| ✅ | `SetTimer` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ✅ | `Settings` | `AGENT_SETTINGS` | Only bounded unlocked DeviceStatus and named Bluetooth loops are exposed. |
| ✅ | `Timer` | `CLOCK` | Bounded schema-aware agent route preserves the native handler. |
| ❌ | `WorldClock` | `CLOCK` | Strict location route preserves the native handler; unmatched web continuation is not restored. |

### Provider-backed actions: 16

Stock native actions kept at the device boundary while the retired cloud dependency is replaced by an operator-selected provider.

Result: 15 ✅, 1 ❌.

| | Stock call | Experience | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `GenerateMusicPlaylist` | `MUSIC` | Native action remains; retired provider boundary has a bounded replacement. |
| ✅ | `GetMusicQueue` | `MUSIC` | Native action remains; retired provider boundary has a bounded replacement. |
| ✅ | `NextTrack` | `MUSIC` | Native action remains; restored provider/session state performs control. |
| ✅ | `PauseMusic` | `MUSIC` | Native action remains; restored provider/session state performs control. |
| ✅ | `PlayCurrentTrackRadio` | `MUSIC` | Public fieldless station action is restored; private track-ID action stays internal. |
| ✅ | `PlayFavoriteTracks` | `MUSIC` | Native action remains; retired provider boundary has a bounded replacement. |
| ✅ | `PlayFeaturedMusic` | `MUSIC` | Native action remains; retired provider boundary has a bounded replacement. |
| ✅ | `PlayMusic` | `MUSIC` | Native action remains; retired provider boundary has a bounded replacement. |
| ✅ | `PreviousTrack` | `MUSIC` | Native action remains; restored provider/session state performs control. |
| ✅ | `Respond` | `ANSWERS` | Native renderer action is backed by the selected bounded provider. |
| ✅ | `RestartTrack` | `MUSIC` | Native action remains; restored provider/session state performs control. |
| ✅ | `ResumeMusic` | `MUSIC` | Native action remains; restored provider/session state performs control. |
| ✅ | `SaveCurrentTrackToFavorites` | `MUSIC` | Explicit library mutation uses the restored provider session. |
| ❌ | `SetDefaultTranslateLanguage` | `TRANSLATION` | Unverified: the deterministic planner emits the Translate{Target} shape and assumes the stock language-selection UI applies it; the server never emits SetDefaultTranslateLanguage and has no verified handler (tools/catalog.rs DELIBERATELY_NOT_EXPOSED). |
| ✅ | `Translate` | `TRANSLATION` | Native action and stock UI are backed by bounded translation services. |
| ✅ | `UnderstandScene` | `ANSWERS` | Native action remains; image analysis has a bounded provider replacement. |

## Non-callable stock ledger: 33

These names exist in stock, but they are not entries the model may call from a
fresh wearer request. They are still listed because correct exclusion is part of parity.

### Context-only actions: 10

Parent-linked state transitions. A check means the clone preserves the context requirement instead of advertising a fresh prompt.

Result: 10 ✅, 0 ❌.

| | Stock action | Stock role | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `AskConfirmationForEmergencyCall` | `context` / `context` | Valid only inside an active matching stock/restored context. |
| ✅ | `AskConfirmationForFactoryReset` | `context` / `context` | Valid only inside an active matching stock/restored context. |
| ✅ | `CancelSendMessage` | `context` / `context` | Valid only inside an active matching stock/restored context. |
| ✅ | `ConfirmSendMessage` | `context` / `context` | Valid only inside an active matching complete draft. |
| ✅ | `StartTranslation` | `context` / `context` | Device-generated session ID only; not synthesized from ordinary voice. |
| ✅ | `StopTranslation` | `context` / `context` | Device-generated session ID only; not synthesized from ordinary voice. |
| ✅ | `UserConfirmedEmergencyCall` | `context` / `context` | Valid only inside an active matching emergency context. |
| ✅ | `UserConfirmedFactoryReset` | `context` / `context` | Valid only inside an active matching reset context. |
| ✅ | `UserDeniedEmergencyCall` | `context` / `context` | Valid only inside an active matching emergency context. |
| ✅ | `UserDeniedFactoryReset` | `context` / `context` | Valid only inside an active matching reset context. |

### Internal actions: 18

Device, renderer, policy, or UI transitions. A check means the action stays internal and cannot leak into the ordinary prompt catalog.

Result: 16 ✅, 2 ❌.

| | Stock action | Stock role | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `DeviceUnlocked` | `internal` / `internal` | Device transition; never a broad prompt fallback. |
| ✅ | `ExplainFailure` | `policy` / `internal` | Renderer/error transition; never a broad prompt fallback. |
| ✅ | `HardModerate` | `policy` / `internal` | Policy transition; never a broad prompt fallback. |
| ✅ | `InstructUnlock` | `internal` / `internal` | UI transition; never a broad prompt fallback. |
| ❌ | `InvalidSubscription` | `policy` / `internal` | Account/policy transition; original subscription backend is not claimed. |
| ✅ | `ManageMemory` | `internal` / `internal` | Quick Action bookkeeping transition; not a prompt tool. |
| ✅ | `Moderate` | `policy` / `internal` | Policy transition; never a broad prompt fallback. |
| ✅ | `Narrate` | `internal` / `internal` | Renderer transition; never a broad prompt fallback. |
| ✅ | `PlayRecommendationsWithTrackId` | `internal` / `internal` | Private handler transition; structurally unreachable from ordinary text. The fieldless action enum is closed, so utterance text cannot select it. |
| ✅ | `PlaySound` | `internal` / `internal` | Renderer transition; never a broad prompt fallback. |
| ✅ | `PresentIncomingMessageAction` | `internal` / `internal` | Telephony event transition; never a broad prompt fallback. |
| ✅ | `PreviousButton` | `internal` / `internal` | Music UI transition; never a broad prompt fallback. |
| ✅ | `ReadAllMessages` | `internal` / `internal` | Handler exists but is absent from the central prompt catalog. |
| ✅ | `ShowError` | `internal` / `internal` | Music error/UI transition; never a broad prompt fallback. |
| ✅ | `ThermalWarning` | `internal` / `internal` | Device event transition; never a broad prompt fallback. |
| ❌ | `UnauthorizedDevice` | `policy` / `internal` | Account/policy transition; original account backend is not claimed. |
| ✅ | `UpdateContactTrusted` | `internal` / `internal` | UI/internal trust transition; never a broad prompt fallback. |
| ✅ | `ViewCallLog` | `internal` / `internal` | Private UI transition; never a broad prompt fallback. |

### Developer-only actions: 3

Diagnostic actions deliberately filtered from wearer requests.

Result: 3 ✅, 0 ❌.

| | Stock action | Stock role | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `ExperimentalInterface` | `developer` / `developer` | Filtered from ordinary product prompts. |
| ✅ | `SystemTraceStart` | `developer` / `developer` | Filtered from ordinary product prompts. |
| ✅ | `SystemTraceStop` | `developer` / `developer` | Filtered from ordinary product prompts. |

### Replacement RPC actions: 1

A dead annotated action whose real stock behavior uses a different RPC path.

Result: 1 ✅, 0 ❌.

| | Stock action | Stock role | Clone verdict |
| --- | --- | --- | --- |
| ✅ | `CreateMemory` | `dead_schema` / `replacement` | Annotated action has no central handler; authentic FunctionExecution is restored instead. |

### Stock-only actions: 1

The local stock handler remains, but the original cloud-side behavior is not cloned.

Result: 0 ✅, 1 ❌.

| | Stock action | Stock role | Clone verdict |
| --- | --- | --- | --- |
| ❌ | `TriggerBugReport` | `prompt` / `stock only` | Installed local handler remains; original cloud delivery is not claimed. |

## Verification

Run the source guards without dispatching a device action:

```sh
node platform/deploy/acceptance/pin/tool-coverage.mjs --check-names
cargo test --manifest-path pin/runtime/core/Cargo.toml catalog_exactly_matches_promptable_parity_ledger_rows
cargo test --manifest-path pin/runtime/core/Cargo.toml catalog_excludes_denied_internal_and_context_only_actions
```

For prompts, schemas, feature gates, and safe end-to-end checks, use the
[full prompting and tool reference](prompting-and-tool-reference.md).
