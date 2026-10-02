"use client";

import { useEffect, useState } from "react";
import styles from "./copyCommand.module.css";

/**
 * A server command the operator types, always visible as text. The Copy
 * button is progressive and only appears where the clipboard exists.
 */
export function CopyCommand({ command, label = "command" }: { command: string; label?: string }) {
  const [canCopy, setCanCopy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCanCopy(typeof navigator !== "undefined" && Boolean(navigator.clipboard?.writeText));
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <span className={styles.root}>
      <code className={styles.command} data-testid="copy-command">{command}</code>
      {canCopy ? (
        <button
          type="button"
          className={styles.copy}
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      ) : null}
    </span>
  );
}
