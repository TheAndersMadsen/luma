// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseCommand, parseRoomRequest, parseRoomConnection, parseFrame, publicText, renderContentPayload, type ChoicesContent, type PlacesContent } from "./ambianceRuntime";
import { roomConnection, runtimeEpoch } from "../browserRoom.test-support";
it("browser runtime wire bounds match the canonical contract", () => {
  const contract = JSON.parse(readFileSync(new URL("../../../../contracts/ambiance-runtime.json", import.meta.url), "utf8"));
  expect(contract.limits.textBytes).toBe(4000); expect(contract.limits.ackDeadlineMs).toBe(3000); expect(contract.limits.displayLifetimeMs).toBe(60000);
  const proof = { surfaceId: "11111111-1111-1111-1111-111111111111", incarnation: "22222222-2222-2222-2222-222222222222" };
  expect(publicText("é".repeat(2000))).toBe(true);
  expect(publicText("é".repeat(2001))).toBe(false);
  expect(() => parseRoomRequest({ ...proof, epoch: runtimeEpoch })).not.toThrow();
  expect(() => parseRoomRequest({ ...proof, epoch: runtimeEpoch, trust: 2 })).toThrow();
  expect(() => parseCommand({ ...proof, version: 1, actionId: proof.surfaceId, turnId: proof.incarnation, generation: 1, channel: "visual.card", contentDigest: "a".repeat(64), privacy: "shared_room", expiresAt: 1, content: { kind: "html", text: "<script/>" } })).toThrow();
});
it("accepts only exact room fields and the configured same-origin signal path", () => {
  const valid = roomConnection(runtimeEpoch);
  expect(parseRoomConnection(valid, "https://center.test")).toEqual(valid);
  for (const url of ["wss://other.test/livekit", "ws://center.test/livekit", "wss://center.test/livekit/",
    "wss://center.test/livekit?token=x", "wss://user@center.test/livekit", "wss://center.test/rtc"]) {
    expect(() => parseRoomConnection({ ...valid, url }, "https://center.test")).toThrow();
  }
  expect(() => parseRoomConnection({ ...valid, owner: "other" }, "https://center.test")).toThrow();
  expect(() => parseFrame(JSON.stringify({ version: 1, kind: "clear", actionId: runtimeEpoch,
    stamp: { epoch: runtimeEpoch, sequence: Number.MAX_SAFE_INTEGER + 1, instanceId: runtimeEpoch } }))).toThrow();
});

const place = {
  placeId: "ChIJ-Copenhagen",
  name: "Café Example",
  address: "Example Street 2, Copenhagen",
  sourceUrl: "https://www.google.com/maps/place/Cafe?cid=123#details",
};
function placesContent(): PlacesContent {
  return { kind: "places", query: "Café in Copenhagen", items: [{ ...place }], attributions: ["Example attribution"] };
}
function commandWithContent(content: unknown) {
  return {
    version: 1, actionId: runtimeEpoch, turnId: runtimeEpoch, generation: 1,
    surfaceId: runtimeEpoch, incarnation: runtimeEpoch, channel: "visual.card",
    contentDigest: "a".repeat(64), privacy: "shared_room", expiresAt: 1, content,
  };
}
function withoutField(value: object, omitted: string) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omitted));
}

it("accepts bounded place-address cards, including zero results and absent provider links", () => {
  const content = placesContent();
  expect(parseCommand(commandWithContent(content)).content).toEqual(content);
  expect(parseCommand(commandWithContent({ ...content, items: [], attributions: [] })).content)
    .toEqual({ ...content, items: [], attributions: [] });
  const fourPlaces = Array.from({ length: 4 }, (_, index) => ({ ...place, placeId: `place-${index}`, sourceUrl: null }));
  expect(() => parseCommand(commandWithContent({ ...content, items: fourPlaces }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, attributions: Array.from({ length: 16 }, (_, index) => `Credit ${index}`) }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [...fourPlaces, { ...place }] }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, attributions: Array.from({ length: 17 }, (_, index) => `Credit ${index}`) }))).toThrow();
});

it("requires exact Places content and item fields without location or action payloads", () => {
  const content = placesContent();
  for (const field of ["kind", "query", "items", "attributions"]) {
    expect(() => parseCommand(commandWithContent(withoutField(content, field))), field).toThrow();
  }
  for (const field of ["placeId", "name", "address", "sourceUrl"]) {
    expect(() => parseCommand(commandWithContent({ ...content, items: [withoutField(place, field)] })), field).toThrow();
  }
  for (const additional of [{ text: "Speak this" }, { provider: "google_places" }, { navigation: true }]) {
    expect(() => parseCommand(commandWithContent({ ...content, ...additional }))).toThrow();
  }
  for (const additional of [{ latitude: 55.67 }, { longitude: 12.56 }, { action: "navigate" }]) {
    expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, ...additional }] }))).toThrow();
  }
  for (const items of [null, {}, "places", [null], ["place"]]) {
    expect(() => parseCommand(commandWithContent({ ...content, items }))).toThrow();
  }
  for (const attributions of [null, {}, "Credit", [null], [42], [""]]) {
    expect(() => parseCommand(commandWithContent({ ...content, attributions }))).toThrow();
  }
  for (const query of [null, 42, ""]) {
    expect(() => parseCommand(commandWithContent({ ...content, query }))).toThrow();
  }
  for (const field of ["placeId", "name", "address"]) {
    for (const value of [null, 42, ""]) {
      expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, [field]: value }] }))).toThrow();
    }
  }
});

it("bounds each Places text field in UTF-8 bytes", () => {
  const content = placesContent();
  expect(() => parseCommand(commandWithContent({ ...content, query: "é".repeat(256) }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, query: `${"é".repeat(256)}x` }))).toThrow();
  for (const [field, limit] of [["placeId", 1024], ["name", 256], ["address", 512]] as const) {
    const boundary = "é".repeat(limit / 2);
    expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, [field]: boundary }] })), field).not.toThrow();
    expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, [field]: `${boundary}x` }] })), field).toThrow();
  }
  expect(() => parseCommand(commandWithContent({ ...content, attributions: ["é".repeat(1024)] }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, attributions: [`${"é".repeat(1024)}x`] }))).toThrow();
  const prefix = "https://maps.google.com/maps?q=";
  const sourceUrl = `${prefix}${"x".repeat(2048 - prefix.length)}`;
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, sourceUrl }] }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, sourceUrl: `${sourceUrl}x` }] }))).toThrow();
});

it("rejects control characters in place identity and labels and whitespace in provider IDs", () => {
  const content = placesContent();
  for (const field of ["placeId", "name", "address"]) {
    for (const value of ["before\u0000after", "before\nafter", "before\u007fafter", "before\u0085after"]) {
      expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, [field]: value }] })), field).toThrow();
    }
  }
  for (const placeId of ["two words", "two\twords", "two\u00a0words"]) {
    expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, placeId }] }))).toThrow();
  }
});

it("accepts only provider Google Maps source URLs and preserves their exact value", () => {
  const content = placesContent();
  for (const sourceUrl of [null, "https://maps.google.com/?cid=123", "https://www.google.com/maps", place.sourceUrl]) {
    expect(parseCommand(commandWithContent({ ...content, items: [{ ...place, sourceUrl }] })).content)
      .toEqual({ ...content, items: [{ ...place, sourceUrl }] });
  }
  for (const sourceUrl of [
    "", 42, "http://maps.google.com/maps", "javascript:alert(1)", "//maps.google.com/maps",
    "https://maps.google.com.evil.test/maps", "https://google.com/maps", "https://www.google.com/search?q=cafe",
    "https://www.google.com/maps-other", "https://maps.google.com:8443/maps",
    "https://user@maps.google.com/maps", "https://user:password@maps.google.com/maps",
    "https://maps.google.com/maps?q=two words", " https://maps.google.com/maps",
    "https://maps.google.com/maps\n", "https://maps.google.com/maps?x=\u0000",
    "https://maps.google.com\\maps", "https://www.google.com/maps/../search",
  ]) {
    expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...place, sourceUrl }] })), String(sourceUrl)).toThrow();
  }
});

it("caps the complete serialized Places content at 8192 UTF-8 bytes", () => {
  const content: PlacesContent = { kind: "places", query: "Café", items: [], attributions: ["", "", "", ""] };
  const overhead = new TextEncoder().encode(JSON.stringify(content)).length;
  content.attributions = ["a".repeat(2048), "b".repeat(2048), "c".repeat(2048), "d".repeat(8192 - overhead - 6144)];
  expect(new TextEncoder().encode(JSON.stringify(content)).length).toBe(8192);
  expect(() => parseCommand(commandWithContent(content))).not.toThrow();
  content.attributions[3] += "x";
  expect(new TextEncoder().encode(JSON.stringify(content)).length).toBe(8193);
  expect(() => parseCommand(commandWithContent(content))).toThrow();
});

it("uses the literal versioned Places array as the digest preimage", () => {
  const content: PlacesContent = {
    kind: "places", query: "Café nearby",
    items: [
      { placeId: "place-1", name: "Café One", address: "Street 1", sourceUrl: null },
      { placeId: "place-2", name: "Café Two", address: "Street 2", sourceUrl: "https://maps.google.com/?cid=2" },
    ],
    attributions: ['<a href="https://credit.test">Credit</a>', "Second credit"],
  };
  const expected = '["cosmos.place-address-card",1,"Café nearby",[["place-1","Café One","Street 1",null],["place-2","Café Two","Street 2","https://maps.google.com/?cid=2"]],["<a href=\\"https://credit.test\\">Credit</a>","Second credit"]]';
  expect(renderContentPayload(content)).toBe(expected);
  expect(renderContentPayload({ attributions: content.attributions, items: content.items, query: content.query, kind: "places" })).toBe(expected);
  expect(renderContentPayload({ ...content, items: [...content.items].reverse() })).not.toBe(expected);
  expect(renderContentPayload({ ...content, attributions: [...content.attributions].reverse() })).not.toBe(expected);
  expect(renderContentPayload({ ...content, items: [{ ...content.items[0], sourceUrl: "https://maps.google.com/?cid=1" }, content.items[1]] })).not.toBe(expected);
});

it("preserves text render digest bytes without normalization, JSON wrapping or trimming", () => {
  const text = '  Café e\u0301\n"quoted" \\ literal\r\n';
  const content = { kind: "text" as const, text };
  expect(parseCommand(commandWithContent(content)).content).toEqual(content);
  expect(renderContentPayload(content)).toBe(text);
  expect(new TextEncoder().encode(renderContentPayload(content))).toEqual(new TextEncoder().encode(text));
});

const choice = { id: "1", title: "Café One", detail: "Open until 22:00" };
function choicesContent(): ChoicesContent {
  return { kind: "choices", title: "Which café?", items: [{ ...choice }, { id: "2", title: "Café Two", detail: "" }] };
}

it("accepts a bounded choice list of two to eight entries numbered in order with exact fields", () => {
  const content = choicesContent();
  expect(parseCommand(commandWithContent(content)).content).toEqual(content);
  const eight = Array.from({ length: 8 }, (_, index) => ({ ...choice, id: String(index + 1) }));
  expect(() => parseCommand(commandWithContent({ ...content, items: eight }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [eight[7], eight[2]] }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [eight[1], eight[0]] }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [eight[0]] }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [...eight, { ...choice, id: "9" }] }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice }, { ...choice }] }))).toThrow();
  for (const id of ["0", "9", "01", "a", 1, "", " 1"]) {
    expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice, id }, { ...choice, id: "2" }] })), String(id)).toThrow();
  }
  for (const field of ["kind", "title", "items"]) expect(() => parseCommand(commandWithContent(withoutField(content, field))), field).toThrow();
  for (const field of ["id", "title", "detail"]) expect(() => parseCommand(commandWithContent({ ...content, items: [withoutField(choice, field), content.items[1]] })), field).toThrow();
  for (const additional of [{ query: "x" }, { action: "navigate" }]) expect(() => parseCommand(commandWithContent({ ...content, ...additional }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice, url: "https://x.test" }, content.items[1]] }))).toThrow();
  for (const title of [null, 42, "", " ", "line\nbreak"]) expect(() => parseCommand(commandWithContent({ ...content, title })), String(title)).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, title: "é".repeat(60) }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, title: `${"é".repeat(60)}x` }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice, title: "é".repeat(40) }, content.items[1]] }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice, title: `${"é".repeat(40)}x` }, content.items[1]] }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice, detail: "é".repeat(100) }, content.items[1]] }))).not.toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice, detail: `${"é".repeat(100)}x` }, content.items[1]] }))).toThrow();
  expect(() => parseCommand(commandWithContent({ ...content, items: [{ ...choice, detail: " " }, content.items[1]] }))).toThrow();
});

it("uses the literal versioned choice-list array as the digest preimage", () => {
  const content: ChoicesContent = { kind: "choices", title: "Which café?", items: [
    { id: "1", title: "Café \"One\"", detail: "Open until 22:00" }, { id: "2", title: "Café Two", detail: "" }] };
  const expected = '["cosmos.choice-list",1,"Which café?",[["1","Café \\"One\\"","Open until 22:00"],["2","Café Two",""]]]';
  expect(renderContentPayload(content)).toBe(expected);
  expect(renderContentPayload({ items: content.items, title: content.title, kind: "choices" })).toBe(expected);
  expect(renderContentPayload({ ...content, items: [...content.items].reverse() })).not.toBe(expected);
});

it("accepts content-free status frames and rejects anything beyond a state, a platform kind and a class", () => {
  const stamp = { epoch: runtimeEpoch, sequence: 3, instanceId: runtimeEpoch };
  const status = { version: 1, turnId: runtimeEpoch, generation: 2, state: "shown", surface: { platform: "macos" }, privacy: "shared_room" };
  const frame = (value: unknown) => JSON.stringify({ version: 1, kind: "status", stamp, status: value });
  expect(parseFrame(frame(status))).toEqual({ version: 1, kind: "status", stamp, status });
  expect(() => parseFrame(frame({ ...status, surface: null, state: "nowhere" }))).not.toThrow();
  for (const bad of [{ ...status, state: "delivered" }, { ...status, surface: { platform: "macos", surfaceId: runtimeEpoch } }, { ...status, surface: {} },
    { ...status, surface: { platform: "" } }, { ...status, surface: { platform: "Mac OS" } }, { ...status, privacy: "secret" }, { ...status, text: "reply" },
    { ...status, generation: 0 }, { ...status, version: 2 }, withoutField(status, "surface"), withoutField(status, "privacy")]) {
    expect(() => parseFrame(frame(bad)), JSON.stringify(bad)).toThrow();
  }
  expect(() => parseFrame(JSON.stringify({ version: 1, kind: "status", stamp, status, actionId: runtimeEpoch }))).toThrow();
  expect(() => parseFrame(JSON.stringify({ version: 1, kind: "progress", stamp, status }))).toThrow();
});
