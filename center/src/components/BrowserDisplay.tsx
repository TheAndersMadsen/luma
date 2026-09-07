"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TabSwitch, useSurfaceTab } from "@/app/settings/account/surfaces/TabDisplay";
import type { BrowserRuntime } from "@/lib/browserRuntime";
import type { ChoicesContent, PlacesContent, RenderCommand } from "@/lib/contracts/ambianceRuntime";
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

/**
 * A numbered list whose numbers are the exact choice ids, so an answer by number
 * names what Cosmos meant. Each row is one control the owner can press, click or
 * pick with a digit; the committed text under it is still exactly the runtime's.
 */
function choicesCommitted(node: HTMLElement, content: ChoicesContent): boolean {
  if (node.childNodes.length !== 2) return false;
  const [title, list] = Array.from(node.childNodes);
  if (!exactText(title, "H2", content.title) || !(list instanceof HTMLOListElement) || list.childNodes.length !== content.items.length) return false;
  return content.items.every((item, index) => {
    const row = list.childNodes[index];
    if (!(row instanceof HTMLLIElement) || row.getAttribute("value") !== item.id || row.childNodes.length !== 1) return false;
    const action = row.firstChild;
    return action instanceof HTMLButtonElement && action.childNodes.length === (item.detail ? 2 : 1)
      && exactText(action.childNodes[0], "STRONG", item.title) && (!item.detail || exactText(action.childNodes[1], "P", item.detail));
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
export function CommittedCard({ command, runtime, onChoose }: {
  command: RenderCommand | null;
  runtime: BrowserRuntime | undefined;
  /** Answering a choice sends its exact title as the next request; absent, the list is shown but inert. */
  onChoose?: (title: string) => void;
}) {
  const node = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
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
    if (command.content.kind === "choices") {
      if (choicesCommitted(card, command.content)) void runtime?.committed(command);
      else { setFailedAction(command.actionId); runtime?.displayFailed(command); }
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
  /** Digits 1–8 pick, arrows walk the list, Home and End jump; Enter and Space are the button's own. */
  function choiceKeys(event: React.KeyboardEvent<HTMLOListElement>, items: ChoicesContent["items"]) {
    const buttons = Array.from(list.current?.querySelectorAll("button") ?? []);
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => { event.preventDefault(); buttons[Math.min(Math.max(index, 0), buttons.length - 1)]?.focus(); };
    if (event.key === "ArrowDown") return move(at + 1);
    if (event.key === "ArrowUp") return move(at < 0 ? buttons.length - 1 : at - 1);
    if (event.key === "Home") return move(0);
    if (event.key === "End") return move(buttons.length - 1);
    if (/^[1-8]$/u.test(event.key)) {
      const index = items.findIndex(item => item.id === event.key);
      if (index >= 0) { event.preventDefault(); buttons[index]?.focus(); onChoose?.(items[index].title); }
    }
  }
  if (!command || failedAction === command.actionId || command.content.kind === "places" && credits === null) return null;
  const content = command.content;
  return <article ref={node} className={`${styles.card}${content.kind === "places" ? ` ${styles.placesCard}` : ""}`} aria-label="Cosmos display">{content.kind === "text" ? <p>{content.text}</p> : content.kind === "choices" ? <>
      <h2 className={styles.placeQuery}>{content.title}</h2>
      <ol ref={list} className={styles.choices} onKeyDown={event => choiceKeys(event, content.items)}>{content.items.map(item => <li key={item.id} value={Number(item.id)}>
        <button type="button" disabled={!onChoose} onClick={() => onChoose?.(item.title)}><strong>{item.title}</strong>{item.detail ? <p>{item.detail}</p> : null}</button>
      </li>)}</ol>
    </> : <>
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

/** Prompts that work with the permissions a browser can hold today. A browser never reads its own screen. */
const EXAMPLES = ["Find cafés near me", "Show my notes about the kitchen", "What is the weather today?"] as const;
/** While one of these is the state, the turn is still running and Cancel task is worth offering. */
const OPEN_STATES: readonly string[] = ["Working", "Waiting for a device", "Waiting for you"];

/**
 * The Ask Cosmos panel: what was just sent, where the turn stands, the card the
 * runtime delivered, and one prompt field. Closing the panel hides it; the turn
 * keeps running, and Cancel task is a separate, explicit action.
 */
export function BrowserDisplay({ active = true }: { active?: boolean }) {
  const tab = useSurfaceTab(active);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState("");
  const [sending, setSending] = useState(false);
  const ready = active && tab.tabStatus === "visible";
  /*
   * The display is ON and this tab is simply behind another one. That is not
   * "off" and it is not "connecting": saying either sent an owner to look for
   * a switch that was already on. It is one thing to do, and only one.
   */
  const backgrounded = active && tab.tabStatus === "hidden";
  useEffect(() => { if (!ready) { setDraft(""); setSent(""); setSending(false); } }, [ready]);
  const status = tab.status;
  const turnOpen = OPEN_STATES.includes(status.title);
  const command = ready ? tab.command : null;
  const empty = !command && !sent;

  /** Acknowledged the instant it leaves: the line appears as "Now", the field clears, and Send stays down until Cosmos answers. */
  function send(text: string) {
    if (!ready || sending || !text.trim()) return;
    setSent(text.trim()); setDraft(""); setSending(true);
    void tab.input(text.trim()).finally(() => setSending(false));
  }
  function promptKeys(event: React.KeyboardEvent<HTMLInputElement>) {
    if (draft.length || command?.content.kind !== "choices" || !/^[1-8]$/u.test(event.key)) return;
    const item = command.content.items.find(candidate => candidate.id === event.key);
    if (item) { event.preventDefault(); send(item.title); }
  }

  return <div className={styles.display}>
    <div className={styles.control}>
      <TabSwitch title="Show replies in this browser" tabStatus={tab.tabStatus} on={tab.on} disabled={!active} onApprove={tab.approve} onLeave={tab.leave} />
    </div>
    <div className={styles.body}>
      <p className={styles.presence} role="status">
        {status.title ? <span className={styles.presenceTitle}>{status.title}</span> : null}
        {status.detail ? <span className={styles.presenceDetail}>{status.detail}</span> : null}
      </p>
      {sent ? <p className={styles.now}><span className={styles.nowLabel}>Now</span><span className={styles.nowText}>{sent}</span></p> : null}
      <CommittedCard command={command} runtime={tab.runtime} onChoose={ready ? send : undefined} />
      {empty ? <div className={styles.empty}>
        <span className={styles.nebula} aria-hidden="true" />
        <h2 className={styles.emptyTitle}>Ask anything</h2>
        <p className={styles.emptyBody}>{ready ? "Replies appear here or on the device that suits them best."
          : backgrounded ? "Replies are on in this browser. Bring this tab to the front to ask from it."
            : "Turn on replies in this browser to ask Cosmos from this tab."}</p>
        <ul className={styles.examples}>{EXAMPLES.map(example => <li key={example}>
          <button type="button" className={styles.example} disabled={!ready || sending} onClick={() => send(example)}>{example}</button>
        </li>)}</ul>
      </div> : null}
    </div>
    <form className={styles.composer} onSubmit={event => { event.preventDefault(); send(draft); }}>
      <input aria-label="Ask Cosmos" placeholder={ready ? "Ask Cosmos…" : backgrounded ? "Bring this tab to the front to ask…" : "Waiting for the connection…"} maxLength={4000}
        value={draft} disabled={!ready || sending} autoComplete="off" onKeyDown={promptKeys} onChange={event => setDraft(event.target.value)} />
      <button type="submit" className={styles.send} disabled={!ready || sending || !draft.trim()}>Send</button>
    </form>
    <div className={styles.tray}>
      {ready ? <span className={styles.destination} title="Cosmos may still answer on another device it thinks suits the reply better.">→ This screen</span> : <span />}
      {turnOpen ? <button type="button" className={styles.trayAction} onClick={tab.cancel}>Cancel task</button> : null}
    </div>
  </div>;
}
