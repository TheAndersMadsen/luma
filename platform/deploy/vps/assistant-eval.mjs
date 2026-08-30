#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");

export const ASSISTANT_CASES = Object.freeze([
  Object.freeze({
    id: "reasoning",
    prompt: "Explain in one sentence why the daytime sky appears blue.",
    requiredActions: ["Respond"],
    forbiddenActions: [],
    route: "a1",
    terminal: "answered",
  }),
  ...[
    ["arithmetic", "What is 15 percent of 80?", /\b(?:12|twelve)\b/iu],
    [
      "unit-conversion",
      "How many kilometers is 5 miles?",
      /\b8(?:\.0?5)?\s*(?:km|kilometers?)\b/iu,
    ],
    [
      "ice-floats",
      "Explain why ice floats on water in one sentence.",
      /\b(?:less dense|lower density|expands?|hydrogen bonds?|crystalline)\b/iu,
    ],
    [
      "definition-ubiquitous",
      "What does ubiquitous mean?",
      /\b(?:everywhere|widespread|omnipresent|commonplace)\b/iu,
    ],
    ["knowledge-pride-austen", "Who wrote Pride and Prejudice?", /\bJane Austen\b/iu],
    [
      "knowledge-eiffel-height",
      "How tall is the Eiffel Tower?",
      /\b(?:330|324|1,?083)\s*(?:m|met(?:er|re)s?|ft|feet)?\b/iu,
    ],
  ].map(([id, prompt, answerPattern]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["Respond"],
    forbiddenActions: ["web_search", "ask_online", "PlayMusic"],
    exactActionCounts: { Respond: 1 },
    answerPattern,
    route: "a1",
    terminal: "answered",
  })),
  Object.freeze({
    id: "assistant-capabilities",
    prompt: "What can you do?",
    requiredActions: ["Respond"],
    forbiddenActions: ["PlayMusic", "CallPerson", "ComposeMessage", "CapturePhotograph"],
    exactActionCounts: { Respond: 1 },
    answerPattern: /\b(?:weather|music|search|directions|messages|notes|timers?|alarms?)\b/iu,
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "chitchat-joke",
    prompt: "Tell me a joke.",
    requiredActions: ["Respond"],
    forbiddenActions: ["web_search", "ask_online", "PlayMusic"],
    exactActionCounts: { Respond: 1 },
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "music-direct-track",
    prompt: "Play One Dance by Drake.",
    requiredActions: ["PlayMusic"],
    forbiddenActions: ["music_discover", "ask_online", "web_search", "Respond"],
    exactActionCounts: { PlayMusic: 1 },
    expectedActionInputFields: { PlayMusic: { Artist: "Drake", Track: "One Dance" } },
    route: "a1",
    terminal: "device_action",
    authenticatedWearer: true,
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "music-direct-album",
    prompt: "Play the album Thriller by Michael Jackson.",
    requiredActions: ["PlayMusic"],
    forbiddenActions: ["music_discover", "ask_online", "web_search", "Respond"],
    exactActionCounts: { PlayMusic: 1 },
    expectedActionInputFields: {
      PlayMusic: { Album: "Thriller", Artist: "Michael Jackson" },
    },
    route: "a1",
    terminal: "device_action",
    authenticatedWearer: true,
    simulateUnlockedPin: true,
  }),
  ...[
    [
      "music-workout-playlist",
      "Play my workout playlist.",
      "PlayMusic",
      { PlayMusic: { Option: /\bworkout\b/iu } },
    ],
    ["music-featured", "Play music.", "PlayFeaturedMusic"],
    ["music-favourites", "Play my favourites.", "PlayFavoriteTracks"],
    [
      "music-generate-running",
      "Make me a playlist for running.",
      "GenerateMusicPlaylist",
      { GenerateMusicPlaylist: { Playlist: /\brunn(?:er|ing)\b/iu } },
    ],
  ].map(([id, prompt, action, expectedActionInputPatterns]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["music_discover", "ask_online", "web_search", "Respond"],
    exactActionCounts: { [action]: 1 },
    ...(expectedActionInputPatterns ? { expectedActionInputPatterns } : {}),
    route: "a1",
    terminal: "device_action",
    authenticatedWearer: true,
    simulateUnlockedPin: true,
  })),
  Object.freeze({
    id: "music-ranked-information",
    prompt: "What is Michael Jackson's most popular song?",
    requiredActions: ["ask_online", "Respond"],
    forbiddenActions: ["music_discover", "PlayMusic"],
    exactActionCounts: { ask_online: 1, Respond: 1 },
    answerPattern: /\bBillie Jean\b/iu,
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "music-ranked-dr-dre-information",
    prompt: "What is Dr. Dre’s most popular song?",
    requiredActions: ["Respond"],
    requiredActionGroups: [["ask_online", "web_search"]],
    forbiddenActions: ["music_discover", "PlayMusic"],
    exactActionCounts: { Respond: 1 },
    exactActionGroupCounts: [{ actions: ["ask_online", "web_search"], count: 1 }],
    answerPattern: /\b(?:Still D\.?R\.?E\.?|The Next Episode)\b/iu,
    route: "a1",
    terminal: "answered",
  }),
  ...[
    ["music-ranked-dr-dre-popular", "Play Dr. Dre’s most popular song."],
    ["music-ranked-drake-popular", "Play the most popular song by Drake."],
    ["music-ranked-drake-viral", "Look up the most viral song by Drake and play it."],
    [
      "music-ranked-drake-controversial-2013",
      "Play Drake’s most controversial song from 2013.",
    ],
    [
      "music-ranked-michael-jackson-best",
      "Look up the best songs by Michael Jackson and play the most popular.",
    ],
  ].map(([id, prompt]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["music_discover", "PlayMusic"],
    requiredActionGroups: [["ask_online", "web_search"]],
    forbiddenActions: ["Respond"],
    exactActionCounts: { music_discover: 1, PlayMusic: 1 },
    exactActionGroupCounts: [{ actions: ["ask_online", "web_search"], count: 1 }],
    providerGroundedMusic: true,
    route: "a2",
    terminal: "device_action",
    simulateUnlockedPin: true,
    authenticatedWearer: true,
  })),
  Object.freeze({
    id: "fresh-web-search",
    prompt: "What is the latest news in Denmark?",
    requiredActions: ["Respond"],
    requiredActionGroups: [["ask_online", "web_search"]],
    forbiddenActions: [],
    exactActionGroupCounts: [{ actions: ["ask_online", "web_search"], count: 1 }],
    route: "a1",
    terminal: "answered",
    answerPattern: /\b(?:Denmark|Danish|Copenhagen|Greenland)\b/iu,
    forbiddenAnswerPattern:
      /(?:couldn['’]t|could not|unable to) find|no reliable (?:current )?(?:result|news)/iu,
  }),
  Object.freeze({
    id: "tour-de-france-current",
    prompt: "Who won the Tour de France this year?",
    requiredActions: ["Respond"],
    requiredActionGroups: [["ask_online", "web_search"]],
    forbiddenActions: ["PlayMusic"],
    exactActionCounts: { Respond: 1 },
    exactActionGroupCounts: [{ actions: ["ask_online", "web_search"], count: 1 }],
    answerPattern: /\b(?:Tour de France|won|winner)\b/iu,
    forbiddenAnswerPattern: /(?:couldn['’]t|could not|unable to) find|no reliable result/iu,
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "compound-research",
    prompt: "Make two separate lookups: search the web for the latest news in Denmark, look up the Eiffel Tower on Wikipedia, then summarize both.",
    requiredActions: ["web_search", "wikipedia", "Respond"],
    forbiddenActions: [],
    route: "a2",
    terminal: "answered",
  }),
  Object.freeze({
    id: "explicit-lookup",
    prompt: "Look up the Eiffel Tower and tell me how tall it is.",
    requiredActions: ["wikipedia", "Respond"],
    forbiddenActions: [],
    route: "a1",
    terminal: "answered",
  }),
  Object.freeze({
    id: "current-product-price",
    prompt: "How much does a Humane AI Pin cost?",
    requiredActions: ["ask_online", "Respond"],
    forbiddenActions: [],
    route: "a1",
    terminal: "answered",
    answerPattern:
      /discontinued|no longer (?:sold|available)|not (?:currently )?(?:sold|available)/iu,
  }),
  Object.freeze({
    id: "nutrition-oatmeal",
    prompt: "What are the nutrition facts for oatmeal?",
    requiredActions: ["food_lookup", "Respond"],
    forbiddenActions: [],
    exactActionCounts: { food_lookup: 1 },
    route: "a1",
    terminal: "answered",
    answerPattern: /\b(?:calories|kcal|protein|fiber|fibre|carbohydrate|fat)\b/iu,
  }),
  Object.freeze({
    id: "show-my-notes",
    prompt: "Show my notes.",
    requiredActions: ["recall_memory", "Respond"],
    forbiddenActions: [],
    exactActionCounts: { recall_memory: 1 },
    route: "a1",
    terminal: "answered",
  }),
  ...[
    [
      "future-weather-limit",
      "What will the weather be tomorrow?",
      /future weather forecasts are not available/iu,
      ["GetCurrentLocation", "current_weather", "weather"],
    ],
    [
      "transit-routing-limit",
      "Give me transit directions to Nyhavn.",
      /transit routing is not supported/iu,
      ["GetCurrentLocation", "route"],
    ],
  ].map(([id, prompt, answerPattern, forbiddenActions]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["Respond"],
    forbiddenActions,
    exactActionCounts: { Respond: 1 },
    answerPattern,
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["show-timers", "Show my timers.", "Timer"],
    ["show-alarms", "Show my alarms.", "Alarm"],
  ].map(([id, prompt, action]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond"],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: { Request: prompt } },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["timer-set-five-minutes", "Set a timer for five minutes.", "Timer"],
    ["timer-pause", "Pause my timer.", "Timer"],
    ["timer-resume", "Resume my timer.", "Timer"],
    ["timer-add-one-minute", "Add one minute to my timer.", "Timer"],
    ["timer-delete", "Delete my timer.", "Timer"],
    ["alarm-set-seven", "Set an alarm for 7 AM.", "Alarm"],
    ["alarm-set-weekday", "Set a weekday alarm for 7:30 AM.", "Alarm"],
    ["alarm-cancel-seven", "Cancel my 7 AM alarm.", "Alarm"],
    ["alarm-cancel", "Cancel my alarm.", "Alarm"],
  ].map(([id, prompt, action]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond"],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: { Request: prompt } },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["food-log-today", "What have I eaten today?"],
    ["food-calories-today", "How many calories have I eaten today?"],
    ["food-log-three-days", "Show my food log for the last three days."],
    ["food-track-eggs", "I ate two eggs."],
    ["food-track-banana", "Track my food: one banana."],
  ].map(([id, prompt]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["ManageNutrition"],
    forbiddenActions: ["Respond", "PlayMusic"],
    exactActionCounts: { ManageNutrition: 1 },
    expectedActionInputs: { ManageNutrition: { Request: prompt } },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["reset-session", "Reset session.", "ClearUnderstandingContext", {}],
    [
      "messages-recent-read",
      "Read my recent messages.",
      "DisplayMessages",
      { IDs: [], MessageCount: 10, Person: [] },
    ],
    [
      "messages-contact-read",
      "Read my messages from Alex.",
      "DisplayMessages",
      { IDs: [], MessageCount: 10, Person: ["Alex"] },
    ],
    [
      "messages-search-read",
      "Search my messages for dinner.",
      "MessageSearch",
      { Person: [], Query: "dinner" },
    ],
    [
      "messages-contact-topic-read",
      "What did Alex say about dinner?",
      "MessageSearch",
      { Person: ["Alex"], Query: "dinner" },
    ],
    ["messages-open-ui", "Open messages.", "OpenMessagesMainMenu", {}],
    ["notifications-catch-up-read", "Catch me up.", "CatchMeUp", {}],
    ["contacts-open-ui", "Open contacts.", "OpenContacts", {}],
    [
      "contacts-search-read",
      "Search contacts for Alex.",
      "Contacts",
      { Request: "Search contacts for Alex" },
    ],
    [
      "contacts-phone-read",
      "What is the phone number for Alex?",
      "Contacts",
      { Request: "What is the phone number for Alex" },
    ],
    [
      "contacts-quick-read",
      "Who are my quick messaging contacts?",
      "Contacts",
      { Request: "Who are my quick messaging contacts" },
    ],
    ["dialer-open-ui", "Open dialer.", "OpenDialerHome", {}],
    ["dialpad-open-ui", "Open the dial pad.", "OpenDialpad", {}],
    ["recent-calls-open-ui", "Open recent calls.", "OpenRecentCalls", {}],
    [
      "translation-good-morning-french",
      "Translate good morning from English to French.",
      "Translate",
      { Source: "English", Target: "French", Text: "good morning" },
    ],
    [
      "translation-hello-spanish",
      "Translate hello to Spanish.",
      "Translate",
      { Target: "Spanish", Text: "hello" },
    ],
    [
      "translation-thank-you-japanese",
      "How do you say thank you in Japanese?",
      "Translate",
      { Target: "Japanese", Text: "thank you" },
    ],
    [
      "recent-photos-open-ui",
      "Show my recent photos.",
      "OpenRecentPhotos",
      { TriggeredFromTouchpad: false },
    ],
    ["music-queue-read", "What's in my music queue?", "GetMusicQueue", {}],
    [
      "vision-action-count-read",
      "Tell me the number of vision actions.",
      "GetIfThenMapSize",
      {},
    ],
  ].map(([id, prompt, action, input]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: [
      "Respond",
      "CallPerson",
      "ComposeMessage",
      "CapturePhotograph",
      "CaptureVideo",
      "PlayMusic",
      "TurnOffWifi",
      "TurnOffCellularData",
    ],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: input },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  ...[
    ["walking", "walking"],
    ["driving", "driving"],
    ["cycling", "bicycling"],
  ].map(([wording, mode]) => Object.freeze({
    id: `route-${wording}-nyhavn`,
    prompt: `Give me ${wording} directions to Nyhavn.`,
    requiredActions: ["GetCurrentLocation", "route", "Respond"],
    forbiddenActions: ["nearby"],
    exactActionCounts: { GetCurrentLocation: 1, route: 1 },
    expectedActionInputs: { route: { destination: "Nyhavn", mode } },
    route: "a1",
    terminal: "answered",
    simulateUnlockedPin: true,
    simulateLocation: true,
  })),
  ...[
    ["current-city-read", "What city am I in?", "reverse_geocode", {}, "a1"],
    ["weather-here", "What's the weather here?", "weather", {}, "a1"],
    [
      "weather-umbrella-local",
      "Should I bring an umbrella here today?",
      "weather",
      {},
      "a1",
      ["a1", "a2"],
    ],
    ["nearby-bare", "What's nearby?", "nearby", { query: "" }, "a1"],
    [
      "nearby-coffee",
      "Find coffee shops nearby.",
      "nearby",
      { query: "coffee shops" },
      "a1",
    ],
    [
      "nearest-coffee",
      "Find the nearest coffee shop.",
      "nearby",
      { query: "coffee shop" },
      "a1",
    ],
  ].map(([id, prompt, action, input, route, routes]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["GetCurrentLocation", action, "Respond"],
    forbiddenActions: ["PlayMusic", "CapturePhotograph", "CallPerson"],
    exactActionCounts: { GetCurrentLocation: 1, [action]: 1 },
    expectedActionInputs: { [action]: input },
    route,
    ...(routes ? { routes } : {}),
    terminal: "answered",
    simulateUnlockedPin: true,
    simulateLocation: true,
  })),
  ...[
    ["weather-copenhagen", "What is the weather in Copenhagen right now?", /\bCopenhagen\b/iu],
    ["weather-capital-australia", "What is the weather in the capital of Australia?", /\bCanberra\b/iu],
  ].map(([id, prompt, answerPattern]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["weather", "Respond"],
    forbiddenActions: ["GetCurrentLocation", "PlayMusic"],
    exactActionCounts: { weather: 1, Respond: 1 },
    answerPattern,
    route: "a1",
    routes: ["a1", "a2"],
    terminal: "answered",
  })),
  Object.freeze({
    id: "nearest-coffee-route",
    prompt: "Find the nearest coffee shop and navigate there.",
    requiredActions: ["GetCurrentLocation", "nearby", "route", "Respond"],
    forbiddenActions: ["PlayMusic", "CapturePhotograph", "CallPerson"],
    exactActionCounts: { GetCurrentLocation: 1, nearby: 1, route: 1, Respond: 1 },
    expectedActionInputs: { nearby: { query: "coffee shop" } },
    route: "a2",
    terminal: "answered",
    simulateUnlockedPin: true,
    simulateLocation: true,
  }),
  Object.freeze({
    id: "weather-and-nearby",
    prompt: "What's the weather here and what's nearby?",
    requiredActions: ["GetCurrentLocation", "weather", "nearby", "Respond"],
    forbiddenActions: ["PlayMusic", "CapturePhotograph", "CallPerson"],
    exactActionCounts: { GetCurrentLocation: 1, weather: 1, nearby: 1 },
    expectedActionInputs: { weather: {}, nearby: { query: "" } },
    route: "a2",
    terminal: "answered",
    simulateUnlockedPin: true,
    simulateLocation: true,
  }),
  ...[
    [
      "volume-up-relative",
      "Turn the volume up a bit.",
      "IncrementVolume",
      {},
      ["DecrementVolume", "SetVolume"],
    ],
    [
      "volume-up-plain",
      "Make it louder.",
      "IncrementVolume",
      {},
      ["DecrementVolume", "SetVolume"],
    ],
    [
      "volume-down-relative",
      "Turn the volume down a bit.",
      "DecrementVolume",
      {},
      ["IncrementVolume", "SetVolume"],
    ],
    [
      "volume-set-30",
      "Set the volume to 30.",
      "SetVolume",
      { level: 30 },
      ["IncrementVolume", "DecrementVolume"],
    ],
  ].map(([id, prompt, action, input, forbiddenActions]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions,
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: input },
    route: "a1",
    terminal: "device_action",
  })),
  ...[
    ["music-pause", "Pause the music.", "PauseMusic"],
    ["music-resume", "Resume the music.", "ResumeMusic"],
    ["music-next", "Skip this song.", "NextTrack"],
    ["music-previous", "Previous track.", "PreviousTrack"],
    ["music-restart", "Restart this song.", "RestartTrack"],
    ["music-save-current", "Save this song.", "SaveCurrentTrackToFavorites"],
    ["music-current-radio", "Play similar music.", "PlayCurrentTrackRadio"],
    ["music-pause-semantic", "Pause playback for now.", "PauseMusic"],
  ].map(([id, prompt, action]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond", "PlayMusic"],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: {} },
    route: "a1",
    terminal: "device_action",
  })),
  ...[
    ["pin-current-time", "What time is it?", "GetCurrentTime", {}],
    ["pin-battery-level", "Battery level.", "GetBatteryLevel", {}],
    ["pin-current-volume", "What is the current volume?", "GetCurrentVolume", {}],
    ["pin-online-status", "Am I online?", "AmIOnline", {}],
    ["pin-device-status", "Device status.", "Settings", { Request: "Device status." }],
    ["pin-bluetooth-status", "Is Bluetooth on?", "GetBluetoothStatus", {}],
    ["pin-airplane-status", "Airplane mode status.", "GetAirplaneModeStatus", {}],
    ["pin-phone-number", "What is my phone number?", "GetPhoneNumber", {}],
    ["pin-serial-number", "What is my serial number?", "GetSerialNumber", {}],
    ["pin-current-location", "Where am I?", "GetCurrentLocation", {}],
  ].map(([id, prompt, action, input]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond"],
    expectedActionInputs: { [action]: input },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  })),
  Object.freeze({
    id: "pin-nutrition-apple",
    prompt: "How many calories are in an apple?",
    requiredActions: ["ManageNutrition"],
    forbiddenActions: ["Respond"],
    expectedActionInputs: {
      ManageNutrition: { Request: "How many calories are in an apple?" },
    },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "pin-nutrition-eggs",
    prompt: "How much protein is in two eggs?",
    requiredActions: ["ManageNutrition"],
    forbiddenActions: ["Respond"],
    expectedActionInputs: {
      ManageNutrition: { Request: "How much protein is in two eggs?" },
    },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "pin-world-clock-tokyo",
    prompt: "What time is it in Tokyo?",
    requiredActions: ["WorldClock"],
    forbiddenActions: ["Respond", "GetCurrentTime"],
    expectedActionInputs: { WorldClock: { Location: "Tokyo" } },
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "ambiguous-no-vision",
    prompt: "Um, what was that thing?",
    requiredActions: ["Respond"],
    forbiddenActions: ["UnderstandScene"],
    route: "a1",
    terminal: "answered",
  }),
  ...[
    [
      "music-control-hypothetical",
      "What happens if I say ‘pause the music’?",
      ["PauseMusic", "PlayMusic"],
      /\b(?:pause|music|playback|song|stop|temporar)\w*\b/iu,
    ],
    [
      "photo-how-to-negative",
      "How do I take a photo?",
      ["CapturePhotograph", "CaptureVideo"],
      /\b(?:photo|capture|camera)\b/iu,
    ],
    [
      "messages-information-negative",
      "Tell me about text messages.",
      ["ComposeMessage", "CallPerson"],
      /\b(?:message|text|SMS)\b/iu,
    ],
  ].map(([id, prompt, forbiddenActions, answerPattern]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["Respond"],
    forbiddenActions,
    exactActionCounts: { Respond: 1 },
    ...(answerPattern ? { answerPattern } : {}),
    route: "a1",
    terminal: "answered",
  })),
  Object.freeze({
    id: "negative-volume-complaint",
    prompt: "The music is too loud.",
    requiredActions: [],
    requiredActionGroups: [["Respond", "DecrementVolume"]],
    forbiddenActions: ["IncrementVolume", "SetVolume"],
    exactActionGroupCounts: [{ actions: ["Respond", "DecrementVolume"], count: 1 }],
    route: "a1",
    terminals: ["answered", "device_action"],
  }),
  ...[
    ["tickle", "Tickle."],
    ["tickle-fancy", "Tickle my fancy."],
    ["tickle-triple", "Tickle tickle tickle."],
  ].map(([id, prompt]) => Object.freeze({
    id,
    prompt,
    requiredActions: ["Tickle"],
    forbiddenActions: ["Respond"],
    exactActionCounts: { Tickle: 1 },
    expectedActionInputs: { Tickle: {} },
    route: "a1",
    terminal: "device_action",
  })),
  ...[
    ["wifi-off", "Turn off Wi-Fi.", "TurnOffWifi", ["TurnOnWifi"], "a1", true],
    ["wifi-on", "Turn on Wi-Fi.", "TurnOnWifi", ["TurnOffWifi"], "a1", true],
    ["wifi-connect", "Connect to Wi-Fi.", "ConnectToWifi", ["DisconnectWifi"], "d1", false],
    ["wifi-qr-scan", "Scan Wi-Fi QR code.", "WifiQrScan", ["ConnectToWifi"], "d1", false],
    ["wifi-disconnect", "Disconnect Wi-Fi.", "DisconnectWifi", ["TurnOffWifi"], "a1", true],
    ["bluetooth-on", "Turn on Bluetooth.", "TurnOnBluetooth", ["TurnOffBluetooth"], "a1", true],
    ["bluetooth-off", "Turn off Bluetooth.", "TurnOffBluetooth", ["TurnOnBluetooth"], "a1", true],
  ].map(([id, prompt, action, oppositeActions, route, modelInvoked]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond", ...oppositeActions],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: {} },
    route,
    terminal: "device_action",
    ...(modelInvoked ? {} : { modelInvoked: false, simulateUnlockedPin: true }),
  })),
  ...[
    ["cellular-data-on", "Turn on cellular data.", "TurnOnCellularData", "TurnOffCellularData"],
    ["cellular-data-off", "Turn off cellular data.", "TurnOffCellularData", "TurnOnCellularData"],
    [
      "cellular-roaming-off",
      "Turn off cellular roaming.",
      "TurnOffCellularRoaming",
      "TurnOnCellularRoaming",
    ],
  ].map(([id, prompt, action, oppositeAction]) => Object.freeze({
    id,
    prompt,
    requiredActions: [action],
    forbiddenActions: ["Respond", oppositeAction],
    exactActionCounts: { [action]: 1 },
    expectedActionInputs: { [action]: {} },
    route: "a1",
    terminal: "device_action",
    simulateUnlockedPin: true,
  })),
  Object.freeze({
    id: "cellular-roaming-on-confirmation",
    prompt: "Turn on cellular roaming.",
    requiredActions: ["Respond"],
    forbiddenActions: ["TurnOnCellularRoaming"],
    exactActionCounts: { Respond: 1 },
    answerPattern: /\b(?:roaming|charge)\w*\b/iu,
    route: "a1",
    terminal: "confirmation_required",
    simulateUnlockedPin: true,
  }),
  Object.freeze({
    id: "tickle-near-miss",
    prompt: "Please tickle.",
    requiredActions: ["Respond"],
    forbiddenActions: ["Tickle"],
    route: "d1",
    terminal: "device_action",
    modelInvoked: false,
  }),
  Object.freeze({
    id: "consequential-confirmation",
    prompt: "Call Alex.",
    requiredActions: ["Respond"],
    forbiddenActions: ["CallPerson"],
    route: "a1",
    terminal: "confirmation_required",
  }),
]);

function decodePrometheusString(value) {
  return value.replaceAll(/\\([\\"n])/gu, (_, escaped) => {
    if (escaped === "n") return "\n";
    return escaped;
  });
}

function labelsKey(labels) {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

export function agentRunSamples(scrape) {
  const samples = new Map();
  for (const line of String(scrape).split(/\r?\n/u)) {
    const match = /^cosmos_agent_runs_total\{([^}]*)\}\s+([0-9]+(?:\.[0-9]+)?)$/u.exec(line);
    if (!match) continue;
    const labels = {};
    for (const label of match[1].matchAll(/([a-z_]+)="((?:\\.|[^"])*)"/gu)) {
      labels[label[1]] = decodePrometheusString(label[2]);
    }
    samples.set(labelsKey(labels), { labels, value: Number(match[2]) });
  }
  return samples;
}

export function changedAgentRuns(beforeScrape, afterScrape) {
  const before = agentRunSamples(beforeScrape);
  const after = agentRunSamples(afterScrape);
  const changed = [];
  for (const [key, sample] of after) {
    const delta = sample.value - (before.get(key)?.value ?? 0);
    if (delta > 0) changed.push({ ...sample, delta });
  }
  return changed;
}

export function evaluateAssistantCase(spec, trace, beforeScrape, afterScrape) {
  const failures = [];
  const steps = Array.isArray(trace?.steps) ? trace.steps : [];
  const actions = steps
    .filter((step) => step?.kind === "action" || step?.kind === "answer")
    .map((step) => step.name)
    .filter((name) => typeof name === "string");
  for (const required of spec.requiredActions) {
    if (!actions.includes(required)) failures.push(`missing_action:${required}`);
  }
  for (const group of spec.requiredActionGroups ?? []) {
    if (!group.some((action) => actions.includes(action))) {
      failures.push(`missing_action_group:${group.join("|")}`);
    }
  }
  for (const forbidden of spec.forbiddenActions) {
    if (actions.includes(forbidden)) failures.push(`forbidden_action:${forbidden}`);
  }
  for (const [action, expected] of Object.entries(spec.exactActionCounts ?? {})) {
    if (actions.filter((name) => name === action).length !== expected) {
      failures.push(`action_count:${action}`);
    }
  }
  for (const group of spec.exactActionGroupCounts ?? []) {
    const count = actions.filter((name) => group.actions.includes(name)).length;
    if (count !== group.count) failures.push(`action_group_count:${group.actions.join("|")}`);
  }
  for (const [action, expected] of Object.entries(spec.expectedActionInputs ?? {})) {
    const matching = steps
      .filter((step) => step?.kind === "action" && step?.name === action)
      .some((step) => {
        try {
          return JSON.stringify(JSON.parse(step.input)) === JSON.stringify(expected);
        } catch {
          return false;
        }
      });
    if (!matching) failures.push(`action_input:${action}`);
  }
  for (const [action, expected] of Object.entries(spec.expectedActionInputFields ?? {})) {
    const matching = steps
      .filter((step) => step?.kind === "action" && step?.name === action)
      .some((step) => {
        try {
          const actual = JSON.parse(step.input);
          return actual !== null && typeof actual === "object" && !Array.isArray(actual) &&
            Object.entries(expected).every(([field, value]) => actual[field] === value);
        } catch {
          return false;
        }
      });
    if (!matching) failures.push(`action_input_fields:${action}`);
  }
  for (const [action, expected] of Object.entries(spec.expectedActionInputPatterns ?? {})) {
    const matching = steps
      .filter((step) => step?.kind === "action" && step?.name === action)
      .some((step) => {
        try {
          const actual = JSON.parse(step.input);
          return actual !== null && typeof actual === "object" && !Array.isArray(actual) &&
            Object.entries(expected).every(([field, pattern]) => {
              const value = actual[field];
              if (typeof value !== "string" || !(pattern instanceof RegExp)) return false;
              pattern.lastIndex = 0;
              return pattern.test(value);
            });
        } catch {
          return false;
        }
      });
    if (!matching) failures.push(`action_input_patterns:${action}`);
  }
  if (spec.answerPattern) {
    const answers = steps
      .filter((step) => step?.kind === "answer" && step?.name === "Respond")
      .map((step) => step.text)
      .filter((text) => typeof text === "string");
    if (!answers.some((answer) => spec.answerPattern.test(answer))) {
      failures.push("answer_mismatch");
    }
    if (
      spec.forbiddenAnswerPattern &&
      answers.some((answer) => spec.forbiddenAnswerPattern.test(answer))
    ) {
      failures.push("answer_forbidden");
    }
  }
  if (spec.providerGroundedMusic) {
    const observation = steps.find(
      (step) => step?.kind === "observation" && step?.name === "music_discover",
    );
    const playback = steps.find(
      (step) => step?.kind === "action" && step?.name === "PlayMusic",
    );
    let grounded = null;
    let actionInput = null;
    try {
      grounded = JSON.parse(observation?.text ?? "");
      actionInput = JSON.parse(playback?.input ?? "");
    } catch {
      // The single closed failure below covers malformed or absent evidence
      // without including provider, catalog, or wearer data in the report.
    }
    const title = grounded?.track?.title;
    const artist = grounded?.track?.artist;
    const provider = grounded?.provider;
    if (
      grounded?.status !== "grounded" ||
      !["spotify", "youtube_music", "tidal"].includes(provider) ||
      grounded?.ranking_provenance !== "not_ranked" ||
      typeof grounded?.discovery_provenance !== "string" ||
      grounded.discovery_provenance.length === 0 ||
      typeof title !== "string" ||
      title.length === 0 ||
      typeof artist !== "string" ||
      artist.length === 0 ||
      actionInput?.Track !== title ||
      actionInput?.Artist !== artist
    ) {
      failures.push("music_not_provider_grounded");
    }
  }
  if (!Number.isFinite(trace?.total_ms) || !Number.isFinite(trace?.device_deadline_ms)) {
    failures.push("malformed_latency");
  } else if (trace.total_ms > trace.device_deadline_ms) {
    failures.push("device_deadline");
  }

  const expectedModelInvoked = spec.modelInvoked ?? true;
  const candidates = changedAgentRuns(beforeScrape, afterScrape).filter(
    ({ labels }) =>
      labels.transport === "legacy" &&
      labels.planner_plane === "cosmos_remote" &&
      labels.model_invoked === String(expectedModelInvoked),
  );
  const routes = Array.isArray(spec.routes) ? spec.routes : [spec.route];
  const terminals = Array.isArray(spec.terminals) ? spec.terminals : [spec.terminal];
  const run = candidates.find(
    ({ labels }) => routes.includes(labels.route) && terminals.includes(labels.terminal),
  );
  if (!run) {
    failures.push("missing_model_run");
  } else if (expectedModelInvoked) {
    for (const label of ["model_provider", "model", "model_speed", "reasoning_effort"]) {
      if (!run.labels[label] || run.labels[label] === "unreported") {
        failures.push(`missing_provenance:${label}`);
      }
    }
  }

  return {
    id: spec.id,
    pass: failures.length === 0,
    failures,
    actions,
    totalMs: Number.isFinite(trace?.total_ms) ? trace.total_ms : null,
    run: run
      ? {
          route: run.labels.route,
          terminal: run.labels.terminal,
          modelProvider: run.labels.model_provider,
          model: run.labels.model,
          speed: run.labels.model_speed,
          effort: run.labels.reasoning_effort,
          modelSteps: run.labels.model_steps,
          modelInvoked: run.labels.model_invoked === "true",
        }
      : null,
  };
}

function usage() {
  return "usage: revival eval assistant production [--repeat N] [--case ID] [--json] [--env-file FILE] [--project-name NAME]";
}

export function parseArguments(argv, environment = process.env) {
  const options = {
    repeat: 2,
    caseId: null,
    json: false,
    envFile: environment.REVIVAL_ENV_FILE,
    projectName: environment.COMPOSE_PROJECT_NAME || "ai-pin-revival",
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (
      seen.has(name) ||
      !["--repeat", "--case", "--json", "--env-file", "--project-name"].includes(name)
    ) {
      throw new Error(usage());
    }
    seen.add(name);
    if (name === "--json") {
      options.json = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(usage());
    if (name === "--repeat") {
      options.repeat = Number(value);
      if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 5) {
        throw new Error("--repeat must be an integer from 1 through 5");
      }
    } else if (name === "--case") {
      if (!ASSISTANT_CASES.some(({ id }) => id === value)) {
        throw new Error(`unknown assistant evaluation case: ${value}`);
      }
      options.caseId = value;
    } else if (name === "--env-file") {
      options.envFile = path.resolve(ROOT, value);
    } else {
      options.projectName = value;
    }
    index += 1;
  }
  if (!options.envFile) throw new Error("REVIVAL_ENV_FILE is required");
  return options;
}

function composeArguments(options) {
  const operatorCompose = path.join(
    process.env.REVIVAL_CONFIG_DIR || "",
    "production",
    "operator.compose.yaml",
  );
  const application = process.env.REVIVAL_COMPOSE_APPLICATION;
  if (!process.env.REVIVAL_CONFIG_DIR || !application) {
    throw new Error("validated production configuration is required");
  }
  return [
    "compose",
    "--project-directory",
    ROOT,
    "--project-name",
    options.projectName,
    "--env-file",
    options.envFile,
    "-f",
    application,
    "-f",
    operatorCompose,
  ];
}

const AUTHENTICATED_WEARER_CURL = [
  'wearer="${COSMOS_ENROLLMENT_USER_ID:-}"',
  'case "$wearer" in',
  '  ""|*[!A-Za-z0-9_-]*)',
  '    echo "configured wearer identity is unavailable" >&2',
  "    exit 78",
  "    ;;",
  "esac",
  'if [ "${#wearer}" -gt 125 ]; then',
  '  echo "configured wearer identity is unavailable" >&2',
  "  exit 78",
  "fi",
  'exec curl --header "x-forwarded-client-cert: V:01:D:assistant-eval:U:$wearer" "$@"',
].join("\n");

export function assistantCurlCommand(curlArguments, spec = {}) {
  if (!spec.authenticatedWearer) return ["curl", ...curlArguments];
  return ["sh", "-eu", "-c", AUTHENTICATED_WEARER_CURL, "assistant-eval", ...curlArguments];
}

function inAiBus(options, curlArguments, input, spec) {
  const command = assistantCurlCommand(curlArguments, spec);
  const result = spawnSync(
    "docker",
    [...composeArguments(options), "exec", "-T", "ai-bus", ...command],
    { encoding: "utf8", input, maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `docker compose exec exited ${result.status}`);
  }
  return result.stdout;
}

function metrics(options) {
  return inAiBus(options, ["--fail", "--silent", "--show-error", "--max-time", "5", "http://127.0.0.1:8080/metrics"]);
}

export function assistantTracePayload(spec) {
  return {
    text: spec.prompt,
    ...(spec.simulateUnlockedPin ? { simulate_unlocked_pin: true } : {}),
    ...(spec.simulateLocation ? { simulate_location: true } : {}),
  };
}

function trace(options, spec) {
  const raw = inAiBus(
    options,
    [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "95",
      "--header",
      "content-type: application/json",
      "--data-binary",
      "@-",
      "http://127.0.0.1:8080/demo-api/trace",
    ],
    JSON.stringify(assistantTracePayload(spec)),
    spec,
  );
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("assistant trace returned malformed JSON");
  }
}

export function renderReport(report) {
  const lines = [
    `Cosmos assistant production evaluation: ${report.passed}/${report.total} passed`,
  ];
  for (const result of report.results) {
    const provenance = result.run
      ? ` ${result.run.modelProvider}/${result.run.model} ${result.run.speed} ${result.run.effort}`
      : "";
    lines.push(
      `${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.totalMs ?? "?"}ms ${result.run?.route ?? "no-run"}/${result.run?.terminal ?? "unknown"}${provenance}`,
    );
    if (result.failures.length) lines.push(`  ${result.failures.join(", ")}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = [];
  const cases = options.caseId
    ? ASSISTANT_CASES.filter(({ id }) => id === options.caseId)
    : ASSISTANT_CASES;
  for (let round = 0; round < options.repeat; round += 1) {
    for (const spec of cases) {
      const before = metrics(options);
      const response = trace(options, spec);
      const after = metrics(options);
      results.push(evaluateAssistantCase(spec, response, before, after));
    }
  }
  const passed = results.filter((result) => result.pass).length;
  const report = { schemaVersion: 1, repeats: options.repeat, passed, total: results.length, results };
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : renderReport(report)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

if (path.resolve(process.argv[1] || "") === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
