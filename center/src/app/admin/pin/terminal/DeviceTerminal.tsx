"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import styles from "./terminal.module.css";
import { getPinAdbSession } from "@/lib/pin-session";
import type { AdbPtySession } from "@/lib/pin-device/adb";

/*
 * The xterm surface itself — the only module in Center that imports @xterm.
 *
 * It lives under /admin/pin/ because that subtree is operator-gated twice
 * (middleware.ts and app/admin/pin/layout.tsx) and what this component opens is
 * a ROOT shell on the wearer's device with no further authorization. Keeping
 * the xterm import colocated is enforced by verify/pin-terminal-gate.test.mjs:
 * a shared terminal component outside the gate would be a wearer-reachable
 * shell one import away.
 *
 * It is loaded through next/dynamic({ssr:false}) from TerminalPane, so xterm is
 * never in the server bundle and never in the initial payload of a page that
 * has no device attached.
 */

const TERMINAL_COLS = 80;
const TERMINAL_ROWS = 24;

export type DeviceTerminalStatus = "closed" | "opening" | "open" | "exited" | "error";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function DeviceTerminal({
  onStatusChange,
}: {
  /** Reported upward so the pane can label the session without owning it. */
  onStatusChange?: (status: DeviceTerminalStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<AdbPtySession | null>(null);
  const cleanupOutputRef = useRef<(() => void) | null>(null);
  /*
   * Which open() attempt owns the refs. Every close bumps it, so a slow
   * `openPty()` that resolves after the user navigated away or hit Reconnect
   * closes its own session instead of adopting the live one.
   */
  const attemptRef = useRef(0);
  const [status, setStatus] = useState<DeviceTerminalStatus>("closed");

  const statusChangeRef = useRef(onStatusChange);
  statusChangeRef.current = onStatusChange;

  const report = useCallback((next: DeviceTerminalStatus) => {
    setStatus(next);
    statusChangeRef.current?.(next);
  }, []);

  const closeTerminal = useCallback(async () => {
    attemptRef.current += 1;
    cleanupOutputRef.current?.();
    cleanupOutputRef.current = null;

    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      await session.close().catch(() => undefined);
    }

    terminalRef.current?.dispose();
    terminalRef.current = null;
    hostRef.current?.replaceChildren();
    report("closed");
  }, [report]);

  const openTerminal = useCallback(async () => {
    if (!hostRef.current) return;

    await closeTerminal();
    const attemptId = ++attemptRef.current;
    report("opening");

    let session: AdbPtySession;
    try {
      session = await getPinAdbSession().openPty();
    } catch {
      if (attemptId === attemptRef.current) report("error");
      return;
    }

    if (attemptId !== attemptRef.current || !hostRef.current) {
      await session.close().catch(() => undefined);
      return;
    }

    hostRef.current.replaceChildren();

    const terminal = new Terminal({
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      theme: { background: "#000000", foreground: "#d6d6d6" },
    });

    terminalRef.current = terminal;
    sessionRef.current = session;
    terminal.open(hostRef.current);
    terminal.focus();

    const encoder = new TextEncoder();
    const inputDisposable = terminal.onData((data) => {
      const active = sessionRef.current;
      if (!active) return;
      void active.write(encoder.encode(data)).catch((error: unknown) => {
        terminal.writeln(`\r\n[write error] ${message(error)}`);
      });
    });

    let readerCancelled = false;
    const reader = session.output.getReader();
    const decoder = new TextDecoder();

    void (async () => {
      try {
        while (!readerCancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) terminal.write(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        if (!readerCancelled) {
          terminal.writeln(`\r\n[output error] ${message(error)}`);
        }
      } finally {
        reader.releaseLock();
      }
    })();

    cleanupOutputRef.current = () => {
      readerCancelled = true;
      inputDisposable.dispose();
      void reader.cancel().catch(() => undefined);
    };

    void session.exited
      .then(() => {
        if (attemptId !== attemptRef.current || sessionRef.current !== session) return;
        terminal.writeln("\r\n[terminal exited]");
        report("exited");
      })
      .catch((error: unknown) => {
        if (attemptId !== attemptRef.current || sessionRef.current !== session) return;
        terminal.writeln(`\r\n[terminal error] ${message(error)}`);
        report("error");
      });

    report("open");
  }, [closeTerminal, report]);

  useEffect(() => {
    void openTerminal();
    return () => {
      void closeTerminal();
    };
  }, [closeTerminal, openTerminal]);

  /*
   * A live shell is unsaved work in the only sense that matters here: closing
   * the tab kills the process the operator is mid-way through.
   */
  useEffect(() => {
    if (status !== "opening" && status !== "open") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status]);

  const reconnectable = status === "exited" || status === "error" || status === "closed";

  return (
    <>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>Shell</span>
        <span className={styles.state} data-testid="pin-terminal-status">
          {status === "opening"
            ? "Opening…"
            : status === "open"
              ? "Attached"
              : status === "exited"
                ? "Session ended"
                : status === "error"
                  ? "Session failed"
                  : "Closed"}
        </span>
      </div>

      <div className={styles.viewportWrap}>
        <div ref={hostRef} className={styles.viewport} data-testid="pin-terminal-viewport" />
      </div>

      <div className={styles.body}>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.buttonQuiet}
            disabled={!reconnectable}
            onClick={() => {
              void openTerminal();
            }}
          >
            Reconnect
          </button>
          <button
            type="button"
            className={styles.buttonQuiet}
            disabled={status !== "open"}
            onClick={() => {
              void sessionRef.current?.sigint().catch(() => undefined);
            }}
          >
            Send Ctrl-C
          </button>
          <button
            type="button"
            className={styles.buttonDanger}
            disabled={status !== "open" && status !== "opening"}
            onClick={() => {
              void closeTerminal();
            }}
          >
            End session
          </button>
        </div>
      </div>
    </>
  );
}
