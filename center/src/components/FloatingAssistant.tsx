"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { AiMicIcon } from "@/icons";
import { AiMicChat, AssistantStatusChip } from "./AiMicChat";
import styles from "./floatingAssistant.module.css";

type AssistantContextValue = {
  open: boolean;
  openAssistant: (opener?: HTMLElement | null) => void;
  closeAssistant: () => void;
};

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function useFloatingAssistant() {
  const value = useContext(AssistantContext);
  if (!value) throw new Error("useFloatingAssistant must be used inside AssistantProvider");
  return value;
}

/** One contextual assistant, mounted above route content so the conversation survives navigation. */
export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const closeAssistant = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }, []);

  const openAssistant = useCallback((opener?: HTMLElement | null) => {
    if (opener) openerRef.current = opener;
    setOpen(true);
  }, []);

  // /talk redirects to /?assistant=open. Consume the compatibility hint without
  // leaving transient interface state in the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("assistant") !== "open") return;
    setOpen(true);
    url.searchParams.delete("assistant");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [pathname]);

  // Never carry a wearer assistant onto a public or unauthenticated surface.
  useEffect(() => {
    if (pathname === "/login" || pathname === "/wifi" || pathname.startsWith("/share/")) {
      setOpen(false);
    }
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAssistant();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeAssistant, open]);

  return (
    <AssistantContext.Provider value={{ open, openAssistant, closeAssistant }}>
      {children}
      <section
        id="ai-pin-assistant"
        className={styles.panel}
        role="dialog"
        aria-modal="false"
        aria-labelledby="ai-pin-assistant-title"
        hidden={!open}
      >
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.mark} aria-hidden>
              <AiMicIcon size={17} />
            </span>
            <span>
              <span id="ai-pin-assistant-title" className={styles.title}>Ai Mic</span>
              <span className={styles.subtitle}>Ask your Pin</span>
            </span>
          </div>
          <div className={styles.headerActions}>
            <AssistantStatusChip className={styles.status} />
            <button type="button" className={styles.close} onClick={closeAssistant} aria-label="Close Ai Mic">
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
                <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>
        <div className={styles.chat}>
          <AiMicChat active={open} />
        </div>
      </section>
    </AssistantContext.Provider>
  );
}
