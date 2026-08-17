// Progressive enhancement for the device-owned setup/recovery page.
//
// Loaded as an EXTERNAL module from 'self' — the runtime serves this page under
// `script-src 'self'` (pin/runtime/core/src/api/setup.rs), which forbids inline
// script and inline event handlers, so all behaviour is wired here.
//
// The page is fully readable and honest with this file absent or blocked; this
// only adds a live connectivity check against the device's own public health
// endpoint (`GET /api/health`, unauthenticated per api/auth.rs) plus the device
// name and build. It performs a single side-effect-free GET and nothing else —
// no account access, no shell.

const HEALTH_ENDPOINT = "/api/health";
const REQUEST_TIMEOUT_MS = 5000;

const statusLine = document.getElementById("status-line");
const detail = document.getElementById("status-detail");
const actions = document.getElementById("status-actions");
const recheckButton = document.getElementById("recheck");
const checkedLabel = document.getElementById("status-checked");
const runtimeCell = document.getElementById("detail-runtime");
const nameCell = document.getElementById("detail-name");
const versionCell = document.getElementById("detail-version");
const addressCell = document.getElementById("detail-address");

// Bail out gracefully if the markup ever drifts from this script.
if (statusLine && detail && actions && recheckButton) {
  addressCell.textContent = window.location.host || "—";

  detail.hidden = false;
  actions.hidden = false;
  recheckButton.addEventListener("click", () => {
    void checkHealth();
  });

  void checkHealth();
}

function setRuntime(state, text) {
  runtimeCell.textContent = text;
  runtimeCell.dataset.state = state;
}

async function checkHealth() {
  recheckButton.disabled = true;
  statusLine.dataset.state = "static";
  statusLine.textContent = "Checking the on-device runtime…";
  setRuntime("checking", "checking…");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(HEALTH_ENDPOINT, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`);
    }

    const payload = await response.json();
    setRuntime("online", "online");
    statusLine.dataset.state = "online";
    statusLine.textContent = "The on-device runtime is up and responding.";
    nameCell.textContent = safeText(payload.name);
    versionCell.textContent = safeText(payload.version);
  } catch (error) {
    // A failure here does not mean the device is down — this very page came
    // from it. It means the JSON runtime endpoint did not answer, so stay
    // honest about what was actually observed.
    setRuntime("offline", "not responding");
    statusLine.dataset.state = "offline";
    statusLine.textContent =
      "The runtime’s status endpoint did not respond, but this page still " +
      "loaded from the Pin. Try “Check again”, or reload after a moment.";
    nameCell.textContent = "—";
    versionCell.textContent = "—";
  } finally {
    clearTimeout(timeout);
    recheckButton.disabled = false;
    checkedLabel.textContent = `Last checked ${formatTime(new Date())}`;
  }
}

function safeText(value) {
  if (typeof value !== "string") return "—";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "—";
}

function formatTime(date) {
  try {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return date.toISOString().slice(11, 16);
  }
}
