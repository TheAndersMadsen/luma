"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clipArticleSchema, type ClipSnapshot } from "@/lib/contracts/clips";
import { cosmosNoteSchema } from "@/lib/contracts/notes";
import { PinApiError, type PinClient } from "@/lib/pin-device/client";
import { StatusMessage } from "@/components/Status";
import { DeviceRequired, PaneSection } from "../_lib/PaneShell";
import { pinClientIdentity, usePinPaneSession } from "../_lib/pinSession";
import styles from "../_lib/panes.module.css";
import local from "./clip.module.css";

export default function PinClipPane() {
  const session = usePinPaneSession();
  if (!session.client) return <DeviceRequired what="Clip" connectionError={session.connectionError} attachedWithoutServer={session.attachedWithoutServer} />;
  return <ConnectedClip key={pinClientIdentity(session.client)} client={session.client} ready={session.ready} />;
}

function ConnectedClip({ client, ready }: { client: PinClient; ready: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [clip, setClip] = useState<ClipSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stageBusy = useRef(false);
  const actionAbort = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const lastClip = useRef<ClipSnapshot | null>(null);
  useEffect(() => () => actionAbort.current?.abort(), []);

  useEffect(() => {
    if (!ready) { setEnabled(false); setBusy(false); return; }
    const controller = new AbortController();
    let retryAt = 0;
    async function persist(value: ClipSnapshot) {
      if (Date.now() < retryAt) return;
      const { id, ...article } = value.article;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
      try {
        const response = await fetch(`/api/capture/clips/${id}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify(article), signal, cache: "no-store",
        });
        if (controller.signal.aborted) return;
        if ([400, 409, 413, 422].includes(response.status)) {
          const result = await client.finishClip(id, "failed", signal);
          if (controller.signal.aborted) return;
          lastClip.current = result.clip;
          setClip(result.clip);
          setError("This article could not be saved. Hand it off again to start a new copy.");
          return;
        }
        if (!response.ok) throw new Error("Save unconfirmed");
        const note = cosmosNoteSchema.parse(await response.json());
        if (note.uuid !== id || note.sealed) throw new Error("Invalid acknowledgement");
        if (controller.signal.aborted) return;
        const result = await client.finishClip(id, "saved", signal);
        if (!controller.signal.aborted) { lastClip.current = result.clip; setClip(result.clip); setError(null); }
      } catch {
        if (controller.signal.aborted) return;
        // A timeout may have happened after Cosmos committed. Retry the SAME
        // immutable ID; never infer failure from a missing acknowledgement.
        retryAt = Date.now() + 1000;
        setError("Save not yet confirmed. Keep this tab open and signed in; Clip is checking again.");
      }
    }
    async function poll() {
      while (!controller.signal.aborted) {
        try {
          const started = revision.current;
          // The Pin paces this response. No hidden-tab timer is needed on the
          // successful path while the article stays in the foreground.
          const result = await client.getClip(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
          if (controller.signal.aborted) return;
          if (started !== revision.current) continue;
          setConnectionError(null);
          if (!result.clip && (lastClip.current?.phase === "requested" || lastClip.current?.phase === "unconfirmed")) {
            setError("The copy session expired. Check Notes before handing off this article again.");
          }
          lastClip.current = result.clip;
          setClip(result.clip);
          if (result.clip?.phase === "requested" || result.clip?.phase === "unconfirmed") await persist(result.clip);
        } catch (cause) {
          if (controller.signal.aborted) return;
          setConnectionError(cause instanceof PinApiError && cause.status === 404
            ? "This Pin needs the Luma Clip update."
            : "Your Pin is not answering. Any copy already requested may still be saved; reconnect to check.");
          await pause(1000, controller.signal);
        }
      }
    }
    void poll();
    return () => controller.abort();
  }, [client, ready]);

  useEffect(() => {
    if (!enabled || !ready) return;
    const controller = new AbortController();
    const receive = async (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "luma.clip.article") return;
      const message = event.data;
      const parsed = clipArticleSchema.safeParse(message.article);
      if (!parsed.success || message.request_id !== parsed.data.id || Object.keys(message).sort().join(",") !== "article,request_id,type") return;
      const acknowledge = (ok: boolean, reason?: string) => window.postMessage({ type: "luma.clip.accepted", request_id: parsed.data.id, ok, reason }, window.location.origin);
      if (stageBusy.current) { acknowledge(false, "Another handoff is in progress."); return; }
      stageBusy.current = true; setBusy(true); revision.current += 1;
      try {
        const result = await client.stageClip(parsed.data, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
        if (controller.signal.aborted) return;
        if (result.clip?.article.id !== parsed.data.id || result.clip.phase !== "ready") throw new Error("Invalid handoff");
        revision.current += 1;
        lastClip.current = result.clip; setClip(result.clip); setError(null); acknowledge(true);
      } catch (cause) {
        if (controller.signal.aborted) return;
        const reason = cause instanceof PinApiError && cause.status === 409
          ? "Finish or cancel the current article in Center before handing off another."
          : "The Pin did not confirm the handoff. Check Clip in Center before trying again.";
        setError(reason); acknowledge(false, reason);
      } finally {
        stageBusy.current = false;
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    window.addEventListener("message", receive);
    return () => { controller.abort(); window.removeEventListener("message", receive); };
  }, [client, enabled, ready]);

  async function cancel() {
    if (!clip || clip.phase !== "ready") return;
    const controller = new AbortController(); actionAbort.current = controller;
    setBusy(true); revision.current += 1;
    try {
      const result = await client.cancelClip(clip.article.id, controller.signal);
      if (!controller.signal.aborted) { revision.current += 1; lastClip.current = result.clip; setClip(result.clip); setError(null); }
    } catch {
      if (!controller.signal.aborted) setError("The article could not be cancelled. A copy may already be in progress.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <>
    <PaneSection title="Pinch to copy">
      <p className={styles.formHelp}>Send an article to your Pin, raise your hand on Home, then pinch. The publisher appears first; the title appears after it is saved. Hold the pinch and pull your hand closer to see selected text or the link.</p>
      <ol className={local.steps}>
        <li><a href="/api/downloads/luma-clip">Download the Luma Clip browser extension</a>, extract it, then use “Load unpacked” at <code>chrome://extensions</code> with Developer mode on.</li>
        <li>Enable browser handoff below. In the extension, set your Center address to this site’s address.</li>
        <li>Open an article, optionally select some text, then choose “Hand off to Pin” in the extension. Leave this Center tab open and signed in.</li>
      </ol>
      <p className={styles.formHelp}>Works in Chrome and compatible browsers on your Mac. The Pin must be connected through USB or your paired remote connection. An article is ready for 60 seconds after handoff.</p>
      <button className={styles.primaryButton} type="button" disabled={!ready || busy} onClick={() => setEnabled(!enabled)}>{enabled ? "Pause browser handoff" : "Enable browser handoff"}</button>
      {enabled && <StatusMessage tone="info">Ready for the browser extension. Your article tab can stay in front.</StatusMessage>}
    </PaneSection>
    <PaneSection title="Current article">
      {clip ? <article className={styles.card}>
        <p className={local.publisher}>{clip.article.publisher}</p>
        <h3 className={styles.cardTitle}>{clip.article.title}</h3>
        <a className={local.url} href={clip.article.url} target="_blank" rel="noopener noreferrer">{clip.article.url}</a>
        {clip.article.selection && <blockquote className={local.selection}>{clip.article.selection}</blockquote>}
        <p role="status" className={local.phase}>{({ ready: "Ready. Raise your hand on Home and pinch to copy.", requested: "Saving your article…", unconfirmed: "Waiting for save confirmation…", saved: "Saved to Notes.", failed: "The article was not saved." })[clip.phase]}</p>
        {clip.phase === "ready" && <button className={styles.linkButton} type="button" disabled={!ready || busy} onClick={() => void cancel()}>Cancel article</button>}
        {clip.phase === "saved" && <Link className={styles.linkButton} href={`/notes/${clip.article.id}`}>Open saved note</Link>}
      </article> : <p className={styles.formHelp}>No article is waiting on your Pin. Use the browser extension to hand one off.</p>}
      {(connectionError || error) && <StatusMessage tone="warning">{connectionError ?? error}</StatusMessage>}
      <p className={styles.formHelp}>Clip saves the title, publisher, link and selected text to your Notes. It does not read the rest of the page. The exact projection and back-of-hand pose are experimental and need validation on your Pin.</p>
    </PaneSection>
  </>;
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
