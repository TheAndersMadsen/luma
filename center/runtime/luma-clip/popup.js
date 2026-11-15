(() => {
/* INFERRED: explicit semantic handoff. No OCR, background browsing or secrets. */
const address = document.querySelector("#center");
const status = document.querySelector("#status");
const connect = document.querySelector("#connect");
const handoff = document.querySelector("#handoff");
let configuredOrigin = null;

function report(message, error = false) { status.textContent = message; status.dataset.error = String(error); }
function centerOrigin(input) {
  const url = new URL(input.trim());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter your Center address without a page path. Use HTTPS, or localhost for development.");
  }
  return url.origin;
}
// Browser host permissions span ports; tab selection below still matches the
// exact saved origin. Access is requested only for the owner's Center host.
function hostGrant(origin) { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }

chrome.storage.local.get("centerOrigin").then((saved) => {
  if (saved.centerOrigin) { configuredOrigin = centerOrigin(saved.centerOrigin); address.value = configuredOrigin; }
}).catch(() => report("Connect your Center address to begin."));

connect.addEventListener("click", async () => {
  try {
    const origin = centerOrigin(address.value);
    // Must occur in this user gesture, before other asynchronous work.
    if (!await chrome.permissions.request({ origins: [hostGrant(origin)] })) throw new Error("Center access was not granted.");
    const previous = configuredOrigin;
    await chrome.storage.local.set({ centerOrigin: origin });
    configuredOrigin = origin; address.value = origin;
    if (previous && hostGrant(previous) !== hostGrant(origin)) await chrome.permissions.remove({ origins: [hostGrant(previous)] });
    report("Connected. Enable browser handoff in Center’s Pin → Clip tab.");
  } catch (error) { report(error instanceof Error ? error.message : "Couldn’t connect Center.", true); }
});

handoff.addEventListener("click", async () => {
  handoff.disabled = true; connect.disabled = true;
  try {
    const origin = centerOrigin(address.value);
    if (origin !== configuredOrigin || !await chrome.permissions.contains({ origins: [hostGrant(origin)] })) throw new Error("Connect this Center address first.");
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active?.id || !/^https?:\/\//.test(active.url ?? "")) throw new Error("Open an article on a regular web page first.");
    const tabs = (await chrome.tabs.query({ url: hostGrant(origin) })).filter((tab) => {
      try { const url = new URL(tab.url); return url.origin === origin && url.pathname === "/settings/pin/clip"; }
      catch { return false; }
    });
    if (tabs.length !== 1) throw new Error(tabs.length ? "Keep one Clip tab open in Center, then try again." : "Open Pin → Clip in Center and enable browser handoff first.");
    const [capture] = await chrome.scripting.executeScript({ target: { tabId: active.id }, func: () => ({
      title: document.querySelector('meta[property="og:title"]')?.content?.trim() || document.title.trim(),
      publisher: document.querySelector('meta[property="og:site_name"]')?.content?.trim() || location.hostname,
      url: location.href,
      selection: window.getSelection()?.toString() || "",
    }) });
    const article = { id: crypto.randomUUID(), ...capture?.result };
    const limits = { title: 256, publisher: 100, url: 2048, selection: 12000 };
    if (Object.entries(limits).some(([key, max]) => typeof article[key] !== "string" || article[key].includes("\0") || Array.from(article[key]).length > max) || !article.title.trim()) {
      throw new Error("The title or selection is too long. Select a shorter excerpt and try again.");
    }
    const url = new URL(article.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("This page’s address cannot be handed off.");
    report("Handing off to your Pin…");
    const [delivery] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id }, world: "MAIN", args: [article, origin],
      func: (article, origin) => new Promise((resolve) => {
        if (location.origin !== origin || location.pathname !== "/settings/pin/clip") { resolve({ ok: false, reason: "The Center tab changed. Open Clip again." }); return; }
        const finish = (result) => { clearTimeout(timer); window.removeEventListener("message", receive); resolve(result); };
        const receive = (event) => {
          if (event.source === window && event.origin === origin && event.data?.type === "luma.clip.accepted" && event.data.request_id === article.id) {
            finish({ ok: event.data.ok === true, reason: typeof event.data.reason === "string" ? event.data.reason.slice(0, 300) : undefined });
          }
        };
        const timer = setTimeout(() => finish({ ok: false, reason: "Center did not confirm. Check Clip and enable browser handoff before trying again." }), 8000);
        window.addEventListener("message", receive);
        window.postMessage({ type: "luma.clip.article", request_id: article.id, article }, origin);
      }),
    });
    if (delivery?.result?.ok !== true) throw new Error(delivery?.result?.reason || "Center did not confirm the handoff.");
    report("Ready on your Pin for 60 seconds. Raise your hand on Home, then pinch to copy.");
  } catch (error) { report(error instanceof Error ? error.message : "Couldn’t hand off this article.", true); }
  finally { handoff.disabled = false; connect.disabled = false; }
});

})();
