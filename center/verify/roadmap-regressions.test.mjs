import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function cssBlock(css, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css)?.[1] ?? "";
}

async function collectCss(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) await collectCss(child, out);
    else if (entry.name.endsWith(".css")) out.push(child);
  }
  return out;
}

async function collectTsx(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) await collectTsx(child, out);
    else if (entry.name.endsWith(".tsx")) out.push(child);
  }
  return out;
}

test("wearer-facing copy stays concise and free of deployment jargon", async () => {
  const paths = [
    "src/app/page.tsx",
    "src/app/captures/page.tsx",
    "src/app/notes/page.tsx",
    "src/app/notes/search/page.tsx",
    "src/app/notes/[id]/page.tsx",
    "src/app/my-data/page.tsx",
    "src/app/my-data/DomainView.tsx",
    "src/app/settings/account/details/DetailsView.tsx",
  ];
  const bannedJargon = /\.Center|\bbackend\b|\bgRPC\b|\bIroh\b|\bADB\b|CARRY_/i;
  const filler = /\b(?:AI-powered|seamlessly|unlock|delve|leverage|revolutionary|game-changing|as an AI|language model)\b/i;

  for (const path of paths) {
    const visible = withoutComments(await source(path));
    assert.doesNotMatch(visible, bannedJargon, `${path} exposes deployment jargon`);
    assert.doesNotMatch(visible, filler, `${path} contains generic AI marketing copy`);
  }
});

test("user interface source stays free of generic AI and prompt filler", async () => {
  const filler =
    /\b(?:AI-powered|seamlessly|unlock (?:the power|your potential)|delve|leverage|revolutionary|game-changing|as an AI|language model|here(?:'|’)s what|it is important to note|you might want to)\b/i;
  const files = [
    ...(await collectTsx(new URL("../src/app/", import.meta.url))),
    ...(await collectTsx(new URL("../src/components/", import.meta.url))),
  ];

  for (const file of files) {
    assert.doesNotMatch(withoutComments(await readFile(file, "utf8")), filler, `${file.pathname} contains prompt filler`);
  }
});

test("Pin setup instructions stay direct", async () => {
  const setup = withoutComments(await source("src/app/settings/pin/setup/SetupView.tsx"));
  assert.match(setup, /Use these checks to finish setting up your Pin\./);
  assert.doesNotMatch(setup, /Stock Humane had no surface|walks the same ceremony|rather than asking you/);
});

test("Ai Mic shows answers without suggestions, tool traces, or reasoning labels", async () => {
  const chat = withoutComments(await source("src/components/AiMicChat.tsx"));
  assert.match(chat, /<p className=\{styles\.say\}>\{t\.text\}<\/p>/);
  assert.doesNotMatch(chat, /Try asking|suggestion|reasoningOf|Used \{.*tool|styles\.trace/i);
  assert.doesNotMatch(chat, /t\.steps\.map|step\.input|step\.elapsed_ms/);
});

test("Assistant status never renders a saved model response", async () => {
  const [assistantPage, memoriesPage, health, timeline] = await Promise.all([
    source("src/app/settings/pin/llm/page.tsx"),
    source("src/app/page.tsx"),
    source("src/app/settings/pin/_lib/providerHealth.ts"),
    source("src/components/MemoriesTimeline.tsx"),
  ]);
  assert.doesNotMatch(assistantPage, /providerHealth\.evidenceText|\.response\b|<pre/);
  assert.doesNotMatch(withoutComments(memoriesPage), /eventData\.response/);
  assert.doesNotMatch(health, /proves:|doesNotProve:/);
  assert.match(health, /evidenceText:\s*null/);
  assert.doesNotMatch(timeline, /eventData\.response|\.response\s*\|\|/);
});

test("shared data errors never expose endpoints or HTTP status codes", async () => {
  const queries = withoutComments(await source("src/lib/queries.ts"));
  assert.doesNotMatch(queries, /new Error\(`\$\{url\}.*\$\{res\.status\}/s);
  assert.doesNotMatch(queries, /[→⇒]|HTTP\s*\$\{|API\s*\$\{/i);
  assert.match(queries, /"Sign in again to continue\."/);
  assert.match(queries, /"Too many requests\. Try again shortly\."/);
  assert.match(queries, /"Try again in a moment\."/);
});

test("Pin settings do not render raw API errors", async () => {
  const [settingsHook, panes, provider] = await Promise.all([
    source("src/app/settings/pin/_lib/useDeviceSettings.ts"),
    source("src/app/settings/pin/_lib/PaneShell.tsx"),
    source("src/app/settings/pin/PinDeviceProvider.tsx"),
  ]);
  assert.match(settingsHook, /deviceErrorMessage\(query\.error/);
  assert.doesNotMatch(settingsHook, /query\.error\.message/);
  assert.doesNotMatch(panes, /companion software|Center reconnects automatically/);
  assert.doesNotMatch(withoutComments(provider), /stopped answering|maintenance or recovery/);
});

test("operator navigation requires both entitlement and a configured console", async () => {
  const [route, menu] = await Promise.all([
    source("src/app/api/auth/session/route.ts"),
    source("src/components/NavMenu.tsx"),
  ]);
  assert.match(route, /await verifySession/);
  assert.match(route, /operator: session\?\.operator === true/);
  assert.match(route, /cache-control": "private, no-store/);
  assert.match(menu, /useOperatorEntitlement\(open\)/);
  assert.match(menu, /useConsoleConfigured\(open && operatorEntitled === true\)/);
  assert.match(menu, /operatorEntitled === true && consoleConfigured === true/);
});

test("core interactive controls retain a 44 pixel touch target", async () => {
  const [controls, floating, status, settings, wifi, talk, install] = await Promise.all([
    source("src/components/controls.module.css"),
    source("src/components/floatingAssistant.module.css"),
    source("src/components/status.module.css"),
    source("src/app/settings/settings.module.css"),
    source("src/app/wifi/wifi.module.css"),
    source("src/app/talk/talk.module.css"),
    source("src/app/settings/pin/install/install.module.css"),
  ]);

  for (const name of ["buttonPrimary", "buttonSecondary", "buttonQuiet", "buttonQuietSmall", "buttonDanger"]) {
    assert.match(cssBlock(controls, name), /min-height:\s*44px/, `${name} is smaller than 44px`);
  }
  for (const [css, name] of [
    [floating, "close"],
    [status, "badgeDismiss"],
    [settings, "navLink"],
    [settings, "infoToggleButton"],
    [wifi, "reveal"],
    [talk, "micButton"],
  ]) {
    assert.match(cssBlock(css, name), /(?:min-)?height:\s*44px/, `${name} is smaller than 44px`);
  }
  assert.match(cssBlock(install, "overflowTrigger"), /width:\s*44px/);
  assert.match(cssBlock(install, "overflowTrigger"), /composes:\s*buttonQuiet/);
});

test("muted text uses the accessible token and reduced motion is global", async () => {
  const globals = await source("src/app/globals.css");
  assert.match(globals, /--hu-text-muted:\s*#a5a7a7/);
  assert.match(globals, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(globals, /animation-duration:\s*0\.01ms !important/);
  assert.match(globals, /transition-duration:\s*0\.01ms !important/);

  for (const file of await collectCss(new URL("../src/", import.meta.url))) {
    const css = await readFile(file, "utf8");
    assert.doesNotMatch(
      css,
      /(?:^|[;{])\s*color\s*:\s*var\(--hu-colors-crater-grey-(?:base|200)\)/gm,
      `${file.pathname} uses a low-contrast grey for text`,
    );
  }

  const chat = await source("src/components/AiMicChat.tsx");
  assert.match(chat, /prefers-reduced-motion: reduce/);
  assert.match(chat, /\? "auto" : "smooth"/);
});

test("My Data and capture overlays have symmetric, reduced-motion-aware exits", async () => {
  const [detail, detailCss, capture, captureCss] = await Promise.all([
    source("src/components/DetailView.tsx"),
    source("src/components/views.module.css"),
    source("src/app/@capturemodal/CaptureLightbox.tsx"),
    source("src/components/captureDetail.module.css"),
  ]);
  assert.match(detail, /prefers-reduced-motion: reduce/);
  assert.match(detail, /detailOverlayClosing/);
  assert.match(detailCss, /detailOverlayIn/);
  assert.match(detailCss, /detailOverlayOut/);
  assert.match(capture, /prefers-reduced-motion: reduce/);
  assert.match(capture, /backdropClosing/);
  assert.match(captureCss, /captureOpen/);
  assert.match(captureCss, /captureClose/);
});
