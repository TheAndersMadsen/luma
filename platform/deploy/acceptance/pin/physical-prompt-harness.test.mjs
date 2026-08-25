import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_IDENTITY,
  encodeProtoBytes,
  encodeProtoString,
  encodeProtoVarint,
} from "./agentic-release-smoke-lib.mjs";

import {
  PHYSICAL_TIMEOUT_MS,
  PHYSICAL_PROMPT_CASES,
  buildTranscriptInjectionCommand,
  decodeLoadingMessageRpcResponse,
  encodeLoadingMessageCaseRequest,
  evaluateAgenticTraceEvidence,
  evaluateLoadingCueEvidence,
  evaluateLocalWeatherTraceEvidence,
  evaluateNativeActionHookEvidence,
  evaluatePhysicalReadiness,
  evaluateProgressModelEvidence,
  evaluatePromptEvidence,
  evaluateSimpleHookEvidence,
  executePhysicalSuite,
  findAttributedMusic,
  loadingCueWithinDeadline,
  main,
  mediaPositionAdvanced,
  parseMediaSessionSummary,
  parsePenumbraHookEvidence,
  parsePhysicalCliArgs,
  parsePidSet,
  parsePromptActivityPage,
  tickleActivityIsForeground,
} from "./physical-prompt-harness.mjs";

test("physical observer outlives every in-device agentic deadline", () => {
  const hookedClientDeadlineMs = 90_000;
  assert.ok(PHYSICAL_TIMEOUT_MS.agenticRemoteWeather > hookedClientDeadlineMs);
  assert.ok(PHYSICAL_TIMEOUT_MS.music > hookedClientDeadlineMs);
});

const EXPECTED = RELEASE_IDENTITY;
const GUARDED_MEDIA_VOLUME_STATE = Object.freeze({
  index: 7,
  minimum: 0,
  maximum: 15,
  muted: false,
});
const GUARDED_MEDIA_VOLUME_DEVICE = Object.freeze({
  async readMediaVolumeState() {
    return { ...GUARDED_MEDIA_VOLUME_STATE };
  },
  async setMediaVolumeIndex(index) {
    assert.equal(index, GUARDED_MEDIA_VOLUME_STATE.index);
  },
});

function liveArgs(extra = [], caseId = "current_time") {
  return [
    "--run",
    "--serial",
    "device-123._:usb",
    "--expect-version-name",
    EXPECTED.versionName,
    "--expect-version-code",
    String(EXPECTED.versionCode),
    "--expect-apk-sha256",
    EXPECTED.apkSha256,
    "--case",
    caseId,
    ...extra,
  ];
}

function readinessFixture() {
  return {
    health: { status: "ok", version: EXPECTED.versionName },
    settings: {
      restart_required: false,
      server: {
        admin_token_auth: true,
        grpc_bind_addr: "127.0.0.1:9090",
      },
    },
    spotify: {
      enabled: true,
      experimental_acknowledged: true,
      state: "ready",
      engine_ready: true,
    },
    featureFlags: {
      flags: [
        {
          key: "tickle",
          desired_value: { type: "bool", value: true },
          assignment_value: { type: "bool", value: true },
        },
      ],
      delivery: {
        state: "stock_cache_applied",
        stock_cache_verified: true,
      },
    },
  };
}

function identityFixture() {
  return {
    packageName: "com.penumbraos.server",
    versionName: EXPECTED.versionName,
    versionCode: EXPECTED.versionCode,
    apkSha256: EXPECTED.apkSha256,
  };
}

function memoryWriter() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text() { return value; },
  };
}

test("the live CLI requires an explicit serial and exact release identity", () => {
  assert.deepEqual(parsePhysicalCliArgs([...liveArgs(), "--json"]), {
    mode: "run",
    serial: "device-123._:usb",
    adbPath: "adb",
    expectedVersionName: EXPECTED.versionName,
    expectedVersionCode: EXPECTED.versionCode,
    expectedApkSha256: EXPECTED.apkSha256,
    caseId: "current_time",
    json: true,
    help: false,
  });
  assert.throws(() => parsePhysicalCliArgs(["--run"]), /explicit ADB serial/);
  assert.throws(
    () =>
      parsePhysicalCliArgs([
        "--run",
        "--serial",
        "device-123._:usb",
        "--expect-version-name",
        EXPECTED.versionName,
        "--expect-version-code",
        String(EXPECTED.versionCode),
        "--expect-apk-sha256",
        EXPECTED.apkSha256,
      ]),
    /requires exactly one --case/,
  );
  assert.throws(
    () => parsePhysicalCliArgs(liveArgs(["--case", "ranked_music"])),
    /provided once/,
  );
  assert.throws(
    () => parsePhysicalCliArgs([...liveArgs(), "--prompt", "call someone"]),
    /unknown command option/,
  );
  assert.throws(
    () =>
      parsePhysicalCliArgs(
        liveArgs().map((value) =>
          value === EXPECTED.versionName ? "2026-07-17.36-local" : value,
        ),
      ),
    /pinned Server version name/,
  );
  assert.throws(
    () => parsePhysicalCliArgs(["--self-check", "--serial", "device"]),
    /does not accept live-device options/,
  );
  assert.throws(
    () => parsePhysicalCliArgs([...liveArgs(), "--self-check"]),
    /exactly one mode/,
  );
  assert.throws(
    () =>
      parsePhysicalCliArgs(
        liveArgs().map((value) =>
          value === "current_time" ? "music_pause_cleanup" : value,
        ),
      ),
    /fixed public physical case/,
  );
});

test("the physical matrix is fixed, bounded, immutable, and side-effect scoped", () => {
  assert.deepEqual(
    PHYSICAL_PROMPT_CASES.map((item) => item.id),
    [
      "loading_semantic_music",
      "loading_semantic_playback",
      "loading_semantic_weather",
      "loading_locked_neutral",
      "current_time",
      "battery_level",
      "current_weather",
      "current_weather_today",
      "capital_weather_remote",
      "ranked_music",
      "tickle_single",
      "tickle_fancy",
      "tickle_triple",
      "tickle_negative",
    ],
  );
  assert.equal(Object.isFrozen(PHYSICAL_PROMPT_CASES), true);
  assert.ok(PHYSICAL_PROMPT_CASES.every(Object.isFrozen));
  assert.ok(PHYSICAL_PROMPT_CASES.every((item) => Buffer.byteLength(item.prompt) <= 256));
  assert.doesNotMatch(
    PHYSICAL_PROMPT_CASES.map((item) => item.prompt).join(" "),
    /\b(?:call|message|camera|photo|privacy mode|settings|install|reboot)\b/i,
  );
});

test("transcript injection is one package-bound command built only from a case id", () => {
  assert.equal(
    buildTranscriptInjectionCommand("tickle_fancy"),
    'am broadcast --user 0 -a hu.ma.ne.INJECT_TRANSCRIPTION -p hu.ma.ne.ironman --es transcription "tickle my fancy" --ez vision false',
  );
  assert.throws(
    () => buildTranscriptInjectionCommand("tickle_fancy;reboot"),
    /unknown fixed physical case/,
  );
  assert.throws(
    () => buildTranscriptInjectionCommand("loading_semantic_music"),
    /cannot be transcript injected/,
  );
});

test("loading-message fixtures use the stock plaintext envelope and report only cue booleans", () => {
  const request = encodeLoadingMessageCaseRequest("loading_semantic_weather");
  assert.ok(Buffer.isBuffer(request));
  assert.ok(request.length > 32);

  const inner = Buffer.concat([
    encodeProtoString(1, "Checking the weather..."),
    encodeProtoString(2, "Checking the weather."),
  ]);
  const info = encodeProtoString(1, "humane.aibus.LoadingMessageResponse");
  const envelope = Buffer.concat([
    encodeProtoBytes(1, info),
    encodeProtoBytes(2, inner),
  ]);
  const decoded = decodeLoadingMessageRpcResponse(encodeProtoBytes(1, envelope));
  const evidence = evaluateLoadingCueEvidence("loading_semantic_weather", decoded);
  assert.deepEqual(evidence, {
    allowlisted: true,
    categoryAppropriate: true,
    semanticCategoryObserved: true,
    lockedNeutralObserved: null,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /weather|Checking/);

  const emptyInner = Buffer.alloc(0);
  const emptyEnvelope = Buffer.concat([
    encodeProtoBytes(1, info),
    encodeProtoBytes(2, emptyInner),
  ]);
  const emptyDecoded = decodeLoadingMessageRpcResponse(
    encodeProtoBytes(1, emptyEnvelope),
  );
  assert.deepEqual(emptyDecoded, { loadingMessage: "", verbalMessage: "" });

  const canonicallyElidedEmptyEnvelope = encodeProtoBytes(1, info);
  assert.deepEqual(
    decodeLoadingMessageRpcResponse(
      encodeProtoBytes(1, canonicallyElidedEmptyEnvelope),
    ),
    { loadingMessage: "", verbalMessage: "" },
  );

  for (const malformedEnvelope of [
    Buffer.concat([
      encodeProtoBytes(1, info),
      encodeProtoBytes(2, emptyInner),
      encodeProtoBytes(2, emptyInner),
    ]),
    Buffer.concat([encodeProtoBytes(1, info), encodeProtoVarint(2, 0)]),
    Buffer.concat([encodeProtoBytes(1, info), encodeProtoVarint(3, 0)]),
  ]) {
    assert.throws(
      () =>
        decodeLoadingMessageRpcResponse(
          encodeProtoBytes(1, malformedEnvelope),
        ),
      /malformed/,
    );
  }

  const neutral = evaluateLoadingCueEvidence("loading_locked_neutral", emptyDecoded);
  assert.equal(neutral.pass, true);
  assert.equal(neutral.lockedNeutralObserved, true);
  assert.equal(neutral.semanticCategoryObserved, null);

  const playback = evaluateLoadingCueEvidence("loading_semantic_playback", {
    loadingMessage: "",
    verbalMessage: "",
  });
  assert.equal(playback.pass, true);
  assert.equal(playback.semanticCategoryObserved, true);
  assert.doesNotMatch(JSON.stringify(playback), /playback|Checking/);
});

test("local weather activity requires exactly one preflight and one grounded terminal", () => {
  const privateLocality = "PRIVATE_LOCALITY_71ff";
  const privateTail = "PRIVATE_RESPONSE_TAIL_71ff";
  const prompt = "What's the weather like where I am right now?";
  const evidence = evaluatePromptEvidence(
    "current_weather",
    [
      { id: 10, prompt, response: "Action: GetCurrentLocation" },
      {
        id: 11,
        prompt,
        response: `Clear, 22 degrees Celsius in ${privateLocality}. ${privateTail}`,
      },
    ],
    9,
  );
  assert.deepEqual(evidence, {
    routeObserved: true,
    terminalObserved: true,
    localityObserved: true,
    pass: true,
    ownedIds: [10, 11],
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|Clear|degrees/);

  const terminal = {
    id: 11,
    prompt,
    response: `Clear, 22 degrees Celsius in ${privateLocality}. ${privateTail}`,
  };
  assert.equal(
    evaluatePromptEvidence("current_weather", [terminal], 9).pass,
    false,
    "a forged terminal-only activity row must fail",
  );
  assert.equal(
    evaluatePromptEvidence(
      "current_weather",
      [{ id: 10, prompt, response: "Action: GetCurrentLocation" }],
      9,
    ).pass,
    false,
    "a preflight-only activity row must fail",
  );
  assert.equal(
    evaluatePromptEvidence(
      "current_weather",
      [
        { id: 10, prompt, response: "Action: GetCurrentLocation" },
        terminal,
        { ...terminal, id: 12 },
      ],
      9,
    ).pass,
    false,
    "duplicate plausible terminals must fail exact attribution",
  );

  const todayPrompt = "What's the weather like today?";
  assert.equal(
    evaluatePromptEvidence(
      "current_weather_today",
      [
        { id: 20, prompt: todayPrompt, response: "Action: GetCurrentLocation" },
        {
          id: 21,
          prompt: todayPrompt,
          response: "Clear, 22 degrees Celsius in Hvidovre.",
        },
      ],
      19,
    ).pass,
    true,
  );
});

test("remote capital weather requires one Paris temperature terminal and no location preflight", () => {
  const prompt = "Lookup the capitol of France and check the weather there";
  const terminal =
    "I found Paris. Current weather in Paris, France: Clear; 22 degrees Celsius. PRIVATE_REMOTE_TAIL";
  const evidence = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: terminal }],
    19,
  );
  assert.deepEqual(evidence, {
    currentLocationObserved: false,
    terminalObserved: true,
    localityObserved: true,
    franceGrounded: true,
    wrongCountryObserved: false,
    pass: true,
    ownedIds: [20],
  });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|Paris|degrees|Clear/);

  assert.equal(
    evaluatePromptEvidence(
      "capital_weather_remote",
      [
        { id: 20, prompt, response: "Action: GetCurrentLocation" },
        { id: 21, prompt, response: terminal },
      ],
      19,
    ).pass,
    false,
  );
  assert.equal(
    evaluatePromptEvidence(
      "capital_weather_remote",
      [
        { id: 20, prompt, response: terminal },
        { id: 21, prompt, response: terminal },
      ],
      19,
    ).pass,
    false,
  );
  assert.equal(
    evaluatePromptEvidence(
      "capital_weather_remote",
      [{ id: 20, prompt, response: "Clear; 22 degrees Celsius in Lyon." }],
      19,
    ).pass,
    false,
  );

  // France grounding is required: bare "Paris" without country fails.
  const noFrance = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Paris is clear, 22 degrees Celsius." }],
    19,
  );
  assert.equal(noFrance.pass, false);
  assert.equal(noFrance.franceGrounded, false);
  assert.equal(noFrance.wrongCountryObserved, false);

  // Same-name wrong-country output is explicitly rejected.
  const parisTexas = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Weather in Paris, Texas: Clear; 22 degrees Celsius." }],
    19,
  );
  assert.equal(parisTexas.pass, false);
  assert.equal(parisTexas.franceGrounded, false);
  assert.equal(parisTexas.wrongCountryObserved, true);

  const parisUsa = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Paris, USA is clear, 22 degrees Celsius." }],
    19,
  );
  assert.equal(parisUsa.pass, false);
  assert.equal(parisUsa.wrongCountryObserved, true);

  // Wrong-country takes precedence even when France is also mentioned.
  const mixedCountry = evaluatePromptEvidence(
    "capital_weather_remote",
    [{ id: 20, prompt, response: "Paris, Texas and also France: 22 degrees Celsius." }],
    19,
  );
  assert.equal(mixedCountry.pass, false);
  assert.equal(mixedCountry.franceGrounded, true);
  assert.equal(mixedCountry.wrongCountryObserved, true);
});

test("agentic trace proof is exact, correlated, ordered, and fails closed", () => {
  const boundary =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const correlation = "223e4567-e89b-42d3-a456-426614174000";
  const otherCorrelation = "323e4567-e89b-42d3-a456-426614174000";
  const line = (
    ordinal,
    tool,
    eventCorrelation = correlation,
    tail = "",
    resultStatus = tool === "terminal" ? null : "ok",
  ) => {
    const result = resultStatus === null ? "" : ` result_status=${resultStatus}`;
    return `1710000000.${String(ordinal + 1).padStart(3, "0")}  100  101 W PenumbraServer: INFO humane_server: <<< Agentic physical proof trace correlation=${eventCorrelation} ordinal=${ordinal} tool=${tool} status=completed${result}${tail}`;
  };
  const log = (events) => [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    ...events,
  ].join("\n");

  const valid = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.deepEqual(valid, {
    correlationMatched: true,
    ordinalsContiguous: true,
    exactOrder: true,
    currentLocationObserved: false,
    terminalObserved: true,
    eventCount: 4,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(valid), /223e|knowledge|place_search|weather_at_place/);

  const missing = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "weather_at_place"),
      line(3, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(missing.pass, false);
  assert.equal(missing.exactOrder, false);

  const misordered = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "place_search"),
      line(2, "knowledge_lookup"),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(misordered.pass, false);
  assert.equal(misordered.ordinalsContiguous, true);

  const extraLocation = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "current_location"),
      line(4, "weather_at_place"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(extraLocation.pass, false);
  assert.equal(extraLocation.currentLocationObserved, true);

  const uncorrelated = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search", otherCorrelation),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(uncorrelated.pass, false);
  assert.equal(uncorrelated.correlationMatched, false);

  const wrongTerminalCorrelation = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "weather_at_place"),
      line(4, "terminal"),
    ]),
    boundary,
    otherCorrelation,
  );
  assert.equal(wrongTerminalCorrelation.pass, false);
  assert.equal(wrongTerminalCorrelation.correlationMatched, false);

  const ordinalGap = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(4, "weather_at_place"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(ordinalGap.pass, false);
  assert.equal(ordinalGap.ordinalsContiguous, false);

  const unavailable = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search", correlation, "", "unavailable"),
      line(3, "place_search"),
      line(4, "weather_at_place"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(unavailable.pass, false);
  assert.equal(unavailable.eventCount, 5);

  const otherRegistered = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "knowledge_lookup"),
      line(2, "place_search"),
      line(3, "weather_at_place"),
      line(4, "other_registered_tool"),
      line(5, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(otherRegistered.pass, false);
  assert.equal(otherRegistered.exactOrder, false);
  assert.equal(otherRegistered.terminalObserved, true);
  assert.equal(otherRegistered.eventCount, 5);

  const invalidTool = evaluateAgenticTraceEvidence(
    "capital_weather_remote",
    log([
      line(1, "invalid_tool", correlation, "", "invalid"),
      line(2, "terminal"),
    ]),
    boundary,
    correlation,
  );
  assert.equal(invalidTool.pass, false);
  assert.equal(invalidTool.exactOrder, false);
  assert.equal(invalidTool.terminalObserved, true);
  assert.equal(invalidTool.eventCount, 2);

  for (const malformed of [
    line(1, "knowledge_lookup", correlation, "", null),
    line(1, "terminal", correlation, "", "ok"),
    line(1, "knowledge_lookup", correlation, "", "provider_secret"),
    line(1, "model_supplied_secret_tool"),
  ]) {
    assert.throws(
      () =>
        evaluateAgenticTraceEvidence(
          "capital_weather_remote",
          log([malformed]),
          boundary,
          correlation,
        ),
      /trace event was malformed/,
    );
  }

  assert.throws(
    () =>
      evaluateAgenticTraceEvidence(
        "capital_weather_remote",
        log([line(1, "knowledge_lookup", correlation, " latitude=48.8")]),
        boundary,
        correlation,
      ),
    /trace event was malformed/,
  );
  assert.throws(
    () =>
      evaluateAgenticTraceEvidence(
        "capital_weather_remote",
        "",
        boundary,
        correlation,
      ),
    /boundary was unavailable/,
  );
});

test("local weather trace requires fresh location, reverse geocode, provider, and terminal", () => {
  const boundary =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const correlation = "223e4567-e89b-42d3-a456-426614174000";
  const otherCorrelation = "323e4567-e89b-42d3-a456-426614174000";
  const line = (
    ordinal,
    tool,
    eventCorrelation = correlation,
    tail = "",
  ) =>
    `1710000000.${String(ordinal + 1).padStart(3, "0")}  100  101 W PenumbraServer: INFO humane_server: <<< Deterministic local weather physical proof trace correlation=${eventCorrelation} ordinal=${ordinal} tool=${tool} status=completed${tail}`;
  const log = (events) => [
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${boundary}`,
    ...events,
  ].join("\n");
  const exact = [
    line(1, "current_location"),
    line(2, "reverse_geocode"),
    line(3, "current_weather"),
    line(4, "terminal"),
  ];

  const valid = evaluateLocalWeatherTraceEvidence(
    "current_weather",
    log(exact),
    boundary,
    correlation,
  );
  assert.deepEqual(valid, {
    correlationMatched: true,
    ordinalsContiguous: true,
    exactOrder: true,
    freshLocationObserved: true,
    reverseGeocodeObserved: true,
    weatherProviderObserved: true,
    terminalObserved: true,
    eventCount: 4,
    pass: true,
  });
  assert.doesNotMatch(
    JSON.stringify(valid),
    /223e|current_location|reverse_geocode|current_weather/,
  );
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather_today",
      log(exact),
      boundary,
      correlation,
    ).pass,
    true,
  );

  for (const incomplete of [
    [line(1, "terminal")],
    [line(1, "current_location")],
    [line(1, "current_location"), line(2, "current_weather"), line(3, "terminal")],
  ]) {
    assert.equal(
      evaluateLocalWeatherTraceEvidence(
        "current_weather",
        log(incomplete),
        boundary,
        correlation,
      ).pass,
      false,
    );
  }
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather",
      log([
        line(1, "current_location"),
        line(2, "current_weather"),
        line(3, "reverse_geocode"),
        line(4, "terminal"),
      ]),
      boundary,
      correlation,
    ).pass,
    false,
  );
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather",
      log([
        line(1, "current_location"),
        line(2, "reverse_geocode"),
        line(4, "current_weather"),
        line(5, "terminal"),
      ]),
      boundary,
      correlation,
    ).ordinalsContiguous,
    false,
  );
  assert.equal(
    evaluateLocalWeatherTraceEvidence(
      "current_weather",
      log([
        line(1, "current_location"),
        line(2, "reverse_geocode", otherCorrelation),
        line(3, "current_weather"),
        line(4, "terminal"),
      ]),
      boundary,
      correlation,
    ).correlationMatched,
    false,
  );
  assert.throws(
    () =>
      evaluateLocalWeatherTraceEvidence(
        "current_weather",
        log([line(1, "current_location", correlation, " latitude=55.6")]),
        boundary,
        correlation,
      ),
    /trace event was malformed/,
  );
});

test("prompt attribution ignores old and unrelated rows and the Tickle control rejects escape", () => {
  const rows = parsePromptActivityPage({
    items: [
      { id: 1, prompt: "tickle", response: "Action: Tickle" },
      { id: 2, prompt: "another fixed public fixture", response: "Action: Tickle" },
      { id: 3, prompt: "please tickle", response: "ordinary answer" },
    ],
  });
  assert.equal(evaluatePromptEvidence("tickle_single", rows, 1).pass, false);
  const rejected = evaluatePromptEvidence("tickle_negative", rows, 1);
  assert.equal(rejected.pass, true);
  assert.equal(rejected.terminalObserved, true);
  const pending = evaluatePromptEvidence("tickle_negative", [], 1);
  assert.equal(pending.pass, false, "an absent response must not pass");
  assert.equal(pending.actionEscaped, false, "an absent response remains pending, not escaped");
  const escaped = [...rows, { id: 4, prompt: "please tickle", response: "Action: Tickle" }];
  const escapedEvidence = evaluatePromptEvidence("tickle_negative", escaped, 1);
  assert.equal(escapedEvidence.pass, false);
  assert.equal(escapedEvidence.actionEscaped, true);

  const duplicatedPositive = [
    { id: 5, prompt: "tickle", response: "Action: Tickle" },
    { id: 6, prompt: "tickle", response: "Action: Tickle" },
  ];
  assert.equal(
    evaluatePromptEvidence("tickle_single", duplicatedPositive, 1).pass,
    false,
  );
});

test("media-session evidence honors the Android 12 playback clock when base position is static", () => {
  const privateTitle = "PRIVATE_TRACK_TITLE_52aa";
  const first = parseMediaSessionSummary(`
    Global priority session is com.android.server.telecom/HeadsetMediaButton (userId=0)
      HeadsetMediaButton com.android.server.telecom/HeadsetMediaButton (userId=0)
        package=com.android.server.telecom
        state=PlaybackState {state=7, position=-1, buffered position=0}
    User Records:
    Record for full_user=0
      Sessions Stack - have 2 sessions:
        unrelated-id unrelated.player/session (userId=0)
          package=unrelated.player
          state=PlaybackState {state=3, position=900, buffered position=1200, speed=1.0, updated=21894, actions=0, custom actions=[], active item id=-1, error=null}
        opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
          package=humane.experience.music
          metadata=${privateTitle}
          state=PlaybackState {state=3, position=100, buffered position=600, speed=1.0, updated=22001, actions=3670015, custom actions=[], active item id=0, error=null}
  `);
  const second = parseMediaSessionSummary(`
    User Records:
    Record for full_user=0
      Sessions Stack - have 1 sessions:
        opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
          package=humane.experience.music
          metadata=${privateTitle}
          state=PlaybackState {state=3, position=100, buffered position=600, speed=1.0, updated=22001, actions=3670015, custom actions=[], active item id=0, error=null}
  `);
  assert.deepEqual(first, {
    sessionCount: 1,
    playing: true,
    playbackClockRunning: true,
    maximumPlayingPosition: 100,
  });
  assert.equal(mediaPositionAdvanced(first, second), false);
  assert.equal(mediaPositionAdvanced(first, second, 1_499), false);
  assert.equal(mediaPositionAdvanced(first, second, 1_500), true);
  assert.doesNotMatch(JSON.stringify({ first, second }), /PRIVATE_TRACK/);
});

test("media-session evidence ignores unrelated playback and historical stock mentions", () => {
  const paused = parseMediaSessionSummary(`
    User Records:
    Record for full_user=0
      Sessions Stack - have 2 sessions:
        unrelated-id unrelated.player/session (userId=0)
          package=unrelated.player
          state=PlaybackState {state=3, position=900, buffered position=1200, speed=1.0, updated=21894}
        opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
          package=humane.experience.music
          state=PlaybackState {state=2, position=400, buffered position=600, speed=1.0, updated=22001}
  `);
  assert.deepEqual(paused, {
    sessionCount: 1,
    playing: false,
    playbackClockRunning: false,
    maximumPlayingPosition: null,
  });

  const historicalOnly = parseMediaSessionSummary(`
    Last MediaButtonReceiver: MBR {pi=PendingIntent{opaque humane.experience.music}}
    Media button session is null
    Audio playback (lastly played comes first)
      uid=10061 packages=humane.experience.music
  `);
  assert.deepEqual(historicalOnly, {
    sessionCount: 0,
    playing: false,
    playbackClockRunning: false,
    maximumPlayingPosition: null,
  });
});

test("media-session evidence selects the greatest position across stock playing records", () => {
  const summary = parseMediaSessionSummary(`
    Sessions Stack - have 3 sessions:
      first-stock-id humane.experience.music/first (userId=0)
        package=humane.experience.music
        state=PlaybackState {state=3, position=1200, buffered position=1600, speed=1.0, updated=22001}
      paused-stock-id humane.experience.music/paused (userId=0)
        package=humane.experience.music
        state=PlaybackState {state=2, position=2400, buffered position=2600, speed=1.0, updated=22001}
      second-stock-id humane.experience.music/second (userId=0)
        package=humane.experience.music
        state=PlaybackState {state=3, position=1700, buffered position=2100, speed=1.0, updated=22001}
  `);
  assert.deepEqual(summary, {
    sessionCount: 3,
    playing: true,
    playbackClockRunning: true,
    maximumPlayingPosition: 1700,
  });
});

test("a stopped playback clock cannot substitute for advancing stock position", () => {
  const first = parseMediaSessionSummary(`
    opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
      package=humane.experience.music
      state=PlaybackState {state=3, position=100, buffered position=600, speed=0.0, updated=22001}
  `);
  const second = parseMediaSessionSummary(`
    opaque-stock-id humane.experience.music/androidx.media3.session.id. (userId=0)
      package=humane.experience.music
      state=PlaybackState {state=3, position=100, buffered position=600, speed=0.0, updated=22001}
  `);
  assert.equal(first.playing, true);
  assert.equal(first.playbackClockRunning, false);
  assert.equal(mediaPositionAdvanced(first, second, 1_500), false);
});

test("music attribution requires the exact normalized provider title, artist set, and album", () => {
  const rankOne = {
    title: "  Beat It ",
    artists: ["Michael Jackson", "Guest Artist"],
    album: "Thriller",
  };
  const rows = [
    {
      id: 10,
      title: "Beat It",
      artists: ["Michael Jackson"],
      album: "Thriller",
    },
    {
      id: 11,
      title: "BEAT   IT",
      artists: ["Guest Artist", "Michael Jackson"],
      album: "Wrong Album",
    },
    {
      id: 12,
      title: "BEAT   IT",
      artists: ["Guest Artist", "Michael Jackson"],
      album: " thriller ",
    },
  ];
  const attributed = findAttributedMusic(rows, 9, rankOne);
  assert.equal(attributed.matching?.id, 12);
  assert.equal(findAttributedMusic(rows, 12, rankOne).matching, undefined);
});

test("process and foreground parsers are strict and privacy-minimal", () => {
  assert.deepEqual(parsePidSet("321 123\n"), [123, 321]);
  assert.deepEqual(parsePidSet("\n"), []);
  assert.throws(() => parsePidSet("123; reboot"), /malformed/);
  assert.equal(
    tickleActivityIsForeground(
      "mResumedActivity: ActivityRecord{x u0 humane.experience.tickle/humaneinternal.system.ipc.HumaneExperienceActivity t7}",
    ),
    true,
  );
  assert.equal(
    tickleActivityIsForeground(
      "mResumedActivity: ActivityRecord{x u0 unrelated.package/.Main t7}",
    ),
    false,
  );
});

test("simple-action hook evidence is bounded by the harness marker and ordered", () => {
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const privateHookText = "PRIVATE_HOOK_DETAIL_4b27";
  const events = parsePenumbraHookEvidence(`
1710000000.001  100  101 W PenumbraHook: Repaired identifier-less local action for streaming dispatch
1710000000.002  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.003  100  101 W PenumbraHook: ${privateHookText}
1710000000.004  100  101 W PenumbraHook: Repaired identifier-less local action for streaming dispatch
1710000000.005  100  101 W PenumbraHook: Observed native action for physical verification | action=GetCurrentTime
1710000000.006  100  101 W PenumbraHook: Hand tracking timeout held for narration | sessionArmed=true
1710000000.007  100  101 W PenumbraHook: NARRATION_END released narration hold | sessionArmed=true
`, marker);
  assert.deepEqual(events, [
    "action:GetCurrentTime",
    "narration_start",
    "narration_end",
  ]);
  assert.deepEqual(evaluateSimpleHookEvidence(events, "GetCurrentTime"), {
    localActionObserved: true,
    narrationStarted: true,
    narrationEnded: true,
    pass: true,
  });
  assert.equal(
    evaluateSimpleHookEvidence([
      "narration_start",
      "action:GetCurrentTime",
      "narration_end",
    ], "GetCurrentTime").pass,
    false,
  );
  assert.equal(
    evaluateSimpleHookEvidence(
      ["action:GetBatteryLevel", "narration_start", "narration_end"],
      "GetCurrentTime",
    ).pass,
    false,
  );
  assert.equal(
    evaluateNativeActionHookEvidence(
      ["action:Tickle", "action:Tickle"],
      "Tickle",
    ).pass,
    false,
  );
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_HOOK/);
  assert.throws(
    () => parsePenumbraHookEvidence("", marker),
    /boundary was unavailable/,
  );
});

test("pause cleanup accepts only the exact boundary-scoped compatibility dispatch", () => {
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const events = parsePenumbraHookEvidence(`
1710000000.001  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic
1710000000.002  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.003  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic extra
1710000000.004  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic
  `, marker);
  assert.deepEqual(events, ["action:PauseMusic"]);
  assert.deepEqual(evaluateNativeActionHookEvidence(events, "PauseMusic"), {
    exactActionObserved: true,
    expectedActionCount: 1,
    actionEventCount: 1,
    pass: true,
  });

  const nearMiss = parsePenumbraHookEvidence(`
1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.002  100  101 W PenumbraHook: Music intent compatibility emitted PauseMusic extra
1710000000.003  100  101 W PenumbraHook: music intent compatibility emitted PauseMusic
  `, marker);
  assert.deepEqual(nearMiss, []);
});

test("progress evidence requires the content-free Spark decision after its boundary", () => {
  const marker = "physical-loading-123e4567-e89b-42d3-a456-426614174000";
  const privateLogText = "PRIVATE_PROGRESS_DETAIL_5c19";
  const observed = evaluateProgressModelEvidence(
    "loading_semantic_weather",
    `
1710000000.001  100  101 W PenumbraServer: emitted=true source=spark reason=spark <<< Returning bounded stock loading message
1710000000.002  100  101 I PenumbraPhysicalHarness: ${marker}
1710000000.003  100  101 W PenumbraServer: ${privateLogText}
1710000000.004  100  101 W PenumbraServer: INFO humane_server: <<< Returning bounded stock loading message emitted=true source=spark reason=spark correlation=${marker}
`,
    marker,
  );
  assert.deepEqual(observed, {
    decisionObserved: true,
    correlationMatched: true,
    emissionMatched: true,
    sparkObserved: true,
    lockedFallbackObserved: null,
    pass: true,
  });
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_PROGRESS/);

  const fallback = evaluateProgressModelEvidence(
    "loading_semantic_weather",
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}\n` +
      `1710000000.002  100  101 W PenumbraServer: <<< Returning bounded stock loading message emitted=true source=fallback reason=timeout correlation=${marker}\n`,
    marker,
  );
  assert.equal(fallback.pass, false);
  assert.equal(fallback.sparkObserved, false);

  const locked = evaluateProgressModelEvidence(
    "loading_locked_neutral",
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}\n` +
      `1710000000.002  100  101 W PenumbraServer: <<< Returning bounded stock loading message emitted=false source=fallback reason=skipped correlation=${marker}\n`,
    marker,
  );
  assert.equal(locked.pass, true);
  assert.equal(locked.lockedFallbackObserved, true);

  const unrelated = evaluateProgressModelEvidence(
    "loading_semantic_weather",
    `1710000000.001  100  101 I PenumbraPhysicalHarness: ${marker}\n` +
      "1710000000.002  100  101 W PenumbraServer: <<< Returning bounded stock loading message emitted=true source=spark reason=spark correlation=physical-loading-223e4567-e89b-42d3-a456-426614174000\n",
    marker,
  );
  assert.equal(unrelated.pass, false);
  assert.equal(unrelated.correlationMatched, false);
});

test("loading cue latency is gated at the five-second end-to-end boundary", () => {
  assert.equal(loadingCueWithinDeadline(0), true);
  assert.equal(loadingCueWithinDeadline(4_999), true);
  assert.equal(loadingCueWithinDeadline(5_000), true);
  assert.equal(loadingCueWithinDeadline(5_001), false);
  assert.equal(loadingCueWithinDeadline(Number.NaN), false);
  assert.equal(loadingCueWithinDeadline(-1), false);
});

test("readiness requires exact release, authenticated Center, and live provider gates", () => {
  const ready = evaluatePhysicalReadiness(readinessFixture(), identityFixture(), EXPECTED);
  assert.equal(ready.pass, true);
  assert.ok(Object.values(ready.checks).every(Boolean));

  const stale = readinessFixture();
  stale.spotify.engine_ready = false;
  stale.featureFlags.delivery.stock_cache_verified = false;
  stale.settings.openstreetmap = {};
  const notReady = evaluatePhysicalReadiness(stale, identityFixture(), EXPECTED);
  assert.equal(notReady.pass, false);
  assert.equal(notReady.checks.spotifyReady, false);
  assert.equal(notReady.checks.tickleReady, false);
  assert.equal(notReady.checks.weatherLocalityReady, false);
});

test("self-check emits a bounded report without fixture response content", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = await main(["--self-check", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.equal(report.fixed_case_count, 14);
  assert.equal(report.safety.one_fixed_case_required_for_live_run, true);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /PRIVATE_|Hvidovre|degrees|transcription/);
});

test("a selected loading case touches no unrelated activity or package surface", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const marker = "physical-loading-123e4567-e89b-42d3-a456-426614174000";
  const exitCode = await main(
    liveArgs(["--json"], "loading_semantic_weather"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async beginProgressEvidence() {
            return marker;
          },
          async loadingCue(caseId, _grpcPort, correlationMarker) {
            assert.equal(correlationMarker, marker);
            calls.push(caseId);
            return {
              loadingMessage: "Checking the weather...",
              verbalMessage: "Checking the weather.",
            };
          },
          async progressEvidenceSince(caseId, boundaryMarker) {
            assert.equal(caseId, "loading_semantic_weather");
            assert.equal(boundaryMarker, marker);
            return {
              decisionObserved: true,
              correlationMatched: true,
              emissionMatched: true,
              sparkObserved: true,
              lockedFallbackObserved: null,
              pass: true,
            };
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.equal(report.selected_case, "loading_semantic_weather");
  assert.deepEqual(report.cases.map((item) => item.id), [
    "loading_semantic_weather",
  ]);
  assert.deepEqual(calls, ["loading_semantic_weather"]);
  assert.deepEqual(report.cleanup, {
    prompt_activity_removed: null,
    music_activity_removed: null,
    music_not_playing: null,
    tickle_not_running: null,
    media_volume_snapshot_captured: null,
    media_volume_restored: null,
  });
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|device-123/);
});

test("each local-weather prompt requires its correlated four-milestone proof", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const correlation = "223e4567-e89b-42d3-a456-426614174000";
  const prompt = "What's the weather like today?";
  const rows = [
    {
      id: 72,
      run_id: correlation,
      prompt,
      response: "Clear, 22 degrees Celsius in PRIVATE_LOCALITY_91af.",
    },
    {
      id: 71,
      run_id: correlation,
      prompt,
      response: "Action: GetCurrentLocation",
    },
  ];
  const injected = [];
  const deleted = [];
  let promptReads = 0;
  const exitCode = await main(
    liveArgs(["--json"], "current_weather_today"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async promptRows() {
            promptReads += 1;
            return promptReads === 1 ? [] : rows;
          },
          async beginAgenticEvidence() {
            return marker;
          },
          async inject(caseId) {
            injected.push(caseId);
          },
          async localWeatherEvidenceSince(
            caseId,
            boundaryMarker,
            expectedCorrelation,
          ) {
            assert.equal(caseId, "current_weather_today");
            assert.equal(boundaryMarker, marker);
            assert.equal(expectedCorrelation, correlation);
            return {
              correlationMatched: true,
              ordinalsContiguous: true,
              exactOrder: true,
              freshLocationObserved: true,
              reverseGeocodeObserved: true,
              weatherProviderObserved: true,
              terminalObserved: true,
              eventCount: 4,
              pass: true,
            };
          },
          async deletePrompt(id) {
            deleted.push(id);
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["current_weather_today"]);
  assert.deepEqual(deleted.sort((a, b) => a - b), [71, 72]);
  assert.deepEqual(report.cases[0], {
    id: "current_weather_today",
    status: "pass",
    route_observed: true,
    physical_effect_observed: null,
    exact_tool_chain_observed: true,
    correlation_observed: true,
    fresh_location_observed: true,
    reverse_geocode_observed: true,
    weather_provider_observed: true,
    trace_event_count: 4,
    terminal_observed: true,
    locality_observed: true,
    duration_bucket: report.cases[0].duration_bucket,
  });
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(
    stdout.text(),
    /fixture-token|device-123|PRIVATE_|weather like today|223e|degrees/,
  );
});

test("the remote capital-weather case requires exact trace and sanitized terminal proof", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker =
    "physical-agentic-123e4567-e89b-42d3-a456-426614174000";
  const prompt = "Lookup the capitol of France and check the weather there";
  const row = {
    id: 71,
    run_id: "223e4567-e89b-42d3-a456-426614174000",
    prompt,
    response:
      "I found Paris. Current weather in Paris, France: Clear; 22 degrees Celsius. PRIVATE_AGENTIC_RESPONSE",
  };
  const injected = [];
  const deleted = [];
  let promptReads = 0;
  const exitCode = await main(
    liveArgs(["--json"], "capital_weather_remote"),
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      dependencies: {
        token: "fixture-token-value-that-is-private",
        verifyDevice: async () => {},
        identity: identityFixture(),
        snapshot: readinessFixture(),
        device: {
          ...GUARDED_MEDIA_VOLUME_DEVICE,
          async promptRows() {
            promptReads += 1;
            return promptReads === 1 ? [] : [row];
          },
          async beginAgenticEvidence() {
            return marker;
          },
          async inject(caseId) {
            injected.push(caseId);
          },
          async agenticEvidenceSince(
            caseId,
            boundaryMarker,
            expectedCorrelation,
          ) {
            assert.equal(caseId, "capital_weather_remote");
            assert.equal(boundaryMarker, marker);
            assert.equal(
              expectedCorrelation,
              "223e4567-e89b-42d3-a456-426614174000",
            );
            return {
              correlationMatched: true,
              ordinalsContiguous: true,
              exactOrder: true,
              currentLocationObserved: false,
              terminalObserved: true,
              eventCount: 4,
              pass: true,
            };
          },
          async deletePrompt(id) {
            deleted.push(id);
          },
        },
      },
    },
  );
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["capital_weather_remote"]);
  assert.deepEqual(deleted, [71]);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].exact_tool_chain_observed, true);
  assert.equal(report.cases[0].correlation_observed, true);
  assert.equal(report.cases[0].current_location_observed, false);
  assert.equal(report.cases[0].trace_event_count, 4);
  assert.equal(report.cases[0].terminal_observed, true);
  assert.equal(report.cases[0].locality_observed, true);
  assert.equal(report.cases[0].france_grounded, true);
  assert.equal(report.cases[0].wrong_country_observed, false);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(
    stdout.text(),
    /fixture-token|device-123|PRIVATE_|France|Paris|degrees|48\.8/,
  );
});

test("a selected simple case uses exact hook evidence without requiring a Center row", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const injected = [];
  const deleted = [];
  const exitCode = await main(liveArgs(["--json"]), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async promptRows() {
          return [];
        },
        async beginHookEvidence() {
          return marker;
        },
        async inject(caseId) {
          injected.push(caseId);
        },
        async hookEvidenceSince(boundaryMarker) {
          assert.equal(boundaryMarker, marker);
          return [
            "action:GetCurrentTime",
            "narration_start",
            "narration_end",
          ];
        },
        async deletePrompt(id) {
          deleted.push(id);
        },
      },
    },
  });
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.equal(report.selected_case, "current_time");
  assert.deepEqual(injected, ["current_time"]);
  assert.deepEqual(deleted, []);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].terminal_observed, true);
  assert.equal(report.cases[0].physical_effect_observed, null);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|what time|transcription/);
});

test("a Tickle positive requires its exact hook action and stable stock launcher without a Center row", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  let launched = false;
  let stopped = false;
  const injected = [];
  const exitCode = await main(liveArgs(["--json"], "tickle_single"), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async promptRows() {
          return [];
        },
        async pids() {
          return launched && !stopped ? [321] : [];
        },
        async tickleForeground() {
          return launched && !stopped;
        },
        async beginHookEvidence() {
          return marker;
        },
        async inject(caseId) {
          injected.push(caseId);
          launched = true;
        },
        async hookEvidenceSince(boundaryMarker) {
          assert.equal(boundaryMarker, marker);
          return ["action:Tickle"];
        },
        async forceStop() {
          stopped = true;
        },
        async deletePrompt() {
          assert.fail("no Center row should be owned");
        },
      },
    },
  });
  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["tickle_single"]);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].launcher_observed, true);
  assert.equal(report.cases[0].physical_effect_observed, null);
  assert.equal(report.cases[0].terminal_observed, null);
  assert.equal(report.cleanup.tickle_not_running, true);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|device-123|PRIVATE_/);
});

test("the Tickle negative fails on an exact hook escape even without launcher state", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const terminalRow = {
    id: 51,
    prompt: "please tickle",
    response: "ordinary answer",
  };
  let injected = false;
  const exitCode = await main(liveArgs(["--json"], "tickle_negative"), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async promptRows() {
          return injected ? [terminalRow] : [];
        },
        async pids() {
          return [];
        },
        async tickleForeground() {
          return false;
        },
        async beginHookEvidence() {
          return marker;
        },
        async inject() {
          injected = true;
        },
        async hookEvidenceSince(boundaryMarker) {
          assert.equal(boundaryMarker, marker);
          return ["action:Tickle"];
        },
        async forceStop() {},
        async deletePrompt() {},
      },
    },
  });
  assert.equal(exitCode, 3);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "incomplete");
  assert.equal(report.cases[0].status, "fail");
  assert.equal(report.cases[0].route_observed, false);
  assert.equal(report.cases[0].launcher_observed, false);
  assert.equal(report.cases[0].terminal_observed, true);
  assert.equal(stderr.text(), "");
});

test("ranked music cleanup accepts exact Hook PauseMusic without a Center row", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const marker = "physical-simple-123e4567-e89b-42d3-a456-426614174000";
  const rankedCase = PHYSICAL_PROMPT_CASES.find((item) => item.id === "ranked_music");
  const rankOne = {
    title: "Public Fixture Track",
    artists: ["Public Fixture Artist"],
    album: "Public Fixture Album",
  };
  const routeRow = {
    id: 61,
    prompt: rankedCase.prompt,
    response: "Action: PlayMusic",
  };
  const musicRow = {
    id: 71,
    ...rankOne,
    status: "playing",
  };
  const injected = [];
  const deletedPrompts = [];
  const deletedMusic = [];
  const cleanupOrder = [];
  let musicStarted = false;
  let playing = false;
  let stopped = false;

  const exitCode = await main(liveArgs(["--json"], "ranked_music"), {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => {},
      identity: identityFixture(),
      snapshot: readinessFixture(),
      rankOne,
      device: {
        ...GUARDED_MEDIA_VOLUME_DEVICE,
        async setMediaVolumeIndex(index) {
          assert.equal(index, GUARDED_MEDIA_VOLUME_STATE.index);
          cleanupOrder.push("volume_restore");
        },
        async promptRows() {
          return musicStarted ? [routeRow] : [];
        },
        async musicRows() {
          return musicStarted ? [musicRow] : [];
        },
        async pids() {
          return musicStarted && !stopped ? [321] : [];
        },
        async media() {
          if (stopped || !musicStarted) {
            return {
              sessionCount: 0,
              playing: false,
              playbackClockRunning: false,
              maximumPlayingPosition: null,
            };
          }
          return {
            sessionCount: 1,
            playing,
            playbackClockRunning: playing,
            maximumPlayingPosition: playing ? 100 : null,
          };
        },
        async inject(caseId) {
          injected.push(caseId);
          if (caseId === "ranked_music") {
            musicStarted = true;
            playing = true;
          } else if (caseId === "music_pause_cleanup") {
            playing = false;
          }
        },
        async beginHookEvidence() {
          return marker;
        },
        async hookEvidenceSince(boundaryMarker) {
          assert.equal(boundaryMarker, marker);
          return injected.at(-1) === "music_pause_cleanup" ? ["action:PauseMusic"] : [];
        },
        async forceStop() {
          cleanupOrder.push("music_stop");
          stopped = true;
          playing = false;
        },
        async deletePrompt(id) {
          cleanupOrder.push("prompt_cleanup");
          deletedPrompts.push(id);
        },
        async deleteMusic(id) {
          cleanupOrder.push("music_row_cleanup");
          deletedMusic.push(id);
        },
      },
    },
  });

  assert.equal(exitCode, 0);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "pass");
  assert.deepEqual(injected, ["ranked_music", "music_pause_cleanup"]);
  assert.deepEqual(deletedPrompts, [61]);
  assert.deepEqual(deletedMusic, [71]);
  assert.equal(cleanupOrder.at(-1), "volume_restore");
  assert.ok(cleanupOrder.indexOf("music_stop") < cleanupOrder.indexOf("volume_restore"));
  assert.ok(cleanupOrder.indexOf("prompt_cleanup") < cleanupOrder.indexOf("volume_restore"));
  assert.ok(cleanupOrder.indexOf("music_row_cleanup") < cleanupOrder.indexOf("volume_restore"));
  assert.equal(report.cleanup.media_volume_snapshot_captured, true);
  assert.equal(report.cleanup.media_volume_restored, true);
  assert.equal(report.cases[0].route_observed, true);
  assert.equal(report.cases[0].physical_effect_observed, true);
  assert.equal(report.cases[0].provider_rank_one_match, true);
  assert.equal(report.cases[0].pause_route_observed, true);
  assert.equal(report.cases[0].cleanup_restored_idle, true);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(
    stdout.text(),
    /fixture-token|Public Fixture|PRIVATE_/,
  );
});

test("an identity mismatch blocks before any physical device method is invoked", async () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  let verified = 0;
  const exitCode = await main([...liveArgs(), "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    dependencies: {
      token: "fixture-token-value-that-is-private",
      verifyDevice: async () => { verified += 1; },
      identity: { ...identityFixture(), apkSha256: "b".repeat(64) },
      snapshot: readinessFixture(),
      device: new Proxy({}, {
        get() { throw new Error("physical device method must not be used"); },
      }),
    },
  });
  assert.equal(verified, 1);
  assert.equal(exitCode, 3);
  const report = JSON.parse(stdout.text());
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.cases, []);
  assert.equal(stderr.text(), "");
  assert.doesNotMatch(stdout.text(), /fixture-token|device-123|bbbbbbbb/);
});

test("suite execution independently refuses a caller-authorized old release", async () => {
  await assert.rejects(
    executePhysicalSuite(
      {
        ...parsePhysicalCliArgs(liveArgs()),
        expectedVersionName: "2026-07-17.36-local",
      },
      {
        token: "must-not-be-read",
        device: new Proxy({}, {
          get() { throw new Error("physical device method must not be used"); },
        }),
      },
    ),
    /unpinned candidate identity/,
  );
});

test("suite execution rejects a missing serial before reading dependencies", async () => {
  let dependencyRead = false;
  await assert.rejects(
    executePhysicalSuite(
      {
        ...parsePhysicalCliArgs(liveArgs()),
        serial: null,
      },
      {
        get token() {
          dependencyRead = true;
          throw new Error("dependency must not be read");
        },
      },
    ),
    /valid explicit ADB serial/,
  );
  assert.equal(dependencyRead, false);
});
