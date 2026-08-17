"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { CaptureThumbnail } from "@/components/CaptureThumbnail";
import { StatusMessage } from "@/components/Status";
import styles from "@/components/captureDetail.module.css";
import { formatTimestamp } from "@/lib/format";
import type { CaptureRecord } from "@/lib/types";
import { BurstSelector, CaptureInfo, CaptureShare, CaptureToolbar } from "./CaptureDetailPanels";

/** A line under the toolbar: what happened, in the tone it deserves. */
type Notice = { tone: "danger" | "warning" | "info"; text: string };
type BestFrameResult = { frame: number; method: string; reason: string };

/**
 * The capture detail, shared by BOTH entry points:
 *   - the @capturemodal intercepting route (mode="modal", a lightbox over the grid)
 *   - /captures/[id] (mode="page", the hard-navigation / deep-link fallback)
 *
 * Toolbar, top-right, as the real .Center had: Download, Info, Share, Forget.
 * The frame is the REAL media (via <CaptureThumbnail>) — the "sealed" box shows
 * only when the frame genuinely 404s, never unconditionally.
 */
export function CaptureDetailBody({
  uuid,
  createdAt,
  mode,
}: {
  uuid: string;
  createdAt?: string;
  mode: "modal" | "page";
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [share, setShare] = useState<{
    url: string | null;
    note: string | null;
    tone: "warning" | "info";
  } | null>(null);
  const [sharePending, setSharePending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rankPending, setRankPending] = useState(false);

  // A real created-time when we have one: the server passes it (fixture match) or
  // the grid already loaded it into the query cache. We never invent a timestamp.
  const cached = queryClient.getQueryData<{ data: CaptureRecord[] }>(["captures"]);
  const cachedRecord = cached?.data.find((c) => c.uuid === uuid);
  const [record, setRecord] = useState<CaptureRecord | undefined>(cachedRecord);
  const created = createdAt ?? record?.userCreatedAt;
  const selectedFrame = record?.data.bestFrameIndex ?? 0;
  const frameCount = record?.data.frameCount ?? record?.data.thumbnailCount ?? 0;

  // A hard refresh has no captures query cache. Read the exact memory so the
  // filmstrip and chosen frame are real on both the modal and deep-link paths.
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/capture/memory/${encodeURIComponent(uuid)}`, { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as CaptureRecord) : null))
      .then((capture) => {
        if (!cancelled && capture) setRecord(capture);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [uuid]);

  function applyBestFrame(result: BestFrameResult) {
    setRecord((current) =>
      current
        ? {
            ...current,
            data: {
              ...current.data,
              bestFrameIndex: result.frame,
              bestFrameMethod: result.method,
              bestFrameReason: result.reason,
            },
          }
        : current,
    );
  }

  // The stock Pin uploads the full burst. Ask Carry once to choose a hero when
  // an older or just-arrived capture has no selection yet; Carry caches it.
  useEffect(() => {
    if (
      !record ||
      record.data.memoryType !== "PHOTO" ||
      record.data.uploadComplete !== true ||
      frameCount < 2 ||
      record.data.bestFrameIndex !== undefined ||
      rankPending
    ) {
      return;
    }
    let cancelled = false;
    setRankPending(true);
    void fetch(`/api/capture/memory/${encodeURIComponent(uuid)}/best-photo`, { method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`selection -> ${response.status}`);
        return (await response.json()) as BestFrameResult;
      })
      .then(async (result) => {
        if (cancelled) return;
        applyBestFrame(result);
        await queryClient.invalidateQueries({ queryKey: ["captures"] });
        await queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] });
      })
      .catch(() => undefined)
      /*
       * UNCONDITIONAL. The flag belongs to the component, not to this effect run.
       *
       * `applyBestFrame` calls `setRecord` with a new object, and `record` is a
       * dependency of this effect — so the effect's own success guarantees its
       * own cleanup. The two awaited `invalidateQueries` above then hand React a
       * gap in which to commit that state change, run the cleanup (`cancelled =
       * true`) and re-run the effect, all BEFORE this `.finally` executes. Under
       * `if (!cancelled)` the reset was therefore skipped every time the ranking
       * worked, and `rankPending` latched true for the life of the mounted
       * lightbox.
       *
       * What that did to a wearer: they opened a freshly-uploaded burst photo,
       * watched Center pick a hero frame, and then could not change it. Every
       * filmstrip button stayed disabled, the header sat on "Choosing the
       * clearest frame…" forever, and both `chooseFrame` and `recheckWithAi`
       * returned at their own `rankPending` guard — silently, with no error to
       * explain any of it. Closing and reopening the lightbox was the only way
       * out. Adding `rankPending` to the dependency list does not help; the
       * ordering is the defect.
       */
      .finally(() => setRankPending(false));
    return () => {
      cancelled = true;
    };
  }, [frameCount, queryClient, record, uuid]);

  async function chooseFrame(frame: number) {
    if (rankPending || frame === selectedFrame) return;
    setRankPending(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/capture/memory/${encodeURIComponent(uuid)}/best-frame`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ frame }),
        },
      );
      if (!response.ok) throw new Error(`selection -> ${response.status}`);
      applyBestFrame((await response.json()) as BestFrameResult);
      await queryClient.invalidateQueries({ queryKey: ["captures"] });
      await queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] });
    } catch {
      setNotice({ tone: "warning", text: "That frame could not be selected right now." });
    } finally {
      setRankPending(false);
    }
  }

  async function compareFramesAgain() {
    if (rankPending) return;
    setRankPending(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/capture/memory/${encodeURIComponent(uuid)}/best-photo?force=true`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`selection -> ${response.status}`);
      applyBestFrame((await response.json()) as BestFrameResult);
      await queryClient.invalidateQueries({ queryKey: ["captures"] });
      await queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] });
    } catch {
      setNotice({ tone: "warning", text: "Frames couldn’t be compared right now." });
    } finally {
      setRankPending(false);
    }
  }

  /** Modal closes back to the grid; the full page returns to /captures. */
  function close() {
    if (mode === "modal") router.back();
    else router.push("/captures");
  }

  /**
   * Forget → confirm, then DELETE the memory for real.
   *
   * The BFF answers 200 with a `degraded` clause when it accepted the request
   * and deleted NOTHING (carry unconfigured, or the RPC failed). This used to
   * close the lightbox on any 200, so the capture reappeared on the next
   * refetch and the wearer had been told it was gone. Now: `degraded` present
   * means the capture is still there, it stays on screen, and the message says
   * why.
   */
  async function forget() {
    if (busy) return;
    if (
      !window.confirm(
        "Forget this capture? This permanently deletes it — it can't be undone.",
      )
    ) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/capture/memory/${encodeURIComponent(uuid)}`, {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        degraded?: string;
        note?: string;
      };
      const explanation = body.degraded ?? body.note;

      if (!res.ok || body.ok === false || explanation) {
        setNotice({
          tone: "warning",
          text: explanation && /session expired|sign in/i.test(explanation)
            ? "Nothing was deleted — this capture is still here. Sign in again, then try."
            : "Nothing was deleted — this capture is still here. Try again.",
        });
        setBusy(false);
        return;
      }

      // The grid is react-query, not a server component; invalidate so it refetches.
      await queryClient.invalidateQueries({ queryKey: ["captures"] });
      await queryClient.invalidateQueries({ queryKey: ["memories-dashboard"] });
      close();
    } catch {
      setNotice({
        tone: "danger",
        text: "Couldn't forget this capture. Nothing was deleted. Try again.",
      });
      setBusy(false);
    }
  }

  /** Download the real frame bytes with a filename. */
  async function download() {
    setNotice(null);
    try {
      const res = await fetch(
        `/api/capture/memory/${encodeURIComponent(uuid)}/file/${selectedFrame}/download`,
      );
      if (!res.ok) throw new Error(res.status === 503 ? "temporary" : `download -> ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `capture-${uuid}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setNotice({
        tone: "danger",
        text:
          error instanceof Error && error.message === "temporary"
            ? "The original photo could not be loaded right now. Try again."
            : "Nothing to download — the original photo isn't available.",
      });
    }
  }

  /**
   * Share → mint a share link server-side; surface it as /share/{token}.
   *
   * Two different failures, two different sentences — the same split the public
   * /share/{token} resolver makes. "This backend can't mint share links" is a
   * fact about the deployment and a retry cannot change it; "we couldn't reach
   * the backend" is a transport failure and pressing Share again may well work.
   */
  async function makeShareLink() {
    if (sharePending) return;
    setNotice(null);
    setCopied(false);
    setSharePending(true);
    try {
      const res = await fetch(`/api/capture/memory/${encodeURIComponent(uuid)}/share`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string | null;
        note?: string | null;
      };
      if (body?.url) {
        setShare({ url: body.url, note: null, tone: "info" });
        await copyLink(body.url);
      } else if (res.ok) {
        // The backend answered and has no share link for this capture.
        setShare({
          url: null,
          note: body?.note ?? "Sharing isn't available here.",
          tone: "info",
        });
      } else {
        setShare({
          url: null,
          note:
            body?.note ??
            "No link was created. Try again.",
          tone: "warning",
        });
      }
    } catch {
      setShare({
        url: null,
        note: "No link was created. Try again.",
        tone: "warning",
      });
    } finally {
      setSharePending(false);
    }
  }

  async function copyLink(path: string) {
    try {
      const absolute =
        typeof window !== "undefined" ? new URL(path, window.location.origin).toString() : path;
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
    } catch {
      // Clipboard blocked (no gesture / insecure context) — the link is still shown.
    }
  }

  return (
    <div className={mode === "page" ? styles.page : undefined}>
      <CaptureToolbar
        mode={mode}
        busy={busy}
        infoOpen={infoOpen}
        sharePending={sharePending}
        onClose={close}
        onDownload={() => void download()}
        onInfo={() => setInfoOpen((value) => !value)}
        onShare={() => void makeShareLink()}
        onForget={() => void forget()}
      />

      <div className={styles.frameWrap}>
        {/* The real frame. <CaptureThumbnail> only swaps in the sealed box on a
            genuine 404/error — never unconditionally. */}
        <CaptureThumbnail
          uuid={uuid}
          index={selectedFrame}
          imgClassName={styles.frame}
          fallbackClassName={styles.sealed}
          frame={record?.data}
        />
      </div>

      <BurstSelector
        uuid={uuid}
        record={record}
        frameCount={frameCount}
        selectedFrame={selectedFrame}
        pending={rankPending}
        onChoose={(frame) => void chooseFrame(frame)}
        onRecheck={() => void compareFramesAgain()}
      />

      <div className={styles.meta}>
        {created ? <span className={styles.timestamp}>{formatTimestamp(created)}</span> : null}
      </div>

      {notice ? (
        <div className={styles.actionError}>
          <StatusMessage tone={notice.tone}>{notice.text}</StatusMessage>
        </div>
      ) : null}

      {infoOpen ? <CaptureInfo uuid={uuid} created={created} frameCount={frameCount} selectedFrame={selectedFrame} /> : null}

      {share ? <CaptureShare share={share} copied={copied} onCopy={(path) => void copyLink(path)} /> : null}
    </div>
  );
}
