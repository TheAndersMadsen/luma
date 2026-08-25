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
  const chat = await source("src/components/AiMicChat.tsx");
  assert.match(chat, /t\.text \? <p className=\{styles\.say\}>/);
  assert.doesNotMatch(chat, /<details className=\{styles\.trace\}/);
  assert.doesNotMatch(chat, /reasoningOf|Used \{.*tool|suggestion/i);
  assert.doesNotMatch(chat, /Done on your Pin|No spoken reply/);
  assert.match(chat, /text: t\.text \|\| assistantCompletionMessage\(t\.steps\)/);
  assert.match(chat, /step\.kind === "action" && step\.source === "device"/);
  assert.match(chat, /This action is only available on your Ai Pin\./);
  assert.match(chat, /Cosmos did not return a reply\. Try again\./);
});

test("Center identifies Cosmos as the assistant authority", async () => {
  const [shell, assistant, chat] = await Promise.all([
    source("src/components/Shell.tsx"),
    source("src/components/FloatingAssistant.tsx"),
    source("src/components/AiMicChat.tsx"),
  ]);

  for (const component of [shell, assistant, chat]) assert.match(component, /Ask Cosmos/);
  assert.doesNotMatch(`${shell}\n${assistant}\n${chat}`, /Ask (?:your )?(?:Ai )?Pin/);
  assert.match(chat, /t\.role === "you" \? "You" : "Cosmos"/);
});

test("a task-specific cue replaces the generic working indicator", async () => {
  const chat = await source("src/components/AiMicChat.tsx");
  assert.match(chat, /t\.cue && <p className=\{styles\.cue\} role="status">\{t\.cue\}<\/p>/);
  assert.match(chat, /t\.streaming && !t\.cue \? \(/);
});

test("legacy full-page Ai Mic links open the floating assistant", async () => {
  const talk = await source("src/app/talk/page.tsx");
  assert.match(talk, /redirect\("\/\?assistant=open"\)/);
  assert.doesNotMatch(talk, /<Shell|<AiMicChat/);
});
