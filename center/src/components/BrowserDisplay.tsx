"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SurfaceTab, type TabStatus } from "@/app/settings/account/surfaces/surfaceTab";
import { BrowserRuntime } from "@/lib/browserRuntime";
import type { PlacesContent, RenderCommand } from "@/lib/contracts/ambianceRuntime";
import { parsePlaceAttribution, type PlaceAttributionPart } from "@/lib/placeAttribution";
import styles from "./browserDisplay.module.css";

function exactText(node: Node | undefined, tag: string, text: string): node is HTMLElement {
  return node instanceof HTMLElement && node.tagName === tag && node.childNodes.length === 1
    && node.firstChild?.nodeType === Node.TEXT_NODE && node.textContent === text;
}
function exactLink(node: Node | undefined, text: string, href: string): boolean {
  return exactText(node, "A", text) && node.getAttribute("href") === href
    && node.getAttribute("target") === "_blank" && node.getAttribute("rel") === "noreferrer noopener"
    && node.getAttribute("referrerpolicy") === "no-referrer";
}
function placesCommitted(node: HTMLElement, content: PlacesContent, credits: PlaceAttributionPart[][]): boolean {
  if (node.childNodes.length !== 3) return false;
  const [query, list, footer] = Array.from(node.childNodes);
  if (!exactText(query, "H2", content.query)) return false;
  if (!content.items.length) {
    if (!exactText(list, "P", "No matching places found.")) return false;
  } else {
    if (!(list instanceof HTMLOListElement) || list.childNodes.length !== content.items.length) return false;
    for (const [index, item] of content.items.entries()) {
      const row = list.childNodes[index];
      if (!(row instanceof HTMLLIElement) || row.dataset.placeId !== item.placeId
        || row.childNodes.length !== (item.sourceUrl === null ? 2 : 3)
        || !exactText(row.childNodes[0], "STRONG", item.name) || !exactText(row.childNodes[1], "P", item.address)
        || item.sourceUrl !== null && !exactLink(row.childNodes[2], "View on Google Maps", item.sourceUrl)) return false;
    }
  }
  if (!(footer instanceof HTMLElement) || footer.tagName !== "FOOTER" || footer.childNodes.length !== credits.length + 1
    || !exactText(footer.childNodes[0], "P", "Google Maps")) return false;
  return credits.every((parts, index) => {
    const credit = footer.childNodes[index + 1];
    if (!(credit instanceof HTMLParagraphElement) || credit.childNodes.length !== parts.length) return false;
    return parts.every((part, partIndex) => {
      const child = credit.childNodes[partIndex];
      return part.kind === "text" ? child.nodeType === Node.TEXT_NODE && child.textContent === part.text : exactLink(child, part.text, part.href);
    });
  });
}

function fitPlaceCard(node: HTMLElement): boolean {
  const bounds = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    const rect = parent.getBoundingClientRect();
    if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top); bounds.bottom = Math.min(bounds.bottom, rect.bottom);
    }
    if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left); bounds.right = Math.min(bounds.right, rect.right);
    }
  }
  const top = node.getBoundingClientRect().top;
  if (top < bounds.top || top >= bounds.bottom) return false;
  node.style.setProperty("--place-card-height", `${bounds.bottom - top}px`);
  const within = (rect: DOMRect, area: typeof bounds) => Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0 && rect.left >= area.left && rect.top >= area.top
    && rect.right <= area.right + 0.5 && rect.bottom <= area.bottom + 0.5;
  const rect = node.getBoundingClientRect();
  const footer = node.lastElementChild;
  if (!(footer instanceof HTMLElement) || !within(rect, bounds) || !within(footer.getBoundingClientRect(), rect)
    || node.clientHeight <= 0 || node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1
    || footer.clientHeight <= 0 || footer.scrollHeight > footer.clientHeight + 1 || footer.scrollWidth > footer.clientWidth + 1) return false;
  return Array.from(footer.children).every(credit => within(credit.getBoundingClientRect(), footer.getBoundingClientRect()));
}

/** Acknowledgment follows an exact DOM commit, including all required credit. */
export function CommittedCard({ command, runtime }: { command: RenderCommand | null; runtime: BrowserRuntime | undefined }) {
  const node = useRef<HTMLElement>(null);
  const [failedAction, setFailedAction] = useState<string | null>(null);
  const credits = useMemo(() => {
    if (command?.content.kind !== "places") return null;
    try { return command.content.attributions.map(parsePlaceAttribution); }
    catch { return null; }
  }, [command]);
  useLayoutEffect(() => {
    const card = node.current;
    if (!command || !card?.isConnected || document.visibilityState !== "visible") return;
    if (command.content.kind === "text") {
      if (card.childNodes.length === 1 && exactText(card.firstChild ?? undefined, "P", command.content.text)) void runtime?.committed(command);
      return;
    }
    const commit = () => {
      if (!card.isConnected || document.visibilityState !== "visible") return;
      if (command.content.kind !== "places" || credits === null || !placesCommitted(card, command.content, credits) || !fitPlaceCard(card)) {
        setFailedAction(command.actionId); runtime?.displayFailed(command); return;
      }
      void runtime?.committed(command);
    };
    commit();
    window.addEventListener("resize", commit); window.addEventListener("scroll", commit, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(commit);
    observer?.observe(card);
    if (card.parentElement) for (const child of card.parentElement.children) observer?.observe(child);
    for (const child of card.children) observer?.observe(child);
    return () => { window.removeEventListener("resize", commit); window.removeEventListener("scroll", commit, true); observer?.disconnect(); };
  });
  if (!command || failedAction === command.actionId || command.content.kind === "places" && credits === null) return null;
  const content = command.content;
  return <article ref={node} className={`${styles.card}${content.kind === "places" ? ` ${styles.placesCard}` : ""}`} aria-label="Cosmos display">{content.kind === "text" ? <p>{content.text}</p> : <>
    <h2 className={styles.placeQuery}>{content.query}</h2>
    {content.items.length ? <ol className={styles.places}>{content.items.map(item => <li key={item.placeId} data-place-id={item.placeId}>
      <strong>{item.name}</strong><p>{item.address}</p>{item.sourceUrl !== null ? <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">View on Google Maps</a> : null}
    </li>)}</ol> : <p>No matching places found.</p>}
    <footer className={styles.attributions}>
      <p className={styles.googleMaps}>Google Maps</p>
      {credits!.map((parts, index) => <p key={index}>{parts.map((part, partIndex) => part.kind === "text" ? <Fragment key={partIndex}>{part.text}</Fragment>
        : <a key={partIndex} href={part.href} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">{part.text}</a>)}</p>)}
    </footer>
  </>}</article>;
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
  return <div className={styles.display}>
    <p className={styles.notice}>This is a shared display. Use public text only. Cosmos cannot establish who can see this screen; private memories, speech and device actions are unavailable here.</p>
    <div className={styles.actions}>
    {confirming ? <div role="group" aria-label="Approve shared display">
      <p>Approve this tab to send public text requests and display public replies for one hour?</p>
      <button onClick={() => { setConfirming(false); void tab.current?.approve(); }}>Confirm shared display</button>
      <button onClick={() => setConfirming(false)}>Cancel</button>
    </div> : <button disabled={!active || status === "approving"} onClick={() => setConfirming(true)}>Approve this tab</button>}
    <button onClick={() => { tab.current?.leave(); setDraft(""); setMessage(""); }}>Leave this tab</button>
    </div>
    <p className={styles.status} role="status">{status === "visible" ? message : status === "inactive" ? "Approve this tab to ask Cosmos." : `Display ${status}.`}</p>
    {status === "lost" && message && <p>{message}</p>}
    <CommittedCard command={active && status === "visible" ? command : null} runtime={tab.current?.runtime} />
    <form className={styles.composer} onSubmit={event => { event.preventDefault(); const text = draft.trim(); if (status === "visible" && text) { setDraft(""); void tab.current?.runtime?.input(text); } }}>
      <input aria-label="Ask Cosmos" placeholder="Ask Cosmos a public question…" maxLength={4000} value={draft} disabled={!active || status !== "visible"} onChange={event => setDraft(event.target.value)} />
      <button type="submit" aria-label="Send" disabled={!active || status !== "visible" || !draft.trim()}>Send</button>
      <button type="button" disabled={!active || status !== "visible"} onClick={() => { void tab.current?.runtime.cancel(); }}>Cancel request</button>
    </form>
  </div>;
}
