import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("the global Shell opens one route-persistent floating assistant", async () => {
  const [providers, shell, assistant] = await Promise.all([
    source("src/components/Providers.tsx"),
    source("src/components/Shell.tsx"),
    source("src/components/FloatingAssistant.tsx"),
  ]);

  assert.match(providers, /<AssistantProvider>/);
  assert.match(shell, /useFloatingAssistant/);
  assert.match(shell, /aria-controls="ai-pin-assistant"/);
  assert.doesNotMatch(shell, /href="\/talk"/);
  assert.match(assistant, /role="dialog"/);
  assert.match(assistant, /event\.key === "Escape"/);
  assert.match(assistant, /openerRef\.current\?\.focus/);
});

test("assistant answers stay primary and implementation traces stay out of the UI", async () => {
  const display = await source("src/components/BrowserDisplay.tsx");
  assert.match(display, /<p ref=\{node\}>\{command\.content\.text\}<\/p>/);
  assert.match(display, /runtime\?\.committed\(command\)/);
  assert.doesNotMatch(display, /dangerouslySetInnerHTML|<audio|<details|trace\/stream/);
});

test("Center identifies Cosmos as the assistant authority", async () => {
  const [shell, assistant, chat] = await Promise.all([
    source("src/components/Shell.tsx"),
    source("src/components/FloatingAssistant.tsx"),
    source("src/components/BrowserDisplay.tsx"),
  ]);

  for (const component of [shell, assistant, chat]) assert.match(component, /Ask Cosmos/);
  assert.doesNotMatch(`${shell}\n${assistant}\n${chat}`, /Ask (?:your )?(?:Ai )?Pin/);
  assert.match(chat, /Cosmos display/);
});

test("the assistant uses the actual thin display without a legacy trace or speech path", async () => {
  const chat = await source("src/components/AiMicChat.tsx");
  assert.match(chat, /<BrowserDisplay active=\{active\}/);
  assert.doesNotMatch(chat, /\/api\/assistant\/(stream|speech)|new Audio|SpeechRecognition/);
});

test("legacy full-page Ai Mic links open the floating assistant", async () => {
  const talk = await source("src/app/talk/page.tsx");
  assert.match(talk, /redirect\("\/\?assistant=open"\)/);
  assert.doesNotMatch(talk, /<Shell|<AiMicChat/);
});
