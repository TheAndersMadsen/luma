# Pin prompting and tool reference

For the short copyable version, use the [prompting map](prompting-map.md).
For a binary audit of every stock action name, use the
[stock tool/action parity checklist](stock-tool-parity-checklist.md).

This is the source-derived reference for what the Pin assistant can be asked to
do. It covers all 89 source-reachable wearer acceptance cases: 37 registered
model tools and 52 native-only prompt capabilities. It also inventories all 98
device-visible Cosmos gRPC methods. The lower-level stock action registry has 105
names, but response, continuation, and internal agent actions are not falsely
presented as independent wearer prompts.

The important distinction is:

- A **prompt capability** is something a wearer can ask for.
- A **model tool** is a structured call available to the assistant when the
  deterministic route did not already handle the request.
- A **native action** is returned to stock firmware for execution on the Pin.
- A **gRPC method** is a device/backend interface. It is not necessarily a
  spoken assistant feature.

The catalogs behind this page are
[`tool-coverage.mjs`](../platform/deploy/acceptance/pin/tool-coverage.mjs),
[`catalog.rs`](../pin/runtime/core/src/services/aibus/tools/catalog.rs),
[`prompt-suite.mjs`](../platform/deploy/acceptance/pin/prompt-suite.mjs), and
[`registry.rs`](../cosmos/crates/core/src/registry.rs).

## Start here

These prompts are read-only and make a good first pass:

1. “What time is it?”
2. “How much battery do I have left?”
3. “Am I connected to the internet?”
4. “What is the volume set to?”
5. “Look up the Eiffel Tower and tell me how tall it is.”
6. With the Pin unlocked: “Where am I?”
7. With location available: “What’s the weather here?”
8. With location available: “What’s nearby?”
9. With a linked music account: “What song is playing right now?”
10. With the Pin unlocked: “What do you remember about me?”

Then try reversible or visible actions:

- “Set a timer for 10 minutes.”
- “Set the volume to 30.”
- “Please remember that my favorite color is teal.”
- “Take a photo.”
- “Play my favourites.”

Calls and messages are live communications. Use a recipient who expects the
test. “Send a message …” opens the stock composer and retains its confirmation
flow; “Call …” can hand a real call to the stock dialer.

## How a spoken request is routed

```text
wearer prompt
  -> deterministic stock-compatible planner, when an exact safe grammar matches
  -> otherwise the assistant model, with only currently permitted tools advertised
  -> server read/write result OR stock native action
  -> stock firmware executes the native action
  -> Cosmos gRPC supplies the backend contract where that path needs cloud work
```

Deterministic routes run first. Therefore “what time is it” can produce
`GetCurrentTime` without the model calling `get_current_time`; both routes expose
the same wearer capability. Tool availability is also dynamic: locked-state,
provider, account, and authorization gates can remove a tool before the model
sees it.

Read tools execute on the backend and return an observation. `remember_fact` is
the one server-side write. Stock-action tools do not perform the device action
on the server; they return a validated action for the firmware to execute.

## Safety and requirement labels

| Label | Meaning |
| --- | --- |
| Read | Reads data without intentionally changing state. |
| Persistent | Saves state locally or in Cosmos/provider storage. |
| Device | Changes Pin state or starts a stock device experience. |
| Live | Can affect another person or an external service. |
| Unlock | Requires a positively confirmed unlocked Pin. Unknown lock state fails closed. |
| Location | Requires the Pin’s current location or a prior resolved place. |
| Provider | Requires network access, configuration, or a linked account. |

## Complete wearer prompt catalog: 89

The quoted wording is the acceptance prompt. Natural variants may be handled by
a model tool, but native-only rows deliberately use narrow wording.

### Knowledge and memory

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `knowledge_lookup` | “Look up the Eiffel Tower and tell me how tall it is.” | `knowledge_lookup` | Read; public encyclopedia lookup. |
| `web_search` | “Search the web for today’s top news headline.” | `web_search` | Read, Provider; hidden unless Brave is configured. |
| `food_lookup` | “What is the calorie count of a Snickers bar?” | `food_lookup` or `ManageNutrition` | Read, Unlock, Provider; disabled while the food runtime permit is off. |
| `remember_fact` | “Please remember that my favorite color is teal.” | `remember_fact` | Persistent, Unlock; stores the exact requested fact. |
| `memory_search` | “What do you remember about me?” | `memory_search` | Read, Unlock; searches private saved memory. |

### Device status and controls

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `get_current_time` | “What time is it?” | `get_current_time` or `GetCurrentTime` | Read; device time. |
| `get_battery_level` | “How much battery do I have left?” | `get_battery_level` or `GetBatteryLevel` | Read; device battery. |
| `am_i_online` | “Am I connected to the internet?” | `am_i_online` or `AmIOnline` | Read; device connectivity result. |
| `get_current_volume` | “What is the volume set to?” | `get_current_volume` or `GetCurrentVolume` | Read; current media volume. |
| `set_alarm` | “Set an alarm for 7 am.” | `set_alarm`, `Alarm`, or `SetAlarm` | Device, Persistent; creates an alarm. |
| `set_timer` | “Set a timer for 10 minutes.” | `set_timer`, `Timer`, or `SetTimer` | Device, Persistent; starts a countdown. |
| `increment_volume` | “Turn the volume up a bit.” | `increment_volume` or `IncrementVolume` | Device; raises volume one step. |
| `decrement_volume` | “Turn the volume down a bit.” | `decrement_volume` or `DecrementVolume` | Device; lowers volume one step. |
| `set_volume` | “Set the volume to 30.” | `set_volume` or `SetVolume` | Device; sets volume from 0 through 100. |

### Music

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `music_catalog_search` | “What is Dr. Dre’s most popular song?” | `music_catalog_search` | Read, Provider; searches the linked music catalog. |
| `music_artist_top_tracks` | “What are Fleetwood Mac’s top tracks?” | `music_artist_top_tracks` | Read, Provider. |
| `current_music` | “What song is playing right now?” | `current_music` | Read, Unlock, Provider. |
| `get_music_queue` | “What is next in the queue?” | `get_music_queue` or `GetMusicQueue` | Read, Provider. |
| `play_music` | “Play Dr. Dre’s most popular song.” | search, then `play_music` / `PlayMusic` | Device, Provider; starts the top grounded result. |
| `play_favorite_tracks` | “Play my favourites.” | `play_favorite_tracks` or `PlayFavoriteTracks` | Device, Provider; starts personal saved music. |
| `play_featured_music` | “Play some featured music.” | `play_featured_music` or `PlayFeaturedMusic` | Device, Provider. |
| `pause_music` | “Pause the music.” | `pause_music` or `PauseMusic` | Device, Provider. |
| `resume_music` | “Resume the music.” | `resume_music` or `ResumeMusic` | Device, Provider. |
| `next_track` | “Skip this song.” | `next_track` or `NextTrack` | Device, Provider. |
| `previous_track` | “Go back to the previous song.” | `previous_track` or `PreviousTrack` | Device, Provider. |
| `restart_track` | “Start this song over.” | `restart_track` or `RestartTrack` | Device, Provider. |
| `save_current_track_to_favorites` | “Add this song to my favourites.” | `save_current_track_to_favorites` or `SaveCurrentTrackToFavorites` | Persistent, Provider; changes the linked library. |
| `generate_music_playlist` | “Make me a playlist for working out.” | `generate_music_playlist` or `GenerateMusicPlaylist` | Device, Provider; uses the requested topic verbatim. |
| `PlayCurrentTrackRadio` | “Play similar songs.” | native `PlayCurrentTrackRadio` | Device, Provider; exact native grammar, no model tool. |

### Messaging and phone

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `send_message` | “Send a message to Alex saying I am running late.” | `send_message` or `ComposeMessage` | Unlock, Live; opens a real stock draft/confirmation flow. |
| `call_person` | “Call Alex.” | `call_person` or `CallPerson` | Unlock, Live; can place a real phone call. |
| `MessageSearch` | “What did Alex say?” | native `MessageSearch`, then linked `DisplayMessages` | Read, Unlock; searches private local messages. |
| `CatchMeUp` | “Catch me up.” | native `CatchMeUp` | Read, Unlock; private notification summary. Also accepts “what did I miss?”, “what’s new?”, and the two “what’s/what has been happening?” forms. |

### Native-only utilities

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `CapturePhotograph` | “Take a photo.” | native `CapturePhotograph` | Device, Persistent; captures a real photo. |
| `GetBluetoothStatus` | “Is Bluetooth on?” | native `GetBluetoothStatus` | Read; exact native grammar. |
| `GetAirplaneModeStatus` | “Is airplane mode on?” | native `GetAirplaneModeStatus` | Read; exact native grammar. |
| `Settings` | “Give me a device status report.” | native `Settings` with nested `DeviceStatus` request | Read, Unlock. |
| `Translate` | “Translate good morning to French.” | native `Translate` | Read, Provider; English, French, Italian, Spanish, Portuguese, and German are supported. |
| `WorldClock` | “What time is it in Tokyo?” | native `WorldClock` | Read; city must be one to three plain words. |

### Compatibility controls and gated experiences

These 18 rows complete the prompt surface implemented by
`native_device_actions.rs`. A gate is a runtime prerequisite, not missing source
implementation. The safe coverage harness plans these actions without
dispatching them.

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `ClearUnderstandingContext` | “Reset session.” | native `ClearUnderstandingContext` | Device; clears the short-term interaction session. Exact two-word command only. |
| `CaptureVideo` | “Record a video.” | native `CaptureVideo` | Device, Persistent; starts real video capture. |
| `StopVideo` | “Stop recording video.” | native `StopVideo` | Device; stops an active video recording. |
| `OpenRecentPhotos` | “Show me my recent photos.” | native `OpenRecentPhotos` | Read, Unlock; opens the private stock gallery. |
| `LockDevice` | “Lock my device.” | native `LockDevice` | Device, Unlock; immediately locks the Pin. |
| `EnterPrivacyMode` | “Enter privacy mode.” | native `EnterPrivacyMode` | Device; enters the stock privacy experience. |
| `StartActivityTracker` | “Start tracking my workout.” | native `StartActivityTracker` | Device; requires `fitness_tracker_enabled=true`, which is off by default. |
| `StopActivityTracker` | “Stop tracking my workout.” | native `StopActivityTracker` | Device; remains available even when the start gate is off. |
| `OpenTutorial` | “Open Laser Ink tutorial.” | native `OpenTutorial` | Device, Unlock; opens projector guidance. |
| `GetPhoneNumber` | “Tell me my phone number.” | native `GetPhoneNumber` | Read; preserves the stock keyguard policy. |
| `GetSerialNumber` | “Tell me my serial number.” | native `GetSerialNumber` | Read, Unlock; private device identifier. |
| `connect_bluetooth_device` | “Connect to my Acme Nova X1.” | native `Settings`, then address lookup and `ConnectToBluetooth` | Device, Unlock; named device must resolve to one stock address. |
| `disconnect_bluetooth_device` | “Disconnect from Acme Nova X1.” | native `Settings`, then paired-address lookup and `DisconnectBluetooth` | Device, Unlock; named device must resolve to one paired address. |
| `Tickle` | “Tickle my fancy.” | native `Tickle` | Device; requires the `tickle` flag, served on by default. |
| `AddIfThenEntry` | “If you see a red bicycle then take a picture.” | native `AddIfThenEntry` | Persistent; requires `vision_actions_enabled=true` and explicit vision consent. |
| `ClearIfThenMap` | “Clear vision actions.” | native `ClearIfThenMap` | Persistent; deletes every visual rule and requires the vision gate/consent. |
| `GetIfThenMapSize` | “Tell me the number of vision actions.” | native `GetIfThenMapSize` | Read; requires the vision gate/consent. |
| `ChangeQuickAction` | “Change my quick action to notes.” | native `ChangeQuickAction` | Persistent; `notes`, `messages`, and `interpreter` are the only targets. The clone serves the captured gate on by default. |

### Restored stock settings, contact, and lifecycle actions

These 25 routes emit the exact installed stock action. The server does not
toggle Android state itself. Factory reset retains the stock confirmation flow,
and Wi-Fi credentials remain inside the installed setup UI.

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `ConnectToWifi` | “Connect to Wi-Fi.” | native `ConnectToWifi` | Device; opens the installed selector/QR flow. |
| `CreateContact` | “Add a contact Ada Lovelace with phone number +45 12 34 56 78.” | native `CreateContact` | Persistent, Unlock; stock always creates it as trusted. |
| `DisconnectWifi` | “Disconnect from Wi-Fi.” | native `DisconnectWifi` | Device; disconnects the current Wi-Fi network. |
| `FactoryReset` | “Factory reset my Pin.” | native `FactoryReset` | Device, Unlock; enters stock confirmation and does not erase directly. |
| `Reboot` | “Reboot my Pin.” | native `Reboot` | Device; interrupts the current session. |
| `SetUpTouchcode` | “Set up Touchcode.” | native `SetUpTouchcode` | Device; opens stock enrollment. |
| `TrustLock` | “Enable Trust Lock.” | native `TrustLock` | Device, Unlock. |
| `TurnOffAirplaneMode` | “Turn off airplane mode.” | native `TurnOffAirplaneMode` | Device. |
| `TurnOffAmberAlert` | “Turn off Amber alerts.” | native `TurnOffAmberAlert` | Device, Unlock; carrier/region support may vary. |
| `TurnOffBluetooth` | “Turn off Bluetooth.” | native `TurnOffBluetooth` | Device. |
| `TurnOffCellularData` | “Turn off cellular data.” | native `TurnOffCellularData` | Device, Unlock; interrupts mobile data. |
| `TurnOffCellularRoaming` | “Turn off cellular roaming.” | native `TurnOffCellularRoaming` | Device, Unlock; SIM/carrier dependent. |
| `TurnOffDevice` | “Turn off my Pin.” | native `TurnOffDevice` | Device; powers down the Pin. |
| `TurnOffEmergencyAlert` | “Turn off emergency alerts.” | native `TurnOffEmergencyAlert` | Device, Unlock; carrier/region support may vary. |
| `TurnOffPublicSafetyAlert` | “Turn off public safety alerts.” | native `TurnOffPublicSafetyAlert` | Device, Unlock; carrier/region support may vary. |
| `TurnOffWifi` | “Turn off Wi-Fi.” | native `TurnOffWifi` | Device; can take the Pin offline. |
| `TurnOnAirplaneMode` | “Turn on airplane mode.” | native `TurnOnAirplaneMode` | Device; stock controls the resulting radio state. |
| `TurnOnAmberAlert` | “Turn on Amber alerts.” | native `TurnOnAmberAlert` | Device, Unlock; carrier/region support may vary. |
| `TurnOnBluetooth` | “Turn on Bluetooth.” | native `TurnOnBluetooth` | Device. |
| `TurnOnCellularData` | “Turn on cellular data.” | native `TurnOnCellularData` | Device, Unlock; SIM/carrier dependent. |
| `TurnOnCellularRoaming` | “Turn on cellular roaming.” | native `TurnOnCellularRoaming` | Device, Unlock; SIM/carrier dependent and may incur charges. |
| `TurnOnEmergencyAlert` | “Turn on emergency alerts.” | native `TurnOnEmergencyAlert` | Device, Unlock; carrier/region support may vary. |
| `TurnOnPublicSafetyAlert` | “Turn on public safety alerts.” | native `TurnOnPublicSafetyAlert` | Device, Unlock; carrier/region support may vary. |
| `TurnOnWifi` | “Turn on Wi-Fi.” | native `TurnOnWifi` | Device. |
| `WifiQrScan` | “Scan Wi-Fi QR code.” | native `WifiQrScan` | Device; opens the installed scanner. |

### Location, places, and weather

| Capability ID | Try saying | Route | Requirements and effect |
| --- | --- | --- | --- |
| `current_location` | “Where am I?” | `current_location` plus stock location preflight | Read, Unlock, Location. |
| `current_weather` | “What’s the weather here?” | `current_weather` | Read, Unlock, Location, Provider; present conditions only. |
| `weather_at_place` | “What’s the weather in Paris?” | `place_search`, then `weather_at_place` | Read, Provider; present conditions only. |
| `nearby_search` | “What’s nearby?” | `nearby_search` | Read, Unlock, Location, Provider; an empty category is valid. |
| `place_search` | “Where is the Eiffel Tower?” | `place_search` | Read, Provider; named-place resolution does not require device location. |
| `route` | “How do I get to the train station?” | `route` | Read, Unlock, Location, Provider; walking, driving, or cycling. |
| `reverse_geocode` | “What is the address here?” | `current_location`, then `reverse_geocode` | Read, Unlock, Location, Provider. |

The System Navigation Nearby card and the spoken `nearby_search` prompt use the
same backend capability family, but they are different clients. A passing raw
prompt probe does not prove that the projector UI opened, and a working card
does not prove that the assistant selected the spoken tool.

## All model-callable tool schemas

These are the JSON arguments advertised to the assistant model. Unknown fields
are rejected. Optional values should be omitted instead of invented.

### Server reads: 14

| Tool | Advertised arguments | Requirements / result |
| --- | --- | --- |
| `knowledge_lookup` | `{ query: string }` | Public encyclopedia result. Keep the query to the user’s subject. |
| `web_search` | `{ query: string }` | Brave must be configured; query terms must come from the request. |
| `place_search` | `{ query: string, context?: string }` | Resolves a public place. |
| `weather_at_place` | `{ location: string, latitude: number, longitude: number }` | Must follow a resolved place result. |
| `current_location` | `{}` | Unlock; can stage `GetCurrentLocation` for the stock client. |
| `current_weather` | `{}` | Unlock and current coordinates. |
| `reverse_geocode` | `{ latitude: number, longitude: number }` | Unlock; normally follows `current_location`. |
| `nearby_search` | `{ query?: string }` | Unlock and current coordinates; omit `query` for bare “what’s nearby”. |
| `route` | `{ origin: "current location", destination: string, mode?: "walking" \| "driving" \| "cycling" }` | Unlock and current coordinates. Transit is unsupported. |
| `music_artist_top_tracks` | `{ artist: string }` | Linked music provider. |
| `music_catalog_search` | `{ query: string, kind?: "track" \| "album" \| "artist" \| "playlist" }` | Linked music provider. |
| `current_music` | `{}` | Unlock and linked music provider. |
| `memory_search` | `{ query: string }` | Unlock; private saved memories. |
| `food_lookup` | `{ query: string }` | Unlock; food runtime permit and provider required. |

### Server writes: 1

| Tool | Advertised arguments | Requirements / result |
| --- | --- | --- |
| `remember_fact` | `{ content: string, kind?: "preference" \| "fact" \| "project" \| "instruction" \| "relationship" \| "other" }` | Unlock and trusted current-user turn; persists only the fact the wearer explicitly asked to save. |

### Stock-action tools: 22

| Tool | Advertised arguments | Native action / effect |
| --- | --- | --- |
| `increment_volume` | `{}` | `IncrementVolume`; device mutation. |
| `decrement_volume` | `{}` | `DecrementVolume`; device mutation. |
| `set_volume` | `{ level: integer }` | `SetVolume`; `level` is 0–100. |
| `get_current_volume` | `{}` | `GetCurrentVolume`; read-only device action. |
| `pause_music` | `{}` | `PauseMusic`; provider playback mutation. |
| `resume_music` | `{}` | `ResumeMusic`; provider playback mutation. |
| `next_track` | `{}` | `NextTrack`; provider playback mutation. |
| `previous_track` | `{}` | `PreviousTrack`; provider playback mutation. |
| `restart_track` | `{}` | `RestartTrack`; provider playback mutation. |
| `save_current_track_to_favorites` | `{}` | `SaveCurrentTrackToFavorites`; persistent provider write. |
| `get_music_queue` | `{}` | `GetMusicQueue`; provider read. |
| `get_battery_level` | `{}` | `GetBatteryLevel`; read-only device action. |
| `get_current_time` | `{}` | `GetCurrentTime`; read-only device action. |
| `am_i_online` | `{}` | `AmIOnline`; read-only device action. |
| `play_favorite_tracks` | `{}` | `PlayFavoriteTracks`; provider playback mutation. |
| `play_featured_music` | `{}` | `PlayFeaturedMusic`; provider playback mutation. |
| `generate_music_playlist` | `{ playlist: string }` | `GenerateMusicPlaylist`; requested topic must be copied from the prompt. |
| `set_timer` | `{ minutes?: number, seconds?: number, hours?: number, name?: string }` | `SetTimer`; exactly one duration unit, within 24 hours. |
| `set_alarm` | `{ time: string, ampm?: "am" \| "pm", once_day?: string }` | `SetAlarm`; clock time must come from the prompt. |
| `send_message` | `{ to: string, message: string }` | `ComposeMessage`; recipient and body must be copied from the current prompt. |
| `call_person` | `{ to: string }` | `CallPerson`; recipient must be copied from the current prompt. |
| `play_music` | `{ from_call_id: string }` | `PlayMusic`; ID must reference this turn’s successful music search, never free text. |

### Native-only prompt actions: 52

These are not model tools. They are strict stock-compatible routes, so the
assistant cannot call them by inventing a tool name.

| Native action | Effective payload | Notes |
| --- | --- | --- |
| `PlayCurrentTrackRadio` | `{}` | Exact music grammar and valid current-player context. |
| `MessageSearch` | `{ Person: string[], Query?: string }` | Unlock; a trusted result may continue to `DisplayMessages`. |
| `CatchMeUp` | `{}` | Unlock; exact catch-up phrases only. |
| `CapturePhotograph` | `{}` | Starts the stock camera capture. |
| `GetBluetoothStatus` | `{}` | Status only; does not toggle Bluetooth. |
| `GetAirplaneModeStatus` | `{}` | Status only; does not toggle airplane mode. |
| `Settings` | nested `DeviceStatus` request | The top-level emitted name is `Settings`, not `DeviceStatus`. |
| `Translate` | `{ Text: string, Source?: language, Target: language }` | Six-language deterministic grammar. |
| `WorldClock` | `{ Location: string }` | One to three plain location words. |
| `ClearUnderstandingContext` | `{}` | Exact “reset session”; clears short-term interaction context. |
| `CaptureVideo` | `{}` | Starts stock video capture. |
| `StopVideo` | `{}` | Stops stock video capture. |
| `OpenRecentPhotos` | `{}` | Unlock; opens the private gallery. |
| `LockDevice` | `{}` | Unlock; immediately locks the Pin. |
| `EnterPrivacyMode` | `{}` | Enters stock privacy mode. |
| `StartActivityTracker` | `{}` | Requires `fitness_tracker_enabled=true`. |
| `StopActivityTracker` | `{}` | Always retains the active-session cleanup route. |
| `OpenTutorial` | `{}` | Unlock; opens the Laser Ink tutorial. |
| `GetPhoneNumber` | `{}` | Reads the subscriber number through the stock handler. |
| `GetSerialNumber` | `{}` | Unlock; reads the device serial. |
| `Settings` for Bluetooth connect | `{ Request: string }` | Unlock; stock `settings/3` continues through `GetNewBluetoothAddress` to `ConnectToBluetooth`. |
| `Settings` for Bluetooth disconnect | `{ Request: string }` | Unlock; stock `settings/3` continues through `GetPairedBluetoothAddress` to `DisconnectBluetooth`. |
| `Tickle` | `{}` | Exact feature-gated Tickle grammar. |
| `AddIfThenEntry` | `{ If: string, Then: string }` | Vision gate and consent; both fields are bounded and copied from the command. |
| `ClearIfThenMap` | `{}` | Vision gate and consent; clears all saved visual rules. |
| `GetIfThenMapSize` | `{}` | Vision gate and consent; reads the rule count. |
| `ChangeQuickAction` | `{ action: "notes" \| "messages" \| "interpreter" }` | Quick-action gate; allowlisted canonical target only. |
| `ConnectToWifi` | `{}` | Opens the installed Wi-Fi connection flow. |
| `CreateContact` | `{ firstName: string, lastName?: string, trusted: true, phoneNumber: string }` | Unlock; requires a complete bounded name and number. |
| `DisconnectWifi` | `{}` | Disconnects through the installed settings handler. |
| `FactoryReset` | `{}` | Unlock; enters CENTRAL’s installed confirmation flow. |
| `Reboot` | `{}` | Reboots through the installed Settings agent handler. |
| `SetUpTouchcode` | `{}` | Opens installed Touchcode enrollment. |
| `TrustLock` | `{}` | Unlock; enables Trust Lock through the installed handler. |
| `TurnOffAirplaneMode` | `{}` | Disables airplane mode through stock Settings. |
| `TurnOffAmberAlert` | `{}` | Unlock; disables Amber alerts through CENTRAL. |
| `TurnOffBluetooth` | `{}` | Disables Bluetooth through stock Settings. |
| `TurnOffCellularData` | `{}` | Unlock; disables cellular data through CENTRAL. |
| `TurnOffCellularRoaming` | `{}` | Unlock; disables cellular roaming through CENTRAL. |
| `TurnOffDevice` | `{}` | Powers off through the installed Settings handler. |
| `TurnOffEmergencyAlert` | `{}` | Unlock; disables emergency alerts through CENTRAL. |
| `TurnOffPublicSafetyAlert` | `{}` | Unlock; disables public-safety alerts through CENTRAL. |
| `TurnOffWifi` | `{}` | Disables Wi-Fi through stock Settings. |
| `TurnOnAirplaneMode` | `{}` | Enables airplane mode through stock Settings. |
| `TurnOnAmberAlert` | `{}` | Unlock; enables Amber alerts through CENTRAL. |
| `TurnOnBluetooth` | `{}` | Enables Bluetooth through stock Settings. |
| `TurnOnCellularData` | `{}` | Unlock; enables cellular data through CENTRAL. |
| `TurnOnCellularRoaming` | `{}` | Unlock; enables cellular roaming through CENTRAL. |
| `TurnOnEmergencyAlert` | `{}` | Unlock; enables emergency alerts through CENTRAL. |
| `TurnOnPublicSafetyAlert` | `{}` | Unlock; enables public-safety alerts through CENTRAL. |
| `TurnOnWifi` | `{}` | Enables Wi-Fi through stock Settings. |
| `WifiQrScan` | `{}` | Opens the installed Wi-Fi QR scanner. |

#### Exact compatibility grammar

Optional polite prefixes are accepted by the ordinary camera, gallery, status,
privacy, volume, tutorial, and Bluetooth aliases. Session reset and the
feature-gated grammars remain intentionally exact.

| Capability | Accepted wording |
| --- | --- |
| Session reset | `reset session`; case and horizontal whitespace may vary, but no punctuation or polite prefix. |
| Video start | `record a video`, `record video`, `take a video`, `take video`, `capture a video`, `capture video`, `start recording a video`, `start recording video`. |
| Video stop | `stop recording`, `stop recording video`, `stop the video`, `stop video`. |
| Recent photos | `open my photos`, `open my recent photos`, `open recent photos`, `show my photos`, `show me my photos`, `show my recent photos`, `show me my recent photos`, `show recent photos`, `show me recent photos`, `open my pictures`, `show me my pictures`. |
| Lock | `lock my device`, `lock the device`, `lock my pin`; terminal `.` or `!` is allowed. |
| Privacy | `enter privacy mode`, `turn on privacy mode`, `enable privacy mode`. |
| Fitness start | `start tracking my run/walk/hike/workout/exercise`, `start activity tracking`, `start fitness tracking`. |
| Fitness stop | `stop tracking my run/walk/hike/workout/exercise`, `stop activity tracking`, `stop fitness tracking`, `stop tracking`. |
| Tutorial | `open tutorial`, `open the tutorial`, `show tutorial`, `show me the tutorial`, `laser ink tutorial`, `open laser ink tutorial`. |
| Phone number | `what is my phone number`, `tell me my phone number`, `what is my number`, plus the equivalent `what’s` forms. |
| Serial number | `what is my serial number`, `what is my Pin’s serial number`, `what is my Pin serial number`, `tell me my serial number`, plus the equivalent `what’s` forms. |
| Bluetooth connect | `connect to <name>`, `connect <name>`, `pair with <name>`, or `pair <name>`; one optional `my/the/a/an` before the name. |
| Bluetooth disconnect | `disconnect from <name>` or `disconnect <name>`; one optional `my/the/a/an` before the name. |
| Tickle | `tickle`, `tickle my fancy`, `tickle tickle tickle`; terminal speech punctuation is allowed, polite prefixes are not. |
| Add visual rule | `if you see <bounded condition> then <one safe Then prompt>`; the final `then` is the separator. |
| Clear visual rules | `clear/erase/delete vision actions` or `clear/erase/delete the vision actions`. |
| Count visual rules | `get/tell` + optional `me` + optional `the` + `number of` + optional `the` + `vision actions`. |
| Quick Action | `swap/change/set/make` + optional `the/my` + optional gesture descriptor + `to <target>`. Descriptors are `action`, `quick action`, `quick action gesture`, `touch action`, `two finger hold gesture`, `two finger gesture`, `two finger touchdown`, `two finger action`, or `two finger touch`. Targets normalize `note/notes`, `messages/messaging`, and `translate/translation/interpreter` to the three canonical values. |
| Wi-Fi setup | `connect to wifi`, `connect to wi fi`, `open wifi setup`, or `open wi fi setup`. |
| Create contact | `create/add [a] contact [for] <1-4 word name> with [phone] number <7-15 digit phone>` or `add <name> as a contact with [phone] number <phone>`. |
| Wi-Fi disconnect | `disconnect [from] wifi` or `disconnect [from] wi fi`. |
| Factory reset | `factory reset`, `factory reset my pin`, or `erase my pin`; unlock required and stock confirmation remains mandatory. |
| Reboot | `reboot`, `reboot device`, `reboot my pin`, `restart device`, or `restart my pin`. |
| Touchcode | `set up touchcode`, `setup touchcode`, or `create touchcode`. |
| Trust Lock | `trust lock`, `enable trust lock`, or `turn on trust lock`; unlock required. |
| Airplane mode | `turn on/off airplane mode` or `enable/disable airplane mode`. |
| Amber alerts | `turn on/off amber alert(s)` or `enable/disable amber alert(s)`; unlock required. |
| Bluetooth radio | `turn on/off bluetooth` or `enable/disable bluetooth`. |
| Cellular data | `turn on/off cellular data` or `enable/disable cellular data`; unlock required. |
| Cellular roaming | `turn on/off cellular roaming` or `enable/disable cellular roaming`; unlock required. |
| Power off | `turn off`, `power off`, or `shut down` + `device`, `the device`, or `my pin`. |
| Emergency alerts | `turn on/off emergency alert(s)` or `enable/disable emergency alert(s)`; unlock required. |
| Public-safety alerts | `turn on/off public safety alert(s)` or `enable/disable public safety alert(s)`; unlock required. |
| Wi-Fi radio | `turn on/off wifi`, `turn on/off wi fi`, `enable/disable wifi`, or `enable/disable wi fi`. |
| Wi-Fi QR | `scan wifi qr code`, `scan wi fi qr code`, `wifi qr scan`, or `wi fi qr scan`. |

## Safe verification

### Spoken, end-to-end

Use the read-only prompts first. For every test, record:

- the exact words spoken;
- whether the Pin was unlocked;
- whether Wi-Fi/mobile data and location were available;
- the visible or spoken response;
- whether a device action actually happened; and
- the timestamp, so operator logs can be correlated.

For location, use “Where am I?” before Nearby or route tests. For music, start
with a catalog question before playback. Test volume at a comfortable level.
Use a disposable timer/alarm and remove it afterward.

### Automated planning/coverage probe

The acceptance harness sends raw `Understand` requests and decodes returned
actions. It never passes `--dispatch`, so it cannot actually send a message,
place a call, play music, take a photo, or set an alarm.

```sh
node platform/deploy/acceptance/pin/tool-coverage.mjs --check-names
node platform/deploy/acceptance/pin/tool-coverage.mjs --serial SERIAL --only am_i_online,nearby_search
node platform/deploy/acceptance/pin/tool-coverage.mjs --serial SERIAL --json
```

Interpret results precisely:

| Result | Meaning |
| --- | --- |
| `reached` | A server read/write tool executed with `ok=true`. |
| `planned` | A native action was returned but not dispatched by the harness. |
| `failed` | The selected tool executed and returned `ok=false`. |
| `rejected` | A grounding or authorization gate refused the proposed mutation. |
| `gated` | Configuration intentionally hid or disabled the capability. |
| `unscoreable` | The raw probe cannot complete a required stock-device round trip. |
| `backend` | Provider/backend failure; no capability conclusion can be drawn. |
| `not-elicited` | Nothing selected or planned the intended capability. |

`current_location` is expected to be unscoreable in the raw harness when it
stages a device preflight. Verify that path with a real spoken turn.

## Providers, accounts, and known limits

- `web_search` is not advertised without a Brave subscription key.
- `food_lookup` returns the disabled result while the food runtime permit is
  off; enabling it still requires a working food provider.
- Music search, playback, favourites, queue, and playlist actions require the
  wearer’s linked provider account.
- Center's Music selector supports `spotify`, `youtube_music`, `apple_music`,
  and `tidal`. Spotify uses Penumbra's embedded librespot runtime. The other
  providers stay in separate Android apps and are controlled through their
  exported media session: [Metrolist](https://github.com/MetrolistGroup/Metrolist)
  (`com.metrolist.music`) for ad-free YouTube Music, Apple Music
  (`com.apple.android.music`), and TIDAL
  (`com.aspiro.tidal`). Selecting one does not install it or copy its login;
  install the app on the Pin and sign in inside the app first.
- External-provider catalog grounding uses MusicBrainz, while the selected app
  resolves and plays the actual media. Standard play, pause, resume, next,
  previous, restart, generated-playlist, and queue prompts share the native
  Humane action/observation boundary. Save/like and current-track radio fail
  closed if that app's active media session exposes no matching custom action.
- The humane-system-hook TIDAL localhost shim from
  [commit `6ac83120`](https://github.com/PenumbraOS/humane-system-hook/commit/6ac83120c8e75cda03048884751541842deae82e)
  is a useful stock-client proof of concept, but it bypasses auth with a stub
  token and serves a generated test tone. It is not used as real TIDAL account
  support.
- Current weather, Nearby, routing, and reverse geocoding depend on a usable
  current location and live place/weather providers.
- Shopping has a registered `VisualSearch` gRPC handler, but real shopping is
  unavailable without an allowlisted endpoint and API key.
- Translation’s deterministic prompt route supports English, French, Italian,
  Spanish, Portuguese, and German.
- Tickle and Quick Action remapping are feature-gated in the runtime; the clone
  serves their captured stock flags on by default.
- Adding, clearing, counting, and executing visual If-Then rules requires both
  `vision_actions_enabled=true` and `llm.vision_consent_acknowledged=true`.
  Source coverage is complete, but the gate remains off by default until the
  operator records camera-to-cloud consent.
- Starting fitness tracking requires `fitness_tracker_enabled=true`, which is
  off by default. Stopping remains reachable even while off so an active sensor
  session cannot be stranded.
- Calendar test-automation RPCs, contact CRUD, provisioning, privacy key
  management, and event ingestion are backend/device APIs. They are not
  registered conversational tools, so this reference does not claim that a
  spoken prompt such as “create a calendar event” is supported.
- Calculator and dictionary questions have no dedicated tools. The assistant
  answers them directly when it can.
- Physical projector rendering, audio quality, account OAuth refresh, and each
  real provider’s behavior remain separate end-to-end acceptance gates.

The acceptance catalog now represents every wearer-reachable path in
`native_device_actions.rs`, including video, gallery, session reset, lock,
privacy, fitness, tutorial, device identifiers, named Bluetooth operations,
Tickle, visual If-Then management, and Quick Action remapping. Gated rows report
`gated`, not a false coverage failure; enabled rows must plan their exact stock
action. This completes source and safe-planning coverage. A safe raw probe still
does not dispatch or physically prove camera, projector, sensor, Bluetooth, or
gesture execution.

## Cosmos gRPC interface appendix

The registry contains 22 services and 98 unique RPC paths. Every descriptor is
currently marked `Implemented` and points at a handler source. The evidence
grade is `Derived`: this proves source-level interface and handler coverage, not
byte-for-byte identity with Humane’s hidden backend or successful physical
acceptance of every path.

The full path for each entry is `/<service>/<method>`.

| Service | Count | Methods |
| --- | ---: | --- |
| `humane.account.FoodPreferencesService` | 4 | `EncryptedGetFoodRestrictions`, `EncryptedSetFoodRestrictions`, `GetUserDailyIntakeGoals`, `SetUserDailyIntakeGoals` |
| `humane.account.UserInformationService` | 1 | `GetUserPersonalDetails` |
| `humane.account.WifiConfigService` | 1 | `ListSecureWifiConfigs` |
| `humane.aibus.AIBusService` | 25 | `ActionExecutionTest`, `AnalyzeImage`, `BidirectionalStreamingUnderstand`, `EncryptedActionBasedInterstitial`, `EncryptedAnalyzeFoodImage`, `EncryptedAnalyzeImage`, `EncryptedChatCompletion`, `EncryptedCompletion`, `EncryptedFunctionExecution`, `EncryptedGeoLocate`, `EncryptedGetFoodItem`, `EncryptedLoadingMessage`, `EncryptedNavigationDirections`, `EncryptedNearbySearch`, `EncryptedReverseGeocode`, `EncryptedSmartPlaylist`, `EncryptedStreamAIBus`, `EncryptedUnderstand`, `EncryptedWeather`, `FunctionExecution`, `ServerStatefulUnderstand`, `TranscriptionRepairTest`, `Translate`, `Understand`, `UploadFile` |
| `humane.aibus.AmazonShoppingService` | 1 | `VisualSearch` |
| `humane.aibus.CompositionService` | 4 | `CategorizeNotifications`, `EncryptedComposeMessage`, `EncryptedSummarizeMessages`, `SummarizeNotifications` |
| `humane.aibus.DeviceMessagesService` | 3 | `BackupMessages`, `QueryMessages`, `UploadAttachment` |
| `humane.aibus.FoodService` | 2 | `EncryptedIdentifyFood`, `Feedback` |
| `humane.aibus.SpeechService` | 5 | `CanTranslate`, `StreamingTextToSpeech`, `TextToSpeech`, `TranslateConversation`, `TranslateText` |
| `humane.aibus.TestAutomationService` | 4 | `CreateNewCalendarEvents`, `DeleteAllCalendarEvents`, `GetCalendarEvents`, `InitializeCalendar` |
| `humane.aibus.WebSearchService` | 1 | `search` |
| `humane.capture.CaptureService` | 11 | `CreateMemory`, `DeclareMemoryCreateIntent`, `DeleteMemory`, `GetCaptureConfig`, `GetFoodLogSummary`, `GetMemoryShareLink`, `GetShareLinkContents`, `ReportPhotographyExperienceStatus`, `SaveSharedMemory`, `UploadComplete`, `UploadFile` |
| `humane.capture.TestingAutomationService` | 4 | `CreateNote`, `DeleteAllNotes`, `DeleteMemory`, `GetRecentNotes` |
| `humane.contacts.ContactsRPCService` | 7 | `CreateContacts`, `DeleteContacts`, `GetContactDeltas`, `GetContacts`, `GetContactsPaginatedStreaming`, `GetContactsStreaming`, `UpdateContacts` |
| `humane.events.DeviceEventsHistoryService` | 1 | `QueryEvents` |
| `humane.events.EventsIngestService` | 2 | `IngestBatch`, `Ingest` |
| `humane.featureflags.FeatureFlagsService` | 1 | `GetFlags` |
| `humane.location.v1.E911GeoLocationService` | 1 | `GeoLocate` |
| `humane.partnerservices.PartnerTokenRPCService` | 2 | `GetToken`, `GetTokens` |
| `humane.provisioning.DeviceOnboardingDACService` | 7 | `CreateDeviceUserBinding`, `CreateLoginFinish`, `CreateLoginInit`, `GetAssignedUserDAC`, `GetSubscriptionStatus`, `VerifyHmcAssociation`, `VerifyHmcByPass` |
| `humane.pushrelay.PushRelayService` | 2 | `GetPushTokens`, `Subscribe` |
| `humane.privacy.grpc.pub.PublicPrivacyService` | 9 | `EstablishWrappingKeys`, `GetConfiguration`, `GetSettings`, `ImportKeys`, `RemoveKeys`, `RequestKeys`, `SyncKeys`, `UpdateKeys`, `UpdateSettings` |

Interface coverage answers “is there a registered path and source handler?” It
does not by itself answer “does every stock client, provider, account state,
streaming sequence, physical UI, and spoken response behave exactly like the
original service?” Use the prompt catalog and physical acceptance checks for
that second question.
