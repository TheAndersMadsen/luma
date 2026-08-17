# Pin prompting map

Copy a prompt below and say it to the Pin. This map covers all 89 accepted
prompt capabilities: 37 model tools and 52 strict native routes.

`U` unlocked · `L` current location · `P` provider/account/config · `W` persistent
write · `DEVICE` changes the Pin · `LIVE` contacts another person/service ·
`GATED` needs a runtime flag or permit

Calls and messages can reach real people. Camera, radio, contact, power, reset,
lock, fitness, and `W` rows can change real device or account state. Native
prompts should be said exactly as shown.

## Model tools: 37

### Knowledge and memory

| Tool / action | Say this | Needs / effect |
| --- | --- | --- |
| `knowledge_lookup` | `Look up the Eiffel Tower and tell me how tall it is.` | Read |
| `web_search` | `Search the web for today's top news headline.` | P, GATED: Brave |
| `food_lookup` / `ManageNutrition` | `What is the calorie count of a Snickers bar?` | U, P, GATED: food permit |
| `remember_fact` | `Please remember that my favorite color is teal.` | U, W |
| `memory_search` | `What do you remember about me?` | U, private read |

### Device

| Tool / action | Say this | Needs / effect |
| --- | --- | --- |
| `get_current_time` / `GetCurrentTime` | `What time is it?` | Read |
| `get_battery_level` / `GetBatteryLevel` | `How much battery do I have left?` | Read |
| `am_i_online` / `AmIOnline` | `Am I connected to the internet?` | Read |
| `get_current_volume` / `GetCurrentVolume` | `What is the volume set to?` | Read |
| `set_alarm` / `Alarm` / `SetAlarm` | `Set an alarm for 7 am.` | DEVICE, W |
| `set_timer` / `Timer` / `SetTimer` | `Set a timer for 10 minutes.` | DEVICE, W |
| `increment_volume` / `IncrementVolume` | `Turn the volume up a bit.` | DEVICE |
| `decrement_volume` / `DecrementVolume` | `Turn the volume down a bit.` | DEVICE |
| `set_volume` / `SetVolume` | `Set the volume to 30.` | DEVICE, range 0-100 |

### Music

| Tool / action | Say this | Needs / effect |
| --- | --- | --- |
| `music_catalog_search` | `What is Dr. Dre's most popular song?` | P, read |
| `music_artist_top_tracks` | `What are Fleetwood Mac's top tracks?` | P, read |
| `current_music` | `What song is playing right now?` | U, P, read |
| `get_music_queue` / `GetMusicQueue` | `What is next in the queue?` | P, read |
| `play_music` / `PlayMusic` | `Play Dr. Dre's most popular song.` | P, DEVICE; grounded search first |
| `play_favorite_tracks` / `PlayFavoriteTracks` | `Play my favourites.` | P, DEVICE |
| `play_featured_music` / `PlayFeaturedMusic` | `Play some featured music.` | P, DEVICE |
| `pause_music` / `PauseMusic` | `Pause the music.` | P, DEVICE |
| `resume_music` / `ResumeMusic` | `Resume the music.` | P, DEVICE |
| `next_track` / `NextTrack` | `Skip this song.` | P, DEVICE |
| `previous_track` / `PreviousTrack` | `Go back to the previous song.` | P, DEVICE |
| `restart_track` / `RestartTrack` | `Start this song over.` | P, DEVICE |
| `save_current_track_to_favorites` / `SaveCurrentTrackToFavorites` | `Add this song to my favourites.` | P, W |
| `generate_music_playlist` / `GenerateMusicPlaylist` | `Make me a playlist for working out.` | P, DEVICE |

### Messaging and phone

| Tool / action | Say this | Needs / effect |
| --- | --- | --- |
| `send_message` / `ComposeMessage` | `Send a message to Alex saying I am running late.` | U, LIVE; stock confirmation flow |
| `call_person` / `CallPerson` | `Call Alex.` | U, LIVE; may place a real call |

### Location and weather

| Tool / action | Say this | Needs / effect |
| --- | --- | --- |
| `current_location` / `GetCurrentLocation` preflight | `Where am I?` | U, L, read |
| `current_weather` | `What's the weather here?` | U, L, P, read |
| `weather_at_place` after `place_search` | `What's the weather in Paris?` | P, read |
| `nearby_search` | `What's nearby?` | U, L, P, read |
| `place_search` | `Where is the Eiffel Tower?` | P, read |
| `route` | `How do I get to the train station?` | U, L, P; walk, drive, or cycle |
| `reverse_geocode` after `current_location` | `What is the address here?` | U, L, P, read |

## Native prompt routes: 52

These are strict compatibility routes, not model-callable tools.

### Everyday native routes

| Native route | Say this | Needs / effect |
| --- | --- | --- |
| `PlayCurrentTrackRadio` | `Play similar songs.` | P, DEVICE |
| `MessageSearch` -> `DisplayMessages` | `What did Alex say?` | U, private read |
| `CatchMeUp` | `Catch me up.` | U, private read |
| `CapturePhotograph` | `Take a photo.` | DEVICE, W |
| `GetBluetoothStatus` | `Is Bluetooth on?` | Read |
| `GetAirplaneModeStatus` | `Is airplane mode on?` | Read |
| `Settings` -> `DeviceStatus` | `Give me a device status report.` | U, read |
| `Translate` | `Translate good morning to French.` | P, read; six supported languages |
| `WorldClock` | `What time is it in Tokyo?` | Read; city is 1-3 words |

### Compatibility and gated routes

| Native route | Say this | Needs / effect |
| --- | --- | --- |
| `ClearUnderstandingContext` | `Reset session.` | DEVICE; clears short-term context |
| `CaptureVideo` | `Record a video.` | DEVICE, W |
| `StopVideo` | `Stop recording video.` | DEVICE |
| `OpenRecentPhotos` | `Show me my recent photos.` | U, private read |
| `LockDevice` | `Lock my device.` | U, DEVICE; immediate |
| `EnterPrivacyMode` | `Enter privacy mode.` | DEVICE |
| `StartActivityTracker` | `Start tracking my workout.` | DEVICE, GATED: fitness flag off by default |
| `StopActivityTracker` | `Stop tracking my workout.` | DEVICE; always available |
| `OpenTutorial` | `Open Laser Ink tutorial.` | U, DEVICE |
| `GetPhoneNumber` | `Tell me my phone number.` | Read; stock keyguard policy |
| `GetSerialNumber` | `Tell me my serial number.` | U, private read |
| `connect_bluetooth_device` -> `Settings` -> `ConnectToBluetooth` | `Connect to my Acme Nova X1.` | U, DEVICE; exact device-name match |
| `disconnect_bluetooth_device` -> `Settings` -> `DisconnectBluetooth` | `Disconnect from Acme Nova X1.` | U, DEVICE; paired device required |
| `Tickle` | `Tickle my fancy.` | DEVICE, GATED: clone default on |
| `AddIfThenEntry` | `If you see a red bicycle then take a picture.` | W, GATED: vision flag and consent |
| `ClearIfThenMap` | `Clear vision actions.` | W, GATED: deletes all visual rules |
| `GetIfThenMapSize` | `Tell me the number of vision actions.` | Read, GATED: vision flag and consent |
| `ChangeQuickAction` | `Change my quick action to notes.` | W, GATED; notes, messages, or interpreter |

### Stock settings, contact, and lifecycle routes

| Native route | Say this | Needs / effect |
| --- | --- | --- |
| `ConnectToWifi` | `Connect to Wi-Fi.` | DEVICE; opens the installed selector/QR flow |
| `CreateContact` | `Add a contact Ada Lovelace with phone number +45 12 34 56 78.` | U, W; stock always makes the new contact trusted |
| `DisconnectWifi` | `Disconnect from Wi-Fi.` | DEVICE |
| `FactoryReset` | `Factory reset my Pin.` | U, DEVICE; opens stock confirmation, do not confirm on a non-sacrificial Pin |
| `Reboot` | `Reboot my Pin.` | DEVICE; immediate interruption |
| `SetUpTouchcode` | `Set up Touchcode.` | DEVICE; opens stock enrollment |
| `TrustLock` | `Enable Trust Lock.` | U, DEVICE |
| `TurnOffAirplaneMode` | `Turn off airplane mode.` | DEVICE |
| `TurnOffAmberAlert` | `Turn off Amber alerts.` | U, DEVICE; carrier support may vary |
| `TurnOffBluetooth` | `Turn off Bluetooth.` | DEVICE |
| `TurnOffCellularData` | `Turn off cellular data.` | U, DEVICE; interrupts mobile data |
| `TurnOffCellularRoaming` | `Turn off cellular roaming.` | U, DEVICE; SIM/carrier dependent |
| `TurnOffDevice` | `Turn off my Pin.` | DEVICE; powers down immediately |
| `TurnOffEmergencyAlert` | `Turn off emergency alerts.` | U, DEVICE; carrier/region support may vary |
| `TurnOffPublicSafetyAlert` | `Turn off public safety alerts.` | U, DEVICE; carrier/region support may vary |
| `TurnOffWifi` | `Turn off Wi-Fi.` | DEVICE; can take the Pin offline |
| `TurnOnAirplaneMode` | `Turn on airplane mode.` | DEVICE; disables radios according to stock behavior |
| `TurnOnAmberAlert` | `Turn on Amber alerts.` | U, DEVICE; carrier support may vary |
| `TurnOnBluetooth` | `Turn on Bluetooth.` | DEVICE |
| `TurnOnCellularData` | `Turn on cellular data.` | U, DEVICE; SIM/carrier dependent |
| `TurnOnCellularRoaming` | `Turn on cellular roaming.` | U, DEVICE; SIM/carrier dependent and may incur charges |
| `TurnOnEmergencyAlert` | `Turn on emergency alerts.` | U, DEVICE; carrier/region support may vary |
| `TurnOnPublicSafetyAlert` | `Turn on public safety alerts.` | U, DEVICE; carrier/region support may vary |
| `TurnOnWifi` | `Turn on Wi-Fi.` | DEVICE |
| `WifiQrScan` | `Scan Wi-Fi QR code.` | DEVICE; opens the installed scanner; credentials stay on-device |

For JSON arguments, exact grammar variants, safe verification, and all Cosmos
gRPC methods, use the [full prompting and tool reference](prompting-and-tool-reference.md).
