// Behavioural expectations for the assistant, as data.
//
// Each case says what the PLANNER must do for an utterance: which actions must
// appear, and which must never appear. Run with:
//
//   node platform/deploy/acceptance/pin/prompt-eval.mjs --serial SERIAL --suite [--repeat 3] [--json]
//
// Why expectations and not just timings: "it just works" is not a latency
// claim. Every defect found on this device was a wrong ACTION — a volume
// request answered with prose, a play request that searched forever, a nearby
// query refused for grounding. Those are all visible here as a missing or
// forbidden action name.
//
// `forbid` matters as much as `expect`. A suite that only checks for the right
// action will pass a build that also does something extra and wrong, and the
// costly failures on this project have been exactly that shape: an action
// firing on a request that never asked for it.
//
// Scope: this drives the raw Understand probe, which bypasses stock speech
// recognition and never dispatches returned actions. Green here means the
// server planned correctly. It does not mean the Pin spoke, played, or sounded
// right — that remains a human listening pass.

// `requiresDeviceRoundTrip` marks cases the raw probe CANNOT score. Location
// requests return a NATIVE_ACTIONS.GET_CURRENT_LOCATION preflight in ~200ms
// and then wait for the stock client to supply a fix; this harness cannot
// answer a preflight, so
// the follow-on read never runs. Scoring them as failures reported three
// phantom regressions for hours. They are reported SKIP and need a real spoken
// turn to verify.
//
// `measurement: true` marks a case whose expectation is NOT YET VERIFIED on this
// build. It is run and REPORTED, but not counted pass/fail, because a
// permanently-red case teaches everyone to ignore the suite — the same damage as
// a green one that proves nothing. It is deliberately NOT an escape hatch for a
// case the assistant fails: the moment an expectation is verified reachable, the
// flag comes off and the case becomes a contract that may go red. Every
// `measurement` note must say what would promote or delete it.
//
// A NAME THAT DOES NOT EXIST IS THE WORST FAILURE MODE HERE, because it is
// invisible in both directions: an `expect` for a nonexistent action can never
// pass, and a `forbid` for one can never trip. Both shipped in this suite until
// 2026-07-28 (`current_time`, `TakePhoto`). See KNOWN_ABSENT_ACTION_NAMES below.
import {
  NATIVE_ACTIONS,
  OPERATIONAL_MARKERS,
} from "./tier-a-symbols.mjs";

export const SUITE = [
  // ---- Device control: the .120/.122/.123 chain -------------------------
  {
    id: "volume-up-relative",
    prompt: "turn the volume up a bit",
    expect: [NATIVE_ACTIONS.INCREMENT_VOLUME],
    forbid: [NATIVE_ACTIONS.SET_VOLUME, NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Shipped inert in .120: tool advertised, catalog grounding refused it.",
  },
  {
    id: "volume-up-plain",
    prompt: "make it louder",
    expect: [NATIVE_ACTIONS.INCREMENT_VOLUME],
    forbid: [NATIVE_ACTIONS.DECREMENT_VOLUME],
    note: "Phrasing with no the-word 'volume' at all. Paired with volume-up-relative: the two FLIPPED pass/fail on identical code before .136, which is how the coin-flip was found.",
  },
  {
    id: "volume-down-relative",
    prompt: "turn the volume down a bit",
    expect: [NATIVE_ACTIONS.DECREMENT_VOLUME],
    forbid: [NATIVE_ACTIONS.INCREMENT_VOLUME],
    note: "Mirror of volume-up-relative. The forbid matters most: an inverted control is worse than a missing one.",
  },
  {
    id: "volume-exact",
    prompt: "set the volume to 30",
    expect: [NATIVE_ACTIONS.SET_VOLUME],
    forbid: [
      NATIVE_ACTIONS.INCREMENT_VOLUME,
      NATIVE_ACTIONS.DECREMENT_VOLUME,
    ],
    note: `${NATIVE_ACTIONS.SET_VOLUME} needs a literal level; relative asks must not reach it.`,
  },

  // ---- Music: the .129-.135 grounding chain ------------------------------
  {
    id: "music-artist-top-track",
    prompt: "play Dr. Dre's most popular song",
    expect: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "0/N until .135. Grounding refused every result; see the .134 record.",
  },
  {
    id: "music-favourites",
    prompt: "play my favourites",
    expect: [NATIVE_ACTIONS.PLAY_FAVORITE_TRACKS],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Exposed in .117; rank-one play cannot express it.",
  },
  {
    id: "music-question-not-command",
    prompt: "what is Dr. Dre's most popular song",
    forbid: [
      NATIVE_ACTIONS.PLAY_MUSIC,
      NATIVE_ACTIONS.PLAY_FAVORITE_TRACKS,
      NATIVE_ACTIONS.PLAY_FEATURED_MUSIC,
    ],
    note: "NEGATIVE CONTROL: a question must never start playback.",
  },
  {
    id: "music-queue-read",
    prompt: "what's in my music queue?",
    expect: [NATIVE_ACTIONS.GET_MUSIC_QUEUE],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.NEXT_TRACK],
    note: "A queue question is a fieldless read and must not alter playback.",
  },
  ...[
    ["music-current-title-read", "what song is playing?"],
    ["music-current-artist-read", "who is this song by?"],
    ["music-current-album-read", "what album is this from?"],
  ].map(([id, prompt]) => ({
    id,
    prompt,
    expect: ["current_music"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.NEXT_TRACK],
    note: "Current-player metadata is a local read and must not alter playback.",
  })),

  // ---- Reads -------------------------------------------------------------
  {
    id: "nearby-bare",
    requiresDeviceRoundTrip: true,
    prompt: "what's nearby",
    expect: ["nearby_search"],
    note: "Unsatisfiable before .119: no named category, yet a query was required.",
  },
  {
    id: "weather-here",
    requiresDeviceRoundTrip: true,
    prompt: "what's the weather here",
    expect: ["current_weather"],
    note: `Returns a ${NATIVE_ACTIONS.GET_CURRENT_LOCATION} preflight in ~200ms and waits for the stock client. Scored as a failure for hours before that was understood.`,
  },
  {
    id: "current-city-read",
    requiresDeviceRoundTrip: true,
    prompt: "what city am I in?",
    expect: ["reverse_geocode"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "The city answer must use the Pin location followed by reverse geocoding.",
  },
  {
    id: "weather-umbrella-local",
    requiresDeviceRoundTrip: true,
    prompt: "should I bring an umbrella here today?",
    expect: ["current_weather"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "The umbrella answer requires current local conditions rather than model memory.",
  },
  {
    id: "weather-copenhagen",
    prompt: "what is the weather in Copenhagen right now?",
    expect: ["weather_at_place"],
    forbid: [NATIVE_ACTIONS.GET_CURRENT_LOCATION],
    note: "An explicit city should be resolved directly without requesting device location.",
  },
  {
    id: "weather-dependent-capital",
    prompt: "what is the weather in the capital of Australia?",
    expect: ["weather_at_place"],
    forbid: [NATIVE_ACTIONS.GET_CURRENT_LOCATION],
    note: "The assistant must resolve Canberra before requesting current weather.",
  },
  {
    id: "nearby-coffee",
    requiresDeviceRoundTrip: true,
    prompt: "find coffee shops nearby",
    expect: ["nearby_search"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "A named nearby category still requires current Pin location.",
  },
  {
    id: "nearest-coffee",
    requiresDeviceRoundTrip: true,
    prompt: "find the nearest coffee shop",
    expect: ["nearby_search"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Nearest-place lookup must be grounded in current Pin location.",
  },
  {
    id: "nearest-coffee-route",
    requiresDeviceRoundTrip: true,
    prompt: "find the nearest coffee shop and navigate there",
    expect: ["nearby_search", "route"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "The compound request must resolve a real nearby place before routing to it.",
  },
  ...[
    ["route-walking", "give me walking directions to Nyhavn"],
    ["route-driving", "give me driving directions to Nyhavn"],
    ["route-cycling", "give me cycling directions to Nyhavn"],
  ].map(([id, prompt]) => ({
    id,
    requiresDeviceRoundTrip: true,
    prompt,
    expect: ["route"],
    forbid: ["nearby_search"],
    note: "A named-destination route must preserve its requested travel mode after location preflight.",
  })),
  {
    id: "future-weather-limit",
    prompt: "what will the weather be tomorrow",
    expectAnswerAll: ["future weather forecasts", "not available"],
    forbid: [NATIVE_ACTIONS.GET_CURRENT_LOCATION, "current_weather"],
    note: "A known product limitation must be truthful, immediate, and tool-less. It must not request the current location or silently substitute current conditions for a forecast.",
  },
  {
    id: "transit-routing-limit",
    prompt: "give me transit directions to Nyhavn",
    expectAnswerAll: ["transit routing", "not supported"],
    forbid: [NATIVE_ACTIONS.GET_CURRENT_LOCATION, "route"],
    note: "Transit is not implemented by the recovered navigation surface. An explicit transit request must explain that limitation without requesting location or inventing a route in another travel mode.",
  },
  {
    id: "compound-request",
    requiresDeviceRoundTrip: true,
    prompt: "what's the weather here and what's nearby",
    expect: ["current_weather", "nearby_search"],
    note: "Both tools must SUCCEED, but NOT in parallel. The loop executes only \
the first call in provider order and resolves siblings as failed observations \
(chat_turn_loop: read_and_mutation_siblings_execute_one_at_a_time_after_replanning), \
so the model must replan and run the second on a later step. A `tool_calls=2` \
step is the model PROPOSING two, not two executing — reading it as parallel \
execution is a misreading of the one-operation contract (Ghidra deep dive S6).",
  },
  {
    id: "knowledge",
    prompt: "how tall is the Eiffel Tower",
    // `expect: ["knowledge_lookup"]` REMOVED 2026-07-28 — it was an invalid
    // contract, not a regression. Nothing blocks the tool: it is always
    // advertised (catalog.rs:872-881), its `required_user_terms` are NOT
    // enforced on the hermes path, and its grounding gate passes for this
    // prompt. Calling it is purely the model's discretion, and on
    // codex/gpt-5.6-sol it almost never does for a stable fact — measured over
    // the on-disk probe summaries: "what is the capital of France?" 1
    // knowledge_lookup in 23 runs, "who wrote Romeo and Juliet?" 1 in 13. An
    // expectation satisfied ~5% of the time is not a contract; it fails forever
    // and trains everyone to ignore the suite. Scored by answer + forbid now;
    // knowledge-lookup-explicit below keeps the .137 token-gate coverage.
    expectAnswer: ["330", "324", "1,083", "1083"],
    forbid: [
      NATIVE_ACTIONS.PLAY_MUSIC,
      NATIVE_ACTIONS.INCREMENT_VOLUME,
      "nearby_search",
    ],
    note: "EXPECTATION WAS WRONG (not the assistant): answering a stable fact from model memory is correct and faster, so requiring a knowledge_lookup call here was never satisfiable — measured 1-in-23 and 1-in-13 on equivalent stable-fact prompts. The original .137 point (the model queries \"Eiffel Tower height\" — every word from the request but not one contiguous span, which the token gate allows and the span gate refused) is now pinned by knowledge-lookup-explicit. Heights accept 330m/324m/1,083ft.",
  },
  {
    id: "knowledge-lookup-explicit",
    prompt: "look up the Eiffel Tower and tell me how tall it is",
    expect: ["knowledge_lookup"],
    forbid: ["web_search", NATIVE_ACTIONS.PLAY_MUSIC],
    // MEASUREMENT, not a contract — see `measurement` in the header comment.
    // Rationale is evidence-based but the prompt itself is UNVERIFIED on this
    // build: explicit instruction is what actually drives tool use here
    // (measured: "what is the latest news about SpaceX? search the web" ->
    // web_search ok=true, while "what is one recent news headline today?" used
    // no tool). Whether that transfers to knowledge_lookup has not been run.
    measurement: true,
    note: "UNVERIFIED on this build: added 2026-07-28 to preserve the .137 token-gate coverage that `knowledge` lost, using EXPLICIT lookup phrasing because that is what measurably drives tool use. No run of this exact prompt exists yet, so it is reported as a MEASURE rather than counted pass/fail. Promote it to a contract (drop `measurement`) once a baseline run shows knowledge_lookup firing reliably; delete it if explicit phrasing turns out not to help either.",
  },

  // ---- Open-web search: the .115 Brave path ------------------------------
  // `web_search` uses a TOKEN gate (require_grounded_query_tokens), not the
  // contiguous-span gate the other reads use. That distinction exists because
  // a usable search query drops filler and reorders terms; demanding one span
  // refused every query and made the tool unreachable. These cases pin that
  // the current-events family reaches the web rather than being answered from
  // model memory, which is what "feels like tao" depends on.
  {
    id: "web-current-events",
    prompt: "what is the latest news in Denmark",
    expect: ["web_search"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.INCREMENT_VOLUME],
    note:
      "Current-events family; must not be answered from stale model memory. KEPT AS A CONTRACT (unlike `knowledge`): answering \"the latest news\" from training data is a real ASSISTANT defect, not a legitimate shortcut, so a red here indicts the assistant. Its 2026-07-28 FAIL? was environmental — codex was wedged mid-run (" +
      OPERATIONAL_MARKERS.backend_unavailable.value +
      ") — so the expectation is UNPROVEN rather than disproven, and this needs a re-run on a healthy backend. Two preconditions before blaming the planner: web_search is HIDDEN entirely unless a Brave subscription key is configured (tools/catalog.rs:2658-2661), and it uses the permissive TOKEN gate, not the contiguous-span gate. Brave IS configured on this device (one web_search ok=true measured), so the tool is reachable.",
  },
  {
    id: "web-result-lookup",
    prompt: "who won the Tour de France this year",
    expect: ["web_search"],
    note:
      "A live result is not general knowledge; knowledge_lookup cannot answer it. Same status as web-current-events: a red indicts the ASSISTANT, but the 2026-07-28 run was environmental (" +
      OPERATIONAL_MARKERS.backend_unavailable.value +
      ") so this is unproven pending a healthy re-run.",
  },
  {
    id: "web-price",
    prompt: "how much does a Humane AI Pin cost",
    expect: ["web_search"],
    note: "Price is a current-events family member: it changes, so the encyclopedia path cannot answer it. Same status as web-current-events: unproven pending a healthy re-run, and a red indicts the ASSISTANT.",
  },
  {
    id: "knowledge-not-web",
    prompt: "who wrote Pride and Prejudice",
    // `expect: ["knowledge_lookup"]` REMOVED for the same measured reason as
    // `knowledge` (1-in-13 on the near-identical "who wrote Romeo and Juliet?").
    // The load-bearing assertions here were always the FORBIDS — no web burn and
    // no title-shaped music misroute — plus answer correctness. Those stay.
    expectAnswer: ["austen"],
    // The music reads are here rather than only on the plain-question control
    // because this is the prompt where the misroute actually fires. Measured on
    // `.145`: 1 music_catalog_search in 8 runs here, and 0 in 8 runs of "what is
    // the capital of France".
    //
    // The difference looks like the entity, not the question type: "Pride and
    // Prejudice" is TITLE-SHAPED, so a catalog lookup is a plausible-but-wrong
    // read in a way it never is for "France". Any future fix should be judged
    // against title-shaped subjects, which is what this case now supplies.
    forbid: ["web_search", "music_catalog_search", "music_artist_top_tracks"],
    note: "A stable fact must not burn a web search: slower, and it needlessly leaves the device. Also pins that a title-shaped subject does not pull the planner into the music catalog — measured 1-in-8 before this rule existed. The knowledge_lookup expectation was dropped 2026-07-28 as unsatisfiable model discretion (EXPECTATION wrong, not the assistant); the forbids and the answer are the real contract here.",
  },

  // ---- Negative controls -------------------------------------------------
  {
    id: "unrelated-question-no-device-action",
    prompt: "what is the capital of France",
    forbid: [
      NATIVE_ACTIONS.INCREMENT_VOLUME,
      NATIVE_ACTIONS.DECREMENT_VOLUME,
      NATIVE_ACTIONS.SET_VOLUME,
      NATIVE_ACTIONS.PLAY_MUSIC,
      NATIVE_ACTIONS.PAUSE_MUSIC,
      NATIVE_ACTIONS.NEXT_TRACK,
      // Reads too, not just mutations. Every forbid rule in this suite used to
      // name an action that CHANGES DEVICE STATE, so "must not play music" was
      // pinned while "must not go looking through the music catalog" was not.
      // Measured at 8 repeats on `.145`: `music_catalog_search` fired once on
      // "who wrote Pride and Prejudice" — a music lookup on a literature
      // question, invisible to this suite because it is a read.
      //
      // A misrouted read is not harmless. It spends a provider round-trip and a
      // model step on a turn that never mentioned music, and on this device
      // that is the difference between a 5s answer and a 12s one.
      "music_catalog_search",
      "music_artist_top_tracks",
    ],
    note: "NEGATIVE CONTROL: no device mutation may fire on a plain question, and no music READ either — the read case was found only by measuring at 8 repeats.",
  },
  {
    id: "negated-volume",
    prompt: "the music is too loud",
    forbid: [NATIVE_ACTIONS.INCREMENT_VOLUME, NATIVE_ACTIONS.SET_VOLUME],
    note: "NEGATIVE CONTROL: a complaint is not a command. Must not raise volume.",
  },
  {
    id: "tickle-near-miss",
    prompt: "please tickle",
    expectAnswerAll: ["tickle", "exact phrases"],
    forbid: [NATIVE_ACTIONS.TICKLE],
    note: "NEGATIVE CONTROL: the optional Tickle action accepts only its three exact phrases. Polite decoration must explain the boundary without triggering it.",
  },

  // ---- Everyday coverage (added 2026-07-28 as a BASELINE, not as regressions)
  //
  // The cases above each encode a defect this device actually shipped. The ones
  // below are different in kind and must not be read the same way: they exist so
  // the suite covers what a real wearer asks day to day, and their first run is a
  // MEASUREMENT, not a pass/fail contract. Where an expectation is a genuine
  // guess it says so in the note; annotate them from observed behaviour rather
  // than treating an unproven `expect` as a regression.
  //
  // `expectAnswer` (new, optional) checks the SPOKEN TEXT, not just the action.
  // It exists because action-only scoring cannot see the failure mode measured on
  // this device: a backend error returns FASTER than a real answer and still
  // arrives as a well-formed NATIVE_ACTIONS.RESPOND, so a suite that only counts
  // actions — and
  // a harness that only records answer LENGTH — both score a broken assistant as
  // healthy. See `evaluateAnswer` and UNAVAILABLE_ANSWER_PATTERNS below.
  // The next four (answer-arithmetic, answer-unit-conversion,
  // answer-stable-fact, definition) are TOOL-LESS BY CONSTRUCTION. There is no
  // calculator and no dictionary anywhere in the product: READ_TOOL_CATALOG has
  // 14 entries and mutation_specs() has 22, and none of them compute or define.
  // The model answers directly, so any tool `expect` here would be invalid the
  // same way `current_time`/`TakePhoto` were. Their 2026-07-28 FAILs were
  // harness bug #1 alone (the answer was read from keys that do not exist) and
  // contain NO assistant-behaviour signal — do not read that baseline as a
  // regression, and do not "fix" these by adding an expect.
  {
    id: "assistant-capabilities",
    prompt: "what can you do?",
    expectAnswerAll: [
      "play music",
      "set timers and alarms",
      "answer questions",
      "take photos",
      "send messages",
      "make calls",
      "look up contacts",
      "translate",
    ],
    forbid: ["web_search", "ask_online", "music_catalog_search"],
    note: "The capability answer is derived from the dispatchable stock catalog. Every wearer-facing category must be named; matching one generic capability is not enough, and answering must not spend a remote lookup.",
  },
  {
    id: "answer-arithmetic",
    prompt: "what is 15 percent of 80",
    expectAnswer: ["12"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, "web_search"],
    note: `ANSWER-CORRECTNESS ANCHOR. Deterministic and unambiguous, so a wrong or error answer is unarguable — this is the case that catches a wedged backend that still returns a fast, well-formed ${NATIVE_ACTIONS.RESPOND}.`,
  },
  {
    id: "answer-unit-conversion",
    prompt: "how many kilometers is 5 miles",
    expectAnswer: ["8"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "ANSWER-CORRECTNESS ANCHOR (~8.05 km). Matches the leading digit only, so rounding or phrasing does not cause a false failure.",
  },
  {
    id: "answer-stable-fact",
    prompt: "how many continents are there",
    expectAnswer: ["seven", "7"],
    forbid: ["web_search", NATIVE_ACTIONS.PLAY_MUSIC],
    note: "ANSWER-CORRECTNESS ANCHOR. A stable fact must not burn a web search.",
  },
  {
    id: "time-of-day",
    prompt: "what time is it",
    expect: [NATIVE_ACTIONS.GET_CURRENT_TIME],
    note:
      "EXPECTATION WAS WRONG, now verified: `current_time` exists nowhere in runtime/core/src or docs/, so this case could never pass. The real action is " +
      `${NATIVE_ACTIONS.GET_CURRENT_TIME} (catalog.rs:1438), reached WITHOUT the model by the deterministic alias table (native_device_actions.rs:155-164), whose first entry is this exact prompt. Device-verified twice on disk (test-runs/session-20260724-160445-cce3f0a8 and session-20260727-215734-43500081): a single ${NATIVE_ACTIONS.GET_CURRENT_TIME} frame, ~2.0s, zero tool calls. Expect the PascalCase ACTION, never the model-facing tool \`get_current_time\` (tools/catalog.rs:492) — that is a mutation, and mutations log \`${OPERATIONAL_MARKERS.mutation.value}\`, not \`${OPERATIONAL_MARKERS.tool_executed.value}\`, so their snake_case name can never enter this harness's action pool.`,
  },
  {
    id: "battery-level-read",
    prompt: "battery level",
    expect: [NATIVE_ACTIONS.GET_BATTERY_LEVEL],
    forbid: [NATIVE_ACTIONS.SETTINGS, NATIVE_ACTIONS.RESPOND],
    note: "The exact status prompt is a device-local native read. It must not spend a model response or open the broader Settings experience.",
  },
  {
    id: "current-volume-read",
    prompt: "what is the current volume",
    expect: [NATIVE_ACTIONS.GET_CURRENT_VOLUME],
    forbid: [NATIVE_ACTIONS.SET_VOLUME, NATIVE_ACTIONS.INCREMENT_VOLUME],
    note: "A volume question is read-only. It must not be confused with an absolute or relative volume mutation.",
  },
  {
    id: "online-status-read",
    prompt: "am I online",
    expect: [NATIVE_ACTIONS.AM_I_ONLINE],
    forbid: [NATIVE_ACTIONS.SETTINGS, "web_search"],
    note: "Connectivity status comes from the Pin itself; a successful web request is not a substitute for reading the active device transport.",
  },
  {
    id: "device-status-read",
    prompt: "device status",
    expect: [NATIVE_ACTIONS.SETTINGS],
    forbid: [NATIVE_ACTIONS.RESPOND],
    note: "The broad status summary belongs to the stock Settings agent and requires an unlocked physical Pin when dispatched.",
  },
  {
    id: "bluetooth-status-read",
    prompt: "is Bluetooth on",
    expect: [NATIVE_ACTIONS.GET_BLUETOOTH_STATUS],
    forbid: [NATIVE_ACTIONS.TURN_ON_BLUETOOTH, NATIVE_ACTIONS.TURN_OFF_BLUETOOTH],
    note: "A Bluetooth-state question must remain a read and never toggle the radio.",
  },
  {
    id: "airplane-mode-status-read",
    prompt: "airplane mode status",
    expect: [NATIVE_ACTIONS.GET_AIRPLANE_MODE_STATUS],
    forbid: [NATIVE_ACTIONS.TURN_ON_AIRPLANE_MODE, NATIVE_ACTIONS.TURN_OFF_AIRPLANE_MODE],
    note: "This is deliberately read-only because changing airplane mode can sever the Cosmos connection.",
  },
  {
    id: "phone-number-read",
    prompt: "what is my phone number",
    expect: [NATIVE_ACTIONS.GET_PHONE_NUMBER],
    forbid: [NATIVE_ACTIONS.OPEN_DIALER_HOME, NATIVE_ACTIONS.CALL_PERSON],
    note: "The carrier-provided number is read from the Pin. Asking for it must not open the dialer or initiate a call.",
  },
  {
    id: "serial-number-read",
    prompt: "what is my serial number",
    expect: [NATIVE_ACTIONS.GET_SERIAL_NUMBER],
    forbid: [NATIVE_ACTIONS.SETTINGS, NATIVE_ACTIONS.RESPOND],
    note: "The hardware serial is an unlocked device-local read, not a model-generated answer.",
  },
  {
    id: "reset-session",
    prompt: "reset session",
    expect: [NATIVE_ACTIONS.CLEAR_UNDERSTANDING_CONTEXT],
    forbid: [NATIVE_ACTIONS.MANAGE_MEMORY, NATIVE_ACTIONS.RESPOND],
    note: "The exact stock phrase clears only short-term understanding context.",
  },
  {
    id: "current-location-read",
    prompt: "where am I",
    expect: [NATIVE_ACTIONS.GET_CURRENT_LOCATION],
    forbid: ["nearby_search", "current_weather"],
    note: "A bare location question requests the Pin's current position only; it must not silently turn into nearby search or weather.",
  },
  {
    id: "world-clock-tokyo",
    prompt: "what time is it in Tokyo",
    expect: [NATIVE_ACTIONS.WORLD_CLOCK],
    forbid: [NATIVE_ACTIONS.GET_CURRENT_TIME, NATIVE_ACTIONS.RESPOND],
    note: "A named-location time question must dispatch WorldClock with the location instead of returning the Pin's local time or model prose.",
  },
  {
    id: "show-timers",
    prompt: "show my timers.",
    expect: [NATIVE_ACTIONS.TIMER],
    forbid: [NATIVE_ACTIONS.ALARM, NATIVE_ACTIONS.RESPOND],
    note: "The read-only timer display request enters the stock Timer child agent; its child-planner contract requires DisplayTimer.",
  },
  {
    id: "show-alarms",
    prompt: "show my alarms.",
    expect: [NATIVE_ACTIONS.ALARM],
    forbid: [NATIVE_ACTIONS.TIMER, NATIVE_ACTIONS.RESPOND],
    note: "The read-only alarm display request enters the stock Alarm child agent; its child-planner contract requires DisplayAlarm.",
  },
  {
    id: "messages-recent-read",
    prompt: "read my recent messages",
    expect: [NATIVE_ACTIONS.DISPLAY_MESSAGES],
    forbid: [NATIVE_ACTIONS.COMPOSE_MESSAGE, NATIVE_ACTIONS.CALL_PERSON],
    note: "Reading recent messages must not compose, send, or call.",
  },
  {
    id: "messages-search-read",
    prompt: "search my messages for dinner",
    expect: [NATIVE_ACTIONS.MESSAGE_SEARCH],
    forbid: [NATIVE_ACTIONS.COMPOSE_MESSAGE, NATIVE_ACTIONS.CALL_PERSON],
    note: "A local message search remains a read-only messages action.",
  },
  {
    id: "messages-open-ui",
    prompt: "open messages",
    expect: [NATIVE_ACTIONS.OPEN_MESSAGES_MAIN_MENU],
    forbid: [NATIVE_ACTIONS.COMPOSE_MESSAGE],
    note: "Opening the messages UI must not create a draft.",
  },
  {
    id: "notifications-catch-up-read",
    prompt: "catch me up",
    expect: [NATIVE_ACTIONS.CATCH_ME_UP],
    forbid: [NATIVE_ACTIONS.COMPOSE_MESSAGE, NATIVE_ACTIONS.CALL_PERSON],
    note: "Notification catch-up is read-only and requires the stock summary action.",
  },
  {
    id: "contacts-open-ui",
    prompt: "open contacts",
    expect: [NATIVE_ACTIONS.OPEN_CONTACTS],
    forbid: [NATIVE_ACTIONS.CREATE_CONTACT, NATIVE_ACTIONS.CALL_PERSON],
    note: "Opening contacts must not create or call a contact.",
  },
  {
    id: "contacts-search-read",
    prompt: "search contacts for Alex",
    expect: [NATIVE_ACTIONS.CONTACTS],
    forbid: [NATIVE_ACTIONS.CREATE_CONTACT, NATIVE_ACTIONS.CALL_PERSON],
    note: "Contact lookup enters the stock Contacts child without mutating the address book.",
  },
  {
    id: "contacts-phone-read",
    prompt: "what is the phone number for Alex?",
    expect: [NATIVE_ACTIONS.CONTACTS],
    forbid: [NATIVE_ACTIONS.CALL_PERSON, NATIVE_ACTIONS.COMPOSE_MESSAGE],
    note: "A contact-number question resolves through Contacts and never initiates communication.",
  },
  {
    id: "contacts-quick-read",
    prompt: "who are my quick messaging contacts?",
    expect: [NATIVE_ACTIONS.CONTACTS],
    forbid: [NATIVE_ACTIONS.SET_QUICK_MESSAGING_CONTACT],
    note: "Listing quick contacts is distinct from changing them.",
  },
  {
    id: "dialer-open-ui",
    prompt: "open dialer",
    expect: [NATIVE_ACTIONS.OPEN_DIALER_HOME],
    forbid: [NATIVE_ACTIONS.CALL_PERSON],
    note: "Opening the phone home screen must not place a call.",
  },
  {
    id: "dialpad-open-ui",
    prompt: "open the dial pad",
    expect: [NATIVE_ACTIONS.OPEN_DIALPAD],
    forbid: [NATIVE_ACTIONS.CALL_PERSON],
    note: "Opening the dial pad must not place a call.",
  },
  {
    id: "recent-calls-open-ui",
    prompt: "open recent calls",
    expect: [NATIVE_ACTIONS.OPEN_RECENT_CALLS],
    forbid: [NATIVE_ACTIONS.CALL_PERSON],
    note: "Opening call history is a read-only UI action.",
  },
  {
    id: "translation",
    prompt: "how do you say thank you in Japanese",
    expectAnswer: ["arigato", "arigatou", "ありがと"],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, "music_catalog_search"],
    note:
      "Answer-scored rather than action-scored: translation is answered directly by the model, so the ANSWER is the only reliable signal. VERIFIED, and Japanese is deliberate: the deterministic planner handles only english/french/italian/spanish/portuguese/german (capabilities/translation.rs:37-62), so a listed language would return a `" +
      NATIVE_ACTIONS.TRANSLATE +
      "` ACTION with no spoken text and this expectAnswer would fail. Never expect a `" +
      NATIVE_ACTIONS.TRANSLATE +
      "` action here — it is DELIBERATELY_NOT_EXPOSED to the planner ('stock translation surface', tools/catalog/tests.rs:1804). Its 2026-07-28 FAIL? was environmental (" +
      OPERATIONAL_MARKERS.backend_unavailable.value +
      ").",
  },
  {
    id: "translation-good-morning-french",
    prompt: "translate good morning from English to French",
    expect: [NATIVE_ACTIONS.TRANSLATE],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.START_TRANSLATION],
    note: "A one-off translation uses Translate rather than starting interpreter mode.",
  },
  {
    id: "translation-hello-spanish",
    prompt: "translate hello to Spanish",
    expect: [NATIVE_ACTIONS.TRANSLATE],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.START_TRANSLATION],
    note: "The exact checklist translation stays a one-off stock Translate action.",
  },
  {
    id: "notes-list-read",
    prompt: "show my notes",
    expect: ["recall_memory"],
    forbid: [NATIVE_ACTIONS.MANAGE_MEMORY, NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Listing notes must read authenticated wearer memory without creating or changing a note.",
  },
  {
    id: "food-calories-apple",
    prompt: "how many calories are in an apple?",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, "music_catalog_search"],
    note: "The top-level planner must enter the stock nutrition agent; the Pin child-planner regression separately verifies RetrieveFoodInfo and its exact FoodItemList.",
  },
  {
    id: "food-facts-oatmeal",
    prompt: "what are the nutrition facts for oatmeal?",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, "music_catalog_search"],
    note: "Read-only nutrition lookup enters the stock nutrition agent without being mistaken for music catalog search.",
  },
  {
    id: "food-protein-eggs",
    prompt: "how much protein is in two eggs?",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, "music_catalog_search"],
    note: "Quantity must survive the top-level nutrition handoff; the Pin child-planner regression requires Quantity=2.",
  },
  {
    id: "food-track-eggs",
    prompt: "I ate two eggs.",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PAUSE_MUSIC, NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Food logging must enter nutrition and must not reproduce the stock loose PauseMusic false positive.",
  },
  {
    id: "food-track-banana",
    prompt: "track my food: one banana.",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PAUSE_MUSIC, NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Explicit food tracking enters the stock nutrition agent; the child-planner regression verifies TrackFoodConsumption with Quantity=1.",
  },
  {
    id: "food-log-today",
    prompt: "what have I eaten today?",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Today's diary read enters nutrition; the child-planner regression verifies GetFoodLog with DayCount=1.",
  },
  {
    id: "food-calories-today",
    prompt: "how many calories have I eaten today?",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "The daily calorie summary is a food-log read, not a general nutrition lookup; the child planner requires DayCount=1.",
  },
  {
    id: "food-log-three-days",
    prompt: "show my food log for the last three days.",
    expect: [NATIVE_ACTIONS.MANAGE_NUTRITION],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note: "The exact checklist wording enters nutrition; the Pin child-planner regression requires spelled-out three to become GetFoodLog DayCount=3.",
  },
  {
    id: "definition",
    prompt: "what does ubiquitous mean",
    forbid: [
      NATIVE_ACTIONS.PLAY_MUSIC,
      "music_catalog_search",
      "web_search",
    ],
    note: "A dictionary answer is stable knowledge; it must not leave the device. Action-forbid only — phrasing of a definition is too free to pin.",
  },
  {
    id: "memory-write",
    prompt: "please remember that my favorite color is teal",
    expect: ["remember_fact"],
    note: "`remember_fact` is the correct and only write-tool name (tools/catalog.rs:313). It returns NO device action, so it is scored purely from the logcat line `hermes tool executed … tool=remember_fact ok=true`. PROMPT CHANGED (en-GB -> en-US): the write is refused unless EVERY non-stopword token of the stored content appears verbatim in the utterance (turn/orchestration.rs:290-318), and normalize_text does no spelling normalisation — so a 'favourite colour' prompt invites an American paraphrase and a LEGITIMATE refusal by a correct security gate. That was an expectation defect, not an assistant defect. This exact en-US wording is the one measured succeeding (test-runs/session-20260727-205837-6341dd00: remember_fact ok=true). It does not collide with any other SUITE prompt, and the duplicate guard only scans SUITE. IF THIS GOES RED, THE ASSISTANT IS AT FAULT, not the expectation: gates are trusted_current_user + confirmed unlock (else the tool is HIDDEN, not refused) and then content grounding, and the model sometimes simply declines without calling the tool at all — measured once with the gates open and trusted_current_user=true (session-20260727-215718-a495644d). Expect flakiness at low repeat counts.",
  },
  {
    id: "music-pause",
    prompt: "pause the music",
    expect: [NATIVE_ACTIONS.PAUSE_MUSIC],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.NEXT_TRACK],
    note: "Transport control. The forbid is the point: pause must never be answered by starting playback.",
  },
  {
    id: "music-next",
    prompt: "skip this song",
    expect: [NATIVE_ACTIONS.NEXT_TRACK],
    forbid: [NATIVE_ACTIONS.PAUSE_MUSIC, NATIVE_ACTIONS.PLAY_MUSIC],
    note: "Phrasing carries no transport vocabulary ('skip', not 'next track').",
  },
  {
    id: "photo-capture",
    prompt: "take a photo",
    expect: [NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH],
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC],
    note:
      "EXPECTATION WAS WRONG, now verified: `TakePhoto` exists nowhere in runtime/core/src or docs/, so this case could never pass. The catalog name is " +
      `${NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH} (catalog.rs:1186). It is deliberately NOT advertised to the planner (tools/catalog/tests.rs:1792, 'stock capture pipeline'), so it is reachable ONLY through the deterministic alias table — whose first entry is this exact prompt (native_device_actions.rs:88-103). Keyguard-safe, so it fires locked too (native_device_actions.rs:1205-1229). A phrasing OUTSIDE that alias list has no tool at all and yields prose or silence; do not generalise this case to free phrasing.`,
  },
  {
    id: "message-send",
    prompt: "send a message to Alex saying I am running late",
    requiresDeviceRoundTrip: true,
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.INCREMENT_VOLUME],
    note: "Contact-dependent: resolving 'Alex' needs the device's own contact store, so a raw probe cannot score the send path. Scored by forbid only. NOTE the probe NEVER dispatches, so running this cannot actually message anyone.",
  },
  {
    id: "notifications-read",
    prompt: "do I have any notifications",
    requiresDeviceRoundTrip: true,
    forbid: [NATIVE_ACTIONS.PLAY_MUSIC, NATIVE_ACTIONS.SET_VOLUME],
    note: "Needs live device state. Forbid-only until a baseline shows the real read.",
  },
  {
    id: "chitchat-joke",
    prompt: "tell me a joke",
    forbid: [
      NATIVE_ACTIONS.PLAY_MUSIC,
      NATIVE_ACTIONS.INCREMENT_VOLUME,
      NATIVE_ACTIONS.SET_VOLUME,
      "web_search",
      "music_catalog_search",
    ],
    note: "NEGATIVE CONTROL: pure conversation must not touch the device or leave it. A joke fetched by web search is a misroute, not a feature.",
  },
  {
    id: "ambiguous-utterance",
    prompt: "um what was that thing",
    forbid: [
      NATIVE_ACTIONS.PLAY_MUSIC,
      NATIVE_ACTIONS.INCREMENT_VOLUME,
      NATIVE_ACTIONS.DECREMENT_VOLUME,
      NATIVE_ACTIONS.SET_VOLUME,
      NATIVE_ACTIONS.PAUSE_MUSIC,
      // Was "TakePhoto", which exists nowhere in the catalog — so this negative
      // control could NEVER trip and silently proved nothing about the camera.
      // A forbid naming a nonexistent action is a vacuous guard.
      NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH,
      NATIVE_ACTIONS.UNDERSTAND_SCENE,
    ],
    note:
      "NEGATIVE CONTROL: an incoherent utterance must not guess an action. Doing nothing is the correct behaviour; acting is the failure. The camera forbid was vacuous until 2026-07-28: it named `TakePhoto`, which is not a real action (the catalog name is " +
      `${NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH}, catalog.rs:1186).`,
  },
  {
    id: "recent-photos-open-ui",
    prompt: "show my recent photos",
    expect: [NATIVE_ACTIONS.OPEN_RECENT_PHOTOS],
    forbid: [NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH, NATIVE_ACTIONS.CAPTURE_VIDEO],
    note: "Opening the gallery must not take a new capture.",
  },
  {
    id: "vision-action-count-read",
    prompt: "tell me the number of vision actions",
    expect: [NATIVE_ACTIONS.GET_IF_THEN_MAP_SIZE],
    forbid: [NATIVE_ACTIONS.ADD_IF_THEN_ENTRY, NATIVE_ACTIONS.CLEAR_IF_THEN_MAP],
    note: "Counting vision rules is read-only and must not add or clear rules.",
  },
  {
    id: "photo-how-to-negative",
    prompt: "how do I take a photo?",
    expect: [NATIVE_ACTIONS.RESPOND],
    forbid: [NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH, NATIVE_ACTIONS.CAPTURE_VIDEO],
    note: "A how-to question must explain rather than capture.",
  },
  {
    id: "messages-information-negative",
    prompt: "tell me about text messages",
    expect: [NATIVE_ACTIONS.RESPOND],
    forbid: [NATIVE_ACTIONS.COMPOSE_MESSAGE, NATIVE_ACTIONS.CALL_PERSON],
    note: "An informational question must not compose, send, or call.",
  },
];

// ---- Reading the spoken answer out of a decoded turn --------------------
//
// This lives here, not in the runner, because it is the part of the instrument
// that was WRONG and the part the tests have to be able to fail.
//
// The original runner read `response.answer ?? response.text ?? response.speech`.
// None of those keys exist on any frame. The decoder
// (agentic-release-smoke-lib.mjs:769-786) emits exactly:
//   kind, isFinal, user, hasIdentifier, hasParentIdentifier, identifier,
//   parentIdentifier, thought, action, input, devicePayloadBytes, source
// and the spoken text is `JSON.parse(input).Response` on a
// NATIVE_ACTIONS.RESPOND frame.
// frame. Every answer-scored case therefore reported "empty answer" and
// `isUnavailableAnswer` never fired even once — so a wedged backend passed the
// forbid-only cases by replying "Codex is unavailable on the host."
//
// Verified over all 115 responses.json under test-runs/: 109 ok, 2 no-frames,
// 4 no-respond-frame — and the 109 exactly equals the independently counted
// number of frames matching NATIVE_ACTIONS.RESPOND.
const RESPOND_ACTION = NATIVE_ACTIONS.RESPOND;
const RESPOND_TEXT_KEY = "Response";

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The spoken text of one frame, or null if this frame carries no answer.
 *
 * Each guard excludes a shape that really occurs and would otherwise be scored
 * as the assistant's answer:
 *  - `kind !== "action"` drops observation frames (they contain `actionName`, not
 *    `action`) and the legacy `other` frame.
 *  - dropping non-NATIVE_ACTIONS.RESPOND frames loses device actions that
 *    contain PROSE: NATIVE_ACTIONS.PLAY_MUSIC holds Track/Artist/Album,
 *    NATIVE_ACTIONS.COMPOSE_MESSAGE holds the outgoing body, and
 *    NATIVE_ACTIONS.UNDERSTAND_SCENE holds the user's own question — an
 *    extractor that scanned every input would score the user's words as the
 *    assistant's answer (understand.rs:3097-3101).
 *  - `input` is an opaque model-produced JSON STRING, so parsing it must never
 *    throw the run away.
 * `thought` is deliberately never read: it is assistant-internal and never spoken.
 */
function respondTextOf(frame) {
  if (!isPlainObject(frame)) return null;
  if (frame.kind !== "action") return null;
  if (frame.action !== RESPOND_ACTION) return null;
  if (typeof frame.input !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(frame.input);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const text = parsed[RESPOND_TEXT_KEY];
  return typeof text === "string" ? text : null;
}

/**
 * Extract the spoken answer from a decoded turn. Never throws.
 *
 * LAST NATIVE_ACTIONS.RESPOND wins, not the longest and not `isFinal === true`:
 *  - `isFinal` is hard-coded false by the only production builder
 *    (runtime/core/src/synapse/actions.rs:36) and is false on 113/113 real frames,
 *    so filtering on it would return nothing — a new instrument bug.
 *  - Longest-wins prefers a verbose interim over the short terminal answer, and
 *    the terminal is frequently the shortest string in the turn (measured
 *    min/median/max answer length = 4/42/93; "Paris." is 6).
 *  - Last-wins is what the server itself does: it holds the last non-interim
 *    candidate back until EOF and appends the timeout fallback last
 *    (stock_deadline.rs:180-215).
 *
 * `status` separates causes that must not be conflated:
 *   ok                  a NATIVE_ACTIONS.RESPOND frame produced text (possibly "")
 *   no-frames           the turn produced nothing, or the probe threw (null)
 *   no-respond-frame    a device action WAS the answer (for example
 *                       NATIVE_ACTIONS.PLAY_MUSIC — 4 real artifacts).
 *                       Legitimate; not an answer failure on its own.
 *   malformed-respond   a NATIVE_ACTIONS.RESPOND frame whose input was unparseable
 *   legacy-text-dropped the answer exists on the wire but not in the decode
 */
export function extractAnswer(responses) {
  const frames = Array.isArray(responses) ? responses : [];
  const result = {
    text: "",
    status: "no-frames",
    frameCount: frames.length,
    frameIndex: -1,
    respondFrames: 0,
    malformedRespondFrames: 0,
    interimCueFrames: 0,
    legacyTextDropped: false,
  };
  if (!Array.isArray(responses)) return result;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    // A Hermes progress cue: an action frame with no thought and no input.
    // Counted so a future multi-frame turn is visible rather than silent.
    if (isPlainObject(frame) && frame.kind === "action" && frame.thought === "" && frame.input === "{}") {
      result.interimCueFrames += 1;
    }
    if (isPlainObject(frame) && frame.kind === "other" && frame.hasLegacyResponse === true) {
      result.legacyTextDropped = true;
    }
    if (!isPlainObject(frame) || frame.kind !== "action" || frame.action !== RESPOND_ACTION) continue;
    result.respondFrames += 1;
    const text = respondTextOf(frame);
    if (text === null) {
      result.malformedRespondFrames += 1;
      continue;
    }
    result.text = text;
    result.frameIndex = index;
  }
  if (frames.length === 0) result.status = "no-frames";
  else if (result.frameIndex >= 0) result.status = "ok";
  else if (result.malformedRespondFrames > 0) result.status = "malformed-respond";
  else if (result.legacyTextDropped) result.status = "legacy-text-dropped";
  else result.status = "no-respond-frame";
  return result;
}

// Answers that mean the assistant is BROKEN even though a well-formed
// NATIVE_ACTIONS.RESPOND
// came back. This list is the direct product of a measured incident: with a
// rejected reasoning-effort setting the backend returned "Codex is unavailable on
// the host. Check its login status." in ~4s — FASTER than a correct answer — so a
// latency-and-action-only reading declared the broken configuration the winner.
// Any answer matching these is a failure regardless of how fast or well-formed.
//
// The apostrophe patterns match BOTH ' and ’. The model emits the curly U+2019
// ("I can’t…", "I couldn’t…"), so the ASCII-only pattern was unreachable on real
// text — measured in 8 of the 109 extracted answers on disk.
export const UNAVAILABLE_ANSWER_PATTERNS = [
  /codex is unavailable/i,
  /check its login status/i,
  /backend[_ ]unavailable/i,
  /\bis unavailable\b/i,
  /i (?:can(?:no|['’])t|am unable to) (?:help|do that|answer)/i,
  /something went wrong/i,
  /try again later/i,
  // The server's OWN canned failures. Verified absent from the patterns above:
  // isUnavailableAnswer returned false for the timeout fallback, so a timed-out
  // turn was scored as a wrong ANSWER and blamed on the planner.
  /i (?:couldn['’]t|could not) finish that request in time/i, // stock_deadline.rs:40-41
  /vision is turned off until camera cloud consent/i, // understand.rs:208-209
  /unlock your pin to use vision/i,
];

// Raw machinery that leaked into speech. This is a shipped DEFECT, not an
// environment problem: one artifact's spoken answer is literally
// "<tool_call_result>Tool call failed: function not found</tool_call_result>"
// (test-runs/session-20260728-110030-e245774a/…). No prose pattern flags it, so
// it would otherwise score as an ordinary wrong answer.
export const MACHINERY_LEAK_PATTERNS = [
  /<tool_call_result>/i,
  /tool call failed/i,
  /^\s*\{"/,
];

/** True when the spoken text is raw plumbing rather than an answer. */
export function isMachineryLeak(answerText) {
  const text = typeof answerText === "string" ? answerText : "";
  return MACHINERY_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the spoken text is an error/unavailable reply rather than an answer. */
export function isUnavailableAnswer(answerText) {
  const text = typeof answerText === "string" ? answerText : "";
  return UNAVAILABLE_ANSWER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Evaluate the SPOKEN ANSWER for a case. Deliberately separate from
 * `evaluateCase` (which scores actions) so existing callers are unaffected.
 *
 * Three outcomes, because "no expectation" and "expectation met" must not be
 * conflated: a case with no `expectAnswer` is `checked: false` and never counts
 * as a pass. An empty or unavailable answer always fails — including for cases
 * that only declare `forbid`, since silence and an error reply are both real
 * failures the action score cannot see.
 */
export function evaluateAnswer(testCase, answerText) {
  // Accepts the raw string (back-compatible) or an `extractAnswer` result, so
  // the STATUS can be scored rather than collapsing every non-answer to "".
  const isExtraction = isPlainObject(answerText) && typeof answerText.status === "string";
  const status = isExtraction ? answerText.status : "ok";
  const raw = isExtraction ? answerText.text : answerText;
  const text = typeof raw === "string" ? raw.trim() : "";
  const expected = testCase.expectAnswer ?? [];
  const expectedAll = testCase.expectAnswerAll ?? [];
  const expectsSpokenAnswer = expected.length > 0 || expectedAll.length > 0;

  // These three are failures for EVERY case, answer-anchored or not. Under the
  // old code a silent or malformed turn returned `checked:false` for any case
  // without `expectAnswer` and so never blocked a pass — which is how a wedged
  // backend passed six forbid-only cases.
  if (status === "no-frames") {
    return { checked: true, pass: false, reason: "turn produced no frames", text };
  }
  if (status === "malformed-respond") {
    return {
      checked: true,
      pass: false,
      reason: `${NATIVE_ACTIONS.RESPOND} input was not parseable JSON with a string Response`,
      text,
    };
  }
  if (status === "legacy-text-dropped") {
    return {
      checked: true,
      pass: false,
      reason: "answer text is unreachable from the decoded frame",
      text,
    };
  }

  if (isUnavailableAnswer(text)) {
    return { checked: true, pass: false, reason: "unavailable/error reply", text };
  }
  // A shipped defect, scored separately so it is never mistaken for an
  // environment problem the way an "unavailable" reply legitimately is.
  if (isMachineryLeak(text)) {
    return { checked: true, pass: false, reason: "raw tool machinery spoken as the answer", text };
  }

  // A device action, rather than a spoken response, was the answer.
  // Real and correct — the action score decides. Only a case that explicitly
  // demands spoken words may fail here, otherwise this re-creates the same
  // false-red the original bug produced, in a new place.
  if (status === "no-respond-frame") {
    if (!expectsSpokenAnswer) {
      return {
        checked: false,
        pass: null,
        reason: "turn ended in a device action, no spoken answer",
        text,
      };
    }
    return { checked: true, pass: false, reason: "expected a spoken answer, got none", text };
  }

  if (!expectsSpokenAnswer) {
    return { checked: false, pass: null, reason: "no answer expectation", text };
  }
  if (text.length === 0) {
    return { checked: true, pass: false, reason: "empty answer", text };
  }
  const haystack = text.toLowerCase();
  const matchedAny = expected.length === 0
    || expected.some((needle) => haystack.includes(String(needle).toLowerCase()));
  const missingAll = expectedAll.filter(
    (needle) => !haystack.includes(String(needle).toLowerCase()),
  );
  const matched = matchedAny && missingAll.length === 0;
  const failure = !matchedAny
    ? `none of ${JSON.stringify(expected)} in answer`
    : `missing required content ${JSON.stringify(missingAll)}`;
  return {
    checked: true,
    pass: matched,
    reason: matched ? "expected content present" : failure,
    text,
  };
}

// Names that were asserted by this suite but exist NOWHERE in runtime/core/src or
// docs/ — verified by grep on 2026-07-28. Each shipped as a silent no-op:
// `current_time` as an unsatisfiable `expect`, `TakePhoto` as both an
// unsatisfiable `expect` and a forbid that could never trip. Kept as data so the
// test can prove they never come back, with the real name to use instead.
export const KNOWN_ABSENT_ACTION_NAMES = {
  // grep '"current_time"' runtime/core/src docs -> no hits.
  current_time: `${NATIVE_ACTIONS.GET_CURRENT_TIME} (catalog.rs:1438)`,
  // grep 'TakePhoto' runtime/core/src docs -> no hits.
  TakePhoto: `${NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH} (catalog.rs:1186)`,
};

// Cases are matched to measured arms BY PROMPT TEXT, so two cases sharing a
// prompt would silently score against the same arm. Fail loudly at load time
// instead of producing a plausible-looking wrong result.
{
  const seenPrompts = new Set();
  const seenIds = new Set();
  for (const testCase of SUITE) {
    if (seenPrompts.has(testCase.prompt)) {
      throw new Error(`duplicate suite prompt: ${JSON.stringify(testCase.prompt)}`);
    }
    if (seenIds.has(testCase.id)) {
      throw new Error(`duplicate suite id: ${testCase.id}`);
    }
    seenPrompts.add(testCase.prompt);
    seenIds.add(testCase.id);
  }
}

/** Evaluate one arm's observed actions against a case. */
export function evaluateCase(testCase, actions) {
  const seen = new Set(actions);
  const missing = (testCase.expect ?? []).filter((action) => !seen.has(action));
  const forbidden = (testCase.forbid ?? []).filter((action) => seen.has(action));
  return { missing, forbidden, pass: missing.length === 0 && forbidden.length === 0 };
}
