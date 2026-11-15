import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { clipExtensionArchive } from "../src/server/clipExtension.js";

// Authored before the extension: real packaged source, simulated browser APIs.
// A browser install and physical Pin remain separate acceptance steps.
test("the downloadable extension stages just the chosen article without switching tabs", async () => {
  const bytes = await clipExtensionArchive();
  const files = await new Bun.Archive(bytes).files();
  assert.deepEqual([...files.keys()].sort(), ["manifest.json", "popup.css", "popup.html", "popup.js"].map((name) => `luma-clip/${name}`).sort());
  const manifest = JSON.parse(await files.get("luma-clip/manifest.json").text());
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "scripting", "storage"].sort());
  assert.equal(manifest.host_permissions, undefined);
  const popup = new JSDOM(await files.get("luma-clip/popup.html").text(), { url: "https://extension.invalid", runScripts: "outside-only" });
  const article = new JSDOM('<title>Fallback</title><meta property="og:title" content="An article"><meta property="og:site_name" content="A publisher"><p>Selected text</p>', { url: "https://news.example/article", runScripts: "outside-only" });
  const center = new JSDOM("", { url: "https://center.example/settings/pin/clip", runScripts: "outside-only" });
  const selection = article.window.getSelection();
  selection.selectAllChildren(article.window.document.querySelector("p"));
  const staged = [], grants = [], tabChanges = [];
  let centerPresent = true;
  center.window.postMessage = (data, origin) => {
    assert.equal(origin, "https://center.example");
    queueMicrotask(() => center.window.dispatchEvent(new center.window.MessageEvent("message", { source: center.window, origin, data })));
  };
  center.window.addEventListener("message", (event) => {
    if (event.data.type !== "luma.clip.article") return;
    staged.push(event.data.article);
    center.window.postMessage({ type: "luma.clip.accepted", request_id: event.data.request_id, ok: true }, center.window.location.origin);
  });
  popup.window.chrome = {
    storage: { local: { get: async () => ({ centerOrigin: "https://center.example" }), set: async () => {} } },
    permissions: { request: async (grant) => { grants.push(grant); return true; }, contains: async () => true, remove: async () => true },
    tabs: {
      query: async (query) => query.active ? [{ id: 1, url: article.window.location.href }] : centerPresent ? [{ id: 2, url: center.window.location.href }] : [],
      update: async (...args) => { tabChanges.push(args); },
    },
    scripting: { executeScript: async (script) => {
      const target = script.target.tabId === 1 ? article.window : center.window;
      return [{ result: await target.eval(`(${script.func.toString()})(...${JSON.stringify(script.args ?? [])})`) }];
    } },
  };
  try {
    popup.window.eval(await files.get("luma-clip/popup.js").text());
    await until(() => popup.window.document.querySelector("#center").value === "https://center.example");
    popup.window.document.querySelector("#connect").click();
    await until(() => grants.length === 1);
    assert.deepEqual(JSON.parse(JSON.stringify(grants[0])), { origins: ["https://center.example/*"] });
    popup.window.document.querySelector("#handoff").click();
    await until(() => /Ready on your Pin/.test(popup.window.document.querySelector("#status").textContent));
    assert.equal(staged.length, 1);
    assert.match(staged[0].id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(JSON.stringify({ ...staged[0], id: undefined })), { title: "An article", publisher: "A publisher", url: "https://news.example/article", selection: "Selected text" });
    assert.equal(tabChanges.length, 0);
    centerPresent = false;
    popup.window.document.querySelector("#handoff").click();
    await until(() => /Open.*Clip.*Center/.test(popup.window.document.querySelector("#status").textContent));
    assert.equal(staged.length, 1);
    const artifact = await mkdtemp(join(tmpdir(), "luma-clip-acceptance-"));
    await writeFile(join(artifact, "luma-clip.tar.gz"), bytes);
    await writeFile(join(artifact, "acceptance.json"), JSON.stringify({ kind: "simulated_browser_handoff", physical_pin_verified: false, archive_sha256: createHash("sha256").update(bytes).digest("hex"), explicit_host_grant: true, foreground_tab_unchanged: true, duplicate_target: false }, null, 2));
    console.log(`Clip browser acceptance artifact: ${artifact}`);
  } finally { popup.window.close(); article.window.close(); center.window.close(); }
});

test("the extension download is bounded, cacheable and has an explicit archive type", async () => {
  const { GET } = await import("../src/app/api/downloads/luma-clip/route.ts");
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.match(response.headers.get("content-disposition"), /attachment; filename="luma-clip.tar.gz"/);
  assert.match(response.headers.get("cache-control"), /max-age=/);
  assert.ok((await response.arrayBuffer()).byteLength < 64 * 1024);
});

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("browser action did not complete");
}
