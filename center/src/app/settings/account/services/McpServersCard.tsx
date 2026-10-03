"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { StatusChip, Switch, type StatusTone } from "@/components/Status";
import settings from "../../settings.module.css";
import styles from "./services.module.css";

/** What Cosmos last saw of a tool server. */
type McpStatus =
  | "untested"
  | "connected"
  | "unauthorized"
  | "unreachable"
  | "timed_out"
  | "invalid_response";

type McpTool = {
  name: string;
  description: string;
  read_only: boolean;
  /** Whether the assistant is offered this tool right now. */
  offered: boolean;
};

type McpServer = {
  id: string;
  name: string;
  url: string;
  /** Names of the saved request headers. Cosmos never sends their values back. */
  headers: string[];
  enabled: boolean;
  allow_actions: boolean;
  allow_when_locked: boolean;
  status: McpStatus;
  checked_at_ms: number | null;
  tools: McpTool[];
};

type McpView = { servers: McpServer[] };

type Message = { tone: "ok" | "error"; text: string; signIn?: boolean };

/** One header row in a form. `saved` rows keep their stored value when left blank. */
type HeaderRow = { key: number; name: string; value: string; saved: boolean };

const STATUSES: ReadonlySet<string> = new Set([
  "untested",
  "connected",
  "unauthorized",
  "unreachable",
  "timed_out",
  "invalid_response",
]);

const MAX_HEADERS = 8;

/** Accept only the shape this card renders. Cosmos is another process. */
function parseView(value: unknown): McpView | null {
  if (!value || typeof value !== "object") return null;
  const servers = (value as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return null;
  const parsed: McpServer[] = [];
  for (const entry of servers) {
    if (!entry || typeof entry !== "object") return null;
    const server = entry as Record<string, unknown>;
    if (
      typeof server.id !== "string" ||
      typeof server.name !== "string" ||
      typeof server.url !== "string" ||
      !Array.isArray(server.headers) ||
      !server.headers.every((header) => typeof header === "string") ||
      typeof server.enabled !== "boolean" ||
      typeof server.allow_actions !== "boolean" ||
      typeof server.allow_when_locked !== "boolean" ||
      typeof server.status !== "string" ||
      !STATUSES.has(server.status) ||
      !Array.isArray(server.tools)
    ) {
      return null;
    }
    const tools: McpTool[] = [];
    for (const item of server.tools) {
      if (!item || typeof item !== "object") return null;
      const tool = item as Record<string, unknown>;
      if (
        typeof tool.name !== "string" ||
        typeof tool.description !== "string" ||
        typeof tool.read_only !== "boolean" ||
        typeof tool.offered !== "boolean"
      ) {
        return null;
      }
      tools.push({
        name: tool.name,
        description: tool.description,
        read_only: tool.read_only,
        offered: tool.offered,
      });
    }
    parsed.push({
      id: server.id,
      name: server.name,
      url: server.url,
      headers: server.headers as string[],
      enabled: server.enabled,
      allow_actions: server.allow_actions,
      allow_when_locked: server.allow_when_locked,
      status: server.status as McpStatus,
      checked_at_ms: typeof server.checked_at_ms === "number" ? server.checked_at_ms : null,
      tools,
    });
  }
  return { servers: parsed };
}

function summary(server: McpServer): { tone: StatusTone; label: string; text: string } {
  if (!server.enabled) {
    return { tone: "off", label: "Off", text: "Switched off. The assistant is not offered its tools." };
  }
  const offered = server.tools.filter((tool) => tool.offered).length;
  switch (server.status) {
    case "connected":
      return {
        tone: "live",
        label: "Connected",
        text:
          offered === 0 && server.tools.length > 0
            ? `It lists ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}, but none is marked read-only. Turn on Allow actions to offer them.`
            : `${offered} of ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"} offered to the assistant.`,
      };
    case "unauthorized":
      return { tone: "absent", label: "Refused", text: "The server refused the request. Check its headers below, then Save." };
    case "unreachable":
      return { tone: "absent", label: "Unreachable", text: "The server could not be reached the last time Cosmos tried. Check the URL, then Test." };
    case "timed_out":
      return { tone: "degraded", label: "Timed out", text: "The server did not answer in time. Check the URL, or Test again in a moment." };
    case "invalid_response":
      return { tone: "absent", label: "Not understood", text: "The server answered, but not as an MCP server over HTTP. Check the URL." };
    default:
      return { tone: "off", label: "Not tested", text: "Not contacted yet. Choose Test to list its tools." };
  }
}

async function readError(response: Response): Promise<Message> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const text = typeof body?.error === "string" ? body.error : "That did not work. Try again.";
  return { tone: "error", text, signIn: response.status === 401 };
}

let nextRowKey = 1;

function blankRow(name = ""): HeaderRow {
  return { key: nextRowKey++, name, value: "", saved: false };
}

/**
 * Name, URL and request headers for one server. Used to add a server and to
 * edit one. A saved header's value is never shown: leaving it blank keeps it.
 */
function ServerForm({
  server,
  busy,
  submitLabel,
  onSubmit,
}: {
  server?: McpServer;
  busy: boolean;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [rows, setRows] = useState<HeaderRow[]>(() =>
    server
      ? server.headers.map((header) => ({ key: nextRowKey++, name: header, value: "", saved: true }))
      : [blankRow("Authorization")],
  );
  const nameId = useId();
  const urlId = useId();

  const setRow = (key: number, change: Partial<HeaderRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const submit = async () => {
    const headers = rows
      .map((row) => ({ name: row.name.trim(), value: row.value.trim(), saved: row.saved }))
      // A row with no name is a blank row. A new row with no value has nothing to send.
      .filter((row) => row.name && (row.value || row.saved))
      .map((row) => (row.value ? { name: row.name, value: row.value } : { name: row.name }));
    const saved = await onSubmit({
      ...(server ? { id: server.id } : {}),
      name: name.trim(),
      url: url.trim(),
      headers,
    });
    if (saved && !server) {
      setName("");
      setUrl("");
      setRows([blankRow("Authorization")]);
    }
    if (saved && server) {
      // This form is re-created only when the name, URL or header names
      // change. A value sent for a header is stored now: take it off the page.
      setRows((current) =>
        current.map((row) => (row.name.trim() && row.value.trim() ? { ...row, value: "", saved: true } : row)),
      );
    }
  };

  return (
    <>
      <div className={styles.integrationField}>
        <label htmlFor={nameId}>
          <strong>Name</strong>
          <small>What you will call it, for example Home or Notes.</small>
        </label>
        <input id={nameId} className={styles.integrationInput} type="text" value={name} maxLength={48} placeholder="Home" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className={styles.integrationField}>
        <label htmlFor={urlId}>
          <strong>Server URL</strong>
          <small>Its Streamable HTTP address, for example https://example.com/mcp</small>
        </label>
        <input id={urlId} className={styles.integrationInput} type="url" value={url} placeholder="https://example.com/mcp" autoCapitalize="none" autoCorrect="off" onChange={(event) => setUrl(event.target.value)} />
      </div>
      <div className={styles.integrationField}>
        <span className={styles.mcpHeaderLabel}>
          <strong>Request headers</strong>
          <small>
            Optional. Most servers want Authorization with the value Bearer followed by your token. Values stay on
            your server and are never shown again.
          </small>
        </span>
        <div className={styles.mcpHeaders}>
          {rows.map((row) => (
            <div className={styles.mcpHeaderRow} key={row.key}>
              <input
                className={styles.integrationInput}
                type="text"
                aria-label="Header name"
                value={row.name}
                maxLength={64}
                placeholder="Header name"
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => setRow(row.key, { name: event.target.value })}
              />
              <input
                className={styles.integrationInput}
                type="password"
                aria-label={`Value for ${row.name || "header"}`}
                value={row.value}
                placeholder={row.saved ? "Saved. Leave blank to keep it" : row.name.toLowerCase() === "authorization" ? "Bearer your-token" : "Value"}
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => setRow(row.key, { value: event.target.value })}
              />
              <button
                className={styles.inlineButton}
                type="button"
                aria-label={`Remove header ${row.name || ""}`.trim()}
                onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}
              >
                Remove
              </button>
            </div>
          ))}
          {rows.length < MAX_HEADERS ? (
            <button className={styles.inlineButton} type="button" onClick={() => setRows((current) => [...current, blankRow()])}>
              Add a header
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.integrationTestActions}>
        <button className={styles.primaryButton} type="button" disabled={busy || !name.trim() || !url.trim()} onClick={() => void submit()}>
          {submitLabel}
        </button>
      </div>
    </>
  );
}

/**
 * The owner's MCP tool servers: add one by name, URL and request headers,
 * edit it, switch it on or off, allow its action tools, test it, and see which
 * tools the assistant is offered. Every change goes to Cosmos, which answers
 * with the new list.
 */
export function McpServersCard({ operator }: { operator: boolean }) {
  const [view, setView] = useState<McpView | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/mcp", { cache: "no-store" });
    if (!response.ok) {
      setMessage(await readError(response));
      return;
    }
    const parsed = parseView(await response.json().catch(() => null));
    if (!parsed) {
      setMessage({ tone: "error", text: "Cosmos answered with a tool server list this page cannot read." });
      return;
    }
    setView(parsed);
  }, []);

  useEffect(() => {
    if (!operator) return;
    void load().catch(() => setMessage({ tone: "error", text: "Your tool servers could not be loaded." }));
  }, [load, operator]);

  /** One change: send it, then show the list Cosmos answers with. */
  const change = useCallback(
    async (key: string, request: () => Promise<Response>, done: string) => {
      setBusy(key);
      setMessage(null);
      try {
        const response = await request();
        if (!response.ok) {
          setMessage(await readError(response));
          return false;
        }
        const parsed = parseView(await response.json().catch(() => null));
        if (!parsed) {
          setMessage({ tone: "error", text: "Cosmos answered with a tool server list this page cannot read." });
          return false;
        }
        setView(parsed);
        setMessage({ tone: "ok", text: done });
        return true;
      } catch {
        setMessage({ tone: "error", text: "Center could not reach your server. Try again." });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const save = useCallback(
    (key: string, body: Record<string, unknown>, done: string) =>
      change(
        key,
        () =>
          fetch("/api/admin/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        done,
      ),
    [change],
  );

  if (!operator) return null;

  return (
    <section className={`${settings.section} ${styles.servicesCard}`} data-testid="mcp-servers-card">
      <div className={styles.serviceHead}>
        <span className={styles.cosmosMark} aria-hidden="true">✦</span>
        <span className={styles.serviceCopy}>
          <strong>Tool servers</strong>
          <span>Give your Pin&rsquo;s assistant more tools from MCP servers. Optional.</span>
        </span>
        <StatusChip
          tone={view?.servers.some((server) => server.enabled && server.status === "connected") ? "live" : "off"}
          label={view ? `${view.servers.filter((server) => server.enabled).length} on` : "Loading"}
        />
      </div>

      <div className={styles.providerNote}>
        <strong>How it works</strong>
        <span>
          Tools from a server that is switched on are offered from your next request. They need an unlocked Pin unless
          you turn on Use while locked for that server.
          Say &ldquo;turn off the &hellip; tools&rdquo; to switch a server by voice.
        </span>
        <span>
          Only tools a server marks read-only are offered, unless you allow actions for that server. Your Pin does
          not ask before an action tool runs.
        </span>
      </div>

      <fieldset className={styles.integrationSettings} disabled={busy !== null}>
        {view?.servers.map((server) => {
          const state = summary(server);
          return (
            <details className={styles.integrationGroup} key={server.id} aria-label={server.name}>
              <summary className={styles.integrationIntro}>
                <span>
                  <strong>{server.name}</strong>
                  <small>{server.url}</small>
                </span>
                <span className={styles.integrationIntroActions}>
                  <StatusChip tone={state.tone} label={state.label} />
                </span>
              </summary>
              <p className={styles.providerNote} data-testid={`mcp-status-${server.id}`} data-status={server.status}>
                <span>{state.text}</span>
              </p>
              <div className={styles.settingRow}>
                <span>
                  <strong>Use {server.name}</strong>
                  <small>Offers this server&rsquo;s tools to the assistant.</small>
                </span>
                <Switch
                  checked={server.enabled}
                  ariaLabel={`Use ${server.name}`}
                  onChange={(enabled) =>
                    void save(`toggle-${server.id}`, { id: server.id, enabled }, enabled ? `${server.name} is on.` : `${server.name} is off.`)
                  }
                />
              </div>
              <div className={styles.settingRow}>
                <span>
                  <strong>Allow actions</strong>
                  <small>Also offers tools the server does not mark read-only. They run without asking you first.</small>
                </span>
                <Switch
                  checked={server.allow_actions}
                  ariaLabel={`Allow actions for ${server.name}`}
                  onChange={(allow_actions) =>
                    void save(
                      `actions-${server.id}`,
                      { id: server.id, allow_actions },
                      allow_actions ? `Action tools are allowed for ${server.name}.` : `Only read-only tools are offered for ${server.name}.`,
                    )
                  }
                />
              </div>
              <div className={styles.settingRow}>
                <span>
                  <strong>Use while locked</strong>
                  <small>Your Pin is locked whenever it is off your body, on its charger for example. Anyone holding it could then use these tools.</small>
                </span>
                <Switch
                  checked={server.allow_when_locked}
                  ariaLabel={`Use ${server.name} while locked`}
                  onChange={(allow_when_locked) =>
                    void save(
                      `locked-${server.id}`,
                      { id: server.id, allow_when_locked },
                      allow_when_locked ? `${server.name} can be used while your Pin is locked.` : `${server.name} needs an unlocked Pin.`,
                    )
                  }
                />
              </div>
              {server.tools.length > 0 ? (
                <ul className={styles.mcpTools} aria-label={`${server.name} tools`}>
                  {server.tools.map((tool) => (
                    <li key={tool.name} data-offered={tool.offered}>
                      <span>
                        <strong>{tool.name}</strong>
                        <small>{tool.description || "No description."}</small>
                      </span>
                      <StatusChip
                        tone={tool.offered ? "live" : "off"}
                        label={tool.offered ? "Offered" : tool.read_only ? "Not offered" : "Action"}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <details className={styles.mcpEdit}>
                <summary>Edit name, URL and headers</summary>
                {/* Re-created when Cosmos answers, so the form shows what was saved. */}
                <ServerForm
                  key={`${server.id}:${server.name}:${server.url}:${server.headers.join(",")}`}
                  server={server}
                  busy={busy !== null}
                  submitLabel={busy === `edit-${server.id}` ? "Saving…" : "Save changes"}
                  onSubmit={(body) => save(`edit-${server.id}`, body, `${server.name} was saved.`)}
                />
              </details>
              <div className={styles.integrationTestActions}>
                <button
                  className={styles.inlineButton}
                  type="button"
                  aria-label={`Remove ${server.name}`}
                  onClick={() => {
                    if (!window.confirm(`Remove ${server.name}?`)) return;
                    void change(
                      `remove-${server.id}`,
                      () => fetch(`/api/admin/mcp/${server.id}`, { method: "DELETE" }),
                      `${server.name} was removed.`,
                    );
                  }}
                >
                  Remove
                </button>
                <button
                  className={styles.inlineButton}
                  type="button"
                  aria-label={`Test ${server.name}`}
                  onClick={() =>
                    void change(
                      `test-${server.id}`,
                      () => fetch(`/api/admin/mcp/${server.id}/test`, { method: "POST" }),
                      `${server.name} was contacted.`,
                    )
                  }
                >
                  {busy === `test-${server.id}` ? "Testing…" : "Test"}
                </button>
              </div>
            </details>
          );
        })}

        <details className={styles.integrationGroup} open={view?.servers.length === 0} aria-label="Add a tool server">
          <summary className={styles.integrationIntro}>
            <span>
              <strong>Add a tool server</strong>
              <small>A remote MCP server, or one running next to your Luma server.</small>
            </span>
          </summary>
          <ServerForm
            busy={busy !== null}
            submitLabel={busy === "add" ? "Adding…" : "Add server"}
            onSubmit={(body) => save("add", body, "Tool server added.")}
          />
        </details>

        {message ? (
          <div className={styles.integrationMessage} data-tone={message.tone} role="status">
            {message.text}
            {message.signIn ? <> <Link href="/login">Sign in again</Link>.</> : null}
          </div>
        ) : null}
      </fieldset>
    </section>
  );
}
