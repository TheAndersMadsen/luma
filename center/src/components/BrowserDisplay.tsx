"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SurfaceTab, type TabStatus } from "@/app/settings/account/surfaces/surfaceTab";
import { BrowserRuntime } from "@/lib/browserRuntime";
import type { RenderCommand } from "@/lib/contracts/ambianceRuntime";

/** Layout effects execute after React commits the actual escaped text node. */
export function CommittedCard({ command, runtime }: { command: RenderCommand | null; runtime: BrowserRuntime | undefined }) {
  const node = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (command && node.current?.isConnected && node.current.textContent === command.content.text && document.visibilityState === "visible") void runtime?.committed(command);
  }, [command, runtime]);
  return command ? <article aria-label="Cosmos display"><p ref={node}>{command.content.text}</p></article> : null;
}

export function BrowserDisplay({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<TabStatus>("inactive");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState<RenderCommand | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const tab = useRef<SurfaceTab | null>(null);
  const isActive = useRef(active); isActive.current = active;
  useEffect(() => {
    const runtime = new BrowserRuntime(crypto.randomUUID(), setCommand, setMessage);
    const current = new SurfaceTab(setStatus, () => {}, runtime); tab.current = current;
    const visibility = () => { current.visibility(isActive.current && document.visibilityState === "visible"); if (document.visibilityState !== "visible") setDraft(""); };
    const pagehide = () => { current.leave(); setDraft(""); };
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", pagehide);
    return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide); current.dispose(); tab.current = null; };
  }, []);
  useEffect(() => { if (!active) { tab.current?.leave(); setDraft(""); setMessage(""); setConfirming(false); } }, [active]);
  return <div>
    <p>This is a shared display. Use public text only. Cosmos cannot establish who can see this screen; private memories, speech and device actions are unavailable here.</p>
    {confirming ? <div role="group" aria-label="Approve shared display">
      <p>Approve this tab to send public text requests and display public replies for one hour?</p>
      <button onClick={() => { setConfirming(false); void tab.current?.approve(); }}>Confirm shared display</button>
      <button onClick={() => setConfirming(false)}>Cancel</button>
    </div> : <button disabled={!active || status === "approving"} onClick={() => setConfirming(true)}>Approve this tab</button>}
    <button onClick={() => { tab.current?.leave(); setDraft(""); setMessage(""); }}>Leave this tab</button>
    <p role="status">{status === "visible" ? message : status === "inactive" ? "Approve this tab to ask Cosmos." : `Display ${status}.`}</p>
    {status === "lost" && message && <p>{message}</p>}
    <CommittedCard command={active && status === "visible" ? command : null} runtime={tab.current?.runtime} />
    <form onSubmit={event => { event.preventDefault(); const text = draft.trim(); if (status === "visible" && text) { setDraft(""); void tab.current?.runtime?.input(text); } }}>
      <input aria-label="Ask Cosmos" placeholder="Ask Cosmos a public question…" maxLength={4000} value={draft} disabled={!active || status !== "visible"} onChange={event => setDraft(event.target.value)} />
      <button type="submit" aria-label="Send" disabled={!active || status !== "visible" || !draft.trim()}>Send</button>
      <button type="button" disabled={!active || status !== "visible"} onClick={() => { void tab.current?.runtime.cancel(); }}>Cancel request</button>
    </form>
  </div>;
}
